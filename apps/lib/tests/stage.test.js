/** GUI capability survives the common runner stage without inventing unknown availability [C7,O5,V4]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../packages/store/index.js';
import { openBoard } from '../index.js';
import { recordRunnerGui } from '../../../packages/resources/index.js';
import { placeRunner } from '../../runner/index.js';
import { readRunnerStage } from '../../runner/index.js';
import { runFixtureGit } from '../../cli/tests/fixtures/child.js';

test('GUI placement uses the common stage and excludes false or unknown desktop sessions [C7,O5,V4]', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-gui-stage-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, stdio: 'pipe' });
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ lanes: { core: { owns: ['src/'] } } }));
  const board = openBoard(':memory:');
  t.after(() => store.closeBoard(board));
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = root;
  t.after(() => { if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previous; });
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ gateSlots: 2, browserSlots: 1, runners: [
    { host: 'fixture-no-gui', slots: 1, browser: 1, gui: true },
    { host: 'fixture-unknown', slots: 1, browser: 1 },
    { host: 'fixture-with-gui', slots: 1, browser: 1, gui: false },
  ] }));
  recordRunnerGui('fixture-no-gui', false);
  recordRunnerGui('fixture-with-gui', true);
  const stage = readRunnerStage(root, { from: new Date(Date.now() - 60_000).toISOString(), to: new Date(Date.now() + 1).toISOString() });
  stage.runners = stage.runners.filter(runner => runner.kind === 'ssh');
  assert.deepEqual(stage.runners.map(runner => [runner.id, runner.capabilities.gui]), [
    ['fixture-no-gui', false], ['fixture-unknown', null], ['fixture-with-gui', true],
  ], 'the common shape carries last authenticated reports and keeps an unreported capability unknown');
  assert.deepEqual(placeRunner(stage, { capabilities: { gui: true } }), { action: 'run', runnerId: 'fixture-with-gui' });
  const unavailable = { ...stage, runners: stage.runners.filter(runner => runner.id !== 'fixture-with-gui') };
  assert.deepEqual(placeRunner(unavailable, { capabilities: { gui: true } }), { action: 'wait' }, 'unknown must not run a desktop job');
  assert.deepEqual(placeRunner({ ...stage, runners: [stage.runners[0]] }, { capabilities: { gui: true } }), { action: 'incompatible' });
  assert.deepEqual(placeRunner(stage, { capabilities: { gui: false } }), { action: 'run', runnerId: 'fixture-no-gui' }, 'unmarked work has no GUI requirement');
  assert.throws(() => placeRunner(stage, { capabilities: { gui: 'yes' } }), error => error.code === 'BAD_RUNNER_POOL');
  assert.throws(() => placeRunner({ ...stage, runners: [{ ...stage.runners[0], capabilities: { gui: 'yes' } }] }), error => error.code === 'BAD_RUNNER_POOL');
});
