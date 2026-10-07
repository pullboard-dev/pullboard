/**
 * The v1 board exchange keeps each SQLite row, including lifecycle history and sequence counters.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { main } from '../src/cli.js';
import { exportBoard, importBoard } from '../src/exchange.js';

const SHA = 'a'.repeat(40);
/** The deterministic frozen criterion used by the fixture. */
const FREEZE = (item) => ({ text: item.item_title, digest: `digest:${item.item_title}` });

/**
 * Make a real board file with every item state, both verdict outcomes, decision and evidence shouts,
 * registered agents, an event history and a held lane.
 * @param {string} file
 * @returns {any}
 */
function populatedBoard(file) {
  const board = store.openBoard(file);
  store.register(board, { lane: 'coordinator', path: '/source' });
  for (let index = 1; index <= 5; index += 1) store.register(board, { lane: 'web', path: `/source/web-${index}` });
  /** Add one open item before driving it into a lifecycle state. */
  const add = (title) => store.addItem(board, { by: 'coordinator', lane: 'web', title });
  const open = add('open');
  const claimed = add('claimed');
  store.claim(board, claimed, { agentId: 'web-1', lane: 'web', leaseMs: 3_600_000, freeze: FREEZE });
  const submitted = add('submitted');
  store.claim(board, submitted, { agentId: 'web-2', lane: 'web', leaseMs: 3_600_000, freeze: FREEZE });
  store.submit(board, submitted, { agentId: 'web-2', commit: SHA, tree: 'tree:submitted' });
  const verified = add('verified');
  store.claim(board, verified, { agentId: 'web-3', lane: 'web', leaseMs: 3_600_000, freeze: FREEZE });
  store.submit(board, verified, { agentId: 'web-3', commit: SHA, tree: 'tree:verified' });
  store.verify(board, verified, { agentId: 'web-4', decision: 'ACCEPT', note: 'removed the proof; its test failed', head: SHA, digest: `digest:verified`, policy: 'any' });
  const rejected = add('rejected then reopened');
  store.claim(board, rejected, { agentId: 'web-5', lane: 'web', leaseMs: 3_600_000, freeze: FREEZE });
  store.submit(board, rejected, { agentId: 'web-5', commit: SHA, tree: 'tree:rejected' });
  store.verify(board, rejected, { agentId: 'web-2', decision: 'REJECT', reason: 'TEST_FAILURE', note: 'the check fails', head: SHA, digest: `digest:rejected then reopened`, policy: 'any' });
  const withdrawn = add('withdrawn');
  store.withdraw(board, withdrawn, { agentId: 'coordinator', reason: 'no longer needed' });
  store.shout(board, { from: 'coordinator', to: 'web', text: 'Should this ship?', lanes: ['web'], decision: true });
  store.shout(board, { from: 'web-1', to: 'coordinator', text: 'Tried the edge case', lanes: [], evidence: { kind: 'attempt', outcome: 'passed after fix', item: open, commit: SHA } });
  store.holdLane(board, 'web', { agentId: 'coordinator', reason: 'freeze the board for export' });
  return board;
}

/**
 * Create a disposable directory removed after a test finishes.
 * @returns {string}
 */
const tempDirectory = () => mkdtempSync(join(tmpdir(), 'pullboard-exchange-'));

/**
 * Create an isolated real git repo with the smallest valid Pullboard config.
 * @param {string} root
 */
function gitRepo(root) {
  mkdirSync(root);
  const result = spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ lanes: {} }));
}

test('round trips every board row, state, history and AUTOINCREMENT counter [A7]', () => {
  const directory = tempDirectory();
  const source = populatedBoard(join(directory, 'source.sqlite'));
  const target = store.openBoard(join(directory, 'target.sqlite'));
  try {
    const document = exportBoard(source);
    const result = importBoard(target, document);
    assert.deepEqual(result.tables, Object.keys(document.tables));
    assert.deepEqual(exportBoard(target), document);
    assert.deepEqual(document.tables.item.map((row) => row.item_status).sort(), ['claimed', 'open', 'open', 'submitted', 'verified', 'withdrawn']);
    assert.ok(document.tables.verdict.some((row) => row.verdict_decision === 'ACCEPT'));
    assert.ok(document.tables.verdict.some((row) => row.verdict_decision === 'REJECT'));
    assert.ok(document.tables.shout.some((row) => row.shout_decision === 1));
    assert.ok(document.tables.shout.some((row) => row.shout_evidence_kind === 'attempt'));
    const previousSequence = document.tables.sqlite_sequence.find((row) => row.name === 'item').seq;
    const next = store.addItem(target, { by: 'coordinator', lane: 'web', title: 'next id' });
    assert.equal(next, previousSequence + 1);
  } finally {
    store.closeBoard(source);
    store.closeBoard(target);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('import refuses a board with rows and leaves it unchanged [A7]', () => {
  const directory = tempDirectory();
  const source = populatedBoard(join(directory, 'source.sqlite'));
  const target = store.openBoard(join(directory, 'target.sqlite'));
  try {
    store.register(target, { lane: 'coordinator', path: '/target' });
    const before = exportBoard(target);
    assert.throws(() => importBoard(target, exportBoard(source)), /IMPORT_NOT_EMPTY.*empty board/);
    assert.deepEqual(exportBoard(target), before);
  } finally {
    store.closeBoard(source);
    store.closeBoard(target);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('import refuses an export from another version before writing [A7]', () => {
  const directory = tempDirectory();
  const source = populatedBoard(join(directory, 'source.sqlite'));
  const target = store.openBoard(join(directory, 'target.sqlite'));
  try {
    const document = exportBoard(source);
    document.version = 2;
    assert.throws(() => importBoard(target, document), /IMPORT_VERSION.*version 1/);
    const empty = store.openBoard(':memory:');
    try {
      assert.deepEqual(exportBoard(target), exportBoard(empty));
    } finally {
      store.closeBoard(empty);
    }
  } finally {
    store.closeBoard(source);
    store.closeBoard(target);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('export and import CLI commands exchange a versioned document between real repos [A7]', async () => {
  const directory = tempDirectory();
  const sourceRoot = join(directory, 'source');
  const targetRoot = join(directory, 'target');
  gitRepo(sourceRoot);
  gitRepo(targetRoot);
  const source = store.openBoard(join(sourceRoot, '.git', 'pullboard', 'board.sqlite'));
  store.register(source, { lane: 'coordinator', path: sourceRoot });
  store.closeBoard(source);
  let exported = '';
  let errors = '';
  const streams = (cwd) => ({ cwd, stdout: { write: (text) => { exported += text; } }, stderr: { write: (text) => { errors += text; } } });
  try {
    assert.equal(await main(['export'], streams(sourceRoot)), 0, errors);
    const document = JSON.parse(exported);
    writeFileSync(join(directory, 'board.json'), JSON.stringify(document));
    exported = '';
    assert.equal(await main(['import', join(directory, 'board.json')], streams(targetRoot)), 0, errors);
    const imported = store.openBoard(join(targetRoot, '.git', 'pullboard', 'board.sqlite'));
    try {
      assert.deepEqual(JSON.parse(JSON.stringify(exportBoard(imported))), document);
    } finally {
      store.closeBoard(imported);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
