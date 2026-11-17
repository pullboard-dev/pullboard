/**
 * One submit on the large board starts no more node child processes than the measured count, and the count may only go
 * down [C7]. Why: each node child costs about 87 ms of startup, so the count is the ratchet under #5330's resident-check cuts.
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { largeBoard } from '../../tests/fixtures/board/large.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';
import { fixtureProjectPolicy } from '../../../../packages/gate/tests/fixtures/testkit.js';
import { spawnCounts } from '../../tests/fixtures/spawns.js';
import { spawnEnv } from '../../tests/fixtures/spawns.js';
import { PULLBOARD_ENTRY } from '../../src/io/resident/client.js';
import { residentPoolSize } from '../../src/io/resident/client.js';
import { residentSocket } from '../../src/io/resident/client.js';

/** The most node children one submit may start (measured on a runner; run id on #10274). */
const MEASURED_NODE_SPAWNS = 40;

/** Stop every resident board process this board started, so the sandbox can be removed. */
function stopResidents(repo) {
  for (let slot = 0; slot < residentPoolSize({}); slot += 1) {
    const place = residentSocket(repo, PULLBOARD_ENTRY, slot);
    if (!place) continue;
    try { process.kill(Number(readFileSync(place.pid, 'utf8').trim()), 'SIGKILL'); } catch { /* None started, or it already exited. */ }
  }
}

test(`clause 1: one submit on the large board starts at most ${MEASURED_NODE_SPAWNS} node child processes [C7]`, (t) => {
  const box = largeBoard(t);
  box.beforeCleanup(() => stopResidents(box.repo));
  for (const name of ['NODE_TEST_CONTEXT', 'NODE_TEST_WORKER_ID']) delete box.env[name];
  const log = join(box.dir, 'spawns.log');
  // Pullboard's own static checker is the configured check, so submit's preflight starts its node children as it does on this repo.
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  fixtureProjectPolicy(box.repo, { config: { ...config, staticChecks: 'node --experimental-vm-modules apps/cli/src/io/static/checks.js' } });
  runFixtureGit(['add', '-A'], { cwd: box.repo, env: box.env });
  runFixtureGit(['commit', '-q', '-m', 'chore: use the own static checker'], { cwd: box.repo, env: box.env });
  runFixtureGit(['merge', '-q', '--ff-only', 'main'], { cwd: box.web, env: box.env });
  const id = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Node spawns', diagnose: false, args: ['--specs', 'G1'] }).item_id;
  box.run(box.web, 'status', '--json'); // real process: this test measures real spawns
  const claim = box.run(box.web, 'claim', String(id), '--json'); // real process: this test measures real spawns
  assert.equal(claim.code, 0, claim.err + claim.out);
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web', 'node-spawns.js'), 'export const spawns = 1;\n');
  runFixtureGit(['add', '-A'], { cwd: box.web, env: box.env });
  runFixtureGit(['commit', '-q', '-m', 'feat(web): node spawns [G1]'], { cwd: box.web, env: box.env });
  Object.assign(box.env, spawnEnv(log), { PULLBOARD_RESIDENT: '1' });
  writeFileSync(log, '');
  const submit = box.run(box.web, 'submit', String(id), '--no-next'); // real process: this test measures real spawns
  assert.equal(submit.code, 0, submit.err + submit.out);
  const counts = spawnCounts(log);
  console.log(`# SUBMIT node spawns ${counts.node} (git ${counts.git}, other ${counts.other})`);
  assert.ok(counts.node >= 1, 'the spawn logger saw no node child, so it is not counting');
  assert.ok(counts.node <= MEASURED_NODE_SPAWNS, `a submit started ${counts.node} node children, over the ${MEASURED_NODE_SPAWNS} allowed`);
});
