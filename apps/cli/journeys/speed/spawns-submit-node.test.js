/**
 * One submit on the large board starts no more node child processes than the measured count, and the count may only go
 * down [C7]. Why: each node child costs about 87 ms of startup, so the count is the ratchet under #5330's resident-check cuts.
 * The submit runs in this process through the production dispatch and the child-process calls are counted as they are made.
 */
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';
import { test } from 'node:test';
import { largeBoard } from '../../tests/fixtures/board/large.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';
import { fixtureProjectPolicy } from '../../../../packages/gate/tests/fixtures/testkit.js';

/** The most node children one submit may start (measured 15 as a real process on a runner, run 24f644ad-2b8c-4371-8027-133dc148f7e4, recorded on #10274). */
const MEASURED_NODE_SPAWNS = 15;
const APIS = ['spawnSync', 'execFileSync', 'execSync', 'spawn', 'execFile', 'exec', 'fork'];

/** Run `work` while counting the child processes it starts whose executable is node; the calls themselves run unchanged. */
async function countNodeChildren(work) {
  const real = Object.fromEntries(APIS.map(api => [api, childProcess[api]]));
  const seen = { node: 0, other: 0 };
  for (const api of APIS) {
    childProcess[api] = function counted(...args) {
      const command = typeof args[0] === 'string' ? args[0].trim().split(/\s+/u)[0] : '';
      seen[api === 'fork' || basename(command) === 'node' ? 'node' : 'other'] += 1;
      return real[api].apply(this, args);
    };
  }
  syncBuiltinESMExports();
  try { await work(); } finally {
    Object.assign(childProcess, real);
    syncBuiltinESMExports();
  }
  return seen;
}

test(`clause 1: one submit on the large board starts at most ${MEASURED_NODE_SPAWNS} node child processes [C7]`, async (t) => {
  const box = largeBoard(t);
  // Pullboard's own static checker is the configured check, so submit's preflight starts its node children as it does on this repo.
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  fixtureProjectPolicy(box.repo, { config: { ...config, staticChecks: 'node --experimental-vm-modules apps/cli/src/io/static/checks.js' } });
  runFixtureGit(['add', '-A'], { cwd: box.repo, env: box.env });
  runFixtureGit(['commit', '-q', '-m', 'chore: use the own static checker'], { cwd: box.repo, env: box.env });
  runFixtureGit(['merge', '-q', '--ff-only', 'main'], { cwd: box.web, env: box.env });
  const id = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Node spawns', diagnose: false, args: ['--specs', 'G1'] }).item_id;
  const claim = await box.runIn(box.web, 'claim', String(id), '--json');
  assert.equal(claim.code, 0, claim.err + claim.out);
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web', 'node-spawns.js'), 'export const spawns = 1;\n');
  runFixtureGit(['add', '-A'], { cwd: box.web, env: box.env });
  runFixtureGit(['commit', '-q', '-m', 'feat(web): node spawns [G1]'], { cwd: box.web, env: box.env });
  let submit;
  const counts = await countNodeChildren(async () => { submit = await box.runIn(box.web, 'submit', String(id), '--no-next'); });
  assert.equal(submit.code, 0, submit.err + submit.out);
  console.log(`# SUBMIT node spawns ${counts.node} (other ${counts.other})`);
  assert.ok(counts.node >= 1, 'the counter saw no node child, so it is not counting');
  assert.ok(counts.node <= MEASURED_NODE_SPAWNS, `a submit started ${counts.node} node children, over the ${MEASURED_NODE_SPAWNS} allowed`);
});
