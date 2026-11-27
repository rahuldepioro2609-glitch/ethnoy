# ELTNOY: decisions needed from the client

**Date:** 2026-11-27. **For:** Er. Jitender Ahlawat (Project Head). **Prepared by:** engineering (Er. Rahul Dhakad's team).

Development is paused at these points. Each item says why the decision is needed and what is blocked until it is made. The options shown are examples to make the question concrete, not recommendations or decided policy. Once a decision is made, it should be recorded in `docs/policy/master-policy-register.md`.

## Decided (Product Owner, 2026-11-27)

| # | Decision |
|---|---|
| **D-01** | **APPROVED, Option B.** "Prepare the Audit Log work for its own branch, but hold the Institute Workspace until its author confirms completion and it is safely isolated in its own branch. No merging yet. Integration will happen on a separate integration branch after both workstreams are ready." |
| **D-02 (F-4)** | **APPROVED, Option B.** "Institutes may prepare exams, admit cards, results and merit-list drafts. ELTNOY Super Admin must review and approve official publication. Institutes must not publish official results or admit cards directly. Preserve A-04 and A-06." |
| All other decisions below | **Deferred** until their implementation phase. |

## Priority 0: security and data integrity

| # | Decision | Why it is needed | What is blocked |
|---|---|---|---|
| 1 | **OD-5: which refusals and failed sign-ins are recorded in the audit log?**<br>Options:<br>(a) Super Admin-only routes, aggregated;<br>(b) all denied requests;<br>(c) failed sign-ins too.<br>And: may the typed login ID be stored when the account does not exist? | Recording refusals helps detect abuse. Storing typed login IDs is personal data. | Audit of authorization denials, refused publishing attempts and failed sign-ins. (Successful actions and refused or failed payments are already recorded.) |
| 2 | **A-08: hide applicants' email and phone from ordinary Officials?**<br>Agreed in principle; implementation not yet approved. | Lowers the exposure of personal data. Officials would see application status but not contact details. | Building the hiding in the admin application list and export |
| 3 | **A-16 for admit cards: should admit-card uploads become drafts that a Super Admin publishes?**<br>Agreed in principle; implementation not yet approved. A-20 also needs a controlled deployment. | Today an upload publishes immediately (an interim rule). Results already follow draft-then-publish. | The admit-card draft step and its deployment plan |
| 4 | **Student password reset**<br>Since 2026-11-24, Students sign in with password only. Should a reset by email code be added, with what code lifetime, and should all other sessions be signed out after a reset? | A forgotten password currently has no self-service recovery. Password-only sign-in increases the importance of a safe reset. | Building password reset |
| 5 | **Off-host backups**<br>Where should encrypted database backups be copied (a location not on the VPS), how often, and how long kept? Who holds the encryption key? Hosting must stay free-only. | Backups are currently manual and stored on the same VPS. A disk failure would lose both the data and its backups. | Automated backup, off-site copy and restore drills |

## Priority 1: merit list rules (the Merit List foundation is built; these rules are not)

The system can already order an exam's results by marks, show equal marks as an **unresolved tie**, check scorecards for arithmetic errors, save draft versions and export them. None of the rules below is applied until decided.

| # | Decision | Why it is needed | What is blocked |
|---|---|---|---|
| ML-1 | **Tie-break order**: for example, higher marks in a named section, fewer wrong answers, older candidate, earlier application, or keep a shared rank | Two candidates with equal marks cannot be ordered otherwise | Resolving ties |
| ML-2 | **Rank numbering for ties**: 1, 2, 2, 4 or 1, 2, 2, 3 | Affects every rank after a tie | Rank numbers |
| ML-3 | **Qualifying criterion** per exam type: minimum marks, percentage or top-N? Is the boundary included? | Decides "Qualified / Not Qualified" | Qualification status |
| ML-4 | **Cut-off**: entered by a Super Admin, or calculated (top-N, percentile)? Per category? | Cut-offs are currently typed into each scorecard by hand | Cut-off management |
| ML-5 | **Category-wise merit**: which categories (General, OBC-NCL, SC, ST, EWS), any reservation percentages, PwD handling, and whether reserved candidates also appear in the general list | Category rank is a legal and policy matter | Category merit lists |
| ML-6 | **Approval and publication of merit lists**: who approves, is a second person required, does publishing a merit list also publish the results, can it be withdrawn? | A-04 covers results only | Approving and publishing merit lists |
| ML-7 | **Re-evaluation and objections**: who may ask, deadline, effect on a published list | Shown in the report (S-18), no rule given | Re-evaluation |
| ML-8 | **May Institutes build merit lists for their own exams?** (part of F-4) | The report shows Institutes doing it; current policy has ELTNOY publish results | Institute merit lists |
| ML-9 | **Negative marking for online exams.** Currently forbidden by approved restriction R-10. | Changing the scoring formula affects every online exam | Negative marking |

## Priority 1: other product decisions (from the project audit)

| # | Decision | What is blocked |
|---|---|---|
| F-4 | **DECIDED 2026-11-27 (D-02, Option B):** Institutes prepare; the Super Admin approves and publishes. | The Institute Workspace work being built by another tool, which today lets institutes publish results directly. It cannot ship until this is decided. |
| F-1 / F-3 | Do subscriptions replace restriction N-03 ("no subscriptions")? Which prices: the report text (₹3,000 for 2 years, ₹5,000 for 5 years, ₹10,000 for 15 years) or the screenshot (₹2,500, ₹5,000 or ₹8,000 a year)? | Plans, usage and the home-page logo scroller |
| F-2 | Does `{name}.eltnoy.com` replace restriction N-04 ("no separate institution websites")? | Username reservation and institute websites (also needs wildcard DNS and TLS) |
| F-5 | Who at ELTNOY reviews question papers, and who may read them before the exam? | Paper tender and upload |
| F-6 | Payment provider or UPI process, and GST on commissions (12% and 5%) | Fees, UPI and commission |
| A-10 | Official management (create Officials, grant or revoke Super Admin): approve the milestone? | Official management screens |
| Q117–Q119 | Approve implementing Institute staff review of applications (Owner and Application Managers)? | Institute applicant review |
| C-03 | May an Institute see its own activity log? (Current policy A-12: Super Admin only.) | Institute activity log screen |
| OD-1 / OD-3 / OD-6 / OD-7 | Audit retention period; collecting IP and browser; off-host audit checkpoints; audit export format | Those audit extensions |
