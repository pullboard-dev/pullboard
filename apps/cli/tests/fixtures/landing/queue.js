import { FIXTURE_GATE_DISPATCH } from '../testkit.js';
import { fixtureMachineSettings } from '../testkit.js';
import { fixtureProjectPolicy } from '../testkit.js';
/** Public, real-Git landing contention fixture; no private drill data is used [B3,R3,Q1,Q2,E8]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { makeLandProjectFixtures } from '../land/project.js';
import { calls as landCalls } from '../land/board.js';
import { landJobs } from '../land/board.js';
import { settleLand } from '../land/settle.js';

/** Run an ordinary fixture command and retain its full refusal on failure. */
function run(box, root, ...args) {
  const result = box.run(root, ...args);
  const observation = result.code !== 0 && result.err.includes('[LAND_ITEM_MOVED]')
    ? readBoard(box, board => store.landingBatches(board).map(batch => ({
      id: batch.id, state: batch.state,
      items: batch.items.map(entry => {
        const item = store.getItem(board, entry.id);
        return { entry, status: item.item_status, commit: item.item_commit,
          checked: store.checkedLandingCommit(board, item),
          accepted: store.acceptedVerdict(board, item),
          sourceAdvance: board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?')
            .get(`item_source_advance:${entry.id}`)?.meta_value ?? null };
      }),
    }))) : null;
  assert.equal(result.code, 0, `${args.join(' ')}: ${result.err}\n${result.out}${observation ? '\npublication observation: ' + JSON.stringify(observation) : ''}`);
  return result.out;
}

/** Read the real board, always closing its SQLite handle. */
function readBoard(box, action) {
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try { return action(board); }
  finally { store.closeBoard(board); }
}








/**
 * The freshness variant on pull: two accepted items, the second changing the first's checked file; the second lands
 * alone (the first held), moving main under the first's verdict, and the next land reopens the first to its lane with
 * STALE_VERDICT and offers no land job for it. Hooks, seats, submits, verdicts and lands run in process [B3,C7,#10412].
 */
async function pulledFreshnessCase(helpers) {
  const { landProject, itemWorktreeLocal, commitItemLocal, submitItemLocal, acceptItemLocal, FILES } = makeLandProjectFixtures(helpers);
  const box = landProject();
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { test: { inProcessHooks: true }, gate: FIXTURE_GATE_DISPATCH });
  const first = await itemWorktreeLocal(box, 1);
  const second = await itemWorktreeLocal(box, 2);
  await commitItemLocal(box, first);
  // The second item changes the first's checked file on its own branch, so its landing makes the first verdict stale.
  mkdirSync(join(second.path, 'web'), { recursive: true });
  writeFileSync(join(second.path, FILES[0]), '// PASS changed\n');
  await commitItemLocal(box, second);
  for (const entry of [first, second]) await submitItemLocal(box, entry);
  for (const entry of [first, second]) await acceptItemLocal(box, entry);
  // Only the second lands now; the first keeps its accept behind a hold.
  readBoard(box, board => store.holdItem(board, first.item, { agentId: 'coordinator', reason: 'land the second item first' }));
  const offer = await box.runIn(box.repo, 'land', '--json');
  assert.equal(offer.code, 0, `land --json: ${offer.err}\n${offer.out}`);
  const landed = await settleLand(box, JSON.parse(offer.out));
  assert.deepEqual(landed.landed, [second.item], JSON.stringify(landed));
  readBoard(box, board => store.releaseItemHold(board, first.item, { agentId: 'coordinator' }));
  const jobs = landJobs(box).length;
  const again = await box.runIn(box.repo, 'land');
  assert.equal(again.code, 0, again.err + again.out);
  assert.match(again.out + again.err, /STALE_VERDICT #\d+ reopened to its lane/u);
  assert.equal(readBoard(box, board => store.getItem(board, first.item).item_status), 'open', 'the stale item left verified for its lane');
  assert.equal(readBoard(box, board => store.getItem(board, first.item).item_merged_commit), null);
  assert.equal(landJobs(box).length, jobs, 'a stale verdict starts no land job');
}

/** The gate arguments each offered land job carries, read from its offered step, in offer order. */
function offeredLandChecks(box) {
  return readBoard(box, board => board.db.prepare("SELECT job_step_payload AS payload FROM job_step JOIN job ON job_id = job_step_job WHERE job_kind = 'land' AND job_step_name = 'offered' ORDER BY job_created, job_id").all()
    .map(row => JSON.parse(row.payload).payload?.check ?? null));
}

/**
 * The admitted-policy variant on pull: the second item changes the project's gate args and lands first, on the policy
 * main accepted before it; the first item's land job, offered after, checks with the new args main now holds. Why: the
 * pulled land check is fixed at offer time from main's policy, so an item never judges itself by the policy it brings [Q1,B3,C7].
 */
async function pulledPolicyCase(helpers) {
  const { landProject, itemWorktreeLocal, commitItemLocal, submitItemLocal, acceptItemLocal } = makeLandProjectFixtures(helpers);
  const box = landProject();
  // The project's own gate judges each land job (no affectedTests ledger proof), and the web lane owns its config.
  const configPath = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  delete config.affectedTests;
  config.lanes.web.owns.push('pullboard.json');
  fixtureProjectPolicy(box.repo, { config });
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: the project gate judges landings');
  box.git(box.repo, 'push', '-q', 'origin', 'main');
  // In-process seats, claims, submits and verdicts: a node start-up per step was most of this case's time [B3].
  const first = await itemWorktreeLocal(box, 1);
  const second = await itemWorktreeLocal(box, 2);
  const itemConfig = JSON.parse(readFileSync(join(second.path, 'pullboard.json'), 'utf8'));
  fixtureProjectPolicy(second.path, { config: { ...itemConfig, gate: itemConfig.gate + ' --new-policy' } });
  await Promise.all([first, second].map(entry => commitItemLocal(box, entry)));
  for (const entry of [first, second]) await submitItemLocal(box, entry);
  for (const entry of [first, second]) await acceptItemLocal(box, entry);
  // The submit gates also ran the gate; only the land jobs' runs count from here.
  writeFileSync(box.calls, '');
  readBoard(box, board => store.holdItem(board, first.item, { agentId: 'coordinator', reason: 'land the policy change first' }));
  const landed = await settleLand(box, JSON.parse(run(box, box.repo, 'land', '--json')));
  assert.deepEqual(landed.landed, [second.item], JSON.stringify(landed));
  assert.match(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'), /--new-policy/u, 'main now holds the new gate args');
  readBoard(box, board => store.releaseItemHold(board, first.item, { agentId: 'coordinator' }));
  const after = await settleLand(box, JSON.parse(run(box, box.repo, 'land', '--json')));
  assert.deepEqual(after.landed, [first.item], JSON.stringify(after));
  const gate = config.gate.trim();
  assert.deepEqual(offeredLandChecks(box), [['sh', '-c', gate], ['sh', '-c', `${gate} --new-policy`]], 'each land job carries the gate main accepted when it was offered');
  const calls = landCalls(box).filter(args => !args.includes('--alone'));
  assert.deepEqual(calls, [[], ['--new-policy']], 'the policy change lands on the old args; the next land job ran the new ones');
}

/** Prove named waiting, exclusion and verdict order with two real overlapping land commands. */
export async function landingQueueCase(t, helpers, { staleAfterFirst = false, policyAfterFirst = false } = {}) {
  // Freshness survives under pull: the land offer rechecks each verdict against the main it lands onto [B3,C7].
  if (staleAfterFirst) return pulledFreshnessCase(helpers);
  if (policyAfterFirst) return pulledPolicyCase(helpers);
}
