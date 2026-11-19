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

/** The most node children one submit may start (measured 15 on a runner, run a738b961-6010-4c28-bb75-1b9f9b65f0fe, recorded on #10274). */
const MEASURED_NODE_SPAWNS = 15;
const APIS = ['spawnSync', 'execFileSync', 'execSync', 'spawn', 'execFile', 'exec', 'fork'];

/** The argv of a counted child: the command and its arguments, whether given as a string or as a command plus an array. */
function argvOf(api, args) {
  if (api === 'fork') return [process.execPath, String(args[0]), ...(Array.isArray(args[1]) ? args[1].map(String) : [])];
  const words = typeof args[0] === 'string' ? args[0].trim().split(/\s+/u) : [];
  return Array.isArray(args[1]) ? [...words, ...args[1].map(String)] : words;
}

/** Sort one node child by its argv into the purpose that started it, or `other` named by its first words. */
function purposeOf(argv) {
  const text = argv.join(' ');
  if (text.includes('changedStaticFailures')) return 'preflight check';
  if (text.includes('STATIC_CHECKS.map')) return 'preflight list';
  if (/pullboard\.js\s+hook\s/u.test(text)) return 'hook shim';
  if (/(^|[\s/])hooks?(\.js|\s|\/)/u.test(text)) return 'hook';
  if (/io\/sender\.js/u.test(text)) return 'sender worker';
  if (/drive\/|dispatch/u.test(text)) return 'dispatcher';
  if (/codemap\/|parser\.js|imports\.js/u.test(text)) return 'codemap parser';
  return 'other';
}

/** Run `work` while counting the child processes it starts whose executable is node, by purpose; the calls themselves run unchanged. */
async function countNodeChildren(work) {
  const real = Object.fromEntries(APIS.map(api => [api, childProcess[api]]));
  const seen = { node: 0, other: 0, purposes: {}, unsorted: [] };
  for (const api of APIS) {
    childProcess[api] = function counted(...args) {
      const argv = argvOf(api, args);
      if (api === 'fork' || basename(argv[0] ?? '') === 'node') {
        seen.node += 1;
        const purpose = purposeOf(argv);
        seen.purposes[purpose] = (seen.purposes[purpose] ?? 0) + 1;
        if (purpose === 'other') seen.unsorted.push(argv.slice(1, 4).join(' '));
      } else seen.other += 1;
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

/** The counts of the one submit the first case runs, for the case that checks they add up. */
let measured = null;

test('cli.journeys-speed-spawns-submit-node.one-submit-on-the-large-board: clause 1: [C7] one submit on the large board starts at most ' + MEASURED_NODE_SPAWNS + ' node child processes', async (t) => {
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
  measured = counts;
  console.log(`# SUBMIT node spawns ${counts.node} (other ${counts.other})`);
  const order = ['preflight check', 'preflight list', 'hook shim', 'hook', 'sender worker', 'dispatcher', 'codemap parser', 'other'];
  console.log(`# SUBMIT node spawns by purpose: ${order.map(name => `${name}=${counts.purposes[name] ?? 0}`).join(', ')}`);
  for (const words of counts.unsorted) console.log(`# SUBMIT node spawn other: ${words}`);
  assert.ok(counts.node >= 1, 'the counter saw no node child, so it is not counting');
  assert.ok(counts.node <= MEASURED_NODE_SPAWNS, `a submit started ${counts.node} node children, over the ${MEASURED_NODE_SPAWNS} allowed`);
});

test('cli.journeys-speed-spawns-submit-node.purposes-add-up-to-the-total: clause 2: [C7] the per-purpose counts add up to the node child total the journey asserts', () => {
  assert.ok(measured, 'the submit case ran first and recorded its counts');
  const sum = Object.values(measured.purposes).reduce((total, count) => total + count, 0);
  assert.equal(sum, measured.node, 'every counted node child is sorted into exactly one purpose');
});
