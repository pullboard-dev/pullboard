/** Landing retains the first real assertion identity when abort interrupts a reporter [C7,V4]. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { copyPackageFiles } from '../packages/runners/index.js';
import { runFixtureChild } from './fixture-child.js';

const ROOT = resolve(import.meta.dirname, '..');

test('an aborted landing publishes the first failing file and test as a structured outcome [C7,V4]', t => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-gate-reporter-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  copyPackageFiles(ROOT, root);
  writeFileSync(join(root, 'test', 'spec-failure.test.js'), `import assert from 'node:assert/strict';
import { test } from 'node:test';
test('spec default failure [C7]', () => assert.fail('intentional reporter fixture failure'));
`);
  const env = { ...process.env, PULLBOARD_LANDING_RUN: '1' };
  if (env.PULLBOARD_GATE_SLOT_HELD !== '1' || !env.PULLBOARD_GATE_SLOT_POOL || !env.PULLBOARD_GATE_SLOT_TOKEN) {
    env.PULLBOARD_MACHINE_HOME = join(root, 'machine');
    for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete env[key];
  }
  const result = runFixtureChild(process.execPath, [join(root, 'bin', 'run-tests.js'), '--test-reporter=spec', 'test/spec-failure.test.js'],
    { cwd: root, env, encoding: 'utf8', timeout: 60000 });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  assert.equal(result.status, 1, `${result.context}\n${output}`);
  const frame = output.split('\n').find(line => line.startsWith('# pullboard test outcomes '));
  assert.ok(frame, 'the failure remains accounted after landing abort');
  assert.deepEqual(JSON.parse(frame.slice('# pullboard test outcomes '.length)).tests,
    [{ file: 'test/spec-failure.test.js', name: 'spec default failure [C7]', passed: false, skipped: false }]);
});
