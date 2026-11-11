import { flakeQuarantines as nativeFlakeQuarantines } from '../../../../packages/flakes/index.js';
import { gateRuns as nativeGateRuns } from '../../../../packages/flakes/index.js';
import { landingWaiverFor as nativeLandingWaiverFor } from '../../../../packages/landing/index.js';
import { waivedLandingProof as nativeWaivedLandingProof } from '../../../../packages/landing/index.js';
import { landingPorts } from '../../tests/fixtures/landing/ports.js';
/** Exercise landing against real private Git worktrees, hooks, SQLite and bare remotes [B3,R3]. */
import assert from 'node:assert/strict';
import { loadConfig } from '../../../../packages/config/index.js';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  join,
  relative,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { fixtureBoard } from '../../tests/fixtures/board.js';
import {
  applyRelayMove,
  prepareEngineMove,
} from '../../../../packages/state/index.js';
import {
  exportBoard,
  importBoard,
} from '../../../../packages/store/index.js';
import {
  landingFailures,
  landingSubject,
} from '../../../../packages/landing/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import {
  startFixtureChild,
  runFixtureChild,
} from '../../tests/fixtures/child.js';
import { stopGroup } from '../../tests/fixtures/runner/group.js';
import { waitForFixtureProgress } from '../../tests/fixtures/progress.js';
import { assertNoRemoteLanding } from '../../tests/fixtures/land/remote.js';
import { assertLandingStopIdentity } from '../../tests/fixtures/land/stop.js';
import { assertLandingDoctrineCounts } from '../../tests/fixtures/land/doctrine.js';
import {
  onBoard,
  events,
  calls,
  json,
  mergeSubjects,
} from '../../tests/fixtures/land/board.js';
import { landingTimeoutFixture } from '../../../../packages/store/tests/fixtures/timeout.js';
import { startInterruptedLanding } from '../../tests/fixtures/land/board.js';
import { settleRecordedSourceWake } from '../../tests/fixtures/land/board.js';
import { recordManualMergedItems } from '../../tests/fixtures/land/board.js';
import {
  assertParallelLanding,
  assertParallelCliLease,
  assertParallelNestedGate,
} from '../../tests/fixtures/land/parallel.js';
import { landEnginesInOrder } from '../../tests/fixtures/land/engine.js';
import { makeLandProjectFixtures } from '../../tests/fixtures/land/project.js';
import { assertLocalWaiverExpiry } from '../../tests/fixtures/land/expiry.js';
import {
  assertAffectedLandingUnstamped,
  assertDeferredBatchIsolation,
} from '../../tests/fixtures/land/deferred.js';
import {
  assertCollisionFreeLanding,
  assertSiblingConflictLanding,
  assertDeferredLandingPriority,
} from '../../../../packages/store/tests/fixtures/collision.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';
const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile, BIN } = e2e;
const { FILES, landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures({ sandbox, project, commitFile });

test('a landing stop never signals a reused process group [Q1,Q3,C7]', async () => {
  await assertLandingStopIdentity();
});

test('a landing records a falling doctrine count and holds a rising count [B3,R3,D1,D3]', () => {
  assertLandingDoctrineCounts({ landProject, itemWorktree, submitItem, acceptItem });
});

test('a repo with no remote lands into the local trunk and status reads as normal [I1,B3,R3,H5]', () => {
  assertNoRemoteLanding(sandbox, commitFile);
});
/** Prepare four independent submitted items and accept them in a caller-selected verdict order. */
function verifiedFour(box, { red, flaky, order = [0, 1, 2, 3] } = {}) {
  box.env.LAND_SUPPRESS_RED = '1';
  const entries = FILES.map((file, index) => itemWorktree(box, index + 1, file));
  for (const [index, entry] of entries.entries()) submitItem(box, entry, index === red ? 'RED\n' : (Array.isArray(flaky) ? flaky.includes(index) : index === flaky) ? 'FLAKE\n' : 'PASS\n');
  for (const index of order) acceptItem(box, entries[index]);
  delete box.env.LAND_SUPPRESS_RED;
  return entries;
}

test('land pushes one exact batch in verdict order and records each first-containing merge once [B3,R3]', () => {
  const box = landProject();
  const entries = verifiedFour(box, { order: [3, 1, 0, 2] });
  const base = box.git(box.repo, 'rev-parse', 'main');
  const start = calls(box).length;
  const result = json(box, box.repo, 'land', '--max', '4');
  const order = [3, 1, 0, 2].map((index) => entries[index].item);
  assert.deepEqual(result.landed, order);
  assert.deepEqual(mergeSubjects(box, base, result.batch.tip), [4, 2, 1, 3].map((n) => `feat(merge): land fixture ${n} [G1]`), 'each merge takes its item\'s type from the item\'s feat commit');
  assert.equal(result.batch.state, 'landed');
  assert.equal(box.git(box.repo, 'rev-parse', 'main'), result.batch.tip);
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), result.batch.tip, 'real pre-push accepted the gated tip');
  assert.ok(relative(join(box.repo, '.git', 'pullboard'), result.batch.root).startsWith('landings/'));
  assert.notEqual(result.batch.root, box.repo);
  assert.deepEqual(calls(box).slice(start), [[]], 'one full batch gate; pre-push reads its exact green tree stamp');
  const merges = box.git(box.repo, 'rev-list', '--reverse', '--first-parent', `${base}..${result.batch.tip}`).split('\n');
  for (const [index, id] of order.entries()) assert.equal(json(box, box.repo, 'show', String(id)).item_merged_commit, merges[index]);
  for (const [index, id] of order.entries()) assert.equal(box.git(box.repo, 'log', '-1', '--format=%b', merges[index]).trim(), `Pullboard-Item: #${id}\nPullboard-Rows: G1`, 'each train merge body is only its trailers, naming no lane branch');
  const receipt = events(box).filter((event) => event.event_kind === 'main-moved');
  assert.equal(receipt.length, 1);
  assert.equal(JSON.parse(receipt[0].event_detail).sha, result.batch.tip);
  assert.equal(json(box, box.repo, 'resume').landingBatches.at(-1).id, result.batch.id);
  const eventCount = events(box).length;
  assert.deepEqual(json(box, box.repo, 'land').landed, []);
  assert.equal(events(box).length, eventCount, 'second invocation writes no duplicate receipts');
  assert.deepEqual(calls(box).slice(start), [[]], 'second invocation runs no tests');
  const lane = box.run(entries[0].path, 'land', '--json');
  assert.equal(JSON.parse(lane.out).error?.code, 'COORDINATOR_ONLY');
});

test('a train merge body is only the item trailer even when the local Git config logs merges [B3,R3]', () => {
  const box = landProject();
  verifiedFour(box, { order: [0, 1, 2, 3] });
  const base = box.git(box.repo, 'rev-parse', 'main');
  box.git(box.repo, 'config', 'merge.log', 'true');
  const result = json(box, box.repo, 'land', '--max', '4');
  assert.equal(result.landed.length, 4);
  const merges = box.git(box.repo, 'rev-list', '--reverse', '--first-parent', `${base}..${result.batch.tip}`).split('\n');
  for (const [index, id] of result.landed.entries()) {
    assert.equal(box.git(box.repo, 'log', '-1', '--format=%b', merges[index]).trim(), `Pullboard-Item: #${id}\nPullboard-Rows: G1`, 'merge.log=true appends no shortlog to the body');
  }
});

test('land names sibling conflicts whose reviews share the unchanged main [B3,R3,E8]', () => {
  assertSiblingConflictLanding({ landProject, itemWorktree, submitItem, acceptItem, json, file: FILES[0] });
});

/** Keep the complete private diagnostic refusal in a failing assertion before fixture cleanup deletes its logs. */
function diagnosticOutput(batch) {
  const directory = dirname(batch.logPath);
  return readdirSync(directory).filter(file => file.startsWith('diagnostic-') && file.endsWith('.log'))
    .map(file => readFileSync(join(directory, file), 'utf8')).join('\n');
}

test('land diagnostics inherit their browser gate lease [C7]', () => {
  const box = landProject();
  const marker = join(box.dir, 'land-diagnostic-lease.json');
  const inspector = join(box.dir, 'inspect-land-diagnostic-lease.mjs');
  const resourcesUrl = new URL('../../../../packages/resources/index.js', import.meta.url).href;
  writeFileSync(inspector, [
    "import { writeFileSync } from 'node:fs';",
    `import { inheritedGateSlot } from ${JSON.stringify(resourcesUrl)};`,
    "const lease = inheritedGateSlot({ root: process.cwd(), browser: true });",
    "if (!lease?.browser) throw new Error('focused diagnosis did not inherit its browser lease');",
    `writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ file: process.argv[2], held: process.env.PULLBOARD_GATE_SLOT_HELD ?? '', pool: process.env.PULLBOARD_GATE_SLOT_POOL ?? '', token: process.env.PULLBOARD_GATE_SLOT_TOKEN ?? '', browser: process.env.PULLBOARD_BROWSER_SLOT_HELD ?? '', inheritedBrowser: lease.browser }));`,
  ].join('\n'));

  const configPath = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.affectedTests = `node ${JSON.stringify(inspector)}`;
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  const configCommit = box.tryGit(box.repo, 'commit', '-q', '-m', 'chore: inspect landing diagnostic lease');
  assert.equal(configCommit.status, 0, configCommit.stderr);
  const configPush = box.tryGit(box.repo, 'push', '-q', 'origin', 'main');
  assert.equal(configPush.status, 0, configPush.stderr);

  const entry = itemWorktree(box, 1, FILES[0]);
  box.env.LAND_SUPPRESS_RED = '1';
  try {
    submitItem(box, entry, 'RED\n');
    acceptItem(box, entry);
  } finally {
    delete box.env.LAND_SUPPRESS_RED;
  }
  const result = json(box, box.repo, 'land');
  assert.equal(result.batch.state, 'flaky', `the full gate is red while its isolated diagnosis passes: ${diagnosticOutput(result.batch)}`);
  assert.deepEqual(result.flakes.map(({ test: file }) => file), [FILES[0]]);
  const inherited = JSON.parse(readFileSync(marker, 'utf8'));
  assert.equal(inherited.file, FILES[0]);
  assert.equal(inherited.held, '1');
  assert.ok(inherited.pool, 'the child names the machine resource pool');
  assert.ok(inherited.token, 'the child names the live gate lease token');
  assert.equal(inherited.browser, '1');
  assert.equal(inherited.inheritedBrowser, true);
});

test('land holds a flake without retries and person waivers cover every failure at the exact tree [B3,R3]', () => {
  const box = landProject();
  const entries = verifiedFour(box, { flaky: [0, 1] });
  const base = box.git(box.repo, 'rev-parse', 'HEAD');
  const start = calls(box).length;
  const held = json(box, box.repo, 'land');
  assert.deepEqual(held.landed, []);
  assert.equal(held.batch.state, 'flaky');
  assert.deepEqual(held.flakes.map((flake) => flake.test), FILES.slice(0, 2));
  assert.deepEqual(calls(box).slice(start), [[], ['--alone', FILES[0]], ['--alone', FILES[1]]]);
  assert.equal(box.git(box.repo, 'rev-parse', 'HEAD'), base);
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), base);
  const refused = box.run(box.repo, 'land', '--json');
  assert.equal(JSON.parse(refused.out).error?.code, 'LAND_FLAKE');
  assert.deepEqual(calls(box).slice(start), [[], ['--alone', FILES[0]], ['--alone', FILES[1]]], 'nothing retries');
  assert.equal(events(box).filter((event) => event.event_kind === 'landing_flake').length, 2);
  const flakeItem = json(box, box.repo, 'show', String(held.flakes.find((flake) => flake.test === FILES[1]).item));
  assert.match(flakeItem.item_title, /Flaky test: web\/land-2/u);
  box.env.CODEX_THREAD_ID = 'private-agent-waiver-attempt';
  const agentAttempt = box.run(box.repo, 'land', '--waive', FILES[1], '--until', '2099-01-01', '--reason', 'private fixture exception', '--json');
  assert.equal(JSON.parse(agentAttempt.out).error?.code, 'B26_PERSON_CHANNEL');
  delete box.env.CODEX_THREAD_ID;
  const waiver = json(box, box.repo, 'land', '--waive', FILES[1], '--until', '2099-01-01', '--reason', 'private fixture exception').waiver;
  assert.equal(waiver.by, 'person');
  assert.equal(box.git(box.repo, 'rev-parse', 'HEAD'), base, 'recording a waiver does not land');
  const partial = box.run(box.repo, 'land', '--json');
  assert.equal(JSON.parse(partial.out).error?.code, 'LAND_FLAKE', 'one waiver cannot cover the other failing test');
  assert.deepEqual(calls(box).slice(start), [[], ['--alone', FILES[0]], ['--alone', FILES[1]]], 'partial waiver permits no retry');
  const waiverZero = json(box, box.repo, 'land', '--waive', FILES[0], '--until', '2099-01-01', '--reason', 'second private fixture exception').waiver;
  const landed = json(box, box.repo, 'land');
  assert.deepEqual(landed.landed, entries.map((entry) => entry.item));
  assert.deepEqual(calls(box).slice(start), [[], ['--alone', FILES[0]], ['--alone', FILES[1]]], 'waiver uses the recorded full gate at the same exact tree without retrying');
  assert.deepEqual(landed.batch.proof.failures.map((failure) => failure.waiver), [waiverZero.id, waiver.id]);
  assert.equal(landed.batch.proof.tree, box.git(landed.batch.root, 'rev-parse', 'HEAD^{tree}'));
  assert.ok(onBoard(box, (board) => nativeWaivedLandingProof(board, landed.batch.proof.tree, landingPorts)));
  assert.equal(onBoard(box, (board) => nativeWaivedLandingProof(board, 'f'.repeat(40), landingPorts)), null, 'proof cannot cover another tree');
  const stamp = box.git(landed.batch.root, 'rev-parse', '--git-path', 'pullboard-gate-green');
  assert.ok(!existsSync(stamp) || readFileSync(stamp, 'utf8').trim() !== landed.batch.proof.tree, 'red gate never writes an ordinary green stamp');
  const expired = { now: () => new Date('2099-01-02T00:00:00Z') };
  assert.equal(onBoard(box, (board) => nativeWaivedLandingProof(board, landed.batch.proof.tree, landingPorts), expired), null, 'every waiver must remain live');
  const event = events(box).find((entry) => entry.event_kind === 'landing_waiver');
  assert.equal(event.event_by, 'person');
  assert.equal(commitFile(box, box.repo, 'docs/after-land.md', 'new exact tree\n', 'chore: advance the private tree').status, 0);
  const laterTree = box.git(box.repo, 'rev-parse', 'HEAD^{tree}');
  const beforeHook = calls(box).length;
  onBoard(box, (board) => {
    store.recordLandingWaiver(board, { agentId: 'person', channel: 'terminal', id: 'expired-hook-proof', test: FILES[1], until: '2000-01-02', reason: 'expired proof fixture' });
    store.recordLandingBatch(board, { agentId: 'coordinator', batch: { ...landed.batch, id: 'expired-hook-batch', state: 'ready',
      base: landed.batch.tip, tip: box.git(box.repo, 'rev-parse', 'HEAD'), revision: 0,
      proof: { tree: laterTree, failures: [{ file: FILES[0], name: FILES[0], waiver: waiverZero.id }, { file: FILES[1], name: FILES[1], waiver: 'expired-hook-proof' }] } } });
  }, { now: () => new Date('2000-01-01T00:00:00Z') });
  const hook = runFixtureChild(process.execPath, [BIN, 'hook', 'pre-push'], { cwd: box.repo, env: box.env, encoding: 'utf8',
    input: `refs/heads/main ${box.git(box.repo, 'rev-parse', 'HEAD')} refs/heads/main ${landed.batch.tip}\n` });
  assert.equal(hook.status, 1, hook.stdout);
  assert.match(hook.stderr, /expired or missing person waiver/u);
  assert.equal(calls(box).length, beforeHook, 'expired proof is refused without rerunning the red gate');
});

test('a waiver after an early-stopped gate runs the gate again [C7,V4]', async (t) => {
  for (const mode of ['early green', 'early red', 'unaccounted', 'complete']) await t.test(`${mode} keeps the exact landing proof [C7,V4]`, () => {
    const box = landProject();
    const gate = join(box.dir, 'land-gate.cjs');
    writeFileSync(gate, [
      "const fs = require('node:fs'); const path = require('node:path');",
      `const calls = ${JSON.stringify(box.calls)}; const trace = ${JSON.stringify(box.trace)};`,
      "const args = process.argv.slice(2); const alone = args.includes('--alone'); fs.appendFileSync(calls, JSON.stringify(args) + '\\n');",
      "const files = alone ? args.filter(arg => arg !== '--alone') : fs.readdirSync('web').filter(name => /^land-\\d+\\.test\\.js$/.test(name)).map(name => 'web/' + name);",
      "console.log('TAP version 13'); let count = 0; let failed = 0;",
      "for (const file of files) { const text = fs.readFileSync(file, 'utf8'); count++; fs.appendFileSync(trace, JSON.stringify({ alone, file }) + '\\n');",
      "  const red = !alone && process.env.LAND_SUPPRESS_RED !== '1' && text.includes('FLAKE');",
      "  console.log((red ? 'not ok ' : 'ok ') + count + ' - ' + file + ' keeps the landed behavior');",
      "  if (red) { failed++; console.log('  ---\\n  location: ' + path.resolve(file) + ':1:1\\n  error: fixture failure\\n  ...');",
      "    if (process.env.LAND_EARLY_STOP === '1') { console.error('Landing gate stopped early after ' + file + ': fixture failure'); console.error('Files not run: ' + files.slice(count).join(', ')); break; } }",
      "}",
      "if (process.env.LAND_UNACCOUNTED === '1' && failed) process.exit(1);",
      "console.log('1..' + count); console.log('# tests ' + count); console.log('# pass ' + (count - failed)); console.log('# fail ' + failed); process.exitCode = failed ? 1 : 0;",
    ].join('\n'));
    const entries = verifiedFour(box, { flaky: 0 });
    if (mode.startsWith('early')) box.env.LAND_EARLY_STOP = '1';
    if (mode === 'unaccounted') box.env.LAND_UNACCOUNTED = '1';
    const base = box.git(box.repo, 'rev-parse', 'HEAD');
    const held = json(box, box.repo, 'land');
    assert.equal(held.batch.state, 'flaky');
    assert.deepEqual(held.landed, []);
    const before = calls(box).length;
    const initial = readFileSync(held.batch.logPath, 'utf8');
    if (mode.startsWith('early')) {
      assert.match(initial, /Landing gate stopped early/u);
      assert.ok(initial.includes(`Files not run: ${FILES.slice(1).join(', ')}`));
      assert.doesNotMatch(initial, /ok 2 -/u, 'later files actually did not run');
    } else {
      assert.doesNotMatch(initial, /stopped early|Files not run/u);
      if (mode === 'unaccounted') assert.doesNotMatch(initial, /^# fail /mu, 'the interrupted account has no positive completion footer');
    }
    json(box, box.repo, 'land', '--waive', FILES[0], '--until', '2099-01-01', '--reason', 'private first failure exception');
    delete box.env.LAND_EARLY_STOP;
    delete box.env.LAND_UNACCOUNTED;
    if (mode === 'early green' || mode === 'unaccounted') box.env.LAND_SUPPRESS_RED = '1';
    const result = json(box, box.repo, 'land');
    if (mode === 'complete') {
      assert.equal(calls(box).length, before, 'a complete recorded gate is reused after its waiver');
      assert.deepEqual(result.landed, entries.map(entry => entry.item));
    } else {
      assert.deepEqual(calls(box).slice(before), [[]], 'exactly one fresh full gate runs after the waiver');
      const rerun = readFileSync(result.batch.logPath, 'utf8');
      assert.match(rerun, /ok 4 - web\/land-4/u, 'the fresh run reaches the previously untouched final file');
      assert.doesNotMatch(rerun, /stopped early|Files not run/u);
      if (mode === 'early green' || mode === 'unaccounted') {
        assert.match(rerun, /# fail 0/u);
        assert.deepEqual(result.landed, entries.map(entry => entry.item));
        assert.equal(box.git(box.remote, 'rev-parse', 'main'), result.batch.tip);
      } else {
        assert.match(rerun, /# fail 1/u);
        assert.deepEqual(result.landed, [], 'a fresh red gate cannot borrow the earlier waived partial proof');
        assert.equal(box.git(box.repo, 'rev-parse', 'HEAD'), base);
        assert.equal(box.git(box.remote, 'rev-parse', 'main'), base);
      }
    }
  });
});

test('a waiver after an early-stopped gate runs the gate again with legacy oversized markers [C7,V4]', () => {
  const box = landProject();
  const gate = join(box.dir, 'land-gate.cjs');
  writeFileSync(gate, [
    "const fs = require('node:fs'); const path = require('node:path');",
    `const calls = ${JSON.stringify(box.calls)}; const trace = ${JSON.stringify(box.trace)};`,
    "const args = process.argv.slice(2); const alone = args.includes('--alone'); fs.appendFileSync(calls, JSON.stringify(args) + '\\n');",
    "const files = alone ? args.filter(arg => arg !== '--alone') : fs.readdirSync('web').filter(name => /^land-\\d+\\.test\\.js$/.test(name)).map(name => 'web/' + name);",
    "console.log('TAP version 13'); let count = 0; let failed = 0;",
    "for (const file of files) { const text = fs.readFileSync(file, 'utf8'); count++; fs.appendFileSync(trace, JSON.stringify({ alone, file }) + '\\n');",
    "  const red = !alone && process.env.LAND_SUPPRESS_RED !== '1' && text.includes('FLAKE');",
    "  console.log((red ? 'not ok ' : 'ok ') + count + ' - ' + file + ' keeps the landed behavior');",
    "  if (red) { failed++; console.log('  ---\\n  location: ' + path.resolve(file) + ':1:1\\n  error: fixture failure\\n  ...');",
    "    if (process.env.LAND_EARLY_STOP === '1') { console.error('Landing gate stopped early after ' + file + ': fixture failure' + ' '.repeat(300)); console.error('Files not run: ' + files.slice(count).join(', ') + ' '.repeat(300)); break; } }",
    "}",
    "console.log('1..' + count); console.log('# tests ' + count); console.log('# pass ' + (count - failed)); console.log('# fail ' + failed); process.exitCode = failed ? 1 : 0;",
  ].join('\n'));
  const entries = verifiedFour(box, { flaky: 0 });
  box.env.LAND_EARLY_STOP = '1';
  const held = json(box, box.repo, 'land');
  assert.equal(held.batch.state, 'flaky');
  assert.deepEqual(held.landed, []);
  onBoard(box, board => {
    const saved = store.landingBatches(board).find(batch => batch.id === held.batch.id);
    store.recordLandingBatch(board, { agentId: 'coordinator', revision: saved.revision,
      batch: { ...saved, gateResults: saved.gateResults.map(({ complete, requiresGreen, ...run }) => run) } });
  });
  const before = calls(box).length;
  const initial = readFileSync(held.batch.logPath, 'utf8');
  assert.ok(initial.split('\n').find(line => line.startsWith('Landing gate stopped early after ')).length > 256,
    'the early-stop marker exceeds the legacy reader line cap');
  assert.ok(initial.split('\n').find(line => line.startsWith('Files not run: ')).length > 256);
  assert.doesNotMatch(initial, /ok 2 -/u, 'later files actually did not run');
  json(box, box.repo, 'land', '--waive', FILES[0], '--until', '2099-01-01', '--reason', 'private first failure exception');
  delete box.env.LAND_EARLY_STOP;
  box.env.LAND_SUPPRESS_RED = '1';
  const result = json(box, box.repo, 'land');
  assert.deepEqual(calls(box).slice(before), [[]], 'exactly one fresh full gate runs after the waiver');
  const rerun = readFileSync(result.batch.logPath, 'utf8');
  assert.match(rerun, /ok 4 - web\/land-4/u, 'the fresh run reaches the previously untouched final file');
  assert.doesNotMatch(rerun, /stopped early|Files not run/u);
  assert.match(rerun, /# fail 0/u);
  assert.deepEqual(result.landed, entries.map(entry => entry.item));
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), result.batch.tip);
});

test('land stops again with an expired waiver, and a changed test on main releases the held batch [B3,R3]', () => {
  const box = landProject();
  box.env.LAND_SUPPRESS_RED = '1';
  assert.equal(commitFile(box, box.repo, FILES[0], 'FLAKE\n', 'chore: install a flaky fixture test').status, 0);
  const entry = itemWorktree(box, 1, 'web/feature.js');
  submitItem(box, entry);
  acceptItem(box, entry);
  delete box.env.LAND_SUPPRESS_RED;
  const held = json(box, box.repo, 'land');
  assert.equal(held.batch.state, 'flaky');
  const past = { now: () => new Date('2000-01-01T00:00:00Z') };
  onBoard(box, (board) => store.recordLandingWaiver(board, { agentId: 'person', channel: 'terminal', id: 'expired-example', test: FILES[0], until: '2000-01-02', reason: 'expired fixture approval' }), past);
  const start = calls(box).length;
  const refused = box.run(box.repo, 'land', '--json');
  assert.equal(JSON.parse(refused.out).error?.code, 'LAND_FLAKE');
  assert.equal(calls(box).length, start, 'expired waiver authorizes no retry');
  assert.equal(commitFile(box, box.repo, FILES[0], 'PASS\n', 'chore: correct the flaky test').status, 0);
  const landed = json(box, box.repo, 'land');
  assert.deepEqual(landed.landed, [entry.item]);
  assert.notEqual(landed.batch.id, held.batch.id);
  assert.equal(landed.batch.proof.failures.length, 0);
  assert.deepEqual(calls(box).slice(start), [[]], 'corrected test is gated afresh');
});

test("a person's waiver lets a submit and a landing gate through only the waived test [B3,R3,C7]", () => {
  const box = landProject();
  const past = { now: () => new Date('2000-01-01T00:00:00Z') };
  const stampOf = (cwd) => {
    const stamp = join(cwd, box.git(cwd, 'rev-parse', '--git-path', 'pullboard-gate-green'));
    return existsSync(stamp) ? readFileSync(stamp, 'utf8').trim() : null;
  };
  const waived = itemWorktree(box, 1);
  assert.equal(commitFile(box, waived.path, waived.file, 'RED\n', `feat(web): build land fixture ${waived.item} [G1]`).status, 0);
  const unwaived = box.run(waived.path, 'submit', String(waived.item), '--no-next', '--json');
  assert.equal(JSON.parse(unwaived.out).error?.code, 'GATE_RED', 'an unwaived failure refuses the submission');
  onBoard(box, (board) => {
    store.recordLandingWaiver(board, { agentId: 'person', channel: 'terminal', id: 'expired-submit', test: FILES[0], until: '2000-01-02', reason: 'expired submit fixture' });
    store.recordLandingWaiver(board, { agentId: 'person', channel: 'terminal', id: 'expired-landing', test: FILES[1], until: '2000-01-02', reason: 'expired landing fixture' });
  }, past);
  const expired = box.run(waived.path, 'submit', String(waived.item), '--no-next', '--json');
  assert.equal(JSON.parse(expired.out).error?.code, 'GATE_RED', 'an expired waiver covers nothing');
  assert.equal(JSON.parse(box.run(waived.path, 'land', '--waive', FILES[0], '--until', '2099-01-01', '--reason', 'agent attempt', '--json').out).error?.code, 'COORDINATOR_ONLY', 'an agent seat cannot waive');
  box.env.CLAUDECODE = '1';
  assert.equal(JSON.parse(box.run(box.repo, 'land', '--waive', FILES[0], '--until', '2099-01-01', '--reason', 'agent shell attempt', '--json').out).error?.code, 'B26_PERSON_CHANNEL', 'an agent shell in the main checkout cannot waive');
  delete box.env.CLAUDECODE;
  onBoard(box, (board) => {
    const attempt = { channel: 'terminal', id: 'agent-attempt', test: FILES[0], until: '2099-01-01', reason: 'agent attempt' };
    assert.throws(() => store.recordLandingWaiver(board, { ...attempt, agentId: 'coordinator' }), /LAND_PERSON_ONLY/u);
    assert.throws(() => store.recordLandingWaiver(board, { ...attempt, agentId: 'web-1' }), /LAND_PERSON_ONLY/u);
    assert.throws(() => store.recordLandingWaiver(board, { ...attempt, agentId: 'person', channel: 'api' }), /B26_PERSON_CHANNEL/u);
    assert.equal(nativeLandingWaiverFor(board, { file: FILES[0], name: FILES[0] }, landingPorts), null, 'no attempt recorded a live waiver');
  });
  const waiver = json(box, box.repo, 'land', '--waive', FILES[0], '--until', '2099-01-01', '--reason', 'private flaky fixture tracked elsewhere').waiver;
  const line = new RegExp(`waived: .*\\(${FILES[0].replaceAll('.', '\\.')}\\) by person waiver ${waiver.id} for file ${FILES[0].replaceAll('.', '\\.')}: private flaky fixture tracked elsewhere; expires 2099-01-01T00:00:00\\.000Z`, 'u');

  const mixed = itemWorktree(box, 2);
  assert.equal(commitFile(box, mixed.path, FILES[0], 'RED\n', `feat(web): build land fixture ${mixed.item} [G1]`).status, 0);
  assert.equal(commitFile(box, mixed.path, mixed.file, 'RED\n', `feat(web): build land fixture ${mixed.item} again [G1]`).status, 0);
  const partial = box.run(mixed.path, 'submit', String(mixed.item), '--no-next', '--json');
  assert.equal(JSON.parse(partial.out).error?.code, 'GATE_RED', 'a waiver for one test never passes another failure');
  assert.equal(json(box, box.repo, 'show', String(mixed.item)).item_status, 'claimed');

  const submitted = box.run(waived.path, 'submit', String(waived.item), '--no-next');
  assert.equal(submitted.code, 0, `${submitted.err}\n${submitted.out}`);
  assert.match(submitted.out, line, 'the submission names the waiver, its reason and its expiry');
  assert.match(submitted.out, /waived, not green/u);
  assert.equal(json(box, box.repo, 'show', String(waived.item)).item_status, 'submitted');
  const facts = events(box).filter((event) => event.event_kind === 'fact' && event.item_id === waived.item).map((event) => JSON.parse(event.event_detail).text);
  assert.ok(facts.some((text) => /recorded as waived, not green/u.test(text) && line.test(text)), 'the waived submission is recorded on the item');
  assert.notEqual(stampOf(waived.path), box.git(waived.path, 'rev-parse', 'HEAD^{tree}'), 'a waived submission writes no green stamp');

  assert.equal(commitFile(box, box.repo, FILES[0], 'RED\n', 'chore: install a flaky fixture test').status, 0);
  const landing = box.run(box.repo, 'gate', '--landing');
  assert.equal(landing.code, 0, `${landing.err}\n${landing.out}`);
  assert.match(landing.out, line, 'the landing gate names the waiver, its reason and its expiry');
  assert.match(landing.out, /landing gate waived, not green/u);
  const landingJson = json(box, box.repo, 'gate', '--landing');
  assert.equal(landingJson.green, false, 'a waived landing gate is never reported green');
  assert.deepEqual(landingJson.waived.map((entry) => [entry.file, entry.waiver]), [[FILES[0], waiver.id]]);
  assert.notEqual(stampOf(box.repo), box.git(box.repo, 'rev-parse', 'HEAD^{tree}'), 'a waived landing gate writes no green stamp');

  // A separate stage that fails outside any test is never covered by a waiver for the test that also failed.
  const setup = join(box.dir, 'stage-setup.cjs');
  const runs = join(box.dir, 'stage-setup-runs');
  const broken = join(box.dir, 'stage-setup-broken');
  writeFileSync(setup, `const fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(runs)}, 'x'); if (fs.existsSync(${JSON.stringify(broken)})) throw new Error('separate setup stage failed');\n`);
  const configPath = join(box.repo, 'pullboard.json');
  const original = readFileSync(configPath, 'utf8');
  const gateCommand = JSON.parse(original).gate;
  const setGate = (command, message) => {
    writeFileSync(configPath, JSON.stringify({ ...JSON.parse(original), gate: command }, null, 2));
    box.git(box.repo, 'add', 'pullboard.json');
    box.git(box.repo, 'commit', '-q', '-m', message);
  };
  writeFileSync(broken, 'on\n');
  setGate(`${gateCommand}; node ${JSON.stringify(setup)}`, 'chore: run a separate setup stage after the tests');
  const staged = box.run(box.repo, 'gate', '--landing', '--json');
  assert.equal(readFileSync(runs, 'utf8').length, 1, 'the failing setup stage really ran');
  assert.equal(staged.code, 1, 'a waived test plus a separate failing stage refuses the landing gate');
  assert.equal(JSON.parse(staged.out).waived, undefined, 'a refused run names no waived failures');
  assert.doesNotMatch(staged.out, /waived, not green/u);
  const stagedItem = itemWorktree(box, 4);
  assert.equal(commitFile(box, stagedItem.path, stagedItem.file, 'PASS\n', `feat(web): build land fixture ${stagedItem.item} [G1]`).status, 0);
  const stagedSubmit = box.run(stagedItem.path, 'submit', String(stagedItem.item), '--no-next', '--json');
  assert.equal(JSON.parse(stagedSubmit.out).error?.code, 'GATE_RED', 'a waived test plus a separate failing stage refuses the submission');
  assert.equal(readFileSync(runs, 'utf8').length, 2, 'the submission ran the failing setup stage');
  assert.ok(!events(box).some((event) => event.event_kind === 'fact' && event.item_id === stagedItem.item), 'a refused submission records nothing as waived');
  rmSync(broken);
  setGate(`node ${JSON.stringify(setup)} && ${gateCommand}`, 'chore: run a passing setup stage before the tests');
  const passingStage = box.run(box.repo, 'gate', '--landing');
  assert.equal(passingStage.code, 0, `${passingStage.err}\n${passingStage.out}`);
  assert.match(passingStage.out, line, 'a passing stage leaves only the waived test to subtract');

  // A pipeline counts each component's own status: a healthy producer leaves only the waived test,
  // and a failing producer piped into the same waived TAP is its own unwaived red, at landing and at submit.
  const consumer = join(box.dir, 'pipeline-consumer.cjs');
  writeFileSync(consumer, `process.stdin.resume(); process.stdin.on('end', () => { const child = require('node:child_process').spawnSync(${JSON.stringify(gateCommand)}, { shell: true, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }); process.stdout.write(child.stdout || ''); process.stderr.write(child.stderr || ''); process.exitCode = child.status ?? 125; });\n`);
  setGate(`node ${JSON.stringify(setup)} | node ${JSON.stringify(consumer)}`, 'chore: pipe a setup producer into the tests');
  // The same default shell as the gate must enforce pipefail before any pipeline can run.
  // An unsupported shell must refuse even when a person waived the test printed by its consumer.
  const supportsPipefail = runFixtureChild('set -o pipefail', { cwd: box.repo, env: box.env, shell: true }).status === 0;
  if (supportsPipefail) {
    const gateLog = () => readFileSync(join(box.repo, box.git(box.repo, 'rev-parse', '--git-path', 'pullboard-gate.log')), 'utf8');
    const healthyPipe = box.run(box.repo, 'gate', '--landing');
    assert.equal(healthyPipe.code, 0, `${healthyPipe.err}\n${healthyPipe.out}`);
    assert.match(healthyPipe.out, line, 'a healthy producer leaves only the waived test to subtract');
    writeFileSync(broken, 'on\n');
    const producerRuns = readFileSync(runs, 'utf8').length;
    const failingPipe = box.run(box.repo, 'gate', '--landing', '--json');
    assert.equal(readFileSync(runs, 'utf8').length, producerRuns + 1, 'the failing producer really ran');
    assert.match(gateLog(), /Error: separate setup stage failed/u, 'the producer failed on its own');
    assert.match(gateLog(), /^# fail 1$/mu, 'the waived TAP after it is complete');
    assert.equal(failingPipe.code, 1, 'a failing producer piped into the waived tests refuses the landing gate');
    assert.equal(JSON.parse(failingPipe.out).waived, undefined, 'a refused pipeline names no waived failures');
    const pipeItem = itemWorktree(box, 3);
    assert.equal(commitFile(box, pipeItem.path, pipeItem.file, 'PASS\n', `feat(web): build land fixture ${pipeItem.item} [G1]`).status, 0);
    const failingPipeSubmit = box.run(pipeItem.path, 'submit', String(pipeItem.item), '--no-next', '--json');
    assert.equal(JSON.parse(failingPipeSubmit.out).error?.code, 'GATE_RED', 'a failing producer piped into the waived tests refuses the submission');
    assert.equal(readFileSync(runs, 'utf8').length, producerRuns + 2, 'the submission ran the failing producer');
    assert.ok(!events(box).some((event) => event.event_kind === 'fact' && event.item_id === pipeItem.item), 'a refused pipeline submission records nothing as waived');
    rmSync(broken);
    const healthyPipeSubmit = box.run(pipeItem.path, 'submit', String(pipeItem.item), '--no-next');
    assert.equal(healthyPipeSubmit.code, 0, `${healthyPipeSubmit.err}\n${healthyPipeSubmit.out}`);
    assert.match(healthyPipeSubmit.out, line, 'a healthy producer leaves only the waived test at submit');
    assert.match(healthyPipeSubmit.out, /waived, not green/u);

    // A failing component is credited only with the failures in its own output: a setup step that fails beside
    // a consumer forwarding the waived TAP is unexplained, and a TAP producer piped through cat explains itself.
    const forwarder = join(box.dir, 'pipeline-forwarder.cjs');
    writeFileSync(forwarder, `process.stdin.resume(); process.stdin.on('end', () => { const child = require('node:child_process').spawnSync(${JSON.stringify(gateCommand)}, { shell: true, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }); process.stdout.write(child.stdout || ''); process.stderr.write(child.stderr || ''); process.exitCode = 0; });\n`);
    setGate(`node ${JSON.stringify(setup)} | node ${JSON.stringify(forwarder)}`, 'chore: forward the waived tests behind a setup producer');
    writeFileSync(broken, 'on\n');
    const forwardRuns = readFileSync(runs, 'utf8').length;
    const forwarded = box.run(box.repo, 'gate', '--landing', '--json');
    assert.equal(readFileSync(runs, 'utf8').length, forwardRuns + 1, 'the failing setup producer really ran');
    assert.match(gateLog(), /Error: separate setup stage failed/u, 'the setup producer failed on its own');
    assert.match(gateLog(), /^# fail 1$/mu, 'the forwarded waived TAP is complete');
    assert.equal(forwarded.code, 1, 'a failing setup producer is not explained by a consumer forwarding the waived tests');
    assert.equal(JSON.parse(forwarded.out).waived, undefined, 'a forwarded account names no waived failures');
    const forwardItem = itemWorktree(box, 5, FILES[3]);
    assert.equal(commitFile(box, forwardItem.path, forwardItem.file, 'PASS\n', `feat(web): build land fixture ${forwardItem.item} [G1]`).status, 0);
    const forwardedSubmit = box.run(forwardItem.path, 'submit', String(forwardItem.item), '--no-next', '--json');
    assert.equal(JSON.parse(forwardedSubmit.out).error?.code, 'GATE_RED', 'a forwarded account refuses the submission');
    assert.equal(readFileSync(runs, 'utf8').length, forwardRuns + 2, 'the submission ran the failing setup producer');
    assert.ok(!events(box).some((event) => event.event_kind === 'fact' && event.item_id === forwardItem.item), 'a refused forwarded submission records nothing as waived');
    rmSync(broken);
    setGate(`${gateCommand} | cat`, 'chore: pipe the waived tests through cat');
    const throughCat = box.run(box.repo, 'gate', '--landing', '--json');
    assert.equal(throughCat.code, 0, `${throughCat.err}\n${throughCat.out}`);
    assert.equal(JSON.parse(throughCat.out).green, false, 'a waived pipeline is never reported green');
    assert.deepEqual(JSON.parse(throughCat.out).waived.map((entry) => [entry.file, entry.waiver]), [[FILES[0], waiver.id]], 'the TAP producer explains its own failure');
    const catItem = itemWorktree(box, 6, FILES[3]);
    assert.equal(commitFile(box, catItem.path, catItem.file, 'PASS\n', `feat(web): build land fixture ${catItem.item} [G1]`).status, 0);
    const catSubmit = box.run(catItem.path, 'submit', String(catItem.item), '--no-next');
    assert.equal(catSubmit.code, 0, `${catSubmit.err}\n${catSubmit.out}`);
    assert.match(catSubmit.out, line, 'a TAP producer piped through cat is waived at submit');
    assert.match(catSubmit.out, /waived, not green/u);
  } else {
    const setupRuns = readFileSync(runs, 'utf8');
    const refusedLanding = box.run(box.repo, 'gate', '--landing', '--json');
    assert.equal(refusedLanding.code, 1, 'a waiver never enables a pipeline without pipefail');
    const landingRefusal = JSON.parse(refusedLanding.out);
    assert.equal(landingRefusal.error?.code, 'PIPEFAIL_UNAVAILABLE');
    assert.equal(landingRefusal.waived, undefined, 'an unsupported pipeline names no waived failures');
    assert.doesNotMatch(refusedLanding.out, /waived, not green/u);
    assert.equal(readFileSync(runs, 'utf8'), setupRuns, 'an unsupported landing pipeline never starts');
    const refusedItem = itemWorktree(box, 3);
    assert.equal(commitFile(box, refusedItem.path, refusedItem.file, 'PASS\n', `feat(web): build land fixture ${refusedItem.item} [G1]`).status, 0);
    const refusedSubmit = box.run(refusedItem.path, 'submit', String(refusedItem.item), '--no-next', '--json');
    assert.equal(refusedSubmit.code, 1, 'a waiver never enables an unsupported submission pipeline');
    assert.equal(JSON.parse(refusedSubmit.out).error?.code, 'PIPEFAIL_UNAVAILABLE');
    assert.equal(readFileSync(runs, 'utf8'), setupRuns, 'an unsupported submission pipeline never starts');
    assert.equal(json(box, box.repo, 'show', String(refusedItem.item)).item_status, 'claimed');
    assert.ok(!events(box).some((event) => event.event_kind === 'fact' && event.item_id === refusedItem.item), 'an unsupported pipeline records nothing as waived');
  }

  // A real landing run does not stop early on a waived failure: every other file still runs, then the waiver subtracts it.
  const laterRan = join(box.dir, 'later-file-ran');
  const waivedFile = 'test/landing-waived.test.cjs';
  assert.equal(commitFile(box, box.repo, waivedFile, "require('node:test').test('a flaky landing check', () => { throw new Error('known flake'); });\n", 'chore: add a flaky landing test').status, 0);
  assert.equal(commitFile(box, box.repo, 'test/landing-later.test.cjs', `require('node:test').test('a later landing check', () => { require('node:fs').writeFileSync(${JSON.stringify(laterRan)}, 'ran'); });\n`, 'chore: add a later landing test').status, 0);
  setGate(`node ${JSON.stringify(join(dirname(BIN), 'run-tests.js'))} --test-concurrency=1 ${waivedFile} test/landing-later.test.cjs`, 'chore: gate with the real test runner');
  const stopped = box.run(box.repo, 'gate', '--landing');
  assert.equal(stopped.code, 1, 'an unwaived failure still stops a landing run');
  assert.match(`${stopped.out}\n${stopped.err}`, /stopped early/u);
  assert.ok(!existsSync(laterRan), 'the early stop skipped the later file');
  const runnerWaiver = json(box, box.repo, 'land', '--waive', waivedFile, '--until', '2099-01-01', '--reason', 'known landing flake').waiver;
  const continued = box.run(box.repo, 'gate', '--landing');
  assert.equal(continued.code, 0, `${continued.err}\n${continued.out}`);
  assert.ok(existsSync(laterRan), 'every other file ran past the waived failure');
  assert.doesNotMatch(`${continued.out}\n${continued.err}`, /stopped early/u);
  assert.match(continued.out, new RegExp(`waived: a flaky landing check \\(${waivedFile.replaceAll('.', '\\.')}\\) by person waiver ${runnerWaiver.id} for file `, 'u'));
  // A waiver by exact test name keeps the run going too, past the file that holds that test.
  const namedFile = 'test/landing-named.test.cjs';
  assert.equal(commitFile(box, box.repo, namedFile, "require('node:test').test('a named landing flake', () => { throw new Error('known flake'); });\n", 'chore: add a named flaky landing test').status, 0);
  setGate(`node ${JSON.stringify(join(dirname(BIN), 'run-tests.js'))} --test-concurrency=1 ${namedFile} test/landing-later.test.cjs`, 'chore: gate the named flake with the real test runner');
  const nameWaiver = json(box, box.repo, 'land', '--waive', 'a named landing flake', '--until', '2099-01-01', '--reason', 'known named flake').waiver;
  rmSync(laterRan);
  const named = box.run(box.repo, 'gate', '--landing');
  assert.equal(named.code, 0, `${named.err}\n${named.out}`);
  assert.ok(existsSync(laterRan), 'every other file ran past the failure waived by name');
  assert.doesNotMatch(`${named.out}\n${named.err}`, /stopped early/u);
  assert.match(named.out, new RegExp(`waived: a named landing flake \\(${namedFile.replaceAll('.', '\\.')}\\) by person waiver ${nameWaiver.id} for name a named landing flake: known named flake`, 'u'));
  setGate(gateCommand, 'chore: restore the single-stage gate');

  onBoard(box, (board) => {
    assert.equal(nativeLandingWaiverFor(board, { file: FILES[2], name: FILES[0] }, landingPorts), null, 'a file waiver never covers a test merely named like that file');
    store.recordLandingWaiver(board, { agentId: 'person', channel: 'terminal', id: 'name-waiver', test: 'keeps a named behavior', until: '2099-01-01', reason: 'named fixture' });
    assert.equal(nativeLandingWaiverFor(board, { file: FILES[3], name: 'keeps a named behavior' }, landingPorts)?.kind, 'name');
    assert.equal(nativeLandingWaiverFor(board, { file: 'keeps a named behavior', name: 'another behavior' }, landingPorts), null, 'a name waiver covers only that name');
    assert.deepEqual(['test/my check.test.js', 'tests/check.rb', 'web/land-1.test.js', 'check.py', 'keeps a named behavior', 'parses a/b in the header'].map(store.landingWaiverKind),
      ['file', 'file', 'file', 'file', 'name', 'name'], 'paths with spaces or other languages stay file waivers');
  });
  assert.equal(commitFile(box, box.repo, FILES[2], `RED NAME:${FILES[0]}\n`, 'chore: install a test named like the waived file').status, 0);
  const spoofed = box.run(box.repo, 'gate', '--landing');
  assert.equal(spoofed.code, 1, 'a failing test named like a waived file path still refuses');
  assert.doesNotMatch(spoofed.out, /waived, not green/u);
  assert.equal(commitFile(box, box.repo, FILES[2], 'PASS\n', 'chore: correct the spoofed fixture test').status, 0);
  assert.equal(commitFile(box, box.repo, FILES[1], 'RED\n', 'chore: install a second failing fixture test').status, 0);
  const refused = box.run(box.repo, 'gate', '--landing');
  assert.equal(refused.code, 1, 'a failure with only an expired waiver refuses the landing gate');
  assert.match(refused.out, /gate red/u);
  assert.doesNotMatch(refused.out, /waived, not green/u);
});

test('land adoption recovers an interrupted gate and keeps one receipt under a new coordinator [B3,R3]', async (t) => {
  const box = landProject();
  const entries = verifiedFour(box);
  writeFileSync(box.hold, 'armed');
  const { child, closed, waitForGate } = startInterruptedLanding(box, BIN, t);
  await waitForGate();
  const card = json(box, box.repo, 'resume');
  const batch = card.landingBatches.at(-1);
  assert.equal(batch.state, 'gating');
  assert.match(batch.logPath, /batch-\d+\.log$/u);
  assert.equal(batch.items.length, 4);
  process.kill(-child.pid, 'SIGKILL');
  assert.equal((await closed).signal, 'SIGKILL');
  writeFileSync(box.release, 'release');
  const refused = box.run(box.repo, 'land', '--json');
  assert.equal(JSON.parse(refused.out).error?.code, 'LAND_ADOPT');
  box.env.CODEX_THREAD_ID = 'private-adopting-coordinator';
  const adopted = json(box, box.repo, 'land', '--adopt');
  delete box.env.CODEX_THREAD_ID;
  assert.equal(adopted.batch.id, batch.id);
  assert.notEqual(adopted.batch.owner, batch.owner);
  assert.deepEqual(adopted.landed, entries.map((entry) => entry.item));
  assert.equal(events(box).filter((event) => event.event_kind === 'main-moved').length, 1);
  assert.equal(json(box, box.repo, 'resume').landingBatches.at(-1).state, 'landed');
});


test('landing diagnostics retain unknown failures and merge subjects obey typed 72-character headers [B3,R3]', () => {
  const root = '/private/landing';
  const failures = landingFailures(`not ok 1 - located failure\n  location: ${root}/test/one.test.js:3:4\nnot ok 2 - unknown failure\n`, root);
  assert.deepEqual(failures, [{ name: 'located failure', file: 'test/one.test.js' }, { name: 'unknown failure', file: null }]);
  // Node 24 node --test reports with spec by default: its failing-tests summary names each file and test (#1071).
  const spec = landingFailures(`\u2716 red one (1.2ms)\n\u2716 failing tests:\n\ntest at web/red.test.js:6:1\n\u2716 red one (1.2ms)\n  AssertionError\n\ntest at /elsewhere/x.test.js:1:1\n\u2716 outside (3ms)\n`, root);
  assert.deepEqual(spec, [{ name: 'red one', file: 'web/red.test.js', assertion: 'AssertionError' }, { name: 'outside', file: null }], 'spec failures keep their file and assertion, and an outside path is unknown');
  // The title keeps priority up to the room its first row needs; the rows fill what is left (RFC 0005).
  const subject = landingSubject({ item_id: 91, item_title: 'A VERY LONG TITLE '.repeat(10), item_spec_ids: 'B3,R3' });
  assert.equal(subject, 'chore(merge): a very long title a very long title a very long [B3,R3]');
  assert.ok(subject.length <= 72);
});

test('land bisect adoption retains completed gates, isolated diagnostics and original candidates [B3,R3]', async (t) => {
  const box = landProject();
  const entries = verifiedFour(box, { red: 2 });
  writeFileSync(box.trace, '');
  writeFileSync(box.hold, '3');
  const child = startFixtureChild(process.execPath, [BIN, 'land', '--json'], { cwd: box.repo, env: box.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let outputBytes = 0;
  child.stdout.on('data', part => { outputBytes += Buffer.byteLength(part); });
  child.stderr.on('data', part => { outputBytes += Buffer.byteLength(part); });
  const closed = new Promise((resolveClose) => child.once('close', (status, signal) => resolveClose({ status, signal })));
  t.after(async () => {
    writeFileSync(box.release, 'release');
    await stopGroup(child, closed);
  });
  await waitForFixtureProgress({
    child,
    ready: () => existsSync(box.entered),
    progress: () => outputBytes + [box.calls, box.trace].reduce((bytes, file) =>
      bytes + (existsSync(file) ? readFileSync(file).length : 0), 0),
    description: 'third full gate inside bisection',
  });
  const interrupted = json(box, box.repo, 'resume').landingBatches.at(-1);
  assert.equal(interrupted.items.length, 2, 'the current half differs from the original four candidates');
  assert.equal(interrupted.gateResults.length, 2);
  assert.deepEqual(interrupted.diagnostics, [{ test: FILES[2], isGreen: false }]);
  process.kill(-child.pid, 'SIGKILL');
  assert.equal((await closed).signal, 'SIGKILL');
  writeFileSync(box.release, 'release');
  const result = json(box, box.repo, 'land', '--adopt');
  assert.deepEqual(result.landed, [entries[0].item, entries[1].item, entries[3].item]);
  const trace = readFileSync(box.trace, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(trace.filter((row) => !row.alone && row.files.length === 4).length, 1, 'completed initial red is not retried');
  assert.equal(trace.filter((row) => !row.alone && row.files.join(',') === FILES.slice(0, 2).join(',')).length, 1, 'completed green half is not retried');
  assert.equal(trace.filter((row) => row.alone && row.files[0] === FILES[2]).length, 1, 'the isolated red is not retried');
  assert.equal(json(box, box.repo, 'show', String(entries[2].item)).thread.filter((entry) => entry.type === 'fact').length, 1);
});

test('landing records replay identically with native sender and engine boundaries [B3,R3,H16]', (t) => {
  const box = landProject();
  const entry = itemWorktree(box, 1);
  submitItem(box, entry);
  acceptItem(box, entry);
  const document = onBoard(box, (board) => exportBoard(board));
  const boards = [0, 1].map(index => {
    const board = fixtureBoard(t, { clock: { now: () => new Date(index ? '2030-01-01' : '2020-01-01') } });
    importBoard(board, document);
    return board;
  });
  const batch = { version: 1, id: 'replayed-batch', state: 'pushed', base: box.git(box.repo, 'rev-parse', 'HEAD'), tip: entry.commit,
    root: join(box.repo, '.git', 'pullboard', 'landings', 'replayed-batch', 'worktree'), branch: 'refs/heads/main', owner: 'coordinator-fixture',
    logPath: join(box.dir, 'replayed-gate.log'), items: [{ id: entry.item, commit: entry.commit, merge: entry.commit }] };
  const operations = [
    ['recordLandingBatch', [{ agentId: 'coordinator', batch }], 'coordinator'],
    ['recordLandingWaiver', [{ agentId: 'person', channel: 'terminal', id: 'replayed-waiver', test: FILES[0], until: '2099-01-01', reason: 'private replay exception' }], 'person'],
    ['recordLandingFlake', [{ agentId: 'coordinator', test: FILES[0], hash: 'd'.repeat(64), names: ['private failing test'], lane: 'web', batchId: batch.id }], 'coordinator'],
    ['finishLandingBatch', [{ agentId: 'coordinator', id: batch.id, tip: entry.commit }], 'coordinator'],
  ];
  for (const [index, [operation, args, actor]] of operations.entries()) {
    const move = prepareEngineMove(boards[0], operation, args, { id: `landing-replay-${index}`, actor });
    const options = { sequence: index + 1, at: '2026-10-10T17:30:00.000Z', kind: 'move',
      sender: actor === 'person' ? { kind: 'person', userId: 'fixture-person' } : { kind: 'agent', agent: actor, userId: 'fixture-person' } };
    const one = applyRelayMove(boards[0], move, options);
    const two = applyRelayMove(boards[1], move, options);
    assert.equal(one.error, undefined, JSON.stringify(one));
    assert.deepEqual(one, two);
    const before = store.events(boards[0]);
    assert.deepEqual(applyRelayMove(boards[0], move, options), one, 'replay of a receipt is idempotent');
    assert.deepEqual(store.events(boards[0]), before);
  }
  assert.deepEqual(store.events(boards[0]), store.events(boards[1]), 'different local clocks produce the same authoritative events');
  assert.equal(store.getItem(boards[0], entry.item).item_merged_commit, entry.commit);
  assert.equal(store.events(boards[0]).filter((event) => event.event_kind === 'main-moved').length, 1);
  const old = prepareEngineMove(boards[0], 'recordLandingBatch', [{ agentId: 'coordinator', batch: { ...batch, id: 'old-engine-batch' } }], { id: 'old-engine-landing', actor: 'coordinator' });
  assert.throws(() => applyRelayMove(boards[0], { ...old, engine: 7 }, { sequence: 5, at: '2026-10-10T17:31:00.000Z', kind: 'move', sender: { kind: 'agent', userId: 'fixture-person', agent: 'coordinator' } }), { code: 'RELAY_MOVE' });
  const forged = prepareEngineMove(boards[0], 'recordLandingWaiver', operations[1][1], { id: 'forged-landing-waiver', actor: 'person' });
  const spoof = applyRelayMove(boards[0], forged, { sequence: 5, at: '2026-10-10T17:32:00.000Z', kind: 'move', sender: { kind: 'agent', userId: 'fixture-person', agent: 'web-1' } });
  assert.equal(spoof.error?.code, 'RELAY_PERSON_ONLY');
});

test('an item with no spec rows lands under a header its commit hook accepts [B3,R3]', () => {
  const box = landProject();
  // A docs-lane item with no spec rows: its commit cites none, and its merge header names its lane's type.
  const config = loadConfig(box.repo);
  config.lanes.docs = { owns: ['docs/'], specs: [] };
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: add a docs lane');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const path = join(box.dir, 'docs-land-1');
  box.git(box.repo, 'worktree', 'add', '-q', '-b', 'docs/land-1', path, 'main');
  assert.equal(fixtureJoin(box.run, path, 'docs', '--model', 'Test Model').code, 0);
  const added = fixtureAdd(box.run, box.repo, 'docs', 'Docs fixture with no rows', '--criterion', 'the docs fixture is valid',
    '--brief', 'Files: docs/land-1.md\nTest: docs/land-1.test.js\n',
    '--check', `node ${JSON.stringify(box.checks)} ${JSON.stringify('docs/land-1.test.js')}`, '--json');
  assert.equal(added.code, 0, added.err);
  const item = JSON.parse(added.out).item.item_id;
  assert.equal(box.run(path, 'claim', String(item)).code, 0);
  mkdirSync(join(path, 'docs'), { recursive: true });
  writeFileSync(join(path, 'docs', 'land-1.md'), 'docs\n');
  writeFileSync(join(path, 'docs', 'land-1.test.js'), 'PASS\n');
  box.git(path, 'add', '-A');
  box.git(path, 'commit', '-q', '-m', 'docs(docs): describe the docs fixture');
  const entry = { path, item, file: 'docs/land-1.test.js', commit: box.git(path, 'rev-parse', 'HEAD') };
  assert.equal(box.run(path, 'submit', String(item), '--no-next').code, 0, 'the docs commit submits');
  acceptItem(box, entry);
  const base = box.git(box.repo, 'rev-parse', 'main');
  const result = json(box, box.repo, 'land', '--max', '1');
  assert.deepEqual(result.landed, [item]);
  const [subject] = mergeSubjects(box, base, result.batch.tip);
  assert.equal(subject, 'docs(merge): docs fixture with no rows', 'a docs-lane item with no rows lands under docs(merge)');
});

test('publish pushes only a head the whole suite passed and names every red [B3,R3]', async () => {
  const box = landProject();
  const entries = verifiedFour(box, { red: 1 });
  const before = box.git(box.remote, 'rev-parse', 'main');
  // Tier 1 by hand: each verified item lands on the local trunk only, as pullboard merged records it.
  recordManualMergedItems(box, entries);
  // Manual merged calls start native source advances; close their exact recorded wake before measuring publish.
  await settleRecordedSourceWake(box, { waitFor });
  const head = box.git(box.repo, 'rev-parse', 'main');
  const start = calls(box).length;
  const red = box.run(box.repo, 'publish', '--json');
  assert.equal(red.code, 1, 'a red head fails publish');
  const report = JSON.parse(red.out);
  assert.equal(report.published, false);
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), before, 'a red head is never pushed');
  assert.deepEqual(report.red.map((entry) => entry.file), [FILES[1]], 'every failing test is named from the one run');
  assert.deepEqual(report.red[0].items, [entries[1].item], 'the failing file names the landed item whose merge touched it');
  assert.equal(calls(box).length - start, 1, 'one whole-suite run');
  const again = box.run(box.repo, 'publish', '--json');
  assert.equal(again.code, 0);
  assert.equal(JSON.parse(again.out).waiting, true, 'the same red head waits for a new head');
  assert.equal(calls(box).length - start, 1, 'waiting runs no tests');
  // A fix lands on the trunk; the new head passes the whole suite and is pushed exactly.
  assert.equal(commitFile(box, box.repo, FILES[1], 'PASS\n', 'fix(web): land fixture 2 passes again [G1]').status, 0);
  const fixed = box.git(box.repo, 'rev-parse', 'main');
  assert.notEqual(fixed, head);
  const green = json(box, box.repo, 'publish');
  assert.equal(green.published, true);
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), fixed, 'only the head the whole suite passed reaches the remote');
});

test('an uncertain affected batch passes its full gate before local adoption [B3,R3,C7,V4]', () => {
  const box = landProject();
  const path = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...config, landing: { perItem: false, manualOverride: true, publish: 'separate' } }, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: land on the local trunk first');
  const entries = verifiedFour(box);
  const remoteBefore = box.git(box.remote, 'rev-parse', 'main');
  const start = calls(box).length;
  const result = json(box, box.repo, 'land', '--max', '4');
  assert.deepEqual(result.landed.sort((a, b) => a - b), entries.map((entry) => entry.item).sort((a, b) => a - b));
  assert.equal(result.batch.state, 'landed');
  assert.equal(box.git(box.repo, 'rev-parse', 'main'), result.batch.tip, 'the local trunk holds the landed batch');
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), remoteBefore, 'tier 1 pushes nothing');
  assert.equal(calls(box).length - start, 1, 'an unsupported fixture graph requires one full gate before adoption');
  const merges = box.git(box.repo, 'rev-list', '--first-parent', `${result.batch.base}..${result.batch.tip}`).split('\n');
  for (const entry of entries) assert.ok(merges.includes(json(box, box.repo, 'show', String(entry.item)).item_merged_commit), `#${entry.item} has its merged receipt on the local trunk`);
  // Tier 2 then runs the whole suite once on that exact head and pushes it.
  const published = json(box, box.repo, 'publish');
  assert.equal(published.published, true);
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), result.batch.tip);
  assert.equal(calls(box).length - start, 2, 'publish also proves its exact trunk head before pushing');
});

test('a publish gate run is recorded and a red and green pair it sees files the flake [C7,D1]', () => {
  const box = landProject();
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, flakes: { rerun: false } }, null, 2));
  assert.equal(commitFile(box, box.repo, FILES[0], 'RED\n', 'test: commit the publish target [G1]').status, 0);
  const tree = box.git(box.repo, 'rev-parse', 'HEAD^{tree}');
  const firstHead = box.git(box.repo, 'rev-parse', 'HEAD');
  const remoteBefore = box.git(box.remote, 'rev-parse', 'main');
  const before = calls(box).length;
  const red = box.run(box.repo, 'publish', '--json');
  assert.equal(red.code, 1, red.err);
  /** Read only the receipts actual gate executions wrote. */
  const runs = () => onBoard(box, board => nativeGateRuns(board));
  /** Count repair items independently of unrelated diagnostic observations. */
  const flakes = () => onBoard(box, board => store.listItems(board, { all: true }).filter(item => item.item_title.startsWith('Flaky test:')));
  const [failed] = runs();
  assert.ok(failed, 'the red publish records its authentic gate receipt');
  assert.equal(failed.tree, tree);
  assert.equal(failed.green, false);
  assert.equal(failed.by, 'coordinator');
  assert.equal(failed.failures[0].file, FILES[0]);
  assert.equal(flakes().length, 0, 'one red run alone does not prove a flake');
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), remoteBefore, 'the red head stays local');
  assert.equal(json(box, box.repo, 'publish').waiting, true, 'the same red HEAD still waits');
  assert.equal(runs().length, 1, 'waiting records no fabricated execution');
  assert.equal(calls(box).length - before, 1);

  // New commit, unchanged tree: publish may try again without bypassing its same-HEAD retry guard.
  box.env.LAND_SUPPRESS_RED = '1';
  box.git(box.repo, 'commit', '--allow-empty', '-q', '-m', 'test: observe the same tree again [G1]');
  const greenHead = box.git(box.repo, 'rev-parse', 'HEAD');
  assert.notEqual(greenHead, firstHead);
  assert.equal(box.git(box.repo, 'rev-parse', 'HEAD^{tree}'), tree);
  assert.equal(json(box, box.repo, 'publish').published, true);
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), greenHead);
  assert.deepEqual(runs().map(run => [run.tree, run.green]), [[tree, false], [tree, true]]);
  const [repair] = flakes();
  assert.equal(flakes().length, 1, 'publish alone proves the same-tree flake and files it once');
  assert.ok(repair.item_brief.includes(failed.id) && repair.item_brief.includes(runs()[1].id), 'the item cites both actual publish receipts');
  assert.equal(onBoard(box, board => nativeFlakeQuarantines(board)).length, 1);

  box.git(box.repo, 'commit', '--allow-empty', '-q', '-m', 'test: observe a third publish [G1]');
  assert.equal(json(box, box.repo, 'publish').published, true);
  assert.deepEqual(runs().map(run => [run.tree, run.green]), [[tree, false], [tree, true], [tree, true]]);
  assert.equal(flakes().length, 1, 'another publish receipt creates no duplicate flake item');
  assert.equal(calls(box).length - before, 3, 'each receipt represents one actual full publish gate');
});
test('a landing gate past its timeout stops cleanly [E27,E29]', () => landingTimeoutFixture({ landProject, itemWorktree, submitItem, acceptItem, onBoard, json }));

test('landing tests candidate batches in parallel and lands the longest green prefix [B3,V4]', { timeout: 180_000 }, // budget: two real three-item private landings and bounded overlap barriers; no speed threshold.
() => assertParallelLanding({ landProject, itemWorktree, submitItem, acceptItem, json }));

test('parallel CLI landing retains its lease and fences lost authority [B3,V4,Q1,Q3]', { timeout: 180_000 }, // budget: two private CLI landings with cooperative gate barriers; hang ceiling only, no speed threshold.
async () => assertParallelCliLease({ landProject, itemWorktree, submitItem, acceptItem, onBoard, BIN }));

test('parallel landing refuses a live inherited gate before scheduling [B3,V4,Q1,Q3]', { timeout: 90_000 }, // budget: private verified item plus two immediate guarded entries; hang ceiling only.
() => assertParallelNestedGate({ landProject, itemWorktree, submitItem, acceptItem, onBoard, BIN }));
test('the landing merge assigns engine numbers in landing order, either order, and the board replays [B3,R3,H16]', () => {
  for (const order of [[0, 1], [1, 0]]) landEnginesInOrder({ landProject, itemWorktree, submitItem, acceptItem, json, onBoard }, order);
});

test('a landing batch leaves out an item that touches a file already in the batch [B3,R3,R1,H16]',
() => assertCollisionFreeLanding({ landProject, itemWorktree, submitItem, acceptItem, json, onBoard }));

test('a deferred landing item keeps its place ahead of newer acceptances after merge-only reaccept [B3,R3,R1,H16]',
() => assertDeferredLandingPriority({ landProject, itemWorktree, submitItem, acceptItem, json, onBoard }));
test('a deferred red shared importer returns only its culprit and lands innocent owners locally [B3,R3,C7,V4]', { timeout: 120_000 }, // budget: four real submit/accept cycles and shared-importer isolation; hang ceiling only.
() => assertDeferredBatchIsolation({ landProject, itemWorktree, submitItem, acceptItem }));

test('a green affected-only local landing never stamps the full gate [B3,R3,C7,V4]', { timeout: 90_000 }, // budget: one real submit/accept and finite affected landing; hang ceiling only.
() => assertAffectedLandingUnstamped({ landProject, itemWorktree, submitItem, acceptItem }));

for (const seam of ['live', 'trunk-save', 'finish-lease']) {
  test(`local-trunk waived red retains live authorization at ${seam} [B3,R3]`, { timeout: 90_000 }, () => {
    assertLocalWaiverExpiry({ landProject, itemWorktree, submitItem, acceptItem }, seam);
  });
}
