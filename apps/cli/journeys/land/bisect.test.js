/** Independently schedule the real red landing bisection [B3,R3,E8]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { waitForFixtureProgress } from '../../tests/fixtures/progress.js';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../tests/fixtures/land/project.js';
import { settleLand } from '../../tests/fixtures/land/settle.js';
import {
  calls,
  json,
} from '../../tests/fixtures/land/board.js';
/**
 * Wait until no process of this fixture is still running. Why: a landing leaves finishing work behind (audits, workers)
 * that runs a gate and takes a lease on its own clock, so counts read before it ends differ by load.
 */
async function drainOwnedProcesses(directory) {
  const owned = () => spawnSync('pgrep', ['-f', directory], { encoding: 'utf8' }).stdout.trim();
  let last = owned(), changes = 0;
  /** Count every change in the owned pid set: a finishing process shrinks it, and that is progress too. */
  const progress = () => { const now = owned(); if (now !== last) { last = now; changes += 1; } return changes; };
  try {
    await waitForFixtureProgress({ child: { exitCode: null, signalCode: null }, ready: () => owned() === '',
      progress, description: 'fixture processes finishing', quietMs: 60_000 });
  } catch (error) {
    const pids = owned().split('\n').filter(Boolean).join(',');
    const listing = pids ? spawnSync('ps', ['-o', 'pid=,ppid=,etime=,command=', '-p', pids], { encoding: 'utf8' }).stdout : '';
    throw new Error(`${error.message}; still running:\n${listing}`, { cause: error });
  }
}

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { commitFile } = e2e;
const { FILES, landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures(e2e);

test('land bisects a real red, blocks stale proof and refuses an unverified stack [B3,R3,E8]', async () => {
  const box = landProject();
  box.env.LAND_SUPPRESS_RED = '1';
  const entries = FILES.map((file, index) => itemWorktree(box, index + 1, file));
  for (const entry of entries.slice(0, 3)) submitItem(box, entry, entry === entries[2] ? 'RED\n' : 'PASS\n');
  const hidden = itemWorktree(box, 5, 'web/unverified.js');
  assert.equal(commitFile(box, hidden.path, hidden.file, '// unverified\n', 'feat(web): unverified ancestor [G1]').status, 0);
  const hiddenSha = box.git(hidden.path, 'rev-parse', 'HEAD');
  box.git(entries[3].path, 'merge', '--no-ff', hiddenSha, '-m', 'feat(web): include ancestor [G1]');
  submitItem(box, entries[3]);
  for (const entry of entries) acceptItem(box, entry);
  assert.equal((await box.runLocal(hidden.path, 'submit', String(hidden.item), '--no-next')).code, 0);
  delete box.env.LAND_SUPPRESS_RED;
  assert.equal(commitFile(box, box.repo, FILES[1], 'different main content\n', 'chore: create a merge conflict').status, 0);
  const base = box.git(box.repo, 'rev-parse', 'main');
  await drainOwnedProcesses(box.dir); // A submit's finishing gate writes its event on its own clock, so count only after it ends.
  const beforeCalls = calls(box).length;
  const result = await settleLand(box, json(box, box.repo, 'land'));
  assert.deepEqual(result.landed, [entries[0].item]);
  // The pulled land returns the stale accept to its lane before it offers the job; the unverified stack never gets in.
  assert.equal(json(box, box.repo, 'show', String(entries[1].item)).item_status, 'open', 'the stale accept is withdrawn and the item reopens');
  assert.ok(json(box, box.repo, 'show', String(entries[1].item)).thread.some(entry => /verdict stale: web\/land-2\.test\.js changed on main/u.test(entry.text ?? '')), 'the builder is told why');
  assert.deepEqual(result.returned.map(row => [row.id, row.reason]), [[entries[2].item, 'red']], 'the red item is the culprit, named by the receipt');
  assert.ok(String(result.landJob.receipt.returned[0].detail).includes(FILES[2]), 'the receipt names the failing file');
  assert.ok(json(box, box.repo, 'show', String(entries[2].item)).thread.some((entry) => entry.type === 'fact' && entry.text.includes(FILES[2])));
  assert.ok(calls(box).length > beforeCalls, 'the lander ran its gate');
  assert.equal(json(box, box.repo, 'show', String(entries[0].item)).item_merged_commit, result.batch.tip);
  for (const entry of entries.slice(1)) assert.equal(json(box, box.repo, 'show', String(entry.item)).item_merged_commit, null);
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), result.batch.tip);
  assert.notEqual(result.batch.tip, base);
  await drainOwnedProcesses(box.dir);
  const afterCalls = calls(box).length;
  const again = await box.runLocal(box.repo, 'land', '--json');
  assert.ok(!again.out.includes('STALE_VERDICT'), `the stale accept was returned, so no stale refusal remains: ${again.out}`);
  assert.equal(json(box, box.repo, 'show', String(entries[2].item)).item_status, 'open', 'the known red is returned to its builder and is no longer a verified landing candidate');
  assert.equal(calls(box).length, afterCalls, 'known unchanged red is not retried');
  await drainOwnedProcesses(box.dir); // Nothing may still write into the fixture when cleanup removes it.
});
