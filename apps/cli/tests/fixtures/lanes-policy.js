/** Shared lane-policy fixtures: real board, frozen ownership and plan-row submissions for the lanes journeys [L2,L3,V2,V4]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createE2eHelpers } from './e2e.js';
import { fixtureAdd } from './testkit.js';
import { whenRunnerSettles } from './runner/local-start.js';
import { publishAcceptedCells } from '../../../../packages/landing/tests/fixtures/plan.js';
import { fixtureProjectPolicy } from './testkit.js';

export const policyFixtures = createE2eHelpers();

/**
 * Assert a green submit routed only foreign paths to their owner: the builder is freed and nothing is submitted (B3,L1,V4).
 *
 * Why: ownership routing (814a7def2a) replaced the immediate OUTSIDE_LANE refusal for proved foreign paths; the owner decides.
 */
export async function assertWaitsOnOwner(box, id, submitted, owner, paths, label = '') {
  assert.equal(submitted.code, 0, `${label} ${submitted.out}${submitted.err}`);
  // The pulled gate's receipt is applied just after its job row closes, so settle on the routing event itself [P7].
  const item = await whenRunnerSettles(box.env, async () => {
    const row = JSON.parse((await box.runLocal(box.repo, 'show', String(id), '--json')).out);
    return row.item_hold_reason ? row : null;
  }, { deadlineMs: 120_000, what: `the owner routing of #${id} ${label}` });
  assert.equal(item.item_status, 'open', label);
  assert.equal(item.item_commit, null, `${label}: owner waiting is not a submission`);
  assert.match(item.item_hold_reason, /^waiting on ownership /u, label);
  const waiting = (item.thread ?? []).findLast(row => row.kind === 'ownership-wait')?.detail;
  assert.ok(waiting, `${label}: the thread records the ownership wait`);
  assert.deepEqual(waiting.owners, [owner], label);
  for (const path of paths) assert.equal(waiting.paths.includes(path), true, `${label} ${path}`);
  return waiting;
}

/** Claim a real item before the coordinator moves one API path into its web lane. */
export async function reassignedPathFixture() {
  const box = policyFixtures.project('true');
  mkdirSync(join(box.repo, 'api'));
  writeFileSync(join(box.repo, 'api/shared.js'), 'original\n');
  box.git(box.repo, 'add', 'api/shared.js');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: create coordinator fixture path');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'Update reassigned path', '--specs', 'G1',
    '--criterion', 'the reassigned path has the new content', '--check', 'true', '--route', 'strong');
  assert.equal(added.code, 0, added.err);
  const claimed = await box.runLocal(box.web, 'claim', '1');
  assert.equal(claimed.code, 0, claimed.err);
  const before = JSON.parse((await box.runLocal(box.web, 'show', '1', '--json')).out);
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  config.lanes.web.owns.push('api/shared.js');
  fixtureProjectPolicy(box.repo, { config });
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: reassign fixture path to web');
  const trunkPolicy = box.git(box.repo, 'rev-parse', 'HEAD');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const committed = policyFixtures.commitFile(box, box.web, 'api/shared.js', 'changed\n',
    'feat(web): update reassigned fixture path [G1]');
  assert.equal(committed.status, 0, committed.failure ?? committed.stderr);
  return { box, before, trunkPolicy };
}

/** A web item that merged main, after which main changed the same foreign file again. */
export async function mergedMainFixture(title) {
  const box = policyFixtures.project('true');
  assert.equal((await fixtureAdd(box.runLocal, box.repo, 'web', title, '--specs', 'G1', '--criterion', 'merge of main stays in lane', '--check', 'true', '--route', 'strong')).code, 0);
  assert.equal((await box.runLocal(box.web, 'claim', '1')).code, 0);
  assert.equal(policyFixtures.commitFile(box, box.web, 'web/index.html', 'own work\n', 'feat(web): own change [G1]').status, 0);
  assert.equal(policyFixtures.commitFile(box, box.repo, 'coordinator.txt', 'main one\n', 'chore: main change one').status, 0);
  box.git(box.web, 'merge', '-q', '--no-edit', 'main');
  assert.equal(policyFixtures.commitFile(box, box.repo, 'coordinator.txt', 'main two\n', 'chore: main change two').status, 0);
  return box;
}

/** Set up a real board and cells plan so submission exercises the frozen lane policy. */
export async function nativePlanRowFixture(t, { mainFile } = {}) {
  const box = policyFixtures.project('true');
  if (process.env.PULLBOARD_RUNNER_PRELOAD) box.env.PULLBOARD_RUNNER_PRELOAD = process.env.PULLBOARD_RUNNER_PRELOAD;
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  config.lanes.web.owns.push('src/');
  fixtureProjectPolicy(box.repo, { config });
  const indexPath = 'packages/codemap/data/plan/cells.json';
  const shardPath = 'packages/codemap/data/plan/01-x.json';
  const index = { version: 1, stays: [], cells: [{ file: shardPath, name: 'x', order: 1 }] };
  const shard = { order: 1, name: 'x', root: 'packages/x', paths: [], reexports: [], cuts: [] };
  mkdirSync(join(box.repo, 'packages/codemap/data/plan'), { recursive: true });
  mkdirSync(join(box.repo, 'src'), { recursive: true });
  if (mainFile) writeFileSync(join(box.repo, mainFile), 'export {};\n');
  writeFileSync(join(box.repo, indexPath), JSON.stringify(index, null, 2) + '\n');
  writeFileSync(join(box.repo, shardPath), JSON.stringify(shard, null, 2) + '\n');
  box.git(box.repo, 'add', 'pullboard.json', indexPath, shardPath, ...(mainFile ? [mainFile] : []));
  box.git(box.repo, 'commit', '-q', '-m', 'chore: seed native plan-row fixture');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  await publishAcceptedCells(t, box.repo, box.git(box.repo, 'rev-parse', 'main').trim(), box.env.PULLBOARD_MACHINE_HOME);
  return { box, shardPath };
}

/** Add and claim a real web item for native plan-row submission coverage. */
export async function nativePlanRowItem(box, title) {
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', title, '--specs', 'G1', '--criterion', 'the owned new file has a canonical plan row',
    '--check', 'true', '--route', 'strong', '--json');
  assert.equal(added.code, 0, added.err + added.out);
  const id = JSON.parse(added.out).item.item_id;
  const claimed = await box.runLocal(box.web, 'claim', String(id), '--json');
  assert.equal(claimed.code, 0, claimed.err + claimed.out);
  return id;
}

/** Commit the candidate's canonical plan row and retain item authorship in Git history. */
export function commitPlanRow(box, id, shardPath, source) {
  const shard = JSON.parse(readFileSync(join(box.web, shardPath), 'utf8'));
  shard.paths.push([source, `packages/x/src/core/${source.slice('src/'.length)}`, 'rule']);
  writeFileSync(join(box.web, shardPath), JSON.stringify(shard, null, 2) + '\n');
  box.git(box.web, 'add', shardPath);
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): place owned new file [G1]', '-m', `Pullboard-Item: #${id}`);
}
