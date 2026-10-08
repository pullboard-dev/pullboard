/** Exercise typed item threads and deterministic replication on isolated SQLite boards [B29,B30,B31,B32]. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { serveApi } from '../src/api.js';
import { main } from '../src/cli.js';
import { relayPresentation } from '../src/relay-presentation.js';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { applyEngineMove, prepareEngineMove } from '../src/engine.js';
import { ENGINE_VERSION } from '../src/machine.js';
import { exportBoard, importBoard } from '../src/exchange.js';

const HOUR = 3_600_000;
const SHA = 'a'.repeat(40);
const KINDS = ['capture', 'measurement', 'note', 'diff', 'decision', 'rejection', 'supersession', 'root-cause'];

/** Open an isolated board with stable time and registered actors; close it with the test. */
function fixture(t) {
  let at = Date.parse('2026-10-08T00:00:00.000Z');
  const clock = { now: () => new Date(at), advance: (ms) => { at += ms; } };
  const board = store.openBoard(':memory:', clock);
  t.after(() => store.closeBoard(board));
  store.register(board, { lane: 'coordinator', path: '/repo' });
  store.register(board, { lane: 'web', path: '/repo-web-1' });
  store.register(board, { lane: 'web', path: '/repo-web-2' });
  store.register(board, { lane: 'api', path: '/repo-api-1' });
  return { board, clock };
}

/** Add a web item and optionally hold it under a deterministic two-hour lease. */
function item(board, title = 'Threaded item', holder = null) {
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title });
  if (holder) store.claim(board, id, {
    agentId: holder, lane: 'web', leaseMs: 2 * HOUR,
    freeze: (found) => ({ text: found.item_title, digest: `digest:${found.item_title}` }),
  });
  return id;
}

test('[B29] every fact kind is stamped, and nonholders can append observations', (t) => {
  const { board } = fixture(t);
  const id = item(board, 'All fact kinds', 'web-1');
  const observations = ['capture', 'measurement', 'note', 'diff'];
  for (const kind of observations) {
    const fact = store.appendFact(board, id, { agentId: 'web-2', kind, text: `evidence: ${kind}`, factId: `observation-${kind}` });
    assert.deepEqual({ id: fact.id, kind: fact.kind, text: fact.text, by: fact.by, at: fact.at, ref: fact.ref, supersedes: fact.supersedes }, {
      id: `observation-${kind}`, kind, text: `evidence: ${kind}`, by: 'web-2', at: '2026-10-08T00:00:00.000Z', ref: null, supersedes: null,
    });
  }
  for (const kind of ['decision', 'rejection', 'supersession', 'root-cause']) {
    assert.equal(store.appendFact(board, id, { agentId: 'web-1', kind, text: `judgement: ${kind}`, factId: `judgement-${kind}` }).kind, kind);
  }
  assert.deepEqual(store.itemThread(board, id).filter((entry) => entry.type === 'fact').map(({ kind }) => kind), KINDS);
  const before = store.events(board).length;
  assert.throws(() => store.appendFact(board, id, { agentId: 'absent-agent', kind: 'note', text: 'unknown author' }), { code: 'NO_AGENT' });
  assert.throws(() => store.appendFact(board, id, { agentId: 'web-2', kind: 'guess', text: 'unsupported label' }), { code: 'BAD_FACT_KIND' });
  assert.throws(() => store.appendFact(board, id, { agentId: 'web-2', kind: 'note', text: '  ' }), { code: 'EMPTY_FACT' });
  assert.throws(() => store.appendFact(board, id, { agentId: 'web-2', kind: 'note', text: 'duplicate identity', factId: 'observation-note' }), { code: 'BAD_FACT_ID' });
  assert.equal(store.events(board).length, before, 'invalid facts create no partial events');
  const closed = item(board, 'Closed item');
  store.withdraw(board, closed, { agentId: 'coordinator', reason: 'kept for historical evidence' });
  assert.equal(store.appendFact(board, closed, { agentId: 'api-1', kind: 'note', text: 'history can still receive evidence' }).by, 'api-1');
  assert.equal(store.getItem(board, closed).item_status, 'withdrawn', 'a fact can be appended to a closed item without reopening it');
});

test('[B30] judgements and corrections require the live holder or coordinator, including after lease expiry', (t) => {
  const { board, clock } = fixture(t);
  const id = item(board, 'Guarded item', 'web-1');
  const observation = store.appendFact(board, id, { agentId: 'web-2', kind: 'note', text: 'shared evidence', factId: 'guard-evidence' });
  for (const kind of ['decision', 'rejection', 'supersession', 'root-cause']) {
    assert.throws(() => store.appendFact(board, id, { agentId: 'web-2', kind, text: 'unauthorized judgement', factId: `denied-${kind}` }), { code: 'FACT_JUDGEMENT' });
  }
  assert.throws(() => store.appendFact(board, id, { agentId: 'web-2', kind: 'note', text: 'unauthorized correction', supersedes: observation.id, factId: 'denied-correction' }), { code: 'FACT_JUDGEMENT' });
  assert.equal(store.appendFact(board, id, { agentId: 'coordinator', kind: 'decision', text: 'coordinator judgement', factId: 'coordinator-decision' }).by, 'coordinator');
  clock.advance(2 * HOUR + 1);
  assert.throws(() => store.appendFact(board, id, { agentId: 'web-1', kind: 'decision', text: 'expired-holder judgement', factId: 'expired-decision' }), { code: 'FACT_JUDGEMENT' });
  assert.throws(() => store.appendFact(board, id, { agentId: 'web-1', kind: 'note', text: 'expired-holder correction', supersedes: observation.id, factId: 'expired-correction' }), { code: 'FACT_JUDGEMENT' });
});

test('[B31] fact events are append-only, corrections retain both facts, and supersession stays on its item', (t) => {
  const { board } = fixture(t);
  const id = item(board, 'Correction chain', 'web-1');
  const otherId = item(board, 'Other item');
  const original = store.appendFact(board, id, { agentId: 'web-2', kind: 'measurement', text: 'first value', factId: 'correction-original' });
  const first = store.appendFact(board, id, { agentId: 'web-1', kind: 'supersession', text: 'corrected once', supersedes: original.id, factId: 'correction-one' });
  const second = store.appendFact(board, id, { agentId: 'web-1', kind: 'supersession', text: 'corrected twice', supersedes: first.id, factId: 'correction-two' });
  assert.deepEqual(store.itemThread(board, id).filter((entry) => entry.type === 'fact').map(({ id: factId, text, supersedes }) => ({ id: factId, text, supersedes })), [
    { id: original.id, text: 'first value', supersedes: null },
    { id: first.id, text: 'corrected once', supersedes: original.id },
    { id: second.id, text: 'corrected twice', supersedes: first.id },
  ]);
  assert.throws(() => store.appendFact(board, otherId, { agentId: 'coordinator', kind: 'supersession', text: 'cross-item correction', supersedes: original.id, factId: 'cross-item' }), { code: 'NO_FACT' });
  assert.throws(() => board.db.prepare("UPDATE event SET event_detail = '{}' WHERE event_kind = 'fact'").run(), /append-only|immutable|event/i);
  assert.throws(() => board.db.prepare("DELETE FROM event WHERE event_kind = 'fact'").run(), /append-only|immutable|event/i);
  assert.equal(store.itemThread(board, id).filter((entry) => entry.type === 'fact').length, 3);
});

test('[B32] fact references require a full SHA and a safe positive ascending line range', (t) => {
  const { board } = fixture(t);
  const id = item(board, 'Bound evidence');
  const fact = store.appendFact(board, id, {
    agentId: 'web-1', kind: 'diff', text: 'lines changed', ref: `src/board.js:12-30@${SHA.toUpperCase()}`, factId: 'full-ref',
  });
  assert.deepEqual(fact.ref, { path: 'src/board.js', start: 12, end: 30, commit: SHA });
  for (const ref of [`src/board.js:12@${SHA.slice(0, 7)}`, `src/board.js:0@${SHA}`, `src/board.js:9-4@${SHA}`, `../board.js:1@${SHA}`, `/tmp/board.js:1@${SHA}`]) {
    assert.throws(() => store.appendFact(board, id, { agentId: 'web-1', kind: 'note', text: 'bad ref', ref, factId: `bad-${ref.replaceAll(/[^A-Za-z0-9]/gu, '-')}` }), { code: 'BAD_FACT_REF' }, ref);
  }
});

test('[B29,B31,B32] itemThread merges moves and facts in append order with exact ids, stamps and text', (t) => {
  const { board, clock } = fixture(t);
  const id = item(board, 'Ordered thread');
  const beforeClaim = store.events(board, { itemId: id }).at(-1);
  clock.advance(1_000);
  store.claim(board, id, {
    agentId: 'web-1', lane: 'web', leaseMs: 2 * HOUR,
    freeze: (found) => ({ text: found.item_title, digest: `digest:${found.item_title}` }),
  });
  const claimEvent = store.events(board, { itemId: id }).at(-1);
  clock.advance(1_000);
  const fact = store.appendFact(board, id, { agentId: 'web-2', kind: 'capture', text: 'first line\nsecond line stays', factId: 'ordered-fact' });
  clock.advance(1_000);
  store.release(board, id, 'web-1');
  const releaseEvent = store.events(board, { itemId: id }).at(-1);
  const thread = store.itemThread(board, id);
  assert.deepEqual(thread.map((entry) => entry.type === 'fact' ? `fact:${entry.id}` : `move:${entry.kind}`), [
    `move:${beforeClaim.event_kind}`, `move:${claimEvent.event_kind}`, `fact:${fact.id}`, 'move:release',
  ]);
  assert.deepEqual(thread[2], {
    type: 'fact', id: 'ordered-fact', eventId: fact.eventId, kind: 'capture', text: 'first line\nsecond line stays',
    by: 'web-2', at: '2026-10-08T00:00:02.000Z', ref: null, supersedes: null,
  });
  assert.equal(thread[0].eventId, beforeClaim.event_id);
  assert.equal(thread[1].eventId, claimEvent.event_id);
  assert.equal(thread[3].eventId, releaseEvent.event_id);
  assert.ok(thread.every((entry, index) => index === 0 || thread[index - 1].eventId < entry.eventId));
});

test('[B31,B32] native export and import preserve every fact in the item thread', (t) => {
  const { board } = fixture(t);
  const id = item(board, 'Portable thread', 'web-1');
  const first = store.appendFact(board, id, { agentId: 'web-2', kind: 'note', text: 'original', factId: 'portable-original' });
  store.appendFact(board, id, { agentId: 'web-1', kind: 'supersession', text: 'corrected', supersedes: first.id, factId: 'portable-correction' });
  const restored = store.openBoard(':memory:');
  t.after(() => store.closeBoard(restored));
  importBoard(restored, exportBoard(board));
  assert.deepEqual(store.itemThread(restored, id), store.itemThread(board, id));
  assert.deepEqual(exportBoard(restored), exportBoard(board));
});

test('[B29,B31,H16] engine fact replay uses move ids, retries once, and keeps corrections identical across replicas', (t) => {
  const clock = { now: () => new Date('2026-10-08T00:00:00.000Z') };
  const left = store.openBoard(':memory:', clock);
  const right = store.openBoard(':memory:', clock);
  t.after(() => { store.closeBoard(left); store.closeBoard(right); });
  for (const replica of [left, right]) {
    store.register(replica, { lane: 'coordinator', path: '/replicated-repo' });
    store.register(replica, { lane: 'web', path: '/replicated-repo-web-1' });
    const id = store.addItem(replica, { by: 'coordinator', lane: 'web', title: 'Replicated thread' });
    assert.equal(id, 1);
    replica.db.prepare('UPDATE board_meta SET meta_value = ? WHERE meta_key = ?').run('b'.repeat(32), 'board_id');
  }
  const id = 1;
  const baselineEvents = store.events(left).length;
  const first = prepareEngineMove(left, 'appendFact', [id, { agentId: 'web-1', kind: 'note', text: 'replicated original' }], { id: 'fact-envelope-one' });
  assert.equal(first.engine, ENGINE_VERSION);
  const firstOptions = { sequence: 1, at: '2026-10-08T00:00:10.000Z' };
  const firstLeft = applyEngineMove(left, first, firstOptions);
  assert.deepEqual(applyEngineMove(right, first, firstOptions), firstLeft);
  assert.equal(firstLeft.result.id, first.id);
  assert.equal(store.events(left).length, baselineEvents + 1);
  assert.deepEqual(applyEngineMove(left, first, firstOptions), firstLeft, 'retry returns its receipt');
  assert.equal(store.events(left).length, baselineEvents + 1, 'retry creates no duplicate event');
  const correction = prepareEngineMove(left, 'appendFact', [id, {
    agentId: 'coordinator', kind: 'supersession', text: 'replicated correction', supersedes: first.id,
  }], { id: 'fact-envelope-two' });
  assert.equal(correction.engine, ENGINE_VERSION);
  const secondOptions = { sequence: 2, at: '2026-10-08T00:00:11.000Z' };
  const correctedLeft = applyEngineMove(left, correction, secondOptions);
  assert.deepEqual(applyEngineMove(right, correction, secondOptions), correctedLeft);
  const facts = store.itemThread(left, id).filter((entry) => entry.type === 'fact');
  assert.deepEqual(facts.map(({ id: factId, text, supersedes }) => ({ id: factId, text, supersedes })), [
    { id: first.id, text: 'replicated original', supersedes: null },
    { id: correction.id, text: 'replicated correction', supersedes: first.id },
  ]);
  assert.deepEqual(store.itemThread(right, id), store.itemThread(left, id));
  assert.equal(store.events(left).length, baselineEvents + 2);
  assert.deepEqual(exportBoard(right), exportBoard(left));
});

/** Exercise facts through the private CLI and local HTTP API against one real isolated repo [B29,B30,B31,B32,A2]. */

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');

/** Quote one path literally for the private worktree's pullboard shim. */
function shellWordHttp(value) {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** Build a committed project in a private HOME, with CLI calls isolated from personal Git state. */
function threadHttpFixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-thread-http-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'repo');
  const bin = join(dir, 'bin');
  mkdirSync(root);
  mkdirSync(bin);
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec ${shellWordHttp(process.execPath)} ${shellWordHttp(BIN)} "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = {
    ...process.env,
    HOME: join(dir, 'home'),
    PULLBOARD_HOME: join(dir, 'home'),
    PATH: bin + ':' + process.env.PATH,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Thread HTTP Fixture',
    GIT_AUTHOR_EMAIL: 'thread-http@example.invalid',
    GIT_COMMITTER_NAME: 'Thread HTTP Fixture',
    GIT_COMMITTER_EMAIL: 'thread-http@example.invalid',
  };
  mkdirSync(env.HOME);
  /** Run Git only in this disposable repository and return trimmed output. */
  const git = (...args) => execFileSync('git', args, { cwd: root, env, stdio: 'pipe', encoding: 'utf8' }).trim();
  /** Invoke the actual CLI with the private environment. */
  const run = (cwd, ...args) => spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
  /** Decode one successful JSON command. */
  function cli(cwd, ...args) {
    const result = run(cwd, ...args, '--json');
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}${result.stdout}`);
    return JSON.parse(result.stdout);
  }
  git('init', '-q', '-b', 'main');
  cli(root, 'init');
  const configFile = join(root, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, gate: 'true', lanes: { app: { owns: ['app/'] } } }));
  writeFileSync(join(root, 'SPEC.md'), '# Thread fixture\n\n## Goals\n- G1 [approved, must] Keep item evidence. | gate: true\n');
  writeFileSync(join(root, 'thread-fixture.txt'), 'committed reference target\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: create private thread fixture');
  return { dir, root, env, git, cli, run, commit: git('rev-parse', 'HEAD') };
}

/** Start a real authenticated API for only this test's fixture board. */
async function threadHttpBox(t) {
  const box = threadHttpFixture(t);
  const api = await serveApi({ runCommand: main, projects: () => [{ root: box.root, name: 'Thread HTTP fixture' }] });
  t.after(() => api.close());
  const url = new URL(api.url);
  const key = url.searchParams.get('k');
  const catalogResponse = await fetch(url.origin + '/api/v1/boards', { headers: { 'x-pullboard-key': key } });
  assert.equal(catalogResponse.status, 200);
  const catalog = await catalogResponse.json();
  const id = catalog.boards[0].id;
  /** Send an authenticated JSON request and return its HTTP status and decoded body. */
  async function call(path, value) {
    const response = await fetch(url.origin + path, {
      method: value === undefined ? 'GET' : 'POST',
      headers: { 'x-pullboard-key': key, ...(value === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
    return { status: response.status, document: await response.json() };
  }
  return { ...box, api, url, key, boardId: id, path: `/api/v1/boards/${id}`, call };
}

test('[B29,B30,B31,B32,A2] CLI and HTTP facts share stamped threads, guard judgements, and preserve full refs and literal text', async (t) => {
  const box = await threadHttpBox(t);
  const holder = box.cli(box.root, 'worktree', 'app');
  const observer = box.cli(box.root, 'worktree', 'app');
  const added = await box.call(box.path + '/moves', { verb: 'add', args: { lane: 'app', title: 'Evidence item', criterion: 'thread stays readable', specs: 'G1' } });
  assert.equal(added.status, 200);
  const id = added.document.result.item.item_id;
  const claim = await box.call(box.path + '/moves', { verb: 'claim', item: id, agent: holder.agent });
  assert.equal(claim.status, 200);
  assert.equal(claim.document.event.event_kind, 'claim');

  const rawRef = `thread-fixture.txt:1@${box.commit}`;
  const shortRef = await box.call(box.path + '/moves', {
    verb: 'fact', item: id, agent: observer.agent,
    args: { kind: 'note', text: 'short reference refused', ref: `thread-fixture.txt:1@${box.commit.slice(0, 7)}` },
  });
  assert.equal(shortRef.status, 409);
  assert.equal(shortRef.document.error.code, 'BAD_FACT_REF');
  const observation = await box.call(box.path + '/moves', {
    verb: 'fact', item: id, agent: observer.agent,
    args: { kind: 'note', text: '--literal evidence', ref: rawRef },
  });
  assert.equal(observation.status, 200);
  assert.equal(observation.document.event.event_kind, 'fact');
  assert.equal(observation.document.event.event_by, observer.agent);
  assert.equal(observation.document.result.fact.text, '--literal evidence');
  assert.equal(observation.document.version, 1);
  assert.equal(observation.document.result.version, 1);
  assert.equal(observation.document.result.fact.by, observer.agent);
  assert.equal(observation.document.result.fact.at, observation.document.event.event_at);
  assert.equal(observation.document.result.fact.eventId, observation.document.event.event_id);
  assert.match(observation.document.result.fact.id, /^[A-Za-z0-9_-]+$/u);
  assert.deepEqual(observation.document.result.fact.ref, {
    path: 'thread-fixture.txt', start: 1, end: 1, commit: box.commit,
  });
  const observationId = observation.document.result.fact.id;

  const beforeRefusal = await box.call(box.path + '/state');
  const existingThread = beforeRefusal.document.state.items.find((entry) => entry.id === id).thread;
  const refused = await box.call(box.path + '/moves', {
    verb: 'fact', item: id, agent: observer.agent,
    args: { kind: 'decision', text: 'observer cannot decide' },
  });
  assert.equal(refused.status, 409);
  assert.equal(refused.document.error.code, 'FACT_JUDGEMENT');
  const afterRefusal = await box.call(box.path + '/state');
  assert.deepEqual(afterRefusal.document.state.items.find((entry) => entry.id === id).thread, existingThread, 'a refused judgement appends no event');

  const correctionRun = box.run(holder.path, 'fact', String(id), 'supersession', '--supersedes', observationId, '--json', '--', 'corrected evidence');
  assert.equal(correctionRun.status, 0, correctionRun.stderr);
  const correction = JSON.parse(correctionRun.stdout);
  assert.equal(correction.item, id, 'the holder CLI command returns its versioned result');
  assert.equal(correction.fact.text, 'corrected evidence');
  const holderCorrection = correction.fact;
  assert.equal(holderCorrection.kind, 'supersession');
  assert.equal(holderCorrection.by, holder.agent);

  const terminalShow = box.run(box.root, 'show', String(id));
  assert.equal(terminalShow.status, 0, terminalShow.stderr);
  const oldText = `fact note ${observationId}: --literal evidence`;
  const newText = `fact supersession ${holderCorrection.id} (supersedes ${observationId}): corrected evidence`;
  const timeline = terminalShow.stdout.slice(terminalShow.stdout.indexOf('thread:'));
  assert.ok(timeline.indexOf('  add') >= 0 && timeline.indexOf('  claim') > timeline.indexOf('  add'), 'show includes moves in order');
  assert.ok(timeline.indexOf(oldText) > timeline.indexOf('  claim'), 'facts follow their earlier moves in one timeline');
  assert.ok(terminalShow.stdout.indexOf(oldText) >= 0, 'show prints the original literal-dash fact');
  assert.ok(terminalShow.stdout.indexOf(newText) > terminalShow.stdout.indexOf(oldText), 'show prints both corrections in append order');
  assert.ok(terminalShow.stdout.includes(`ref: thread-fixture.txt:1@${box.commit}`), 'show keeps the full commit reference');

  const terminalJson = JSON.parse(box.run(box.root, 'show', String(id), '--json').stdout);
  const apiState = await box.call(box.path + '/state');
  const apiItem = apiState.document.state.items.find((entry) => entry.id === id);
  assert.deepEqual(terminalJson.thread, apiItem.thread, 'CLI JSON and API state expose the same stamped thread');
  assert.deepEqual(relayPresentation(box.root).state.items.find((entry) => entry.id === id).thread, apiItem.thread, 'sealed presentation carries the same facts');
  assert.deepEqual(apiItem.thread.filter((entry) => entry.type === 'fact').map(({ id: factId, text, supersedes }) => ({ id: factId, text, supersedes })), [
    { id: observationId, text: '--literal evidence', supersedes: null },
    { id: holderCorrection.id, text: 'corrected evidence', supersedes: observationId },
  ]);
});
