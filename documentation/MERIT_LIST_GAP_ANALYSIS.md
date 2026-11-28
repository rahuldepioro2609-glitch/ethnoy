# Merit List Engine: verified gap analysis

**Date:** 2026-11-27
**Code inspected:** worktree `.claude/worktrees/audit-log` (branch `audit-log`, base `1dd6145` plus the uncommitted A-11/A-12 work).
**Sources:** `server/schema.sql`, `server/index.ts` (results, online exams, applications), `server/onlineExamScoring.ts`, `server/mockScoring.ts`, `docs/policy/master-policy-register.md`, `docs/policy/policy-conflict-and-gap-register.md`, `docs/architecture/*`, `README.md`, and the client report `Project Report.docx` (requirement R-10 and screenshot S-18).

## 1. What exists today (verified)

| Area | What the code does | Evidence |
|---|---|---|
| Result records | `published_results` holds one row per (exam, roll number) with a **scorecard JSON imported from a workbook or sent to `POST /api/admin/results`**. The scorecard already contains section marks, total marks, percentiles, `allIndiaRank`, `categoryRank`, `qualifyingStatus` and `cutoffMarks`. **ELTNOY does not compute any of these; people compute them outside the system and type them in.** | `server/schema.sql:283`; `scorecardSchema` in `server/index.ts` |
| Result workflow | Imports and direct writes are always drafts. Publish, unpublish and correction are Super Admin only (A-04, A-16). Each step is audited (A-11). | `RESULT_UPSERT_SQL`, `PATCH /api/admin/results/:id` |
| Candidate scorecards | Candidates look up their own **published** result by identifier, date of birth and exam. | `candidateResultLookupHandler` |
| Online exam scoring | Points for correct answers only, **no negative marking**. The maximum is the sum of points, with per-section totals. | `server/onlineExamScoring.ts` |
| Categories | Applications and scorecards carry one of `General`, `OBC-NCL`, `SC`, `ST`, `Gen-EWS`, plus a PwD flag. **These are data fields only. No rule uses them.** | `server/schema.sql:141`, `scorecardSchema` |
| Exam types | `exams.category` is `Undergraduate`, `Scholarship`, `Teacher` or `Professional`. It is a label only. | `server/schema.sql:173` |
| Ranking, merit lists, cut-offs | **Not computed anywhere.** | Search of `server/` and `src/` |

## 2. Client decisions that apply (verified in the register)

| ID | Decision | Effect on this module |
|---|---|---|
| **R-10** | IMPLEMENTATION_APPROVED **restriction**: "Scoring formula, exam duration, negative marking and one attempt per exam unchanged" | Online-exam scoring and negative marking **must not be changed**. |
| **A-04** | Results: Super Admin only to publish, unpublish or correct. Direct creation never publishes. | Any merit **publication** belongs to Super Admin. |
| **A-16** | Correcting published content returns it to draft. | Recalculation must never silently change published results. |
| **A-07** | Sensitive data export: Super Admin only. | Merit exports stay Super Admin only. |
| **A-11 / A-12** | Audit important actions in the same transaction; audit reads are Super Admin only. | Merit operations are audited. |
| **A-19** | Authorization on the backend, with route tests. | Applies. |
| Client report R-10 / S-18 | "Result and Merit list maker with result sheet preview". The screenshot shows rank lists, category-wise merit, cut-offs, tie-break rules, re-evaluation and publishing. | A **requirement**. It does **not** state any rule: no tie-break order, cut-off method, reservation percentages or qualification criterion. |

**No approved document states:**
- a tie-breaking rule;
- a cut-off method or value;
- a qualifying criterion;
- category-wise (reservation) ranking;
- a ranking convention (for example 1, 2, 2, 4 or 1, 2, 2, 3);
- a merit-list publication or finalization rule;
- a re-evaluation process.

Q1–Q114 are unverifiable (register section Q).

## 3. Requirement-by-requirement gap analysis

| # | Requirement | Status today | Decision | This phase |
|---|---|---|---|---|
| 1 | Marks calculation and validation | Online scoring exists (R-10, frozen). Imported scorecards are schema-checked only, not checked for arithmetic. | Validation is arithmetic, not policy. | **BUILD:** consistency checks on imported scorecards (section sums, marks within maximum, rank and status fields present). Read-only; flags issues, changes nothing. |
| 2 | Negative marking | Online engine: none (R-10). Imported marks may already include it. | R-10 forbids changing it. | **BLOCKED** for the online engine (R-10). Imported marks are taken as given. |
| 3 | Qualification criteria | Typed into each scorecard by hand | No approved criterion | **BLOCKED.** The engine only reports the imported `qualifyingStatus`. |
| 4 | Merit ranking | Typed in by hand (`allIndiaRank`) | Ordering by total marks is arithmetic. **How equal marks are numbered is a convention, not approved.** | **BUILD (foundation):** order by total marks; equal totals form a **tie group** shown with its position range and marked unresolved. Imported ranks that contradict the marks order are flagged. |
| 5 | Category-wise ranking | Typed in by hand (`categoryRank`) | Not approved | **BLOCKED.** Category is not read or stored by the engine. |
| 6 | Tie-breaking rules | None | Not approved | **BLOCKED.** No tie-break is applied. Ties stay visible as unresolved groups. |
| 7 | Cut-off calculation | Typed in by hand (`cutoffMarks`) | Not approved | **BLOCKED.** |
| 8 | Multiple examination types | Labels only | Per-type rules are not approved | Foundation is type-agnostic; per-type rules **BLOCKED**. |
| 9 | Merit list generation | None | Safe as a draft snapshot | **BUILD:** versioned draft snapshots computed from the exam's result records. |
| 10 | Draft and review workflow | Results have draft/published | Review is safe; approval and finalization rules are not approved | **BUILD:** draft snapshots and their version history. **Approval, finalization and publication of a merit list: BLOCKED.** |
| 11 | Authorized approval and publication | Results publication is Super Admin only (A-04) | No merit-list publication rule | **BLOCKED** (no publish route is built). |
| 12 | Result recalculation and version history | Results are replaced by re-import (A-16 draft) | Changing marks is not approved | Snapshots are **append-only versions**: a later import followed by a new snapshot is the "recalculation", and earlier versions are kept. Results themselves are never changed by the engine. |
| 13 | Candidate scorecards | Exist (published lookup) | — | **No change.** |
| 14 | Export | Super Admin data export exists (A-07) | Same restriction | **BUILD:** CSV export of a snapshot, Super Admin only, audited before it is sent. |
| 15 | Duplicate processing prevention | — | Technical | **BUILD:** each snapshot stores a fingerprint of its inputs. The same inputs cannot create a second version (409). Versions are created under a per-exam lock. |
| 16 | Audit events | A-11 exists | — | **BUILD:** `merit_list.snapshot_created` and `merit_list.exported`, in the same transaction. |
| 17 | Tenant isolation | Results are platform-wide (ELTNOY admin). Institutes have no result access. | Institute merit lists depend on client decision F-4 (audit) | Admin-only routes; no Institute or Student route. Institute merit lists **BLOCKED** by F-4. |
| 18 | Authorization | — | A-04, A-07 | **Super Admin only** for every merit route. Ordinary Officials today see the result list but **not** marks or names, so the preview must not widen that. |
| 19 | Transaction safety | — | — | Snapshot creation: one transaction, exam-level advisory lock, unique version and fingerprint constraints, audit row in the same transaction. |
| 20 | Tests | — | — | Unit, route matrix, transaction and real-PostgreSQL tests. |

## 4. Privacy decisions taken for the foundation (technical, conservative)

- Snapshots store only the fields needed to review an order:
  - application number;
  - roll number;
  - total marks and maximum marks;
  - position range and tie group;
  - issue codes.
- **Names, dates of birth, categories, PwD status and section marks are not copied.** The preview reads them from the scorecard for display only where needed, and does not show categories.
- Super Admin only, as for result publication and data export.

## 5. Decisions needed from the client to finish the module

| ID | Question |
|---|---|
| ML-1 | Tie-break order. Options include: higher marks in a named section, fewer wrong answers, older candidate, earlier application, or shared rank. |
| ML-2 | Rank numbering for ties: "1, 2, 2, 4" (competition) or "1, 2, 2, 3" (dense). |
| ML-3 | Qualification criterion per exam type: fixed marks, percentage, or top-N. Inclusive or exclusive? |
| ML-4 | Cut-off method: entered by the Super Admin, or computed (top-N, percentile). Per category? |
| ML-5 | Category-wise (reservation) merit: which categories, any percentages, PwD handling, and whether reserved candidates also appear in the general list. |
| ML-6 | Merit-list approval and publication: who approves, maker-checker, whether publication also publishes the results, and whether a published list can be withdrawn. |
| ML-7 | Re-evaluation and objections: who may request, deadlines, and effect on a published list. |
| ML-8 | Whether Institutes may build merit lists for their own exams (client decision F-4 in the project audit). |
| ML-9 | Negative marking for online exams. Currently forbidden by R-10; a change needs a new client decision. |
