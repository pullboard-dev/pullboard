/** A three-replica submit whose gate-offer reply is lost, leaving a runner job row and no hand-off record [C7,P7,#9740]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RUNS_STORE_KEY } from '../../../../../../packages/store/index.js';
import { cli } from '../client-harness.js';
import { cliResult } from '../client-harness.js';
import { assertDroppedReplyConsumed } from './policy.js';
import { enterLegacyAckPolicy } from './policy.js';

/**
 * Submit one claimed item on clone A's worktree with the relay dropping the reply of the submit's gate-offer note, so the
 * gate job is offered and the note is not delivered. Why a helper of its own: client-harness.js is at its size cap, and the
 * lost add reply it already recovers is the same fault around a different move.
 *
 * @param {object} fixture - A threeReplicaFixture.
 * @param {{ begin: Function, wait: Function }} timing - Its phase capture.
 * @returns {Promise<{ item: number, job: string }>} The submitted item and the gate job the lost offer names.
 */
export async function lostGateOffer(fixture, timing) {
  const { scratch, clones, worktrees, envs, gitAt, commonDir, relay, key, boardId, replicaFiles } = fixture;
  timing.begin('lost gate offer', 'submit one item whose gate-offer reply is dropped and keep the offered job row');
  await timing.wait('establish the legacy approval baseline before the lost offer', () => cli(clones[0], envs[0], 'shout', 'all', 'Legacy board ready for a lost gate offer'));
  const restoreOutboxDefault = await enterLegacyAckPolicy(fixture);
  const brief = join(scratch, 'lost-offer-brief.md');
  writeFileSync(brief, 'Files: web/\nTest: a lost gate-offer reply leaves the offered job row.\n');
  const item = (await timing.wait('add the lost-offer item', () => cli(clones[0], envs[0], 'add', 'web', 'Relay lost gate offer', '--route', 'mid', '--brief-file', brief, '--specs', 'G1', '--criterion', 'a lost gate-offer reply leaves the job row to recover from', '--check', 'true'))).item.item_id;
  await timing.wait('claim the lost-offer item on worktree A', () => cli(worktrees[0], envs[0], 'claim', String(item)));
  writeFileSync(join(worktrees[0], 'web', 'lost-offer.txt'), 'the lost-offer candidate\n');
  gitAt(worktrees[0], envs[0], 'add', 'web/lost-offer.txt');
  gitAt(worktrees[0], envs[0], 'commit', '-q', '-m', 'test: create the lost-offer candidate [G1]');
  // The offered job lives in the runs store, as it does on a board that has it on.
  const meta = new DatabaseSync(replicaFiles[0]);
  try { meta.prepare('INSERT OR REPLACE INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run(RUNS_STORE_KEY, '1'); } finally { meta.close(); }
  relay.dropNextReply({ offline: true, operation: 'appendFact', item, key, boardId });
  const lost = await timing.wait('submit the lost-offer item with its offer reply dropped', () => cliResult(worktrees[0], envs[0], 'submit', String(item), '--no-next'));
  assertDroppedReplyConsumed(relay, 'the lost gate-offer reply');
  assert.equal(lost.status, 1);
  assert.equal(lost.document.error.code, 'RELAY_UNAVAILABLE');
  const note = JSON.parse(readFileSync(join(commonDir(clones[0], envs[0]), 'pullboard', 'relay.json'), 'utf8')).pending?.move;
  const job = /^Gate job (\S+) offered for /u.exec(note?.args?.[1]?.text ?? '')?.[1];
  assert.ok(job, `the pending note names the gate job: ${JSON.stringify(note?.args?.[1]?.text)}`);
  relay.failReads(false);
  await restoreOutboxDefault();
  return { item, job };
}
