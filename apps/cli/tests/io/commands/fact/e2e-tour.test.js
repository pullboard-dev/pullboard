/**
 * The scripted tour on real repos, apart from the other end-to-end journeys so the tour never waits behind them
 * and the file timeout never lands on it [N10].
 */
import assert from 'node:assert/strict';
import {
  runFixtureChildAsync,
} from '../../../fixtures/child.js';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';

import { createE2eHelpers } from '../../../fixtures/e2e.js';
const e2e = createE2eHelpers();
after(e2e.cleanup);
const { BIN, sandbox } = e2e;

test('cli.journeys-fact-e2e-tour.a-second-tour-replaces-the-first: a second tour replaces the first demo and links nothing to the relay [N10]', { timeout: 300_000 }, async () => {
  // The machine's own list and relay state hold their own home, so a tour run here can only touch that home (#951).
  const box = sandbox();
  const home = join(box.dir, 'private-home');
  mkdirSync(home);
  const real = join(box.dir, 'real-project');
  mkdirSync(real);
  box.git(real, 'init', '-q', '-b', 'main');
  writeFileSync(join(home, 'projects.json'), JSON.stringify({ projects: [{ root: real, name: 'real-project', project: '', added: '2026-01-01T00:00:00.000Z' }] }));
  mkdirSync(join(home, 'relay-machine'), { mode: 0o700 });
  writeFileSync(join(home, 'relay-machine', 'state.json'), JSON.stringify({ v: 2, autoLink: true, owner: null, machine: 'machine-951', devices: [], excluded: [], pending: null, revocations: [], approvals: [] }), { mode: 0o600 });
  const tourEnv = { ...box.env, TMPDIR: box.dir, PULLBOARD_HOME: home };
  delete tourEnv.NO_COLOR;
  delete tourEnv.FORCE_COLOR;
  delete tourEnv.PULLBOARD_MODEL;
  const repos = [];
  for (let run = 1; run <= 2; run += 1) {
    const shown = await runFixtureChildAsync(process.execPath, [BIN, 'tour'], { cwd: box.dir, env: tourEnv, encoding: 'utf8' });
    assert.equal(shown.status, 0, `run ${run}: ${shown.stdout}${shown.stderr}`);
    repos.push(/Look around: cd (\S+) && pullboard log/u.exec(shown.stdout)[1]);
  }
  const registry = JSON.parse(readFileSync(join(home, 'projects.json'), 'utf8')).projects;
  assert.deepEqual(registry.map((entry) => entry.root), [real, repos[1]], 'the list holds the real project and the demo of the second run, and no other');
  const state = JSON.parse(readFileSync(join(home, 'relay-machine', 'state.json'), 'utf8'));
  assert.deepEqual(state.approvals, [], 'no relay link request or approval was made for either demo');
});
