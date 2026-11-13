/** Recover an interrupted local rebuild from authenticated order, never by resending its prefix [H16,H21]. */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { discardUnpublished } from '../src/relay-local-recovery.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import * as store from '../src/board.js';
import { applyRelayMove, appliedSequence, checkpointSequence, engineReceipt, prepareEngineMove } from '../src/engine.js';
import { exportBoard, importBoard } from '../src/exchange.js';
import { impliesSeed } from '../src/implies.js';
import { submitFixture } from './board-submit-fixture.js';
import { storeBoardKey } from '../src/relay-key.js';
import { relayOrdering } from '../src/relay-ordering.js';
import { flushOutbox, outboxFile, queueMove, readOutbox, writeOutbox } from '../src/relay-outbox.js';
import { undoQueued } from '../src/relay-outbox-undo.js';
import { seal, unseal } from '../src/seal.js';

/** Real SQLite, native changesets and sealed queue; the only remote is an in-process ordered fixture. */
async function fixture(t, { partialReapply = false, setup, pending, fileBacked = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-rebuild-recovery-'));
  const names = ['PULLBOARD_HOME', 'PULLBOARD_MACHINE_HOME', 'PULLBOARD_RELAY_KEY', 'PULLBOARD_RELAY_TOKEN'];
  const prior = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => { for (const name of names) { if (prior[name] === undefined) delete process.env[name]; else process.env[name] = prior[name]; } });
  process.env.PULLBOARD_HOME = join(directory, 'home');
  process.env.PULLBOARD_MACHINE_HOME = join(directory, 'machine');
  delete process.env.PULLBOARD_RELAY_KEY;
  delete process.env.PULLBOARD_RELAY_TOKEN;
  if (fileBacked) {
    assert.equal(spawnSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q', directory]).status, 0);
    mkdirSync(join(directory, '.git', 'pullboard'), { mode: 0o700 });
  }
  const board = store.openBoard(fileBacked ? join(directory, '.git', 'pullboard', 'board.sqlite') : ':memory:', { now: () => new Date('2026-10-24T00:00:00Z') });
  t.after(() => { store.closeBoard(board); rmSync(directory, { recursive: true, force: true }); });
  store.register(board, { lane: 'coordinator', path: directory, sessionDigest: 'a'.repeat(64) });
  const extra = setup?.(board, directory);
  checkpointSequence(board, 1);
  const id = board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='board_id'").get().meta_value;
  const key = randomBytes(32);
  storeBoardKey(id, key);
  const checkpoint = { native: exportBoard(board), sequence: 1 };
  const state = { board: id, sequence: 2, mode: 'ordered', machine: 'fixture-machine', outbox: { moves: [] } };
  if (!fileBacked) mkdirSync(join(directory, 'link'), { mode: 0o700 });
  const file = fileBacked ? join(directory, '.git', 'pullboard', 'relay.json') : join(directory, 'link', 'relay.json');
  const records = [], posts = [], reads = [], errors = [];
  /** Authenticate the fixture's actual sealed record and use the real deterministic board engine. */
  async function replay(board, key, state, record) {
    const bytes = await unseal(key, Buffer.from(record.sealed, 'base64url'), { boardId: state.board, kind: record.kind, sequence: record.event_id });
    const move = JSON.parse(Buffer.from(bytes).toString());
    return applyRelayMove(board, move, { sequence: record.event_id, at: record.event_at, sender: record.sender, kind: record.kind });
  }
  /** Preserve the exact move bytes and original sequence on the synthetic relay. */
  async function record(move, sequence) {
    return { event_id: sequence, event_at: new Date(Date.parse('2026-10-24T00:00:00Z') + sequence * 1000).toISOString(), kind: 'move',
      sender: { kind: 'agent', userId: 'fixture', agent: move.actor },
      sealed: Buffer.from(await seal(key, Buffer.from(JSON.stringify(move)), { boardId: id, kind: 'move', sequence })).toString('base64url') };
  }
  /** Make a normal native shout without test-only SQL mutations. */
  const move = (number) => prepareEngineMove(board, 'shout', [{ from: 'coordinator', to: 'all', text: `original-${number}`, lanes: [] }], { id: `original-${number}`, actor: 'coordinator' });
  const second = move(2); records.push(await record(second, 2));
  assert.equal((await replay(board, key, state, records[0])).error, undefined);
  const ordering = relayOrdering({ replayRelayRecord: replay });
  const link = {
    root: directory, file, state, io: { err: text => errors.push(text) },
    localRecords: (_root, use) => use(board), saveLink: () => {},
    request: async (_state, path) => {
      const after = Number(path.split('after=')[1]); reads.push(after);
      return { events: records.filter(row => row.event_id > after) };
    },
    fetchCheckpoint: async () => structuredClone(checkpoint),
    advanceCheckpoint: (key, checkpoint, prefix, minimum) => ordering.advanceCheckpoint(key, state, checkpoint, prefix, minimum),
    applyRecords: async (_root, key, state, prefix) => { for (const row of prefix) await replay(board, key, state, row); },
    sealedRecord: async (_key, move, _state, _kind, sequence) => (await record(move, sequence)).sealed,
    postPending: async (_root, _file, _state, pending) => { posts.push(pending.move.id); records.push(await record(pending.move, pending.sequence)); },
  };
  const third = move(3), fourth = move(4);
  for (const next of [third, fourth]) await queueMove(link, { operation: next.operation, args: next.args, move: next,
    quiet: true, applyLocally: () => store.atomic(board, () => store.shout(board, ...next.args)) });
  await pending?.({ board, link, key, id, extra });
  const queued = await readOutbox(outboxFile(file), key, id);
  assert.equal(queued.version, 3); assert.equal(queued.baseSequence, 2);
  assert.equal(undoQueued(board, queued.moves), null);
  records.push(await record(third, 3));
  assert.equal((await replay(board, key, state, records[1])).error, undefined);
  if (partialReapply) store.atomic(board, () => store.shout(board, ...fourth.args));
  // This is the actual failure cut: ordered prefix committed, sealed queue still describes the prior local rows.
  assert.equal(appliedSequence(board), 3);
  const receipt = engineReceipt(board, third.id);
  return { board, link, key, id, checkpoint, records, posts, reads, errors, receipt, third, fourth, ordering, extra, record };
}

for (const mode of ['ordered-only', 'partial-reapply', 'paged']) test(`interrupted rebuild restores local pending work without resending accepted moves (${mode}) [H16,H21]`, async t => {
  const f = await fixture(t, { partialReapply: mode === 'partial-reapply' });
  if (mode === 'paged') {
    const request = f.link.request;
    f.link.request = async (...args) => ({ events: (await request(...args)).events.slice(0, 1) });
  }
  await flushOutbox(f.link);
  assert.deepEqual(f.posts, ['original-4'], 'only the genuinely unperformed move is sent');
  assert.deepEqual(engineReceipt(f.board, f.third.id), f.receipt, 'the original accepted outcome is unchanged');
  assert.equal(appliedSequence(f.board), 4);
  assert.equal(await readOutbox(outboxFile(f.link.file), f.key, f.id), null);
  assert.deepEqual(f.board.db.prepare('SELECT shout_text FROM shout ORDER BY shout_id').all().map(row => row.shout_text), ['original-2', 'original-3', 'original-4']);
});

for (const kind of ['gap', 'short', 'foreign-board', 'receipt-mismatch', 'engine-failure']) test(`checkpoint bridge refuses ${kind} without changing local board or queue [H16,H21]`, async t => {
  const f = await fixture(t);
  const originalRequest = f.link.request;
  if (kind === 'gap') f.link.request = async (state, path) => path.endsWith('after=1') ? { events: [f.records[1]] } : originalRequest(state, path);
  if (kind === 'short') {
    let initial = true;
    f.link.request = async (_state, path) => { if (initial) { initial = false; return { events: [f.records[1]] }; }
      return { events: path.endsWith('after=1') ? [f.records[0]] : [] }; };
  }
  if (kind === 'foreign-board') f.link.fetchCheckpoint = async () => {
    const cp = structuredClone(f.checkpoint); cp.native.tables.board_meta.find(row => row.meta_key === 'board_id').meta_value = 'b'.repeat(32); return cp;
  };
  if (kind === 'receipt-mismatch') f.link.advanceCheckpoint = async (...args) => {
    const cp = await f.ordering.advanceCheckpoint(args[0], f.link.state, ...args.slice(1));
    cp.native.tables.board_meta.find(row => row.meta_key.startsWith('relay_receipt_') && row.meta_value.includes('original-3')).meta_value += ' ';
    return cp;
  };
  if (kind === 'engine-failure') {
    const row = f.records[1];
    row.sealed = Buffer.from(await seal(f.key, Buffer.from(JSON.stringify({ ...f.third, engine: 100000 })),
      { boardId: f.id, kind: row.kind, sequence: row.event_id })).toString('base64url');
  }
  const native = exportBoard(f.board), queued = readFileSync(outboxFile(f.link.file));
  const codes = { gap: 'RELAY_RESPONSE', short: 'RELAY_OUTBOX', 'foreign-board': 'RELAY_SNAPSHOT', 'receipt-mismatch': 'RELAY_RECOVERY_MISMATCH', 'engine-failure': 'ENGINE_VERSION' };
  await assert.rejects(flushOutbox(f.link), error => error.code === codes[kind]);
  assert.deepEqual(exportBoard(f.board), native, 'failed recovery does not publish a partial replica');
  assert.deepEqual(readFileSync(outboxFile(f.link.file)), queued, 'the original sealed outbox is retained byte for byte');
  assert.deepEqual(f.posts, []);
});

/** Rebuild two genuinely queued claims made after the preceding lease expired, with no relay send. */
async function leaseFixture(t, applicationDelay = 0) {
  const start = Date.parse('2026-10-24T00:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const f = await fixture(t, {
    setup(board, directory) {
      const actor = store.register(board, { lane: 'core', path: join(directory, 'builder'), route: 'mid' });
      const items = [1, 2].map(n => store.addItem(board, { by: 'coordinator', lane: 'core', title: `lease-${n}`,
        criterion: 'a later claim must not renew an earlier lease', check: 'true', route: 'mid',
        brief: 'Files: src/relay-outbox.js\nTest: preserves historical local lease expiry' }));
      return { actor, items, leases: [], moves: [] };
    },
    async pending({ board, link, extra }) {
      board.clock = store.systemClock;
      for (const [index, item] of extra.items.entries()) {
        t.mock.timers.setTime(start + 10_000 + index * 2_000);
        const args = [item, { agentId: extra.actor, lane: 'core', leaseMs: 1_000,
          freeze: found => ({ text: found.item_title, digest: `digest:${found.item_title}` }) }];
        const move = prepareEngineMove(board, 'claim', args, { id: `queued-claim-${index}`, actor: extra.actor });
        const result = await queueMove(link, { operation: 'claim', args, move, quiet: true,
          applyLocally: () => { t.mock.timers.setTime(start + 10_000 + index * 2_000 + applicationDelay); return store.claim(board, ...args); } });
        extra.leases.push(result.leaseUntil); extra.moves.push(move);
      }
      t.mock.timers.setTime(start + 100_000);
    },
  });
  f.link.postPending = async () => { throw Object.assign(new Error('qualification stops before transport'), { code: 'NO_SEND' }); };
  return f;
}

test('local reconstitution preserves expired claim leases without changing authoritative replay time [H21,B4,B5,H16]', async t => {
  const f = await leaseFixture(t);
  await assert.rejects(flushOutbox(f.link), error => error.code === 'NO_SEND');
  const rows = f.extra.items.map(id => f.board.db.prepare('SELECT item_owner,item_lease_until FROM item WHERE item_id=?').get(id));
  assert.deepEqual(rows.map(row => row.item_owner), [f.extra.actor, f.extra.actor]);
  assert.deepEqual(rows.map(row => row.item_lease_until), f.extra.leases, 'reconstitution is not a new lease renewal');
  assert.equal(f.board.clock, store.systemClock, 'the caller clock is restored');
  assert.deepEqual((await readOutbox(outboxFile(f.link.file), f.key, f.id)).moves.slice(-2).map(entry => entry.move), f.extra.moves);
  assert.equal(engineReceipt(f.board, f.extra.moves[0].id), null, 'local reconstitution is not an ordered receipt');
  const at = new Date().toISOString();
  assert.equal(applyRelayMove(f.board, f.extra.moves[0], { sequence: 4, at, kind: 'move',
    sender: { kind: 'agent', userId: 'fixture', agent: f.extra.actor } }).error, undefined);
  assert.equal(applyRelayMove(f.board, f.extra.moves[1], { sequence: 5, at, kind: 'move',
    sender: { kind: 'agent', userId: 'fixture', agent: f.extra.actor } }).error.code, 'ONE_CLAIM', 'real ordering still uses the relay time and records its conflict');
});

test('missing queued clock refuses before changing a board or its sealed outbox [H21,B4]', async t => {
  const f = await leaseFixture(t), file = outboxFile(f.link.file);
  const outbox = await readOutbox(file, f.key, f.id);
  delete outbox.moves.at(-1).queuedAt;
  await writeOutbox(file, f.key, f.id, outbox);
  const native = exportBoard(f.board), queued = readFileSync(file);
  await assert.rejects(flushOutbox(f.link), error => error.code === 'RELAY_OUTBOX');
  assert.deepEqual(exportBoard(f.board), native);
  assert.deepEqual(readFileSync(file), queued);
  assert.deepEqual(f.posts, []);
});

// Retained baseline RED: the correction disappeared after its original random fact id was replaced by move.id.
test('pending fact corrections retain their genuine original identity during rebuild [H21,B29,B30,B31]', async t => {
  const f = await fixture(t, {
    setup(board) { return { item: store.addItem(board, { by: 'coordinator', lane: 'coordinator', title: 'fact identity', criterion: 'preserve corrections' }) }; },
    async pending({ board, link, extra }) {
      for (const index of [0, 1]) {
        const args = [extra.item, { agentId: 'coordinator', kind: 'note', text: index ? 'correction' : 'original',
          ...(index ? { supersedes: extra.originalId } : {}) }];
        const move = prepareEngineMove(board, 'appendFact', args, { id: `fact-move-${index}`, actor: 'coordinator' });
        await queueMove(link, { operation: 'appendFact', args, move, quiet: true, applyLocally: () => store.appendFact(board, ...args) });
        if (!index) extra.originalId = JSON.parse(board.db.prepare("SELECT event_detail FROM event WHERE event_kind='fact' ORDER BY event_id DESC LIMIT 1").get().event_detail).id;
      }
      extra.originalFacts = board.db.prepare("SELECT event_detail FROM event WHERE event_kind='fact' ORDER BY event_id").all().map(row => JSON.parse(row.event_detail));
      assert.equal(extra.originalFacts.length, 2, 'both original operations really succeeded');
    },
  });
  f.link.postPending = async () => { throw Object.assign(new Error('stop before send'), { code: 'NO_SEND' }); };
  await assert.rejects(flushOutbox(f.link), error => error.code === 'RELAY_OUTBOX_IDENTITY');
  const facts = f.board.db.prepare("SELECT event_detail FROM event WHERE event_kind='fact' ORDER BY event_id").all().map(row => JSON.parse(row.event_detail));
  assert.deepEqual(facts.map(row => ({ id: row.id, supersedes: row.supersedes })), f.extra.originalFacts.map(row => ({ id: row.id, supersedes: row.supersedes })));
});

/** The meaningful identity/reference fields, not differences in provisional versus relay timestamps. */
function referenceProjection(board) {
  return {
    events: board.db.prepare('SELECT event_id,event_by,event_kind,item_id,event_detail FROM event ORDER BY event_id').all(),
    shouts: board.db.prepare('SELECT shout_id,shout_from,shout_to,shout_text,shout_decision,shout_answers FROM shout ORDER BY shout_id').all(),
    activity: store.activityDeliveryState(board, 'web-1'),
  };
}

test('fact and implied-fact identities preserve later decisions, supersession and activity event references on repeated rebuild [H21,B29,B31,N26]', async t => {
  const f = await fixture(t, {
    setup(board, directory) {
      store.register(board, { lane: 'web', path: join(directory, 'web-1') });
      return { items: [1, 2].map(n => store.addItem(board, { by: 'coordinator', lane: 'coordinator', title: `references-${n}`, criterion: 'retain exact references' })) };
    },
    async pending({ board, link, key, id, extra }) {
      let serial = 0;
      /** Use the normal queued local operation, including its original generated ids. */
      const queued = async (operation, args, actor = 'coordinator') => {
        const move = prepareEngineMove(board, operation, args, { id: `reference-move-${++serial}`, actor });
        return queueMove(link, { operation, args, move, quiet: true, applyLocally: () => store[operation](board, ...args) });
      };
      const [one, two] = extra.items;
      const fact = await queued('appendFact', [one, { agentId: 'coordinator', kind: 'note', text: 'initial evidence', implies: [two] }]);
      extra.originalFactId = fact.id;
      await queued('appendFact', [one, { agentId: 'coordinator', kind: 'note', text: 'corrected evidence', supersedes: fact.id, implies: [two] }]);
      let answer;
      for (const index of [0, 1]) {
        const ask = await queued('shout', [{ from: 'web-1', to: 'coordinator', text: `choose-${index}`, decision: true, lanes: ['web'] }], 'web-1');
        answer = await queued('answerDecision', [ask, { agentId: 'coordinator', text: `answer-${index}`, lanes: ['web'], implies: [two], ...(index ? { supersedes: answer } : {}) }]);
      }
      const answerEvent = store.events(board).findLast(row => row.event_kind === 'answer');
      const implied = JSON.parse(board.db.prepare("SELECT event_detail FROM event WHERE event_kind='fact' AND json_extract(event_detail,'$.decision.source')='answer' ORDER BY event_id LIMIT 1").get().event_detail);
      await queued('appendFact', [two, { agentId: 'coordinator', kind: 'note', text: 'qualify implication', supersedes: implied.id }]);
      const through = store.events(board).at(-1).event_id;
      const interrupt = { id: `event:${answerEvent.event_id}`, eventId: answerEvent.event_id, reason: 'answered' };
      await queued('recordActivityDelivery', [{ agentId: 'web-1', through, observedThrough: through, digestThrough: through, interrupts: [interrupt] }], 'web-1');
      await queued('actOnActivity', [{ agentId: 'web-1', ids: [interrupt.id] }], 'web-1');
      extra.original = referenceProjection(board);
      extra.originalMoves = (await readOutbox(outboxFile(link.file), key, id)).moves.slice(2).map(entry => entry.move);
    },
  });
  f.link.postPending = async () => { throw Object.assign(new Error('stop before send'), { code: 'NO_SEND' }); };
  for (const round of [1, 2]) {
    await assert.rejects(flushOutbox(f.link), error => error.code === 'RELAY_OUTBOX_IDENTITY');
    assert.deepEqual(referenceProjection(f.board), f.extra.original, `all original references retain their meaning after rebuild ${round}`);
    const queued = await readOutbox(outboxFile(f.link.file), f.key, f.id);
    assert.deepEqual(queued.moves.slice(1).map(entry => entry.move), f.extra.originalMoves, 'no queued payload is rewritten');
    assert.deepEqual(f.posts, [], 'no real relay attempt is made by this regression');
  }
  assert.throws(() => store.appendFact(f.board, f.extra.items[0], { agentId: 'web-1', kind: 'note', text: 'unauthorized correction', supersedes: f.extra.originalFactId }), error => error.code === 'FACT_JUDGEMENT');
});

// Independent review regressions: preserve the failing baseline, not just the successful recovery cut.
test('review partial-reapply bridge failure leaves the original board and queue unchanged [H16,H21]', async t => {
  const f = await fixture(t, { partialReapply: true });
  f.link.fetchCheckpoint = async () => { throw Object.assign(new Error('checkpoint unavailable'), { code: 'OFFLINE' }); };
  const native = exportBoard(f.board), queued = readFileSync(outboxFile(f.link.file));
  await assert.rejects(flushOutbox(f.link), error => error.code === 'OFFLINE');
  assert.deepEqual(exportBoard(f.board), native, 'do not undo an already-advanced prefix before failed recovery');
  assert.deepEqual(readFileSync(outboxFile(f.link.file)), queued);
  assert.deepEqual(f.posts, []);
});

test('review delayed local application retains exact original claim deadlines [H21,B4,B5]', async t => {
  const f = await leaseFixture(t, 125);
  await assert.rejects(flushOutbox(f.link), error => error.code === 'NO_SEND');
  const actual = f.extra.items.map(id => f.board.db.prepare('SELECT item_lease_until FROM item WHERE item_id=?').get(id).item_lease_until);
  assert.deepEqual(actual, f.extra.leases, 'queue persistence time is not the original lease-computation time');
  assert.equal(f.board.clock, store.systemClock);
  assert.deepEqual(f.posts, []);
});

/** Two original fact captures, optionally using ids already representable by the sealed ordered moves. */
async function deliveryFactFixture(t, compatible = false) {
  return fixture(t, {
    setup(board) { return { item: store.addItem(board, { by: 'coordinator', lane: 'coordinator', title: 'retained facts', criterion: 'retain exact fact identities' }) }; },
    async pending({ board, link, extra }) {
      extra.moves = []; extra.ids = [];
      for (const index of [0, 1]) {
        const args = [extra.item, { agentId: 'coordinator', kind: 'note', text: `retained fact ${index}`, ...(index ? { supersedes: extra.ids[0] } : {}) }];
        const move = prepareEngineMove(board, 'appendFact', args, { id: `retained-fact-${index}`, actor: 'coordinator' });
        if (compatible) args[1].factId = move.id;
        const fact = await queueMove(link, { operation: 'appendFact', args, move, quiet: true, applyLocally: () => store.appendFact(board, ...args) });
        extra.moves.push(move); extra.ids.push(fact.id);
      }
    },
  });
}

for (const mode of ['malformed', 'ambiguous']) test(`review ${mode} identity capture refuses before any restore or undo [H21,B30]`, async t => {
  const f = await deliveryFactFixture(t), file = outboxFile(f.link.file);
  const outbox = await readOutbox(file, f.key, f.id);
  outbox.moves.at(-1).changes = mode === 'malformed' ? ['AA=='] : outbox.moves.at(-2).changes;
  await writeOutbox(file, f.key, f.id, outbox);
  const native = exportBoard(f.board), queued = readFileSync(file);
  let refusal; try { await flushOutbox(f.link); } catch (error) { refusal = error; }
  assert.ok(refusal, 'invalid original identity capture must refuse');
  assert.deepEqual(exportBoard(f.board), native, 'capture validation precedes every restore and local replay');
  assert.deepEqual(readFileSync(file), queued);
  assert.equal(refusal.code, 'RELAY_OUTBOX');
  assert.deepEqual(f.posts, []);
});

test('review unrepresentable legacy fact identities stop before the first ordered send [H16,H21,B30,B31]', async t => {
  const f = await deliveryFactFixture(t);
  await assert.rejects(flushOutbox(f.link), error => error.code === 'RELAY_OUTBOX_IDENTITY');
  assert.deepEqual(f.posts, [], 'do not partially drain ahead of the known unrepresentable dependency');
  for (const move of f.extra.moves) assert.equal(engineReceipt(f.board, move.id), null);
  const queued = await readOutbox(outboxFile(f.link.file), f.key, f.id);
  assert.deepEqual(queued.moves.slice(-2).map(e => e.move), f.extra.moves, 'do not rewrite or remint the original moves');
  const facts = store.events(f.board).filter(e => e.event_kind === 'fact').map(e => JSON.parse(e.event_detail));
  assert.deepEqual(facts.map(fact => fact.id), f.extra.ids);
});

test('review representable original facts still deliver and retain both successful receipts [H16,H21,B30,B31]', async t => {
  const f = await deliveryFactFixture(t, true);
  await flushOutbox(f.link);
  for (const move of f.extra.moves) {
    const receipt = engineReceipt(f.board, move.id);
    assert.ok(receipt); assert.equal(receipt.outcome.error, undefined);
  }
  assert.equal(await readOutbox(outboxFile(f.link.file), f.key, f.id), null);
  const facts = store.events(f.board).filter(e => e.event_kind === 'fact').map(e => JSON.parse(e.event_detail));
  assert.deepEqual(facts.map(fact => fact.id), f.extra.ids);
});

/** Original numeric references, without fact IDs that would independently hold transport. */
async function positionalFixture(t, kind) {
  return fixture(t, {
    setup(board, directory) { store.register(board, { lane: 'web', path: join(directory, 'web-1') }); return { moves: [] }; },
    async pending({ board, link, extra }) {
      const queued = async (operation, args, actor) => {
        const move = prepareEngineMove(board, operation, args, { id: `positional-${extra.moves.length}`, actor });
        extra.moves.push(move);
        return queueMove(link, { operation, args, move, quiet: true, applyLocally: () => store[operation](board, ...args) });
      };
      if (kind === 'shout') {
        const question = await queued('shout', [{ from: 'web-1', to: 'coordinator', text: 'original question', decision: true, lanes: ['web'] }], 'web-1');
        extra.answer = await queued('answerDecision', [question, { agentId: 'coordinator', text: 'original answer', lanes: ['web'] }], 'coordinator');
      } else {
        const through = store.events(board).at(-1).event_id;
        await queued('recordActivityDelivery', [{ agentId: 'web-1', through, observedThrough: through, digestThrough: through, interrupts: [] }], 'web-1');
      }
      extra.original = referenceProjection(board);
    },
  });
}

for (const kind of ['shout', 'event']) test(`review positional ${kind} shift refuses before changing the board or queue [H16,H21,B27,N26]`, async t => {
  const f = await positionalFixture(t, kind);
  const extra = prepareEngineMove(f.board, 'shout', [{ from: 'coordinator', to: 'all', text: 'another ordered message', lanes: [] }], { id: 'extra-ordered', actor: 'coordinator' });
  f.records.push(await f.record(extra, 4));
  const native = exportBoard(f.board), queued = readFileSync(outboxFile(f.link.file));
  let refusal; try { await flushOutbox(f.link); } catch (error) { refusal = error; }
  assert.ok(refusal, 'shifted numeric references cannot silently name different records');
  assert.deepEqual(exportBoard(f.board), native, 'detect the shift before publishing any replacement state');
  assert.deepEqual(readFileSync(outboxFile(f.link.file)), queued);
  assert.equal(refusal.code, 'RELAY_OUTBOX_REFERENCE');
  assert.deepEqual(f.posts, []);
});

/** A formerly successful implied verdict is refused locally, but would succeed at the later ordered clock. */
test('review2 refused legacy reapply retains its transport veto across persisted retries [H16,H21,B30,B31]', async t => {
  const start = Date.parse('2026-10-24T00:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: start + 5_000 });
  const f = await fixture(t, {
    setup(board, directory) {
      const [builder, reviewer, blocker] = [1, 2, 3].map(n => {
        const seat = store.register(board, { lane: 'core', path: join(directory, `review-${n}`), route: 'mid', createdBy: 'coordinator' });
        // Synthetic prior enrollment, as in relay-client.test.js: not a live credential or approval.
        board.db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run(`agent_enrolled:${seat}`, 'coordinator');
        return seat;
      });
      const item = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'reviewed source', criterion: 'synthetic source', route: 'mid',
        check: 'true', brief: 'Files: src/relay-outbox.js\nTest: retained refusal identity' });
      const target = store.addItem(board, { by: 'coordinator', lane: 'coordinator', title: 'implication', criterion: 'retain correction' });
      const text = JSON.stringify({ policy: { version: 1, commit: 'a'.repeat(40), verify: { policy: 'any', family: 'off' } } });
      store.claim(board, item, { agentId: builder, lane: 'core', leaseMs: 60_000, freeze: () => ({ text, digest: 'fixture-digest' }) });
      submitFixture(board, item, { agentId: builder, commit: 'a'.repeat(40), tree: 'b'.repeat(40) });
      return { item, target, reviewer, blocker };
    },
    async pending({ board, link, extra }) {
      board.clock = store.systemClock;
      const args = [extra.item, { agentId: extra.reviewer, decision: 'REJECT', reason: 'TEST_FAILURE', note: 'synthetic original verdict',
        head: 'a'.repeat(40), digest: 'fixture-digest', policy: 'any', implies: [extra.target] }];
      extra.verdict = prepareEngineMove(board, 'verify', args, { id: 'legacy-verdict', actor: extra.reviewer });
      await queueMove(link, { operation: 'verify', args, move: extra.verdict, quiet: true, applyLocally: () => store.verify(board, ...args) });
      const fact = store.events(board).filter(e => e.event_kind === 'fact').at(-1);
      extra.originalId = JSON.parse(fact.event_detail).id;
      const correction = [extra.target, { agentId: 'coordinator', kind: 'note', text: 'original correction', supersedes: extra.originalId }];
      extra.correction = prepareEngineMove(board, 'appendFact', correction, { id: 'legacy-correction', actor: 'coordinator' });
      correction[1].factId = extra.correction.id;
      await queueMove(link, { operation: 'appendFact', args: correction, move: extra.correction, quiet: true, applyLocally: () => store.appendFact(board, ...correction) });
    },
  });
  const reservation = prepareEngineMove(f.board, 'reserveReview', [f.extra.item, { agentId: f.extra.blocker, leaseMs: 2_000, policy: 'any' }],
    { id: 'intervening-reservation', actor: f.extra.blocker });
  f.records.push(await f.record(reservation, 4));
  const cp = await f.ordering.advanceCheckpoint(f.key, f.link.state, f.checkpoint, f.records, 4);
  for (const [elapsed, expected] of [[5_000, 'REVIEW_HELD'], [7_000, undefined]]) {
    const copy = store.openBoard(':memory:');
    try {
      importBoard(copy, cp.native);
      const at = new Date(start + elapsed).toISOString();
      const outcome = applyRelayMove(copy, f.extra.verdict, { sequence: 5, at, kind: 'move', sender: { kind: 'agent', userId: 'fixture', agent: f.extra.reviewer } });
      assert.equal(outcome.error?.code, expected, 'the authentic reservation distinguishes local refusal from later ordered success');
      if (!expected) {
        const correction = applyRelayMove(copy, f.extra.correction, { sequence: 6, at, kind: 'move', sender: { kind: 'agent', userId: 'fixture', agent: 'coordinator' } });
        assert.equal(correction.error?.code, 'NO_FACT', 'sending would lose the original correction');
      }
    } finally { store.closeBoard(copy); }
  }
  const original = readFileSync(outboxFile(f.link.file));
  const queued = await readOutbox(outboxFile(f.link.file), f.key, f.id);
  for (const attempt of [1, 2]) {
    // A fresh link/state still reads the sealed original; no process-local veto may be required.
    const link = { ...f.link, state: structuredClone(f.link.state) };
    let refusal; try { await flushOutbox(link); } catch (error) { refusal = error; }
    assert.deepEqual(f.posts, [], `attempt ${attempt} must not send even the earlier unrelated queued move`);
    assert.equal(refusal?.code, 'RELAY_OUTBOX_IDENTITY');
    assert.deepEqual(readFileSync(outboxFile(f.link.file)), original, 'the refused replay must not replace its only identity evidence with empty captures');
    assert.deepEqual((await readOutbox(outboxFile(f.link.file), f.key, f.id)).moves, queued.moves);
    assert.equal(engineReceipt(f.board, f.extra.verdict.id), null);
    t.mock.timers.setTime(start + 20_000);
  }
});

for (const length of [73, 80]) test(`review2 canonical ${length}-character implied move seed remains deliverable [H16,H21,B31]`, async t => {
  const f = await fixture(t, {
    setup(board, directory) {
      store.register(board, { lane: 'web', path: join(directory, 'web-1') });
      const target = store.addItem(board, { by: 'coordinator', lane: 'coordinator', title: 'long implied identity', criterion: 'canonical seed' });
      const question = store.shout(board, { from: 'web-1', to: 'coordinator', text: 'original stable question', decision: true, lanes: ['web'] });
      return { target, question };
    },
    async pending({ board, link, extra }) {
      const id = 'v'.repeat(length);
      const args = [extra.question, { agentId: 'coordinator', text: 'canonical long answer', lanes: ['web'], implies: [extra.target] }];
      extra.move = prepareEngineMove(board, 'answerDecision', args, { id, actor: 'coordinator' });
      args[1].impliesId = id;
      await queueMove(link, { operation: 'answerDecision', args, move: extra.move, quiet: true, applyLocally: () => store.answerDecision(board, ...args) });
      extra.originalId = JSON.parse(store.events(board).filter(e => e.event_kind === 'fact').at(-1).event_detail).id;
      assert.equal(extra.originalId, `${impliesSeed(id)}-i${extra.target}`);
    },
  });
  await flushOutbox(f.link);
  assert.deepEqual(f.posts, [f.fourth.id, f.extra.move.id]);
  assert.equal(engineReceipt(f.board, f.extra.move.id)?.outcome.error, undefined);
  assert.ok(engineReceipt(f.board, f.extra.move.id), 'the canonical implied answer really reached ordered application');
  const facts = store.events(f.board).filter(e => e.event_kind === 'fact').map(e => JSON.parse(e.event_detail));
  assert.deepEqual(facts.map(fact => fact.id), [f.extra.originalId]);
  assert.equal(await readOutbox(outboxFile(f.link.file), f.key, f.id), null);
});

for (const kind of ['shout', 'event']) test(`review unshifted positional ${kind} references retain meaning and deliver [H16,H21,B27,N26]`, async t => {
  const f = await positionalFixture(t, kind);
  await flushOutbox(f.link);
  assert.deepEqual(referenceProjection(f.board), f.extra.original);
  for (const move of f.extra.moves) {
    const receipt = engineReceipt(f.board, move.id);
    assert.ok(receipt); assert.equal(receipt.outcome.error, undefined);
  }
  assert.equal(await readOutbox(outboxFile(f.link.file), f.key, f.id), null);
});

/** Explicit service-first selection uses real durable queue/link files and native SQLite, no live relay. */
export async function lossFixture(t, options = {}) {
  const f = await fixture(t, { partialReapply: true, ...options,
    setup(board, directory) {
      const actor = store.register(board, { lane: 'core', path: join(directory, 'builder'), route: 'mid' });
      return { actor };
    } });
  f.link.state.token = 'synthetic-machine-credential';
  f.link.state.pending = { move: { id: 'uncertain-original' }, sequence: 4, sealed: 'synthetic-retained-ciphertext' };
  f.link.loadLink = () => JSON.parse(readFileSync(f.link.file));
  f.link.saveLink = (file, state) => writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  f.link.saveLink(f.link.file, f.link.state);
  const queue = readFileSync(outboxFile(f.link.file));
  const choice = { queueSha256: createHash('sha256').update(queue).digest('hex'), decision: 'fixture principal accepts unpublished message loss' };
  return { ...f, queue, choice };
}

for (const cut of ['none', 'held', 'archived', 'restored']) test(`service-first recovery survives ${cut} cut without replay and resumes useful native work [H16,H21]`, async t => {
  const f = await lossFixture(t);
  const before = JSON.stringify(f.link.state);
  if (cut !== 'none') {
    f.link.io.recoveryCut = name => { if (name === cut) throw new Error('fixture interruption'); };
    await assert.rejects(discardUnpublished(f.link, f.choice), /fixture interruption/u);
    assert.equal(f.link.loadLink().recovery.kind, 'discard-unpublished');
    // Reopen the persisted link, rather than relying on the interrupted call's in-memory state.
    f.link.state = f.link.loadLink(); delete f.link.io.recoveryCut;
  }
  const result = await discardUnpublished(f.link, f.choice);
  assert.equal(result.sequence, 3);
  assert.equal(result.nativeEventCursor, f.board.db.prepare('SELECT max(event_id) AS id FROM event').get().id);
  assert.match(result.targetDigest, /^[0-9a-f]{64}$/u);
  assert.deepEqual(f.posts, [], 'neither settled nor uncertain nor abandoned old moves were posted');
  assert.deepEqual(engineReceipt(f.board, f.third.id), f.receipt);
  assert.equal(engineReceipt(f.board, f.fourth.id), null, 'abandonment did not invent a refusal/receipt');
  assert.equal(engineReceipt(f.board, 'uncertain-original'), null);
  assert.deepEqual(readFileSync(result.archive), f.queue);
  assert.equal(existsSync(outboxFile(f.link.file)), false);
  assert.equal(f.link.loadLink().token, JSON.parse(before).token);
  assert.equal(f.link.loadLink().board, f.id);
  assert.equal(f.link.loadLink().pending, undefined);
  assert.equal(JSON.parse(readFileSync(result.plan)).previousLinkState.pending.move.id, 'uncertain-original');
  assert.equal(f.link.loadLink().recovery, undefined);
  assert.equal(f.link.loadLink().cursor, f.board.db.prepare('SELECT max(event_id) AS id FROM event').get().id);
  const item = store.addItem(f.board, { by: 'coordinator', lane: 'core', title: 'new useful source work', criterion: 'claim exact source', route: 'mid',
    check: 'node --test test/relay-outbox-rebuild-recovery.test.js', brief: 'Files: src/relay-local-recovery.js\nTest: new native work can be claimed after explicit recovery' });
  const claimed = store.claim(f.board, item, { agentId: f.extra.actor, lane: 'core', leaseMs: 60000,
    freeze: () => ({ text: 'new source obligation', digest: 'fixture-source-digest' }) });
  assert.ok(claimed);
  const after = exportBoard(f.board);
  const again = await discardUnpublished(f.link, f.choice);
  assert.equal(again.alreadyCompleted, true);
  assert.deepEqual(exportBoard(f.board), after, 'response recovery never overwrites later native work');
});

for (const failure of ['wrong-digest', 'changed-during-fetch', 'foreign-checkpoint', 'short-prefix', 'receipt-mismatch']) test(`service-first preflight refuses ${failure} before losing local work [H16,H21]`, async t => {
  const f = await lossFixture(t);
  const native = exportBoard(f.board), link = readFileSync(f.link.file);
  if (failure === 'wrong-digest') f.choice.queueSha256 = 'f'.repeat(64);
  if (failure === 'changed-during-fetch') {
    const fetch = f.link.fetchCheckpoint;
    f.link.fetchCheckpoint = async key => { const cp = await fetch(key); f.link.state.testConcurrent = true; f.link.saveLink(f.link.file, f.link.state); return cp; };
  }
  if (failure === 'foreign-checkpoint') {
    const fetch = f.link.fetchCheckpoint;
    f.link.fetchCheckpoint = async key => { const cp = await fetch(key); cp.native.tables.board_meta.find(r => r.meta_key === 'board_id').meta_value = 'f'.repeat(32); return cp; };
  }
  if (failure === 'short-prefix') f.link.request = async () => ({ events: [] });
  if (failure === 'receipt-mismatch') {
    const advance = f.link.advanceCheckpoint;
    f.link.advanceCheckpoint = async (...args) => { const cp = await advance(...args); cp.native.tables.board_meta.find(r => r.meta_key === 'relay_receipt_' + f.third.id).meta_value += ' '; return cp; };
  }
  await assert.rejects(discardUnpublished(f.link, f.choice));
  assert.deepEqual(exportBoard(f.board), native);
  assert.deepEqual(readFileSync(outboxFile(f.link.file)), f.queue);
  if (failure !== 'changed-during-fetch') assert.deepEqual(readFileSync(f.link.file), link);
  assert.deepEqual(f.posts, []);
});

for (const failure of ['changed-plan', 'changed-queue', 'changed-board', 'changed-link']) test(`service-first persisted ${failure} keeps its recovery hold and refuses replacement [H16,H21]`, async t => {
  const f = await lossFixture(t);
  f.link.io.recoveryCut = name => { if (name === 'held') throw new Error('fixture interruption'); };
  await assert.rejects(discardUnpublished(f.link, f.choice), /fixture interruption/u);
  delete f.link.io.recoveryCut; f.link.state = f.link.loadLink();
  if (failure === 'changed-plan') writeFileSync(join(f.link.root, 'link', 'local-recovery', f.choice.queueSha256, 'plan.json'), '{}');
  if (failure === 'changed-queue') writeFileSync(outboxFile(f.link.file), 'changed queue');
  if (failure === 'changed-board') store.shout(f.board, { from: 'coordinator', to: 'all', text: 'new writer must not be lost', lanes: [] });
  if (failure === 'changed-link') { const state = f.link.loadLink(); state.pending = { move: { id: 'new-uncertain-writer' } }; f.link.saveLink(f.link.file, state); }
  const after = exportBoard(f.board), queue = readFileSync(outboxFile(f.link.file));
  await assert.rejects(discardUnpublished(f.link, f.choice));
  assert.deepEqual(exportBoard(f.board), after); assert.deepEqual(readFileSync(outboxFile(f.link.file)), queue);
  assert.equal(f.link.loadLink().recovery.kind, 'discard-unpublished'); assert.deepEqual(f.posts, []);
});
