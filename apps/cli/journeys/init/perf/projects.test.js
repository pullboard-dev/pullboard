// pullboard: browser
/** @pullboard-test-gui */
/** The performance harness measures real projects: eight registered boards and the single-project baseline [N26,N40]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
} from 'node:fs';
import {
  dirname,
  join,
  resolve,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import {
  cleanupFixtureChildren,
  runFixtureChildAsync,
} from '../../../tests/fixtures/child.js';
import { removeStressBoard } from '../../../tests/fixtures/cockpit/perf/generate.mjs';

after(cleanupFixtureChildren);

test('the harness measures with eight registered projects [N26,N40]', async (t) => {
  const fixtures = [];
  t.after(() => {
    if (t.passed) for (const fixture of fixtures) removeStressBoard(fixture);
  });
  const root = resolve(import.meta.dirname, '../../../../..');
  for (const projects of [8, 1]) {
    const result = await runFixtureChildAsync(process.execPath, [join(root, 'apps/cli/tests/fixtures/cockpit/perf/run.mjs'),
      ...(projects > 1 ? ['--projects', String(projects)] : []),
      '--size', '5', '--runs', '1', '--idle', '1', '--live-every', '1', '--keep'],
    { cwd: root, env: process.env });
    assert.equal(result.status, 0, result.context);
    const kept = /^Generated board kept at (.+)$/mu.exec(result.stdout);
    assert.ok(kept, 'the CLI retains its private fixture for independent registry checks');
    const workspace = dirname(kept[1]);
    const fixture = { ...JSON.parse(readFileSync(join(workspace, 'stress-board.json'), 'utf8')), workspace };
    fixtures.push(fixture);
    const end = result.stdout.indexOf('\n\n| action |');
    assert.ok(end > 0, 'the harness prints its JSON before the existing table');
    const report = JSON.parse(result.stdout.slice(0, end));
    assert.equal(report.projects, projects, 'the JSON records the measured project count');
    assert.equal(report.projectNames.length, projects, 'the real view lists every requested project');
    assert.equal(new Set(report.projectNames).size, projects, 'the projects have distinct names');
    const registered = JSON.parse(readFileSync(join(fixture.home, 'projects.json'), 'utf8')).projects;
    assert.equal(registered.length, projects, 'the stress home contains the requested real projects');
    assert.equal(new Set(registered.map((project) => project.root)).size, projects);
    for (const project of registered) {
      assert.ok(existsSync(join(project.root, '.git/pullboard/board.sqlite')), 'each project has its own board');
    }
    const switching = report.actions.filter((action) => action.name === 'switchProject');
    assert.equal(switching.length, projects > 1 ? 1 : 0,
      'only a multi-project run measures a real project switch');
    for (const action of switching) {
      assert.ok(action.samples.every((sample) => sample.stable === true), 'the switch reaches the stress board');
      assert.ok(Number.isFinite(action.medianMs) && Number.isFinite(action.worstMs), 'switch latency is measured');
    }
    assert.deepEqual(report.actions.filter((action) => action.name !== 'switchProject').map((action) => action.name),
      ['firstLoad', 'tab:shouts', 'tab:spec', 'tab:doctrine', 'tab:activity', 'tab:roadmap', 'tab:items',
        'openSmallItem', 'openLongestHistoryItem', 'search', 'idleWithLiveWrites'], 'the eleven existing actions stay intact');
    assert.equal(report.size, 5, 'the measured stress-board size is preserved');
    t.diagnostic(JSON.stringify({ projects: report.projects, size: report.size,
      projectNames: report.projectNames, actions: report.actions.map((action) => action.name) }));
  }
});
