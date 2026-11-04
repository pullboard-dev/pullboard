/** @pullboard-test-input source-tree */
/** @pullboard-test-loads src/compact-verdict-review.js src/engine.js src/relay-outbox.js src/relay-ordering.js */
/** Real Git/SQLite and sealed loopback transport; synthetic identities only [H3,H16,V8]. */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { expandReviewPaths } from '../src/compact-verdict-review.js';
import { COMPACT_VERDICT_REVIEW_ENGINE } from '../src/compact-verdict-review-engine.js';
import {
  appliedSequence,
  applyRelayMove,
  engineReceipt,
  executableArgs,
  prepareEngineMove,
} from '../src/engine.js';
import { localRecords, request, saveLink } from '../src/relay.js';
import { storeBoardKey } from '../src/relay-key.js';
import { locked } from '../src/relay-lock.js';
import {
  flushOutbox,
  outboxFile,
  queueMove,
  readOutbox,
} from '../src/relay-outbox.js';
import { withOutboxGuard } from '../src/relay-outbox-guard.js';
import { relayOrdering } from '../src/relay-ordering.js';
import { operationIntent } from '../src/relay-sender.js';
import { seal, unseal } from '../src/seal.js';
import { captureVerdictReview } from '../src/verdict-freshness.js';
import { submitFixture } from './board-submit-fixture.js';
import { runFixtureGit } from './fixture-child.js';

/** Hash real fixture data without copying any private board content. */
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

/** Build the native outbox an older writer queued, not a pre-compacted replacement. */
async function queuedReview(t) {
  const scratch = mkdtempSync(join(tmpdir(), 'pullboard-compact-outbox-'));
  const previousHome = process.env.PULLBOARD_HOME;
  process.env.PULLBOARD_HOME = join(scratch, 'home');
  t.after(() => {
    if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = previousHome;
    rmSync(scratch, { recursive: true, force: true });
  });
  const root = join(scratch, 'repo');
  mkdirSync(root);
  const git = (...args) => runFixtureGit(args, { cwd: root });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Outbox fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ lanes: { web: { owns: ['web/'] } } }));
  git('add', '.');
  git('commit', '-qm', 'synthetic base');
  const trunk = git('rev-parse', 'HEAD');
  git('switch', '-qc', 'candidate');
  const paths = [...Array.from({ length: 1420 }, (_, n) =>
    `web/synthetic-review-fixtures/a-long-shared-component-directory/another-shared-directory/case-${String(n).padStart(4, '0')}.txt`),
  'web/[literal]*?.txt'].sort();
  for (const path of paths) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), 'candidate\n');
  }
  git('add', '.');
  git('commit', '-qm', 'synthetic candidate');
  const head = git('rev-parse', 'HEAD'), tree = git('rev-parse', 'HEAD^{tree}');
  git('switch', '-q', 'main');
  const boardId = randomBytes(16).toString('hex'), key = randomBytes(32);
  storeBoardKey(boardId, key);
  const file = join(root, '.git/pullboard/relay.json');
  const journal = [], bodies = [], moves = [], warnings = [];
  /** Seal the real executable record with its board/kind/sequence binding. */
  const encode = async (move, sequence) => Buffer.from(await seal(key, Buffer.from(JSON.stringify(move)),
    { boardId, kind: 'move', sequence })).toString('base64url');
  /** Decode the actual authenticated fixture record for native replay. */
  const decode = async record => JSON.parse(new TextDecoder().decode(await unseal(key,
    Buffer.from(record.sealed, 'base64url'), { boardId, kind: record.kind, sequence: record.event_id })));
  /** Fixture transport identity is bound by native applyRelayMove; no live enrollment is used. */
  const sender = actor => ({ kind: 'agent', userId: 'fixture-owner', agent: actor, root: true, lineage: 'fixture-lineage' });
  let id, digest, review;
  const board = store.openBoard(join(dirname(file), 'board.sqlite'), undefined, { isMain: true, gitRoot: root });
  try {
    store.ensureCoordinator(board, root);
    for (const seat of ['web-1', 'web-2']) {
      const move = prepareEngineMove(board, 'register', [{ lane: 'web', id: seat,
        path: join(root, seat), createdBy: 'coordinator' }], { actor: 'coordinator' });
      move.engine = COMPACT_VERDICT_REVIEW_ENGINE - 1;
      const sequence = journal.length + 1, sealed = await encode(move, sequence), at = new Date().toISOString();
      const registration = { target: seat, creator: 'coordinator', sequence, digest: sha256(sealed) };
      const outcome = applyRelayMove(board, move, { sequence, at, sender: sender('coordinator'),
        kind: 'move', digest: registration.digest, registration });
      assert.equal(outcome.error, undefined);
      journal.push({ event_id: sequence, kind: 'move', sealed, event_at: at, sender: sender('coordinator'), registration });
    }
    id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Synthetic queued review' });
    const text = JSON.stringify({ rows: [], policy: { version: 1, commit: trunk, verify: { policy: 'any', family: 'off' } } });
    digest = sha256(text);
    store.claim(board, id, { agentId: 'web-1', lane: 'web', head: trunk,
      leaseMs: 3_600_000, freeze: () => ({ text, digest }) });
    submitFixture(board, id, { agentId: 'web-1', commit: head, tree, policyCommit: trunk });
    review = captureVerdictReview(root, board, store.getItem(board, id), trunk, head);
    assert.deepEqual(review.paths, paths);
  } finally { store.closeBoard(board); }
  let unavailable = false;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET') {
        if (unavailable) { res.writeHead(503); res.end(JSON.stringify({ version: 1,
          error: { code: 'UNAVAILABLE', message: 'synthetic unreadable journal' } })); return; }
        res.end(JSON.stringify({ version: 1, events: journal.filter(record => record.event_id > Number(url.searchParams.get('after'))) }));
        return;
      }
      assert.equal(req.method, 'POST');
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      bodies.push(bytes.length);
      if (bytes.length > 100_000) {
        res.writeHead(413);
        res.end(JSON.stringify({ version: 1, error: { code: 'BAD_REQUEST', message: 'body exceeds 100000 bytes' } }));
        return;
      }
      const body = JSON.parse(bytes);
      assert.equal(body.sequence, journal.length + 1);
      const record = { event_id: body.sequence, kind: 'move', sealed: body.sealed, event_at: new Date().toISOString() };
      const move = await decode(record);
      record.sender = sender(move.actor);
      journal.push(record);
      moves.push(move);
      res.end(JSON.stringify({ version: 1, event: record }));
    } catch (error) {
      res.writeHead(500);
      res.end(JSON.stringify({ version: 1, error: { code: 'FIXTURE_ERROR', message: error.message } }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const state = { version: 1, board: boardId, url: `http://127.0.0.1:${server.address().port}`,
    mode: 'ordered', baselineAccepted: true, sequence: journal.length, token: null,
    machine: 'fixture-machine', computerName: 'fixture' };
  saveLink(file, state);
  const io = { err: line => warnings.push(line) };
  const sealedRecord = async (_key, move, _state, _kind, sequence) => encode(move, sequence);
  const ordering = relayOrdering({ request, localRecords, decoded: async (_key, record) => decode(record),
    replayRelayRecord: async (b, _key, _state, record) => applyRelayMove(b, await decode(record),
      { sequence: record.event_id, at: record.event_at, sender: record.sender, kind: record.kind }),
    reportRecoveredReply: () => {}, saveLink, sealedRecord, flush: () => { throw new Error('unexpected recursive flush'); } });
  let loseReply = false;
  const link = { root, file, state, io, localRecords, saveLink, request, sealedRecord,
    applyRecords: ordering.applyRecords, fetchCheckpoint: () => { throw new Error('native reverse captures must remain usable'); },
    postPending: async (_root, _file, _state, pending) => {
      const logical = structuredClone(pending.move.args);
      if (pending.move.operation === 'verify' && !Array.isArray(logical[1].review.paths))
        logical[1].review.paths = expandReviewPaths(logical[1].review.paths);
      assert.equal(pending.intent, operationIntent(pending.move.operation, logical), 'logical command matching is unchanged');
      if (pending.move.operation === 'verify') {
        const durable = (await readOutbox(outboxFile(file), key, boardId)).moves.find(entry => entry.move.id === pending.move.id);
        assert.ok(Array.isArray(durable.move.args[1].review.paths), 'the older durable record is not amended');
        assert.equal(durable.move.engine, COMPACT_VERDICT_REVIEW_ENGINE - 1);
        assert.equal(durable.intent, pending.intent);
      }
      const reply = await request(state, `/api/v1/boards/${boardId}/moves`, { method: 'POST',
        body: { sequence: pending.sequence, sealed: pending.sealed } }, io);
      assert.equal(reply.event.sealed, pending.sealed);
      if (loseReply) { loseReply = false; throw Object.assign(new Error('synthetic lost acknowledgement'), { code: 'RELAY_UNAVAILABLE' }); }
    } };
  const args = [id, { agentId: 'web-2', decision: 'ACCEPT', note: 'Synthetic protocol fixture, not a product review.',
    head, digest, policy: 'any', familyPolicy: 'off', review, check: 'green' }];
  const move = localRecords(root, b => prepareEngineMove(b, 'verify', args, { actor: 'web-2' }));
  // Reconstruct the previous released writer's array form, retaining its real native bindings.
  move.engine = COMPACT_VERDICT_REVIEW_ENGINE - 1;
  move.args[1].review.paths = [...paths];
  await withOutboxGuard(file, () => queueMove(link, { operation: 'verify', args, move, quiet: true,
    applyLocally: () => localRecords(root, b => store.verify(b, ...executableArgs(move, b))) }));
  const factArgs = [id, { agentId: 'web-2', kind: 'note', text: 'later queued fixture fact' }];
  const tail = localRecords(root, b => prepareEngineMove(b, 'appendFact', factArgs, { actor: 'web-2' }));
  tail.engine = COMPACT_VERDICT_REVIEW_ENGINE - 1;
  await withOutboxGuard(file, () => queueMove(link, { operation: 'appendFact', args: factArgs, move: tail, quiet: true,
    applyLocally: () => localRecords(root, b => store.appendFact(b, ...executableArgs(tail, b))) }));
  const original = await readOutbox(outboxFile(file), key, boardId);
  return { root, file, state, link, key, boardId, journal, bodies, moves, warnings, id, digest, review, move, tail, original,
    setUnavailable: value => { unavailable = value; }, loseReply: () => { loseReply = true; },
    flush: () => locked(file, () => flushOutbox(link), io),
    remote: async () => {
      const remoteArgs = [id, { agentId: 'web-2', kind: 'note', text: 'independent remote fixture fact' }];
      const remote = localRecords(root, b => prepareEngineMove(b, 'appendFact', remoteArgs, { actor: 'web-2' }));
      remote.engine = COMPACT_VERDICT_REVIEW_ENGINE - 1;
      const sequence = journal.length + 1;
      journal.push({ event_id: sequence, kind: 'move', sealed: await encode(remote, sequence),
        event_at: new Date().toISOString(), sender: sender(remote.actor) });
    } };
}

/** Check real receipt, actor, exact coverage, frozen criterion and once-only tail after native replay. */
function assertSettled(f) {
  assert.equal(existsSync(outboxFile(f.file)), false);
  assert.deepEqual(f.moves.map(move => move.id), [f.move.id, f.tail.id]);
  const expanded = structuredClone(f.moves[0]);
  expanded.engine = f.move.engine;
  expanded.args[1].review.paths = expandReviewPaths(expanded.args[1].review.paths);
  assert.deepEqual(expanded, f.move, 'only wire coverage representation and its engine floor change');
  assert.ok(f.moves[0].engine >= COMPACT_VERDICT_REVIEW_ENGINE);
  assert.deepEqual(f.moves[1], f.tail, 'the later unrelated move is not rewritten');
  localRecords(f.root, board => {
    const item = store.getItem(board, f.id), verdict = store.acceptedVerdict(board, item);
    assert.equal(item.item_status, 'verified');
    assert.equal(item.item_frozen_digest, f.digest);
    assert.equal(verdict.verdict_by, f.move.actor);
    assert.deepEqual(verdict.review, f.review);
    for (const move of [f.move, f.tail]) assert.equal(engineReceipt(board, move.id).outcome.error, undefined);
    assert.equal(appliedSequence(board), f.journal.length);
    assert.equal(store.itemThread(board, f.id).filter(event => event.type === 'fact' && event.text === 'later queued fixture fact').length, 1);
  });
  assert.equal(f.warnings.some(line => /checkpoint|cannot be taken back/u.test(line)), false);
  assert.ok(f.bodies.every(bytes => bytes < 100_000));
}

for (const interleaved of [false, true]) {
  test(`older queued review uses native compact send/rebuild${interleaved ? ', concurrent remote move and lost ACK' : ''} [H3,H16,V8]`, async t => {
    const f = await queuedReview(t);
    assert.ok(Array.isArray(f.original.moves[0].move.args[1].review.paths));
    assert.equal(f.original.moves[0].intent, operationIntent('verify', f.move.args));
    if (interleaved) { await f.remote(); f.loseReply(); }
    if (interleaved) await assert.rejects(f.flush(), /synthetic lost acknowledgement/u);
    await f.flush();
    assertSettled(f);
    const count = f.bodies.length;
    await f.flush();
    assert.equal(f.bodies.length, count, 'a settled move is never posted again');
    t.diagnostic(`native recovery: ${f.review.paths.length} exact paths, ${f.moves.length} posts, max HTTP JSON ${Math.max(...f.bodies)} bytes`);
  });
}

test('unreadable remote journal leaves old queue, link and sealed pending untouched [H3,H16]', async t => {
  const f = await queuedReview(t);
  f.state.pending = { move: structuredClone(f.move), sequence: f.state.sequence + 1, sealed: 'opaque-existing-pending' };
  saveLink(f.file, f.state);
  const queue = readFileSync(outboxFile(f.file)), link = readFileSync(f.file);
  f.setUnavailable(true);
  await assert.rejects(f.flush());
  assert.deepEqual(readFileSync(outboxFile(f.file)), queue);
  assert.deepEqual(readFileSync(f.file), link);
  assert.deepEqual(await readOutbox(outboxFile(f.file), f.key, f.boardId), f.original);
  assert.equal(f.bodies.length, 0);
});
