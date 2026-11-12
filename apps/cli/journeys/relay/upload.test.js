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
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import {
  decodeBoardKey,
  unseal,
} from '../../../../packages/kernel/index.js';
import { ENGINE_VERSION } from '../../../../packages/state/index.js';
import { legacyRelayClientFixture as relayClientFixture } from '../../tests/fixtures/relay/client.js';

// The subtests each start their own private relay fixture, so they run side by side: back to back they outlast the file's wall limit on a loaded runner.
test('a refused upload never blocks board moves [H16,B26]', { concurrency: 4 }, async (t) => {
  const pending = [];
  const sub = (...args) => { const run = t.test(...args); pending.push(run); return run; };
  const box = await relayClientFixture(t);
  const buildLane = 'fixture-build';
  const gate = 'node --check src/relay-pause-fixture.js';
  const configPath = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.gate = gate;
  config.lanes[buildLane] = { owns: ['src/'], specs: ['G'], starts: 'now' };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  const specPath = join(box.root, 'SPEC.md');
  const spec = readFileSync(specPath, 'utf8').replace('\n## K · Constraints',
    `\n- G1 [approved, must] The fixture builder's file parses. | gate: ${gate}\n\n## K · Constraints`);
  writeFileSync(specPath, spec);
  const added = await box.cliLocal('add', buildLane, 'paused relay fixture task', '--specs', 'G1', '--criterion', 'the fixture agent completes this task',
    '--brief', 'Files: src/relay-pause-fixture.js\nTest: the fixture source parses', '--check', gate);
  assert.equal(added.code, 0, `the fixture creates its task; result=${JSON.stringify(added.document)}`);
  const item = added.document.item.item_id;
  box.rejectSnapshots({ status: 400, code: 'BAD_REQUEST', message: 'fixture refuses the initial baseline until repaired' });
  const linked = await box.link();
  assert.equal((linked.document.diagnostics ?? []).filter(line => /relay paused/u.test(line)).length, 1);
  const status = await box.cliLocal('status');
  assert.equal(status.code, 0);
  assertPaused(status.document);
  const pausedLink = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  assert.deepEqual(Object.keys(pausedLink.baselinePause).sort(), ['code', 'message', 'status'],
    'a small refused baseline persists only its bounded safe diagnostic');
  assert.equal(pausedLink.baselinePause.status, 400);
  assert.ok(pausedLink.baselinePause.message.length <= 240);
  assert.doesNotMatch(JSON.stringify(pausedLink.baselinePause), /(?:ps|pa)_[A-Za-z0-9_-]{20,}/u);
  assert.ok(pausedLink.snapshot, 'refused ciphertext remains durable until a recovered baseline includes all paused local work');
  const diagnosed = await box.cliLocal('doctor');
  assert.ok([0, 1].includes(diagnosed.code));
  assertPaused(diagnosed.document);

  symlinkSync(resolve(import.meta.dirname, '../../pullboard.js'), join(box.env.PATH, 'pullboard'));
  const staged = spawnSync('git', ['add', '-A'], { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.equal(staged.status, 0, staged.stderr);
  const seeded = spawnSync('git', ['commit', '-m', 'chore(test): seed relay pause fixture'], { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.equal(seeded.status, 0, seeded.stderr);
  const agentRoot = join(box.root, '..', 'relay-stuck-upload-agent');
  const worktree = spawnSync('git', ['worktree', 'add', '-b', 'fixture-relay-stuck-agent', agentRoot, 'HEAD'], {
    cwd: box.root, env: box.env, encoding: 'utf8',
  });
  assert.equal(worktree.status, 0, worktree.stderr);

  const joined = await box.cliAtLocal(agentRoot, 'join', buildLane);
  assert.equal(joined.code, 0);
  assertPaused(joined.document);
  const claimed = await box.cliAtLocal(agentRoot, 'claim', String(item));
  assert.equal(claimed.code, 0, `the linked agent claims locally while no relay baseline exists; result=${JSON.stringify(claimed.document)}`);
  assertPaused(claimed.document);

  mkdirSync(join(agentRoot, 'src'), { recursive: true });
  writeFileSync(join(agentRoot, 'src/relay-pause-fixture.js'), 'export const relayPauseFixture = true;\n');
  const stagedChange = spawnSync('git', ['add', 'src/relay-pause-fixture.js'], { cwd: agentRoot, env: box.env, encoding: 'utf8' });
  assert.equal(stagedChange.status, 0, stagedChange.stderr);
  const committed = spawnSync('git', ['commit', '-m', 'feat(fixture-build): complete relay pause fixture [G1]'], { cwd: agentRoot, env: box.env, encoding: 'utf8' });
  assert.equal(committed.status, 0, committed.stderr);
  const submitted = await box.cliAtLocal(agentRoot, 'submit', String(item));
  assert.equal(submitted.code, 0, 'the linked agent submits locally while the baseline is refused');
  assertPaused(submitted.document);
  const shouted = await box.cliAtLocal(agentRoot, 'shout', 'all', 'Relay pause fixture remains available');
  assert.equal(shouted.code, 0, 'the linked agent shouts locally while the baseline is refused');
  assertPaused(shouted.document);

  box.rejectSnapshots(null);
  const resumed = await box.cliAtLocal(agentRoot, 'status');
  assert.equal(resumed.code, 0);
  assert.doesNotMatch((resumed.document.diagnostics ?? []).join('\n'), /relay paused/u, 'a fitting snapshot clears the pause');
  // Submit records a background review comparison fact (499990d401); that one native move queues while paused and may follow the baseline.
  const sentOperations = async () => {
    const key = decodeBoardKey(readFileSync(box.keyFile, 'utf8').trim());
    const board = JSON.parse(readFileSync(box.linkFile, 'utf8')).board;
    return Promise.all(box.moveAcks.map(async row => JSON.parse(new TextDecoder().decode(
      await unseal(key, Buffer.from(row.sealed, 'base64url'), { boardId: board, kind: row.kind, sequence: row.event_id }))).operation));
  };
  assert.deepEqual((await sentOperations()).filter(operation => operation !== 'appendFact'), [],
    'no paused local move was sent before its baseline existed');
  const baseline = await uploadedState(box);
  assert.equal(baseline.sequence, box.moveAcks.length, 'the baseline checkpoint covers only the queued review fact move, if it was sent');
  assert.equal(baseline.document.tables.item.find(row => row.item_id === item).item_status, 'submitted',
    'the accepted fresh baseline includes the local claim and submission');
  assert.ok(baseline.document.tables.shout.some(row => row.shout_text === 'Relay pause fixture remains available'),
    'the fresh baseline retains the local shout');
  assert.ok(baseline.document.tables.agent.some(row => row.agent_path === agentRoot),
    'the fresh baseline retains the locally enrolled agent');
  const ordered = await box.cliAtLocal(agentRoot, 'shout', 'all', 'The relay baseline has resumed');
  assert.equal(ordered.code, 0);
  assert.doesNotMatch((ordered.document.diagnostics ?? []).join('\n'), /relay paused/u);
  const operations = await sentOperations();
  assert.deepEqual(operations.slice(-1), ['shout']);
  assert.deepEqual(box.moveAcks.map(row => row.event_id), operations.map((operation, index) => index + 1),
    'the real relay ACK places the first post-recovery native move immediately after its baseline');
  const final = await uploadedState(box);
  assert.equal(final.sequence, operations.length, 'the native checkpoint covers the post-recovery move');
  assert.ok(final.document.tables.shout.some(row => row.shout_text === 'The relay baseline has resumed'));


  /** Each internal move in a long-running command retains its own loud pause notice. */
  sub('multiple local moves in one session do not repeat the refused baseline notice [H16,B26]', async subtest => {
    const repeated = await relayClientFixture(subtest);
    repeated.rejectSnapshots({ status: 400, code: 'BAD_REQUEST', message: 'fixture refuses the initial baseline until repaired' });
    await repeated.link();
    const before = repeated.calls.filter(call => call.method === 'PUT' && call.path.endsWith('/state')).length;
    const result = await repeated.script(`
      const { syncRelay, relayOperation } = await import(${JSON.stringify(new URL('../../../../packages/link/index.js', import.meta.url).href)});
      const { withOutboxGuard } = await import(${JSON.stringify(new URL('../../../../packages/outbox/index.js', import.meta.url).href)});
      const { replay: replayConflictRecord } = await import(${JSON.stringify(new URL('../../../../packages/outbox/index.js', import.meta.url).href)});
      const { remoteBoardMissing, uncertainUploadFailure, decideUncertainBaseline } = await import(${JSON.stringify(new URL('../../../../packages/outbox/index.js', import.meta.url).href)});
      const { checkpointInBackground, scheduleCheckpoint, requestCheckpointCheck } = await import(${JSON.stringify(new URL('../../../../packages/outbox/index.js', import.meta.url).href)});
      const { flushOutbox, queueMove, outboxHasPendingCreatedItem, outboxFields, ACKNOWLEDGED_OPERATIONS, outboxQueueable } = await import(${JSON.stringify(new URL('../../../../packages/outbox/index.js', import.meta.url).href)});
      const { openBoard, nativeBoardPorts } = await import(${JSON.stringify(new URL('../../../lib/index.js', import.meta.url).href)});
      const { checkpointPublisher } = await import(${JSON.stringify(new URL('../../../../packages/outbox/index.js', import.meta.url).href)});
      const { relayOrdering } = await import(${JSON.stringify(new URL('../../../../packages/outbox/index.js', import.meta.url).href)});
      const diagnostics = [];
      const io = { checkpointWorker: ${JSON.stringify(new URL('../../../lib/src/io/worker/checkpoint/relay.js', import.meta.url).pathname)}, openBoard, nativeBoardPorts, withOutboxGuard, replayConflictRecord, remoteBoardMissing, uncertainUploadFailure, decideUncertainBaseline, checkpointPublisher, relayOrdering, checkpointInBackground, scheduleCheckpoint, requestCheckpointCheck, outboxPolicy: () => ({ acknowledgedOperations: ACKNOWLEDGED_OPERATIONS, outboxQueueable }), outboxFields, flushOutbox, queueMove, outboxHasPendingCreatedItem, /** Retain safe diagnostic lines for exact per-move counts. */ err: line => diagnostics.push(line) };
      try {
      await syncRelay(process.cwd(), io);
      await relayOperation(process.cwd(), 'shout', [{ from: 'coordinator', to: 'all', lanes: [], text: 'first internal paused move' }], io);
      await relayOperation(process.cwd(), 'shout', [{ from: 'coordinator', to: 'all', lanes: [], text: 'second internal paused move' }], io);
      await syncRelay(process.cwd(), io);
      process.stdout.write(JSON.stringify({ diagnostics }));
      } catch (error) { process.stdout.write(JSON.stringify({ error: { code: error.code, message: error.message } })); process.exitCode = 1; }
    `);
    assert.equal(result.code, 0);
    assert.equal(result.document.diagnostics.filter(line => /relay paused for /u.test(line)).length, 0,
      'the session was already notified when linking; internal moves do not repeat it');
    assert.equal(repeated.calls.filter(call => call.method === 'PUT' && call.path.endsWith('/state')).length - before, 1,
      'one command attempts only one fresh baseline despite multiple local moves');
    assert.equal(repeated.moveAcks.length, 0, 'unaccepted local moves never become sequence-one uploads');
  });

  /** Two authenticated device sessions contend for one real SQLite baseline slot. */
  sub('concurrent initial baseline uploads accept exactly one device [H16]', async subtest => {
    const race = await relayClientFixture(subtest);
    race.rejectSnapshots({ status: 400, code: 'BAD_UPLOAD', message: 'fixture retains two native baseline candidates' });
    await race.link();
    const first = JSON.parse(race.transit.find(row => row.method === 'PUT' && row.path.endsWith('/state')).request.toString('utf8'));
    assert.equal((await race.cli('add', race.lane, 'local work in the second baseline candidate')).code, 0);
    assert.equal((await race.cli('status')).code, 0);
    const second = JSON.parse(race.transit.filter(row => row.method === 'PUT' && row.path.endsWith('/state')).at(-1).request.toString('utf8'));
    assert.notEqual(first.sealed, second.sealed);
    race.rejectSnapshots(null);
    const state = JSON.parse(readFileSync(race.linkFile, 'utf8'));
    const secondSession = await privatePersonSession(race);
    const candidates = [first, second];
    const sessions = [state.token, secondSession];
    const replies = await Promise.all(candidates.map((candidate, index) => fetch(race.origin + '/api/v1/boards/' + state.board + '/state', {
      method: 'PUT', headers: { authorization: 'Bearer ' + sessions[index], 'content-type': 'application/json',
        'x-pullboard-engine': String(ENGINE_VERSION), 'if-none-match': '*' }, body: JSON.stringify(candidate),
    })));
    assert.deepEqual(replies.map(reply => reply.status).sort(), [200, 412], 'one atomic baseline creator wins and one receives a precondition refusal');
    const loser = replies.find(reply => reply.status === 412);
    assert.equal((await loser.json()).error.code, 'BASELINE_EXISTS');
    const winnerIndex = replies.findIndex(reply => reply.status === 200);
    assert.equal((await uploadedState(race)).sealed, candidates[winnerIndex].sealed, 'the winning ciphertext is never replaced by the loser');
    const replacement = candidates[1 - winnerIndex];
    const checkpoint = await fetch(race.origin + '/api/v1/boards/' + state.board + '/state', {
      method: 'PUT', headers: { authorization: 'Bearer ' + state.token, 'content-type': 'application/json',
        'x-pullboard-engine': String(ENGINE_VERSION) }, body: JSON.stringify(replacement),
    });
    assert.equal(checkpoint.status, 200, 'ordinary later snapshots remain replaceable at their covered sequence');
    assert.equal((await uploadedState(race)).sealed, replacement.sealed);
  });

  /** A competing native snapshot arrives after absence was checked but before the client PUT. */
  sub('a baseline race fences the native retry without discarding local work [H16]', async subtest => {
    const race = await relayClientFixture(subtest);
    race.rejectSnapshots({ status: 400, code: 'BAD_UPLOAD', message: 'fixture baseline pause before a competing device' });
    await race.link();
    const competing = JSON.parse(race.transit.find(row => row.method === 'PUT' && row.path.endsWith('/state')).request.toString('utf8'));
    assert.equal((await race.cli('add', race.lane, 'preserved unaccepted local work')).code, 0);
    race.rejectSnapshots(null);
    const state = JSON.parse(readFileSync(race.linkFile, 'utf8'));
    const secondSession = await privatePersonSession(race);
    let conditional;
    let competingStatus;
    race.beforeNextSnapshot(async headers => {
      conditional = headers['if-none-match'];
      const reply = await fetch(race.origin + '/api/v1/boards/' + state.board + '/state', {
        method: 'PUT', headers: { authorization: 'Bearer ' + secondSession, 'content-type': 'application/json',
          'x-pullboard-engine': String(ENGINE_VERSION), 'if-none-match': '*' }, body: JSON.stringify(competing),
      });
      competingStatus = reply.status;
      await reply.arrayBuffer();
      race.rejectStateReads({ status: 503, code: 'RELAY_UNAVAILABLE' });
    });
    const blocked = await race.cli('add', race.lane, 'must not overwrite the competing baseline');
    assert.equal(competingStatus, 200);
    assert.equal(conditional, '*', 'the real native client asks for an atomic initial upload');
    assert.equal(blocked.code, 1);
    assert.equal(blocked.document.error.code, 'RELAY_BASELINE_EXISTS');
    assert.equal(JSON.parse(readFileSync(race.linkFile, 'utf8')).baselineConflict, true, 'the atomic conflict is durable even when a following state read would fail');
    race.rejectStateReads(null);
    const remote = await uploadedState(race);
    assert.equal(remote.sealed, competing.sealed);
    assert.equal(remote.document.tables.item.some(row => row.item_title === 'preserved unaccepted local work'), false);
    const local = await race.cli('export');
    assert.ok(local.document.tables.item.some(row => row.item_title === 'preserved unaccepted local work'), 'the conflicting local work survives for export');
    assert.equal(local.document.tables.item.some(row => row.item_title === 'must not overwrite the competing baseline'), false);
    assert.equal(race.moveAcks.length, 0);
  });

  /** Prove that malformed permanent refusals pause and recover from a fresh snapshot. */
  sub('malformed baseline refusals carry their reason and recover [H16]', async (subtest) => {
    const malformed = await relayClientFixture(subtest);
    malformed.rejectSnapshots({ status: 400, code: 'BAD_UPLOAD', message: 'send only a sequence and sealed payload' });
    const linked = await malformed.link();
    const paused = await malformed.cli('status');
    assert.equal(paused.code, 0);
    assert.equal((paused.document.diagnostics ?? []).filter(line => /relay paused/u.test(line)).length, 0, 'the link already delivered this session notice');
    const notice = (linked.document.diagnostics ?? []).join('\n');
    assert.match(notice, /BAD_UPLOAD/u);
    assert.match(notice, /send only a sequence and sealed payload/u);
    assert.match(notice, /upgrade pullboard|pullboard relay on/u, 'the malformed-upload notice gives its recovery step');
    malformed.rejectSnapshots(null);
    const recovered = await malformed.cli('status');
    assert.equal(recovered.code, 0);
    assert.doesNotMatch((recovered.document.diagnostics ?? []).join('\n'), /relay paused/u);
  });

  /** Preserve ordinary retry behavior for every retryable HTTP response status. */
  for (const status of [408, 425, 429, 503]) {
    sub(`transient snapshot HTTP ${status} keeps retry behavior [H16]`, async (subtest) => {
      const transient = await relayClientFixture(subtest);
      transient.rejectSnapshots({ status, code: 'RELAY_UNAVAILABLE', message: `fixture snapshot HTTP ${status}` });
      await transient.link();
      const title = `not applied before baseline HTTP ${status}`;
      const kept = await transient.cli('add', transient.lane, title);
      assert.equal(kept.code, 0, 'a retryable outage never fails a local move before the baseline is accepted [B26]');
      assert.doesNotMatch((kept.document.diagnostics ?? []).join('\n'), /relay paused/u,
        'retryable statuses never activate the permanent baseline pause');
      assert.equal(JSON.parse(readFileSync(transient.linkFile, 'utf8')).baselinePause, undefined);
      transient.rejectSnapshots(null);
      const retried = await transient.cli('status');
      assert.equal(retried.code, 0, 'the next command uploads the baseline once the transient failure clears');
      const exported = await transient.cli('export');
      assert.equal(exported.document.tables.item.filter(row => row.item_title === title).length, 1, 'the move rides the later baseline once');
      assert.equal(transient.moveAcks.length, 0);
    });
  }

  /** A durable pre-ACK local intent cannot prove that the remote board is empty. */
  for (const sequence of [0, 1]) {
    sub(`an existing remote baseline at sequence ${sequence} never pauses locally [H16]`, async subtest => {
      const existing = await relayClientFixture(subtest);
      await existing.link();
      const first = JSON.parse(readFileSync(existing.linkFile, 'utf8'));
      const response = await fetch(existing.origin + '/api/v1/boards/' + first.board + '/state', {
        headers: { authorization: 'Bearer ' + first.token, 'x-pullboard-engine': String(ENGINE_VERSION) },
      });
      assert.equal(response.status, 200);
      const original = (await response.json()).state;
      if (sequence === 1) assert.equal((await existing.cli('add', existing.lane, 'live remote prefix before new local intent')).code, 0);
      // This is exactly a durable initial upload intent before the native client received its ACK.
      const interrupted = JSON.parse(readFileSync(existing.linkFile, 'utf8'));
      interrupted.baselineAccepted = false;
      interrupted.snapshot = { sequence: 0, sealed: original.sealed };
      writeFileSync(existing.linkFile, JSON.stringify(interrupted) + '\n', { mode: 0o600 });
      existing.rejectSnapshots({ status: 400, code: 'BAD_UPLOAD', message: 'fixture permanently refused retry' });
      const movesBefore = existing.moveAcks.length;
      const blocked = await existing.cli('add', existing.lane, 'must never diverge into local fallback');
      assert.equal(blocked.code, 1, 'an existing authenticated remote snapshot prevents local fallback');
      assert.equal(blocked.document.error.code, 'RELAY_BASELINE_EXISTS');
      assert.match(blocked.document.error.message, /protect.*ordered history/u);
      const durable = JSON.parse(readFileSync(existing.linkFile, 'utf8'));
      assert.equal(durable.baselinePause, undefined, 'no never-accepted claim is persisted for an existing remote baseline');
      assert.equal(existing.moveAcks.length, movesBefore, 'the refused command emits no divergent ordered move');
      const exported = await existing.cli('export');
      assert.equal(exported.code, 0);
      assert.equal(exported.document.tables.item.some(row => row.item_title === 'must never diverge into local fallback'), false,
        'the guarded command never applies locally either');
      assert.equal((await uploadedState(existing)).sequence, sequence, 'the actual stored remote prefix remains intact');
      const beforeRestart = await uploadedState(existing);
      existing.rejectSnapshots(null);
      const restarted = await existing.cli('add', existing.lane, 'never overwrite a conflicting baseline after restart');
      assert.equal(restarted.code, 1, 'fresh commands remain fenced even when the snapshot refusal clears');
      assert.equal(restarted.document.error.code, 'RELAY_BASELINE_EXISTS');
      assert.deepEqual(await uploadedState(existing), beforeRestart, 'the remote baseline remains byte-for-byte intact');
      assert.equal(existing.moveAcks.length, movesBefore);
      assert.equal(JSON.parse(readFileSync(existing.linkFile, 'utf8')).baselineConflict, true);
      for (const command of ['status', 'doctor']) {
        const reported = await existing.cli(command);
        assert.match((reported.document.diagnostics ?? []).join('\n'), /RELAY_BASELINE_EXISTS.*pullboard export.*pullboard relay off/u);
      }
      const relink = await existing.cli('relay', 'on', '--url', existing.origin);
      assert.equal(relink.code, 1, 'plain relay on refuses the durable conflict before sign-in or snapshot upload');
      assert.equal(relink.document.error.code, 'RELAY_BASELINE_EXISTS');
      assert.deepEqual(await uploadedState(existing), beforeRestart);
      const restartExport = await existing.cli('export');
      assert.equal(restartExport.document.tables.item.some(row => row.item_title === 'never overwrite a conflicting baseline after restart'), false);
    });
  }

  /** A remote baseline appearing after a durable pause must end local-only fallback. */
  for (const sequence of [0, 1]) {
    sub(`a previously paused board with remote sequence ${sequence} never diverges locally [H16]`, async subtest => {
      const existing = await relayClientFixture(subtest);
      existing.rejectSnapshots({ status: 400, code: 'BAD_UPLOAD', message: 'fixture refused initial baseline' });
      await existing.link();
      const paused = readFileSync(existing.linkFile, 'utf8');
      assert.ok(JSON.parse(paused).baselinePause);
      existing.rejectSnapshots(null);
      const advanced = sequence === 0 ? await existing.cli('status')
        : await existing.cli('add', existing.lane, 'actual native remote prefix');
      assert.equal(advanced.code, 0);
      assert.equal((await uploadedState(existing)).sequence, sequence);
      // Model a restarted client's still-durable pause after the remote accepted another upload.
      writeFileSync(existing.linkFile, paused, { mode: 0o600 });
      const putsBeforeConflict = existing.calls.filter(call => call.method === 'PUT' && call.path.endsWith('/state')).length;
      const beforeConflict = await uploadedState(existing);
      const blocked = await existing.cli('add', existing.lane, 'never apply a divergent paused local move');
      assert.equal(blocked.code, 1);
      assert.equal(blocked.document.error.code, 'RELAY_BASELINE_EXISTS');
      assert.equal(existing.calls.filter(call => call.method === 'PUT' && call.path.endsWith('/state')).length, putsBeforeConflict,
        'a remote baseline appearing during pause is checked before any recovered upload can overwrite it');
      assert.deepEqual(await uploadedState(existing), beforeConflict);
      const durable = JSON.parse(readFileSync(existing.linkFile, 'utf8'));
      assert.equal(durable.baselineAccepted, true, 'remote presence is durable evidence against future local fallback');
      assert.equal(durable.baselinePause, undefined);
      const exported = await existing.cli('export');
      assert.equal(exported.code, 0);
      assert.equal(exported.document.tables.item.some(row => row.item_title === 'never apply a divergent paused local move'), false);
      assert.equal((await uploadedState(existing)).sequence, sequence);
      const beforeRestart = await uploadedState(existing);
      const movesBeforeRestart = existing.moveAcks.length;
      existing.rejectSnapshots(null);
      const restarted = await existing.cli('add', existing.lane, 'never overwrite a resumed conflicting baseline');
      assert.equal(restarted.code, 1, 'the durable remote-presence fence survives a fresh CLI invocation');
      assert.equal(restarted.document.error.code, 'RELAY_BASELINE_EXISTS');
      assert.deepEqual(await uploadedState(existing), beforeRestart);
      assert.equal(existing.moveAcks.length, movesBeforeRestart);
      assert.equal(JSON.parse(readFileSync(existing.linkFile, 'utf8')).baselineConflict, true);
      for (const command of ['status', 'doctor']) {
        const reported = await existing.cli(command);
        assert.match((reported.document.diagnostics ?? []).join('\n'), /RELAY_BASELINE_EXISTS.*pullboard export.*pullboard relay off/u);
      }
      const relink = await existing.cli('relay', 'on', '--url', existing.origin);
      assert.equal(relink.code, 1, 'plain relay on refuses the durable conflict before sign-in or snapshot upload');
      assert.equal(relink.document.error.code, 'RELAY_BASELINE_EXISTS');
      assert.deepEqual(await uploadedState(existing), beforeRestart);
      const restartExport = await existing.cli('export');
      assert.equal(restartExport.document.tables.item.some(row => row.item_title === 'never overwrite a resumed conflicting baseline'), false);
    });
  }

  /** Only authenticated absence may authorize a local move, including after a failed preflight. */
  for (const refusal of [
    { label: 'unknown', status: 404, code: 'UNKNOWN_STATE' },
    { label: 'auth', status: 401, code: 'AUTH_REQUIRED' },
    { label: 'unavailable', status: 503, code: 'RELAY_UNAVAILABLE', transient: true },
    { label: 'wrong-version', status: 404, code: 'NO_BOARD', version: 2 },
    { label: 'unavailable-absence', status: 503, code: 'NO_BOARD', transient: true },
    { label: 'auth-absence', status: 401, code: 'NO_SNAPSHOT' },
  ]) {
    sub(`uncertain ${refusal.label} remote state never authorizes local fallback [H16]`, async subtest => {
      const uncertain = await relayClientFixture(subtest);
      uncertain.rejectSnapshots({ status: 400, code: 'BAD_UPLOAD', message: 'fixture refused initial baseline' });
      await uncertain.link();
      assert.ok(JSON.parse(readFileSync(uncertain.linkFile, 'utf8')).baselinePause);
      uncertain.rejectStateReads(refusal);
      const blocked = await uncertain.cli('add', uncertain.lane, 'never apply a move after uncertain preflight');
      if (refusal.transient) {
        // #919: a relay that merely cannot answer never fails a local move; the move waits for a baseline, never an ordered send.
        assert.equal(blocked.code, 0, 'an unreachable relay never fails a move before the baseline is accepted [B26]');
        assert.equal(uncertain.moveAcks.length, 0);
        const kept = await uncertain.cli('export');
        assert.equal(kept.document.tables.item.some(row => row.item_title === 'never apply a move after uncertain preflight'), true);
        return;
      }
      assert.equal(blocked.code, 1, 'a failed remote check cannot become local fallback in the same command');
      assert.equal(blocked.document.error.code, refusal.code);
      assert.equal(uncertain.moveAcks.length, 0);
      const exported = await uncertain.cli('export');
      assert.equal(exported.code, 0);
      assert.equal(exported.document.tables.item.some(row => row.item_title === 'never apply a move after uncertain preflight'), false);
    });
  }

  /** A refused checkpoint after an accepted baseline does not switch moves to local-only mode. */
  sub('a refused later checkpoint keeps ordered moves [H16]', async (subtest) => {
    const accepted = await relayClientFixture(subtest);
    await accepted.link();
    accepted.rejectSnapshots({ status: 400, code: 'BAD_UPLOAD', message: 'fixture checkpoint refusal' });
    const first = await accepted.cli('add', accepted.lane, 'ordered move before checkpoint refusal');
    assert.equal(first.code, 0, 'the move remains ordered after baseline acceptance');
    const second = await accepted.cli('add', accepted.lane, 'ordered move during checkpoint refusal');
    assert.equal(second.code, 0, 'a permanent later checkpoint refusal does not pause ordered moves');
    assert.doesNotMatch((second.document.diagnostics ?? []).join('\n'), /relay paused/u);
    const link = JSON.parse(readFileSync(accepted.linkFile, 'utf8'));
    const response = await fetch(`${accepted.origin}/api/v1/boards/${link.board}/events?after=0`, {
      headers: { authorization: `Bearer ${link.token}`, 'x-pullboard-engine': String(ENGINE_VERSION) },
    });
    assert.equal(response.status, 200);
    const events = (await response.json()).events;
    assert.deepEqual(events.map(event => event.event_id), [1, 2], 'both post-baseline moves keep their relay positions');
  });
  await Promise.all(pending);
});

/** The session's link already named its pause; later local commands keep working without repeating it. */
function assertPaused(document) {
  assert.equal((document.diagnostics ?? []).filter(line => /relay paused/u.test(line)).length, 0,
    'one session does not repeat a durable baseline pause on each command');
}

/** Authenticate the actual relay checkpoint, accepting both supported plaintext snapshot formats. */
async function uploadedState(box) {
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const response = await fetch(box.origin + '/api/v1/boards/' + link.board + '/state', {
    headers: { authorization: 'Bearer ' + link.token, 'x-pullboard-engine': String(ENGINE_VERSION) },
  });
  assert.equal(response.status, 200);
  const row = (await response.json()).state;
  const plain = await unseal(decodeBoardKey(readFileSync(box.keyFile, 'utf8').trim()),
    Buffer.from(row.sealed, 'base64url'), { boardId: link.board, kind: 'snapshot', sequence: row.sequence });
  const bytes = plain[0] === 0x1f && plain[1] === 0x8b ? gunzipSync(plain) : plain;
  return { sequence: row.sequence, sealed: row.sealed, document: JSON.parse(new TextDecoder().decode(bytes)) };
}

/** Obtain a second real OAuth session in RAM without changing the native device's stored link. */
async function privatePersonSession(box) {
  const start = await fetch(box.origin + '/auth/github/start', { redirect: 'manual' });
  const binding = start.headers.getSetCookie()[0].split(';')[0];
  const grant = await fetch(start.headers.get('location'), { redirect: 'manual' });
  const signed = await fetch(grant.headers.get('location'), { redirect: 'manual', headers: { cookie: binding } });
  assert.equal(signed.status, 303);
  const cookie = signed.headers.getSetCookie().find(value => value.startsWith('pb_session='));
  return cookie.split(';')[0].slice('pb_session='.length);
}

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
  assert.equal((await box.cliLocal('status')).code, 0);
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
  const remote = await fetch(box.origin + '/api/v1/boards/' + refused.board + '/events?after=' + baselineSequence, {
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
  const exported = await box.cliLocal('export');
  assert.equal(exported.code, 0);
  for (const text of ['same io first ordered move', 'same io second ordered move']) {
    assert.equal(exported.document.tables.shout.filter(row => row.shout_text === text).length, 1,
      'each acknowledged move has exactly one committed native effect');
  }
});
