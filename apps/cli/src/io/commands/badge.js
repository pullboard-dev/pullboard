/** Publish board-derived badge endpoint documents in any Pullboard project [B3,V1]. */
import { badgeCounts } from '../../../../view/index.js';
import { writeBadges } from '../../../../view/index.js';
import { context } from '../entry.js';
import { withBoardRead } from '../entry.js';
import { Refused } from '../../../../../packages/kernel/index.js';

/** Run `pullboard badge` without modifying the board or contacting a badge service. */
export function run(io, { first }) {
  if (first) throw new Refused('USAGE', 'pullboard badge takes no arguments');
  const ctx = context(io);
  const counts = withBoardRead(ctx, badgeCounts);
  const changed = writeBadges(ctx.info.root, counts);
  io.result?.({ ...counts, changed });
  if (!counts.items) io.say('No finished items yet; no badge files were written.');
  else io.say(`${counts.items} items; ${counts.percent}% agent-verified. ${changed.length ? `Wrote ${changed.join(' and ')}.` : 'Badge files are unchanged.'}`);
  return 0;
}
