/** @pullboard-test-gui */
/** @pullboard-test-input source-cell apps/cli apps/lib store */
/** Cockpit fixture setup without a model, and the view reading its release notes once [N26]. */
import assert from 'node:assert/strict';
import {
  createHash,
} from 'node:crypto';
import {
  spawnSync,
} from 'node:child_process';
import {
  readFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import {
  test,
} from 'node:test';
import {
  machine,
  project,
} from '../../../tests/fixtures/cockpit/harness.js';

test('the cockpit fixture inits its board without a model [N26]', () => {
  const box = machine();
  project(box, 'model-free-coordinator');
  const init = box.invocations.find((call) => call.args.length === 1 && call.args[0] === 'init');
  const join = box.invocations.find((call) => call.args[0] === 'join' && call.args[1] === 'web');
  assert.ok(init, 'the fixture ran init');
  assert.equal(init.hasModel, false, 'init does not inherit the test runner model');
  assert.ok(join, 'the fixture ran a later agent join');
  assert.equal(join.hasModel, true, 'later agent joins retain the machine model');
  assert.equal(join.model, 'Test Model');
});

test('clause 1: the view reads its release notes once, not on every state [N26]', async () => {
  const box = machine();
  const p = project(box, 'release-note-cache');
  await box.runIn(p.repo, 'add', 'web', 'A real board row', '--specs', 'G1');
  const changelog = readFileSync(resolve(import.meta.dirname, '../../../../../CHANGELOG.md'));
  const expectedHash = createHash('sha256').update(changelog).digest('hex');
  const serveUrl = new URL('../../../src/io/view.js', import.meta.url).href;
  const script = `
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = ${JSON.stringify(p.repo)};
const observedReads = [];
const originalReadFileSync = fs.readFileSync;
fs.readFileSync = function (file, ...args) {
  const value = Reflect.apply(originalReadFileSync, this, [file, ...args]);
  let name = '';
  try { name = basename(file instanceof URL ? fileURLToPath(file) : String(file)); } catch { /* non-path input */ }
  if (name === 'CHANGELOG.md') {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    observedReads.push({ sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
  }
  return value;
};
syncBuiltinESMExports();
const { projectState } = await import(${JSON.stringify(serveUrl)} + '?release-cache-regression');
const states = [projectState(repo), projectState(repo), projectState(repo)];
assert.equal(states.length, 3);
process.stdout.write(JSON.stringify({ observedReads, releaseNotes: states.map(state => state.releaseNotes) }) + '\\n');
`;
  const env = { ...box.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: box.dir, env, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  assert.equal(child.status, 0, `fresh real project-state process: ${child.stderr}`);
  const observation = JSON.parse(child.stdout);
  assert.equal(observation.observedReads.length, 1, 'one successful filesystem changelog read serves multiple project states');
  assert.deepEqual(observation.observedReads[0], { sha256: expectedHash, bytes: changelog.length }, 'the read returns the unchanged shipped changelog bytes');
  assert.equal(observation.releaseNotes.length, 3, 'three real SQLite-backed project states were built');
  for (const releaseNotes of observation.releaseNotes.slice(1)) {
    assert.deepEqual(releaseNotes, observation.releaseNotes[0], 'cached release content is identical in every state');
  }
});
