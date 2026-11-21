/** Health and agents name the machine load against its ceiling, the top local consumers and the seats holding nothing [Q1,C7,#2466]. */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import {
  setMachineLoadPort,
  setProcessSamplePort,
} from '../../../../../../packages/resources/index.js';
import { createE2eHelpers } from '../../../fixtures/e2e.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

const PS = [
  ' 90.0 /usr/local/bin/node /work/packages/gate/src/io/run/tests.js apps/a.test.js',
  ' 60.5 /usr/local/bin/node /work/packages/gate/src/io/run/tests.js apps/b.test.js',
  ' 30.0 /usr/bin/git status',
  '  1.0 /sbin/launchd',
].join('\n');

/** Inject the load reading and the ps sample for one test; restore both afterwards. */
function inject(t, load) {
  const restoreLoad = setMachineLoadPort({ loadavg: () => [load, load, load], cores: () => 4 });
  const restorePs = setProcessSamplePort({ ps: () => PS });
  t.after(() => { restoreLoad(); restorePs(); });
}

test('cli.journeys-health-machine-load.pullboard-health-prints-the-1-minute: clause 1: pullboard health prints the 1-minute load and the ceiling it is judged against [Q1,C7,#2466]', async t => {
  inject(t, 7.5);
  const box = e2e.project();
  const health = await box.runLocal(box.repo, 'health', '--json');
  const load = JSON.parse(health.out).machineLoad;
  assert.equal(load.load, 7.5);
  assert.equal(load.ceiling, 6);
  assert.equal(load.held, true);
  const text = await box.runLocal(box.repo, 'health');
  assert.match(text.out, /load: holding heavy local work: 1-minute load 7\.5 on 4 cores \(ceiling 6\)/u);
});

test('cli.journeys-health-machine-load.pullboard-agents-lists-the-top-local: clause 2: pullboard agents lists the top local consumers by command kind [Q1,C7,#2466]', async t => {
  inject(t, 1);
  const box = e2e.project();
  const agents = await box.runLocal(box.repo, 'agents', '--json');
  assert.deepEqual(JSON.parse(agents.out).consumers, [
    { kind: 'node tests.js', cpu: 150.5, processes: 2 },
    { kind: 'git', cpu: 30, processes: 1 },
    { kind: 'launchd', cpu: 1, processes: 1 },
  ]);
  const text = await box.runLocal(box.repo, 'agents');
  assert.match(text.out, /top local consumers: node tests\.js 150\.5% \(2\), git 30% \(1\), launchd 1% \(1\)/u);
});

test('cli.journeys-health-machine-load.pullboard-agents-names-seats-on-the: clause 3: pullboard agents names seats on the machine that hold nothing [Q1,C7,#2466]', async t => {
  inject(t, 1);
  const box = e2e.project();
  const agents = await box.runLocal(box.repo, 'agents', '--json');
  const idle = JSON.parse(agents.out).idleSeats;
  assert.ok(idle.length >= 1, `the joined fixture seat holds nothing: ${agents.out}`);
  const text = await box.runLocal(box.repo, 'agents');
  assert.match(text.out, new RegExp(`seats holding nothing: .*${idle[0].id}`, 'u'));
});
