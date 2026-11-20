/** The pullboard cells command: each cell sealed or unsealed, and the commit that broke an unsealed one, read-only [C7,SC1,SC16]. */
import { sealedCells } from '../../../../../packages/gate/heavy.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { context } from '../context.js';

/**
 * Run `pullboard cells [--json]` and return its exit code.
 * Why read-only: a seal is a recorded verdict at a content hash; the listing only shows which cells hold one at HEAD.
 */
export function run(io, { first, second, rest, values }) {
  if (first || second || rest.length || Object.keys(values).some(key => key !== 'json')) {
    throw new Refused('USAGE', 'cells takes no arguments', 'pullboard cells [--json]');
  }
  const cells = sealedCells(context(io).info.root).map(row => ({
    cell: row.package, hash: row.hash, state: row.sealed ? 'sealed' : 'unsealed', receipts: row.receipts, sealedAt: row.sealedAt,
    changedBy: row.change?.commit ?? null, changedSubject: row.change?.subject ?? null,
  }));
  io.result?.({ cells, unsealed: cells.filter(row => row.state === 'unsealed').map(row => row.cell) });
  if (!cells.length) io.say('no cells');
  for (const row of cells) {
    const detail = row.state === 'sealed' ? `by ${row.receipts.join(', ')}` : row.changedBy ? `broken by ${row.changedBy.slice(0, 12)} ${row.changedSubject}` : 'no change found in the recent history';
    io.say(`${row.cell}  ${row.state}  ${row.hash.slice(0, 12)}  ${detail}`);
  }
  return 0;
}
