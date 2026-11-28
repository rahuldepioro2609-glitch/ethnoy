// Merit List Engine, foundation release (documentation/MERIT_LIST_GAP_ANALYSIS.md). Pure: no
// database or request access.
//
// What it does (arithmetic only, no client policy):
// - checks each imported scorecard for internal consistency (identity, section sums, maxima);
// - orders valid results by total marks, highest first;
// - groups equal totals into TIE GROUPS and reports their position range, deliberately unresolved;
// - flags imported ranks that contradict the marks order;
// - fingerprints the inputs so the same inputs never produce a second draft version.
//
// What it deliberately does NOT do, because no rule is approved (BLOCKED, ML-1 to ML-9):
// break ties, number tied ranks, apply cut-offs or qualification criteria, rank by category, or
// change any marks. Online-exam scoring and negative marking are untouched (R-10).
import { createHash } from 'node:crypto';

export const MERIT_ENGINE_VERSION = 'merit-foundation-v1';
/** Floating-point tolerance when comparing sums of marks (marks may have decimals). */
const EPSILON = 1e-6;

export type MeritIssueCode =
  | 'scorecard_unreadable'
  | 'identity_mismatch'
  | 'section_sum_mismatch'
  | 'maximum_sum_mismatch'
  | 'total_above_maximum'
  | 'section_above_maximum'
  | 'imported_rank_conflict';

export const MERIT_ISSUE_TEXT: Readonly<Record<MeritIssueCode, string>> = Object.freeze({
  scorecard_unreadable: 'The scorecard has no usable total or maximum marks; it is left out of the order.',
  identity_mismatch: 'The scorecard roll number, application number or exam code differs from the result record.',
  section_sum_mismatch: 'Section marks do not add up to the total marks.',
  maximum_sum_mismatch: 'Section maximum marks do not add up to the total maximum marks.',
  total_above_maximum: 'Total marks are above the total maximum marks.',
  section_above_maximum: 'A section has more marks than its maximum.',
  imported_rank_conflict: 'The imported rank is better than the imported rank of a candidate with higher marks.',
});

/** One row of published_results (draft or published) for the exam. */
export interface MeritResultRecord {
  resultId: string;
  applicationNumber: string;
  rollNumber: string;
  examCode: string;
  isPublished: boolean;
  scorecard: unknown;
}

export interface MeritEntry {
  resultId: string;
  applicationNumber: string;
  rollNumber: string;
  isPublished: boolean;
  totalMarks: number;
  maxMarks: number;
  /** 1-based position range. Equal totals share one range (an unresolved tie group). */
  positionFrom: number;
  positionTo: number;
  /** Tie group number (1, 2, …) when two or more results have the same total; otherwise null. */
  tieGroup: number | null;
  /** The rank typed into the imported scorecard (shown for comparison only). */
  importedRank: number | null;
  issues: MeritIssueCode[];
}

export interface ExcludedResult {
  resultId: string;
  applicationNumber: string;
  rollNumber: string;
  issues: MeritIssueCode[];
}

export interface TieGroup {
  tieGroup: number;
  totalMarks: number;
  positionFrom: number;
  positionTo: number;
  size: number;
}

export interface MeritAnalysis {
  examCode: string;
  engineVersion: string;
  entries: MeritEntry[];
  excluded: ExcludedResult[];
  tieGroups: TieGroup[];
  summary: {
    resultCount: number;
    orderedCount: number;
    excludedCount: number;
    publishedCount: number;
    draftCount: number;
    tieGroupCount: number;
    entriesWithIssues: number;
  };
  /** SHA-256 over the engine version, exam and every ordered input; equal inputs give equal fingerprints. */
  fingerprint: string;
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const same = (a: unknown, b: string) => typeof a === 'string' && a.trim().toUpperCase() === b.trim().toUpperCase();

function readScorecard(record: MeritResultRecord) {
  const card = (record.scorecard && typeof record.scorecard === 'object' && !Array.isArray(record.scorecard))
    ? record.scorecard as Record<string, unknown>
    : null;
  const issues: MeritIssueCode[] = [];
  if (!card || !isFiniteNumber(card.totalMarksObtained) || !isFiniteNumber(card.totalMaxMarks) || card.totalMaxMarks <= 0) {
    return { total: null, max: null, importedRank: null, issues: ['scorecard_unreadable' as const] };
  }
  const total = card.totalMarksObtained;
  const max = card.totalMaxMarks;
  if (!same(card.rollNumber, record.rollNumber) || !same(card.applicationNumber, record.applicationNumber) || !same(card.examCode, record.examCode)) {
    issues.push('identity_mismatch');
  }
  if (total > max + EPSILON) issues.push('total_above_maximum');
  const sections = Array.isArray(card.sectionScores) ? card.sectionScores as Array<Record<string, unknown>> : [];
  if (sections.length) {
    const usable = sections.every((section) => isFiniteNumber(section?.marksObtained) && isFiniteNumber(section?.maxMarks));
    if (usable) {
      const obtained = sections.reduce((sum, section) => sum + (section.marksObtained as number), 0);
      const maximum = sections.reduce((sum, section) => sum + (section.maxMarks as number), 0);
      if (Math.abs(obtained - total) > EPSILON) issues.push('section_sum_mismatch');
      if (Math.abs(maximum - max) > EPSILON) issues.push('maximum_sum_mismatch');
      if (sections.some((section) => (section.marksObtained as number) > (section.maxMarks as number) + EPSILON)) issues.push('section_above_maximum');
    } else {
      issues.push('section_sum_mismatch');
    }
  }
  const importedRank = Number.isSafeInteger(card.allIndiaRank) && (card.allIndiaRank as number) > 0 ? card.allIndiaRank as number : null;
  return { total, max, importedRank, issues };
}

/** Orders an exam's results by total marks and reports issues and unresolved ties. Never mutates input. */
export function analyseMeritResults(examCode: string, records: readonly MeritResultRecord[]): MeritAnalysis {
  const code = examCode.trim().toUpperCase();
  const ordered: MeritEntry[] = [];
  const excluded: ExcludedResult[] = [];
  for (const record of records) {
    const read = readScorecard(record);
    if (read.total === null || read.max === null) {
      excluded.push({ resultId: record.resultId, applicationNumber: record.applicationNumber, rollNumber: record.rollNumber, issues: read.issues });
      continue;
    }
    ordered.push({
      resultId: record.resultId, applicationNumber: record.applicationNumber, rollNumber: record.rollNumber, isPublished: record.isPublished,
      totalMarks: read.total, maxMarks: read.max, positionFrom: 0, positionTo: 0, tieGroup: null, importedRank: read.importedRank, issues: read.issues,
    });
  }
  // Highest total first. Within equal totals the roll number only fixes a stable DISPLAY order; it is
  // not a tie-break (ML-1) and the group's position range is shared.
  ordered.sort((a, b) => (b.totalMarks - a.totalMarks) || a.rollNumber.localeCompare(b.rollNumber) || a.resultId.localeCompare(b.resultId));

  const tieGroups: TieGroup[] = [];
  let worstRankAmongHigher = 0; // the worst (highest-numbered) imported rank seen at strictly higher totals
  for (let start = 0; start < ordered.length;) {
    let end = start;
    while (end + 1 < ordered.length && Math.abs(ordered[end + 1].totalMarks - ordered[start].totalMarks) <= EPSILON) end += 1;
    const group = ordered.slice(start, end + 1);
    const tieGroup = group.length > 1 ? tieGroups.length + 1 : null;
    for (const entry of group) {
      entry.positionFrom = start + 1;
      entry.positionTo = end + 1;
      entry.tieGroup = tieGroup;
      // A candidate with fewer marks must not hold a better imported rank than anyone above.
      if (entry.importedRank !== null && entry.importedRank < worstRankAmongHigher) entry.issues.push('imported_rank_conflict');
    }
    if (tieGroup !== null) {
      tieGroups.push({ tieGroup, totalMarks: group[0].totalMarks, positionFrom: start + 1, positionTo: end + 1, size: group.length });
    }
    for (const entry of group) {
      if (entry.importedRank !== null) worstRankAmongHigher = Math.max(worstRankAmongHigher, entry.importedRank);
    }
    start = end + 1;
  }

  const fingerprintInput = JSON.stringify([
    MERIT_ENGINE_VERSION, code,
    ordered.map((entry) => [entry.resultId, entry.applicationNumber, entry.rollNumber, entry.isPublished, entry.totalMarks, entry.maxMarks, entry.importedRank, entry.issues]),
    [...excluded].sort((a, b) => a.resultId.localeCompare(b.resultId)).map((entry) => [entry.resultId, entry.issues]),
  ]);
  return {
    examCode: code,
    engineVersion: MERIT_ENGINE_VERSION,
    entries: ordered,
    excluded,
    tieGroups,
    summary: {
      resultCount: records.length,
      orderedCount: ordered.length,
      excludedCount: excluded.length,
      publishedCount: records.filter((record) => record.isPublished).length,
      draftCount: records.filter((record) => !record.isPublished).length,
      tieGroupCount: tieGroups.length,
      entriesWithIssues: ordered.filter((entry) => entry.issues.length > 0).length + excluded.length,
    },
    fingerprint: createHash('sha256').update(fingerprintInput).digest('hex'),
  };
}

/** A spreadsheet cell that cannot be read as a formula (CSV injection). Numbers stay numbers. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const MERIT_CSV_HEADER = ['Position from', 'Position to', 'Tie group', 'Application number', 'Roll number', 'Total marks', 'Maximum marks', 'Imported rank', 'Result state', 'Issues'];

/** CSV of a draft snapshot. Ties are shown as shared position ranges, never as resolved ranks. */
export function meritEntriesToCsv(entries: readonly MeritEntry[]): string {
  const lines = [MERIT_CSV_HEADER.map(csvCell).join(',')];
  for (const entry of entries) {
    lines.push([
      entry.positionFrom, entry.positionTo, entry.tieGroup ?? '', entry.applicationNumber, entry.rollNumber, entry.totalMarks, entry.maxMarks,
      entry.importedRank ?? '', entry.isPublished ? 'published' : 'draft', entry.issues.join(' '),
    ].map(csvCell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}
