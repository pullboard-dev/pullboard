/** Registered SSH runner execution stays inside a committed, secret-free worker checkout [C7]. */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import { openBoard } from '../../../../lib/index.js';
import {
  HOST,
  after,
  assert,
  awaitRoundTrip,
  cli,
  copyCommittedPackageFiles,
  createE2eHelpers,
  dirname,
  existsSync,
  fixtureResultContext,
  git,
  installSshStandIn,
  join,
  mkdirSync,
  observe,
  phaseCounts,
  readFileSync,
  resolve,
  startToolingCli,
  takeResource,
  test,
  writeFileSync,
} from '../../../tests/fixtures/scenarios/runners.js';

test('review655 a registered runner honors the same live person waiver at landing [B3,R3,C7]', { timeout: 120_000 }, async (t) => {
  const { createE2eHelpers } = await import('../../../tests/fixtures/e2e.js');
  const helper = createE2eHelpers();
  t.after(helper.cleanup);
  const box = helper.project('true');
  const repo = box.repo;
  const fixtureBin = join(box.dir, 'runner-bin');
  const remoteHome = join(box.dir, 'runner-home');
  const remoteMachineHome = join(remoteHome, '.pullboard');
  const worker = join(box.dir, 'second-machine');
  const requests = join(box.dir, 'runner-requests.jsonl');
  for (const folder of [fixtureBin, remoteHome, remoteMachineHome, worker, join(repo, 'bin'), join(repo, 'test')]) mkdirSync(folder, { recursive: true });
  const env = { ...box.env, PATH: fixtureBin + ':' + box.env.PATH };
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ private: true, type: 'module' }) + '\n');
  copyCommittedPackageFiles(box, resolve(import.meta.dirname, '../../../../..'), { directory: 'tooling' });
  const failing = 'test/review655-waived-red.test.js';
  writeFileSync(join(repo, failing), "import { test } from 'node:test'; test('review655 known waived runner flake', () => { throw new Error('known private flaky failure'); });\n");
  const configPath = join(repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(configPath, JSON.stringify({ ...config, gate: 'node tooling/apps/cli/src/io/run/tests.js --test-concurrency=1 ' + failing }) + '\n');
  box.git(repo, 'add', '.');
  box.git(repo, 'commit', '-q', '-m', 'test: commit private registered-runner waiver fixture');
  const store = await import('../../../../../packages/store/index.js');
  // @pullboard-board-file persistence: the registered runner reads this committed board's live person waiver.
  const board = openBoard(join(repo, '.git', 'pullboard', 'board.sqlite'));
  let waiver;
  try { waiver = store.recordLandingWaiver(board, { agentId: 'person', channel: 'terminal', id: 'review655-remote-person-waiver', test: failing, until: '2099-01-01', reason: 'same live person exception on either execution machine' }); }
  finally { store.closeBoard(board); }
  const capacity = cli(repo, env, 'settings', 'gateSlots', '1', '--json');
  assert.equal(capacity.status, 0, fixtureResultContext(capacity));
  const local = cli(repo, env, 'gate', '--landing', '--json');
  assert.equal(local.status, 0, fixtureResultContext(local));
  const localDocument = JSON.parse(local.stdout);
  assert.equal(localDocument.green, false);
  assert.equal(localDocument.waived[0].waiver, waiver.id, 'the same exact committed source is waived locally');
  installSshStandIn({ bin: fixtureBin, worker, home: remoteHome, machineHome: remoteMachineHome, requests });
  const registered = cli(repo, env, 'runner', 'add', HOST, '--slots', '1', '--browser', '1', '--json');
  assert.equal(registered.status, 0, fixtureResultContext(registered));
  const priorHome = process.env.PULLBOARD_HOME, priorMachine = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_HOME = env.PULLBOARD_HOME;
  process.env.PULLBOARD_MACHINE_HOME = env.PULLBOARD_MACHINE_HOME;
  let held;
  try {
    held = await takeResource({ name: 'gate', capacity: 1, scope: 'machine', root: repo, agent: 'review655-local-holder', item: 'review655-local-holder', kind: 'force-registered-runner' });
    const phases = requests + '.phases';
    const before = phaseCounts(phases);
    const remote = observe(startToolingCli(repo, env, ['gate', '--landing', '--json'], { detached: true }));
    const result = await awaitRoundTrip(remote.child, remote.closed, phases, before);
    const profile = JSON.parse(readFileSync(join(repo, '.git', 'pullboard-gate.log.profile.json'), 'utf8'));
    const raw = readFileSync(join(repo, '.git', 'pullboard-gate.log'), 'utf8');
    assert.equal(profile.executionRunner, HOST, 'the real registered runner executed the frozen source');
    assert.equal(profile.executionSource?.commit, box.git(repo, 'rev-parse', 'HEAD'), 'local and remote execute the same committed failing test');
    assert.match(raw, /review655 known waived runner flake/u, 'the actual remote test is named in its result');
    assert.match(raw, /known private flaky failure/u, 'the actual committed test threw its known error');
    assert.match(raw, /^# tests 1$/mu, 'there is only this one committed test');
    const document = JSON.parse(result.stdout);
    console.log('review655 actual registered-runner waiver outcome ' + JSON.stringify({ localStatus: local.status, localWaiver: localDocument.waived[0].waiver, remoteStatus: result.status, executionRunner: profile.executionRunner, executionCommit: profile.executionSource?.commit, earlyStopped: raw.includes('Landing gate stopped early'), cancelled: /^# cancelled (\d+)$/mu.exec(raw)?.[1], raw, document }));
    assert.equal(result.status, 0, 'the same live person waiver must cover this named landing failure on the registered runner');
    assert.equal(document.green, false, 'a waived remote failure is never an ordinary green');
    assert.equal(document.waived[0].waiver, waiver.id);
    assert.equal(document.waived[0].file, failing, 'failure identities stay relative to the committed source');
    assert.equal(document.waived[0].reason, waiver.reason);
    assert.equal(document.waived[0].until, waiver.until);
    assert.equal(existsSync(join(repo, '.git', 'pullboard-gate-green')), false, 'a waived remote run writes no ordinary green stamp');
    assert.doesNotMatch(raw, /Landing gate stopped early/u);
    assert.match(raw, /^# cancelled 0$/mu);

    /** Change only the private gate, then require the real registered worker's complete response. */
    const remoteGate = async (command, message) => {
      writeFileSync(configPath, JSON.stringify({ ...config, gate: command }) + '\n');
      box.git(repo, 'add', 'pullboard.json');
      box.git(repo, 'commit', '-q', '-m', message);
      const prior = phaseCounts(phases);
      const run = observe(startToolingCli(repo, env, ['gate', '--landing', '--json'], { detached: true }));
      const finished = await awaitRoundTrip(run.child, run.closed, phases, prior);
      const measured = JSON.parse(readFileSync(join(repo, '.git', 'pullboard-gate.log.profile.json'), 'utf8'));
      assert.equal(measured.executionRunner, HOST, 'each accounting counter actually executes on the registered worker');
      assert.equal(measured.executionSource.commit, box.git(repo, 'rev-parse', 'HEAD'));
      assert.equal(existsSync(join(repo, '.git', 'pullboard-gate-green')), false);
      return { ...finished, document: JSON.parse(finished.stdout), raw: readFileSync(join(repo, '.git', 'pullboard-gate.log'), 'utf8') };
    };
    const tests = 'node tooling/apps/cli/src/io/run/tests.js --test-concurrency=1 ' + failing;
    const throughCat = await remoteGate(tests + ' | cat', 'test: retain a remote TAP producer account');
    assert.equal(throughCat.status, 0, fixtureResultContext(throughCat));
    assert.equal(throughCat.document.green, false);
    assert.equal(throughCat.document.waived[0].waiver, waiver.id, 'the failing producer accounts for its own test');

    const independent = await remoteGate('node -e "process.exitCode=1" | ' + tests, 'test: retain an independent remote pipeline failure');
    assert.equal(independent.status, 1, 'an unattributed producer failure is not covered by the consumer test waiver');
    assert.match(independent.raw, /^# fail 1$/mu, 'the consumer still returns its complete waived TAP');
    assert.equal(independent.document.waived, undefined);

    const staged = await remoteGate(tests + '; node -e "process.exitCode=2"', 'test: retain a separate remote stage failure');
    assert.equal(staged.status, 1, 'a separate failing stage is not a test waiver');
    assert.equal(staged.document.waived, undefined);

  } finally {
    held?.release();
    if (priorHome === undefined) delete process.env.PULLBOARD_HOME; else process.env.PULLBOARD_HOME = priorHome;
    if (priorMachine === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = priorMachine;
  }
});
