import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { toolingIsPinned } from '../../../../packages/gate/index.js';
import { warmAcceptedCells } from '../../../../packages/gate/index.js';
import { withMainCheckout } from '../../../../packages/landing/index.js';
import { withFileLock } from '../../../../packages/outbox/index.js';

/**
 * Produce the accepted inventory with the pinned commit's own tooling. When this process runs another snapshot of the
 * tooling (the seat that nudged it), re-run the main-audit entry from a checkout of the pinned commit, so the recorded
 * checker and preload fingerprints are the pinned main's whichever seat started the producer.
 * It lives here, not in bin/main-audit.js, so the bin file stays a thin process entry [C7].
 * @param {string} root absolute repository root
 * @param {string} token native UUID token the entry was started with
 * @param {string} commit the pinned commit to produce for
 * @returns {Promise<unknown>} the warm result, or the re-run result
 */
export async function produceAcceptedCells(root, token, commit) {
  if (toolingIsPinned(root, commit)) return warmAcceptedCells(root, commit, { withCheckout: withMainCheckout, withLock: withFileLock });
  if (process.env.PULLBOARD_CELLS_PINNED === commit) throw new Error('the pinned checkout did not carry the pinned tooling');
  const ran = await withMainCheckout(root, commit, checkout => spawnSync(process.execPath,
    [join(checkout, 'bin/main-audit.js'), root, token, '--cells-only', commit],
    { cwd: checkout, env: { ...process.env, PULLBOARD_CELLS_PINNED: commit }, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] }));
  if (ran?.unavailable || ran?.status !== 0) throw new Error(ran?.unavailable ?? `accepted cells producer failed in the pinned checkout: ${String(ran?.stderr ?? '').split('\n').filter(line => /Error/u.test(line)).slice(0, 2).join(' ').slice(0, 600)}`);
  return ran;
}
