/** The advisory dry-run review: the verifier's checklist printed before a submit, behind a default-off line setting [C7]. */
import { Refused } from '../../../../kernel/light.js';

const SETTING = 'bar.dryRunReview';

/**
 * Read the board's default-off bar.dryRunReview line setting: false (off), true (on) or 'ab' (alternate items between on and off).
 * Why: the checklist costs every submitter output, so a board opts in; a malformed stored value refuses rather than guessing.
 */
export function dryRunReviewMode(board) {
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`line_setting:${SETTING}`);
  if (!row) return false;
  let value;
  try { value = JSON.parse(row.meta_value); }
  catch { throw new Refused('LINE_SETTING_RANGE', 'the stored bar.dryRunReview setting is malformed; restore its recorded board value before changing policy'); }
  if (typeof value !== 'boolean' && value !== 'ab') throw new Refused('LINE_SETTING_RANGE', 'the stored bar.dryRunReview setting is not off, on or ab; restore its recorded board value before changing policy');
  return value;
}

/**
 * The arm an item receives: null when the setting is off, 'on' when on, and under ab 'on' for an even item id and 'off' for an odd one.
 * Why: the id alone decides, so a replay or a second look assigns the same arm with no stored coin flip.
 */
export function dryRunReviewArm(mode, id) {
  if (mode === false) return null;
  if (mode === true) return 'on';
  return Number(id) % 2 === 0 ? 'on' : 'off';
}

/** The "edge cases:" line of a builder's bar-check note, or null when none was recorded. */
function noteEdgeCases(note) {
  return /^\s*edge cases:\s*(\S.*)$/imu.exec(String(note?.text ?? ''))?.[1].trim() ?? null;
}

/**
 * The lines a verifier will walk: every bar clause, the bar-check edge cases, and the test that must fail without the fix.
 * Why: a builder who reads the checklist first fixes what the verifier would reject; it is advice, never a verdict, and calls no model.
 */
export function dryRunReviewChecklist({ id, clauses, criterion, barNote = null }) {
  const lines = [`dry-run review for #${id}: the checklist a verifier walks; advisory, not a verdict, and no model is called`];
  lines.push('bar clauses:');
  if (clauses.length) for (const clause of clauses) lines.push(`  ${clause.number}. ${clause.text}`);
  else lines.push(`  ${String(criterion ?? '').trim() || 'the item has no criterion'}`);
  const edge = noteEdgeCases(barNote);
  lines.push('bar-check edge cases:', edge ? `  ${edge}` : `  none recorded; name them with pullboard fact ${id} bar-check "bar: ...\\nedge cases: ...\\ntest: ..."`);
  const tests = clauses.filter(clause => clause.kind === 'test').map(clause => clause.number);
  lines.push('a test that fails without the fix:', tests.length
    ? `  clause${tests.length > 1 ? 's' : ''} ${tests.join(', ')} ${tests.length > 1 ? 'each need' : 'needs'} a test that fails on main and passes with your change`
    : '  name the test that fails on main and passes with your change, or say why none can');
  return lines;
}
