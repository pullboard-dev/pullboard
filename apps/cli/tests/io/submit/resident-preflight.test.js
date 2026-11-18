/** @pullboard-test-input apps/cli/src/io/submit/preflight.js apps/cli/src/io/resident/calls.js apps/cli/src/io/resident/check-worker.js apps/cli/src/io/resident/client.js apps/cli/src/io/resident/board.js */
/**
 * With submit.residentChecks on, submit's preflight is answered by the resident board process and starts no node child,
 * with the findings it has with the setting off; with the setting off, or no resident process running, it starts its
 * children as before [C7,#5330]. The preflight runs in this process and the child-process calls are counted as made.
 */
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { waitForState } from '../../fixtures/check-baseline.js';
import { startFixtureResident } from '../../fixtures/resident.js';
import { stopFixtureResidents } from '../../fixtures/resident.js';
import { fixtureMachineSettings } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { runPreflight } from '../../../src/io/submit/preflight.js';
import { PULLBOARD_ENTRY } from '../../../src/io/resident/client.js';
import { residentSocket } from '../../../src/io/resident/client.js';

const CLEAN = ['packages/x/src/a.js'];
const REFUSED = ['packages/x/src/b.js', 'test/w.test.js'];
const APIS = ['spawnSync', 'execFileSync', 'execSync', 'spawn', 'execFile', 'exec', 'fork'];

/** Run `work` while counting the child processes it starts whose executable is node; the calls themselves run unchanged. */
async function countNodeChildren(work) {
  const real = Object.fromEntries(APIS.map(api => [api, childProcess[api]]));
  const seen = { node: 0 };
  for (const api of APIS) {
    childProcess[api] = function counted(...args) {
      const command = typeof args[0] === 'string' ? args[0].trim().split(/\s+/u)[0] : '';
      if (api === 'fork' || basename(command) === 'node') seen.node += 1;
      return real[api].apply(this, args);
    };
  }
  syncBuiltinESMExports();
  try { await work(); } finally {
    Object.assign(childProcess, real);
    syncBuiltinESMExports();
  }
  return seen.node;
}

/**
 * A committed project with one clean file and, uncommitted, a file with an empty catch and a test with a fixed wait. With
 * `running`, a resident board process serves its board.
 */
async function preflightProject(t, { running }) {
  const helpers = createE2eHelpers();
  const box = helpers.project('true');
  const saved = { home: process.env.PULLBOARD_MACHINE_HOME, resident: process.env.PULLBOARD_RESIDENT };
  t.after(() => {
    try { stopFixtureResidents(box.repo); } finally {
      for (const [name, value] of [['PULLBOARD_MACHINE_HOME', saved.home], ['PULLBOARD_RESIDENT', saved.resident]]) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
      helpers.cleanup();
    }
  });
  mkdirSync(join(box.repo, 'bin/checks'), { recursive: true });
  mkdirSync(join(box.repo, 'packages/gate/data/baselines'), { recursive: true });
  writeFileSync(join(box.repo, 'packages/gate/data/baselines/test-waits-baseline.json'), '{}');
  mkdirSync(join(box.repo, 'packages/x/src'), { recursive: true });
  writeFileSync(join(box.repo, 'packages/x/src/a.js'), 'export const a = 1;\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: base for the resident preflight');
  writeFileSync(join(box.repo, 'packages/x/src/b.js'), "import { b, c } from './b.js';\nexport function a() { try { b(); } catch {}\n}\n");
  mkdirSync(join(box.repo, 'test'), { recursive: true });
  writeFileSync(join(box.repo, 'test/w.test.js'), 'await new Promise(resolve => setTimeout(resolve, 500));\n');
  process.env.PULLBOARD_MACHINE_HOME = box.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_RESIDENT = '1';
  if (running) {
    await startFixtureResident(box);
  }
  return box;
}

/** Run the preflight in this process: the findings by check, and the node children it started. */
async function preflight(box, files, residentChecks) {
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { submit: { residentChecks } });
  let report;
  const nodeChildren = await countNodeChildren(async () => { report = await runPreflight(box.repo, files); });
  return { findings: report.results.map(({ name, failures }) => ({ name, failures })).sort((a, b) => a.name.localeCompare(b.name)), nodeChildren };
}

test('cli.io-submit-resident-preflight.with-submit-residentchecks-on-the-preflight-is: clause 1: with submit.residentChecks on, the preflight is answered by the resident process, starts no node child, and finds what it finds with the setting off, for a clean and a refused change [C7,#5330]', { timeout: 240_000 }, async (t) => {
  const box = await preflightProject(t, { running: true });
  for (const files of [CLEAN, REFUSED]) {
    const off = await preflight(box, files, false);
    const on = await preflight(box, files, true);
    assert.ok(off.nodeChildren > 0, 'the counter sees the children the setting-off preflight starts');
    assert.equal(on.nodeChildren, 0, `the resident process answered: no node child started for ${files.join(', ')}`);
    assert.deepEqual(on.findings, off.findings);
  }
  assert.ok((await preflight(box, REFUSED, true)).findings.some(row => row.failures.length), 'the refused change is refused');
  assert.ok((await preflight(box, CLEAN, true)).findings.every(row => !row.failures.length), 'the clean change is clean');
});

test('cli.io-submit-resident-preflight.with-submit-residentchecks-on-and-no-resident: clause 1: with submit.residentChecks on and no resident process running, the preflight falls back to its children and finds the same [C7,#5330]', { timeout: 240_000 }, async (t) => {
  const box = await preflightProject(t, { running: false });
  const on = await preflight(box, REFUSED, true);
  assert.ok(on.nodeChildren > 0, 'no resident process: the children ran');
  assert.deepEqual(on.findings, (await preflight(box, REFUSED, false)).findings);
  assert.equal(existsSync(residentSocket(box.repo, PULLBOARD_ENTRY, 0).pid), false, 'asking never starts a resident process');
});

test('cli.io-submit-resident-preflight.with-submit-residentchecks-off-the-preflight-starts: clause 2: with submit.residentChecks off, the preflight starts its node children as today even with a resident process running [C7,#5330]', { timeout: 240_000 }, async (t) => {
  const box = await preflightProject(t, { running: true });
  const off = await preflight(box, REFUSED, false);
  assert.ok(off.nodeChildren >= 2, `the list child and a child per check started (${off.nodeChildren})`);
});

test('cli.io-submit-resident-preflight.fixture-resident-starts-and-stops-a-live-process: clause 1: the fixture starts a resident board process on an e2e board and stops it, leaving no live pid [C7,#10936]', { timeout: 240_000 }, async () => {
  const helpers = createE2eHelpers();
  const box = helpers.project('true');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = box.env.PULLBOARD_MACHINE_HOME;
  try {
    const place = await startFixtureResident(box, { ...process.env, PULLBOARD_MACHINE_HOME: box.env.PULLBOARD_MACHINE_HOME });
    const pid = Number(readFileSync(place.pid, 'utf8').trim());
    assert.doesNotThrow(() => process.kill(pid, 0), 'the pid names a live process');
    stopFixtureResidents(box.repo);
    await waitForState(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 'the resident process is gone');
    assert.throws(() => process.kill(pid, 0), 'no live resident pid is left');
  } finally {
    stopFixtureResidents(box.repo);
    if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved;
    helpers.cleanup();
  }
});
