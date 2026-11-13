/** Recover an interrupted local rebuild from authenticated order, never by resending its prefix [H16,H21]. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as store from '../src/board.js';
import { applyRelayMove, appliedSequence, checkpointSequence, engineReceipt, prepareEngineMove } from '../src/engine.js';
import { exportBoard } from '../src/exchange.js';
import { storeBoardKey } from '../src/relay-key.js';
import { relayOrdering } from '../src/relay-ordering.js';
import { flushOutbox, outboxFile, queueMove, readOutbox, writeOutbox } from '../src/relay-outbox.js';
import { undoQueued } from '../src/relay-outbox-undo.js';
import { seal, unseal } from '../src/seal.js';

/** Real SQLite, native changesets and sealed queue; the only remote is an in-process ordered fixture. */
async function fixture(t, { partialReapply = false, setup, pending } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-rebuild-recovery-'));
  const names = ['PULLBOARD_HOME', 'PULLBOARD_MACHINE_HOME', 'PULLBOARD_RELAY_KEY', 'PULLBOARD_RELAY_TOKEN'];
  const prior = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => { for (const name of names) { if (prior[name] === undefined) delete process.env[name]; else process.env[name] = prior[name]; } });
  process.env.PULLBOARD_HOME = join(directory, 'home');
  process.env.PULLBOARD_MACHINE_HOME = join(directory, 'machine');
  delete process.env.PULLBOARD_RELAY_KEY;
  delete process.env.PULLBOARD_RELAY_TOKEN;
  const board = store.openBoard(':memory:', { now: () => new Date('2026-10-24T00:00:00Z') });
  t.after(() => { store.closeBoard(board); rmSync(directory, { recursive: true, force: true }); });
  store.register(board, { lane: 'coordinator', path: directory, sessionDigest: 'a'.repeat(64) });
  const extra = setup?.(board, directory);
  checkpointSequence(board, 1);
  const id = board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='board_id'").get().meta_value;
  const key = randomBytes(32);
  storeBoardKey(id, key);
  const checkpoint = { native: exportBoard(board), sequence: 1 };
  const state = { board: id, sequence: 2, mode: 'ordered', machine: 'fixture-machine', outbox: { moves: [] } };
  mkdirSync(join(directory, 'link'), { mode: 0o700 });
  const file = join(directory, 'link', 'relay.json');
  const records = [], posts = [], reads = [], errors = [];
  /** Authenticate the fixture's actual sealed record and use the real deterministic board engine. */
  async function replay(board, key, state, record) {
    const bytes = await unseal(key, Buffer.from(record.sealed, 'base64url'), { boardId: state.board, kind: record.kind, sequence: record.event_id });
    const move = JSON.parse(Buffer.from(bytes).toString());
    return applyRelayMove(board, move, { sequence: record.event_id, at: record.event_at, sender: record.sender, kind: record.kind });
  }
  /** Preserve the exact move bytes and original sequence on the synthetic relay. */
  async function record(move, sequence) {
    return { event_id: sequence, event_at: `2026-10-24T00:00:0${sequence}Z`, kind: 'move',
      sender: { kind: 'agent', userId: 'fixture', agent: 'coordinator' },
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
  return { board, link, key, id, checkpoint, records, posts, reads, errors, receipt, third, fourth, ordering, extra };
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
async function leaseFixture(t) {
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
          applyLocally: () => store.claim(board, ...args) });
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
