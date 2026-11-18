/** A dry run of census skip-unchanged: which files two census outputs and the commits between them would skip, run nothing [C7,#10379]. */
import { readFileSync } from 'node:fs';
import { selectAffectedTests } from '../../../../../packages/gate/index.js';
import { skipSplit } from '../../logic/census-skip.js';

/** The rows of one census JSONL, skipping blank or garbled lines. */
function readRows(path) {
  return readFileSync(path, 'utf8').split('\n').flatMap((line) => { try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; } });
}

/**
 * Read the earlier and later census outputs and select the tests the commits between their shas affect (the declared
 * U149 inputs feed that selection); report which of the later census's files have an earlier green row and no changed input.
 *
 * @param {string} root - A checkout of the repository both shas belong to.
 * @param {{ previous: string, current: string }} outputs - Paths of the two census JSONL files.
 * @returns {ReturnType<typeof skipSplit> & { from: string, to: string }}
 */
export function dryRunSkip(root, { previous, current }) {
  const before = readRows(previous), after = readRows(current);
  const from = before[0]?.sha, to = after[0]?.sha;
  const selection = from && to ? selectAffectedTests(root, { base: from, commit: to }) : { full: true, reason: 'a census output holds no rows', files: [] };
  return { ...skipSplit({ files: after.map(row => row.file), previousRows: before, selection }), from: from ?? '', to: to ?? '' };
}
