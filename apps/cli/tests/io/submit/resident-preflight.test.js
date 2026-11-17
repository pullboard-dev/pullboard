/** @pullboard-test-input apps/cli/src/io/submit/preflight.js apps/cli/src/io/resident/calls.js apps/cli/src/io/resident/client.js apps/cli/src/io/resident/board.js */
/**
 * With submit.residentChecks on, submit's preflight is answered by the resident board process and starts no node child,
 * with the findings it has with the setting off; with the setting off, or no resident process running, it starts its
 * children as before [C7,#5330].
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { runFixtureChild } from '../../fixtures/child.js';
import { spawnCounts } from '../../fixtures/spawns.js';
import { spawnEnv } from '../../fixtures/spawns.js';
import { fixtureMachineSettings } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { PULLBOARD_ENTRY } from '../../../src/io/resident/client.js';
import { residentPoolSize } from '../../../src/io/resident/client.js';
import { residentSocket } from '../../../src/io/resident/client.js';

const PREFLIGHT = pathToFileURL(resolve(import.meta.dirname, '../../../src/io/submit/preflight.js')).href;
const CLEAN = ['packages/x/src/a.js'];
const REFUSED = ['packages/x/src/b.js', 'test/w.test.js'];

/** Stop every resident board process this board started, so the sandbox can be removed. */
function stopResidents(repo) {
  for (let slot = 0; slot < residentPoolSize({}); slot += 1) {
    const place = residentSocket(repo, PULLBOARD_ENTRY, slot);
    if (!place) continue;
    try { process.kill(Number(readFileSync(place.pid, 'utf8').trim()), 'SIGKILL'); } catch { /* None started, or it already exited. */ }
  }
}

/**
 * A committed project with one clean file and, uncommitted, a file with an empty catch and a test with a fixed wait. With
 * `running`, a resident board process serves its board.
 */
function preflightProject(t, { running }) {
  const helpers = createE2eHelpers();
  t.after(() => { try { stopResidents(box.repo); } finally { helpers.cleanup(); } });
  const box = helpers.project('true');
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
  for (const name of ['NODE_TEST_CONTEXT', 'NODE_TEST_WORKER_ID']) delete box.env[name];
  box.env.PULLBOARD_RESIDENT = '1';
  // Two real status calls: the first starts the resident process, the second is answered by it.
  if (running) for (let call = 0; call < 2; call += 1) box.run(box.web, 'status', '--json'); // real process: this test needs a running resident process
  return box;
}

/** Run the preflight in a real process under the spawn counter: the findings by check, and the node children it started. */
function preflight(box, files, residentChecks) {
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { submit: { residentChecks } });
  const script = join(box.dir, 'preflight-child.mjs');
  const log = join(box.dir, `spawns-${Math.random().toString(36).slice(2)}.log`);
  writeFileSync(script, `import { runPreflight } from ${JSON.stringify(PREFLIGHT)};
const report = await runPreflight(process.argv[2], JSON.parse(process.argv[3]));
process.stdout.write(JSON.stringify(report.results.map(({ name, failures }) => ({ name, failures }))));
`);
  writeFileSync(log, '');
  const ran = runFixtureChild(process.execPath, [script, box.repo, JSON.stringify(files)], // real process: this test counts real spawns
    { cwd: box.repo, env: { ...box.env, ...spawnEnv(log) }, encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.failure ?? ran.stderr);
  return { findings: JSON.parse(ran.stdout).sort((a, b) => a.name.localeCompare(b.name)), nodeChildren: spawnCounts(log).node };
}

test('clause 1: with submit.residentChecks on, the preflight is answered by the resident process, starts no node child, and finds what it finds with the setting off, for a clean and a refused change [C7,#5330]', { timeout: 240_000 }, (t) => {
  const box = preflightProject(t, { running: true });
  for (const files of [CLEAN, REFUSED]) {
    const off = preflight(box, files, false);
    const on = preflight(box, files, true);
    assert.ok(off.nodeChildren > 0, 'the counter sees the children the setting-off preflight starts');
    assert.equal(on.nodeChildren, 0, `the resident process answered: no node child started for ${files.join(', ')}`);
    assert.deepEqual(on.findings, off.findings);
  }
  assert.ok(preflight(box, REFUSED, true).findings.some(row => row.failures.length), 'the refused change is refused');
  assert.ok(preflight(box, CLEAN, true).findings.every(row => !row.failures.length), 'the clean change is clean');
});

test('clause 1: with submit.residentChecks on and no resident process running, the preflight falls back to its children and finds the same [C7,#5330]', { timeout: 240_000 }, (t) => {
  const box = preflightProject(t, { running: false });
  const on = preflight(box, REFUSED, true);
  assert.ok(on.nodeChildren > 0, 'no resident process: the children ran');
  assert.deepEqual(on.findings, preflight(box, REFUSED, false).findings);
  assert.equal(existsSync(residentSocket(box.repo, PULLBOARD_ENTRY, 0).pid), false, 'asking never starts a resident process');
});

test('clause 2: with submit.residentChecks off, the preflight starts its node children as today even with a resident process running [C7,#5330]', { timeout: 240_000 }, (t) => {
  const box = preflightProject(t, { running: true });
  const off = preflight(box, REFUSED, false);
  assert.ok(off.nodeChildren >= 2, `the list child and a child per check started (${off.nodeChildren})`);
});
