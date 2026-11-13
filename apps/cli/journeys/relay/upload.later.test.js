/** @pullboard-test-input apps/cli/pullboard.js apps/lib/index.js apps/lib/src/io/worker/checkpoint/relay.js packages/link/index.js packages/outbox/index.js */
/** Legacy API1 refusals recover without blocking moves; current API2 pause proofs live in relay-upload-pause.test.js [H16,B26]. */
import assert from 'node:assert/strict';
import { runFixtureChild as spawnSync } from '../../tests/fixtures/child.js';
import {
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { ENGINE_VERSION } from '../../../../packages/state/index.js';
import {
  closingFetch,
  relayClientFixture,
  uploadedState,
} from '../../tests/fixtures/relay/upload.js';

/** A refused checkpoint after an accepted baseline does not switch moves to local-only mode. */
test('a refused later checkpoint keeps ordered moves [H16]', async (subtest) => {
  const accepted = await relayClientFixture(subtest);
  await accepted.link();
  accepted.rejectSnapshots({ status: 400, code: 'BAD_UPLOAD', message: 'fixture checkpoint refusal' });
  const first = await accepted.cli('add', accepted.lane, 'ordered move before checkpoint refusal');
  assert.equal(first.code, 0, 'the move remains ordered after baseline acceptance');
  const second = await accepted.cli('add', accepted.lane, 'ordered move during checkpoint refusal');
  assert.equal(second.code, 0, 'a permanent later checkpoint refusal does not pause ordered moves');
  assert.doesNotMatch((second.document.diagnostics ?? []).join('\n'), /relay paused/u);
  const link = JSON.parse(readFileSync(accepted.linkFile, 'utf8'));
  const response = await closingFetch(`${accepted.origin}/api/v1/boards/${link.board}/events?after=0`, {
    headers: { authorization: `Bearer ${link.token}`, 'x-pullboard-engine': String(ENGINE_VERSION) },
  });
  assert.equal(response.status, 200);
  const events = (await response.json()).events;
  assert.deepEqual(events.map(event => event.event_id), [1, 2], 'both post-baseline moves keep their relay positions');
});

/** The accepted-baseline path stays ordered while one actionable line survives internal retries. */
test('a refused later checkpoint names its repair once on every native agent command [H16,B26]', async t => {
  const box = await relayClientFixture(t);
  const configPath = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const lane = 'fixture-build';
  const gate = 'node --check src/relay-checkpoint-fixture.js';
  config.gate = gate;
  config.lanes[lane] = { owns: ['src/'], specs: ['G'] };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  const specPath = join(box.root, 'SPEC.md');
  writeFileSync(specPath, readFileSync(specPath, 'utf8').replace('\n## K · Constraints',
    `\n- G1 [approved, must] The checkpoint fixture parses. | gate: ${gate}\n\n## K · Constraints`));
  const added = await box.cliLocal('add', lane, 'accepted baseline work', '--specs', 'G1', '--criterion', 'the fixture source parses',
    '--brief', 'Files: src/relay-checkpoint-fixture.js\nTest: the fixture source parses', '--check', gate);
  assert.equal(added.code, 0);
  const item = added.document.item.item_id;
  symlinkSync(resolve(import.meta.dirname, '../../pullboard.js'), join(box.env.PATH, 'pullboard'));
  assert.equal(spawnSync('git', ['add', '-A'], { cwd: box.root, env: box.env }).status, 0);
  assert.equal(spawnSync('git', ['commit', '-q', '-m', 'chore(test): prepare checkpoint fixture'], { cwd: box.root, env: box.env }).status, 0);
  const agentRoot = join(box.root, '..', 'later-checkpoint-agent');
  assert.equal(spawnSync('git', ['worktree', 'add', '-q', '-b', 'fixture-later-checkpoint-agent', agentRoot, 'HEAD'], { cwd: box.root, env: box.env }).status, 0);
  await box.link();
  assert.equal((await box.cliAtLocal(agentRoot, 'join', lane)).code, 0);
  assert.ok(JSON.parse(readFileSync(box.linkFile, 'utf8')).baselineAccepted);
  box.rejectSnapshots({ status: 503, code: 'RELAY_UNAVAILABLE', message: 'temporary checkpoint refusal' });
  assert.equal((await box.cliLocal('shout', 'all', 'private transient checkpoint change')).code, 0);
  const transient = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  assert.ok(transient.checkpoint, 'a transient checkpoint keeps its exact queued ciphertext');
  assert.equal(transient.checkpointRefusal, undefined, 'a retryable response never becomes a permanent checkpoint diagnostic');
  box.rejectSnapshots(null);
  assert.equal((await box.cliWithSnapshotTrace(1, 'status')).code, 0); // traced child: the one retry upload is part of the proof
  assert.equal(JSON.parse(readFileSync(box.linkFile, 'utf8')).checkpoint, undefined, 'a later read retries the transient checkpoint without requiring another change');
  const baselineSequence = (await uploadedState(box)).sequence;
  box.rejectSnapshots({ status: 400, code: 'BAD_UPLOAD', message: 'malformed sealed snapshot' });

  /** Leave a genuinely refused checkpoint pending before each measured command. */
  async function seed() {
    assert.equal((await box.cliLocal('shout', 'all', 'private checkpoint seeding change')).code, 0);
    assert.ok(JSON.parse(readFileSync(box.linkFile, 'utf8')).checkpoint);
  }
  /** Demand one bounded diagnostic with upload, reason and the coordinator's concrete repair. */
  function diagnostic(result, name) {
    const lines = result.document.diagnostics ?? [];
    assert.equal(lines.length, 1, name + ' prints one diagnostic across preflight, move and postflight: ' + JSON.stringify(lines));
    assert.match(lines[0], /relay checkpoint refused for [0-9a-f]{32}: BAD_UPLOAD malformed sealed snapshot/u);
    assert.match(lines[0], /moves still sync in order; a fresh checkpoint goes up on the next change/u);
    assert.match(lines[0], /upgrade pullboard \(npm i -g pullboard\) or run pullboard relay off then relay on --all/u);
    assert.doesNotMatch(lines[0], /\n|run pullboard status to see pending uploads|relay paused/u);
  }
  await seed();
  const claimed = await box.cliAtLocal(agentRoot, 'claim', String(item));
  assert.equal(claimed.code, 0); diagnostic(claimed, 'claim');
  mkdirSync(join(agentRoot, 'src'), { recursive: true });
  writeFileSync(join(agentRoot, 'src/relay-checkpoint-fixture.js'), 'export const checkpoint = true;\n');
  assert.equal(spawnSync('git', ['add', 'src/relay-checkpoint-fixture.js'], { cwd: agentRoot, env: box.env }).status, 0);
  assert.equal(spawnSync('git', ['commit', '-q', '-m', 'feat(fixture-build): complete checkpoint work [G1]'], { cwd: agentRoot, env: box.env }).status, 0);
  await seed();
  const submitted = await box.cliAtLocal(agentRoot, 'submit', String(item));
  assert.equal(submitted.code, 0); diagnostic(submitted, 'submit');
  await seed();
  const shouted = await box.cliAtLocal(agentRoot, 'shout', 'all', 'ordered agent with refused checkpoint');
  assert.equal(shouted.code, 0); diagnostic(shouted, 'shout');
  for (const command of ['status', 'doctor']) {
    await seed();
    const result = await box.cliAtLocal(agentRoot, command);
    assert.ok([0, 1].includes(result.code)); diagnostic(result, command);
    if (command === 'doctor') {
      const finding = result.document.problems.find(problem => problem.code === 'RELAY_CHECKPOINT_REFUSED');
      assert.ok(finding, 'doctor exposes a repair finding as well as its single diagnostic');
      assert.match(finding.next, /npm i -g pullboard.*relay off.*relay on --all/u);
    }
  }
  for (const command of ['status', 'doctor']) {
    const text = await box.script(`
      const { main } = await import(${JSON.stringify(box.mainURL)});
      let stdout = '', stderr = '';
      const code = await main([${JSON.stringify(command)}], {
        cwd: process.cwd(), stdout: { write(value) { stdout += value; } }, stderr: { write(value) { stderr += value; } },
      });
      console.log(JSON.stringify({ code, stdout, stderr }));
    `);
    assert.equal(text.code, 0);
    const lines = (text.document.stdout + text.document.stderr).split('\n').filter(line => line.includes('relay checkpoint refused for '));
    assert.equal(lines.length, 1, command + ' text mode also prints only one actionable upload line');
    assert.match(text.document.stdout, /relay checkpoint refused for /u, 'text readers preserve their existing stdout diagnostic');
    assert.match(lines[0], /npm i -g pullboard.*relay off.*relay on --all/u);
    assert.doesNotMatch(text.document.stderr, /relay checkpoint refused for /u);
  }
  const refused = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  assert.equal(refused.baselinePause, undefined);
  const remote = await closingFetch(box.origin + '/api/v1/boards/' + refused.board + '/events?after=' + baselineSequence, {
    headers: { authorization: 'Bearer ' + refused.token, 'x-pullboard-engine': String(ENGINE_VERSION) },
  });
  assert.equal(remote.status, 200);
  const records = (await remote.json()).events;
  assert.deepEqual(records.map(record => record.event_id), records.map((_, index) => baselineSequence + index + 1));
  assert.ok(records.some(record => record.sender.kind === 'agent'), 'agent effects stay in authenticated relay order');
  box.rejectSnapshots(null);
  assert.equal((await box.cliAtLocal(agentRoot, 'shout', 'all', 'fresh checkpoint after repair')).code, 0);
  const recovered = await box.cliAtLocal(agentRoot, 'status');
  assert.equal((recovered.document.diagnostics ?? []).length, 0, 'fresh accepted checkpoint clears the refusal');
  assert.equal(JSON.parse(readFileSync(box.linkFile, 'utf8')).checkpointRefusal, undefined);
  assert.equal((await uploadedState(box)).sequence, baselineSequence + records.length + 1);
});

/** One long-lived caller can acknowledge several distinct moves without hiding later warnings. */
test('a refused later checkpoint names each distinct ordered move with the same io [H16,B26]', async t => {
  const box = await relayClientFixture(t);
  await box.link();
  box.rejectSnapshots({ status: 400, code: 'BAD_UPLOAD', message: 'malformed sealed snapshot' });
  assert.equal((await box.cliLocal('shout', 'all', 'seed the per-move checkpoint refusal')).code, 0);
  assert.ok(JSON.parse(readFileSync(box.linkFile, 'utf8')).checkpointRefusal);
  const before = box.moveAcks.length;
  const result = await box.script(`
    const { relayOperation, syncRelay } = await import(${JSON.stringify(new URL('../../../../packages/link/index.js', import.meta.url).href)});
    const { withOutboxGuard } = await import(${JSON.stringify(new URL('../../../../packages/outbox/index.js', import.meta.url).href)});
    const { replay: replayConflictRecord } = await import(${JSON.stringify(new URL('../../../../packages/outbox/index.js', import.meta.url).href)});
    const { remoteBoardMissing, uncertainUploadFailure, decideUncertainBaseline } = await import(${JSON.stringify(new URL('../../../../packages/outbox/index.js', import.meta.url).href)});
      const { checkpointInBackground, scheduleCheckpoint, requestCheckpointCheck } = await import(${JSON.stringify(new URL('../../../../packages/outbox/index.js', import.meta.url).href)});
      const { flushOutbox, queueMove, outboxHasPendingCreatedItem, outboxFields, ACKNOWLEDGED_OPERATIONS, outboxQueueable } = await import(${JSON.stringify(new URL('../../../../packages/outbox/index.js', import.meta.url).href)});
      const { openBoard, nativeBoardPorts } = await import(${JSON.stringify(new URL('../../../lib/index.js', import.meta.url).href)});
      const { checkpointPublisher } = await import(${JSON.stringify(new URL('../../../../packages/outbox/index.js', import.meta.url).href)});
      const { relayOrdering } = await import(${JSON.stringify(new URL('../../../../packages/outbox/index.js', import.meta.url).href)});
    const root = process.cwd();
    const lines = [];
    const io = { checkpointWorker: ${JSON.stringify(new URL('../../../lib/src/io/worker/checkpoint/relay.js', import.meta.url).pathname)}, openBoard, nativeBoardPorts, withOutboxGuard, replayConflictRecord, remoteBoardMissing, uncertainUploadFailure, decideUncertainBaseline, checkpointPublisher, relayOrdering, checkpointInBackground, scheduleCheckpoint, requestCheckpointCheck, outboxPolicy: () => ({ acknowledgedOperations: ACKNOWLEDGED_OPERATIONS, outboxQueueable }), outboxFields, flushOutbox, queueMove, outboxHasPendingCreatedItem, cwd: root, say(value) { lines.push(value); }, err(value) { lines.push(value); } };
    const notices = () => lines.filter(line => line.includes('relay checkpoint refused for '));
    await syncRelay(root, io);
    const first = await relayOperation(root, 'shout', [{ from: 'coordinator', to: 'all', text: 'same io first ordered move', lanes: [] }], io);
    await syncRelay(root, io);
    const firstCount = notices().length;
    const second = await relayOperation(root, 'shout', [{ from: 'coordinator', to: 'all', text: 'same io second ordered move', lanes: [] }], io);
    await syncRelay(root, io);
    await syncRelay(root, io);
    const directCount = notices().length;
    io.relayCommand = { cliOperation: 'submit', cwd: root };
    await syncRelay(root, io);
    await relayOperation(root, 'shout', [{ from: 'coordinator', to: 'all', text: 'command bookkeeping first', lanes: [] }], { ...io });
    await relayOperation(root, 'shout', [{ from: 'coordinator', to: 'all', text: 'command bookkeeping second', lanes: [] }], { ...io });
    const commandCount = notices().length;
    io.relayCommand = { cliOperation: 'submit', cwd: root };
    await syncRelay(root, io);
    await relayOperation(root, 'shout', [{ from: 'coordinator', to: 'all', text: 'next independent command', lanes: [] }], io);
    console.log(JSON.stringify({ first: Number.isSafeInteger(first), second: Number.isSafeInteger(second), firstCount, directCount, commandCount, lines: notices() }));
  `);
  assert.equal(result.code, 0);
  assert.equal(result.document.first, true);
  assert.equal(result.document.second, true);
  assert.equal(box.moveAcks.length - before, 5, 'all distinct moves are acknowledged through the real ordered relay');
  assert.equal(result.document.firstCount, 1, 'preflight, one move and repeated synchronization share one diagnostic');
  assert.equal(result.document.directCount, 2, 'two distinct acknowledged moves sharing io each name the refused checkpoint');
  assert.equal(result.document.commandCount, 3, 'preflight and cloned bookkeeping io share one logical command notice');
  assert.equal(result.document.lines.length, 4, 'the next independent command sharing io receives a fresh notice');
  for (const line of result.document.lines) {
    assert.match(line, /relay checkpoint refused for [0-9a-f]{32}: BAD_UPLOAD malformed sealed snapshot/u);
    assert.match(line, /moves still sync in order.*npm i -g pullboard.*relay off then relay on --all/u);
  }
  // Read the committed shout rows straight from the board file: no CLI child is needed to count them.
  const db = new DatabaseSync(join(box.root, '.git', 'pullboard', 'board.sqlite'), { readOnly: true });
  try {
    for (const text of ['same io first ordered move', 'same io second ordered move']) {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shout WHERE shout_text = ?').get(text).n, 1,
        'each acknowledged move has exactly one committed native effect');
    }
  } finally { db.close(); }
});
