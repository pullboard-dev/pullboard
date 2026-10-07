/**
 * The v1 board exchange keeps each SQLite row, including lifecycle history and sequence counters.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { exportBoard, importBoard } from '../src/exchange.js';

const SHA = 'a'.repeat(40);
const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
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

test('export keeps a single SQLite snapshot while another connection writes [A7]', () => {
  const directory = tempDirectory();
  const file = join(directory, 'shared.sqlite');
  const source = store.openBoard(file);
  const writer = store.openBoard(file);
  try {
    store.register(source, { lane: 'coordinator', path: '/shared' });
    store.register(source, { lane: 'web', path: '/shared/web-1' });
    store.register(source, { lane: 'web', path: '/shared/web-2' });
    store.addItem(source, { by: 'coordinator', lane: 'web', title: 'present before export' });
    const before = JSON.stringify(exportBoard(source));
    let wrote = false;
    const db = new Proxy(source.db, {
      get(target, property) {
        if (property === 'prepare') return (sql) => {
          const statement = target.prepare(sql);
          if (sql !== 'SELECT * FROM "item" ORDER BY rowid') return statement;
          return { all: (...args) => {
            const rows = statement.all(...args);
            if (!wrote) {
              wrote = true;
              writeAcceptedItem(writer);
            }
            return rows;
          } };
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const duringWrite = JSON.stringify(exportBoard({ db }));
    assert.equal(wrote, true, 'the second connection wrote after the item table was read');
    assert.equal(duringWrite, before, 'every exported table came from the same pre-write snapshot');
    assert.equal(exportBoard(writer).tables.item.length, 2, 'the legitimate write committed to the board');
  } finally {
    store.closeBoard(writer);
    store.closeBoard(source);
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * Create an item and finish its lifecycle on the second database connection.
 * @param {any} board
 */
function writeAcceptedItem(board) {
  const item = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'written during export' });
  const freeze = (row) => ({ text: row.item_title, digest: `digest:${row.item_title}` });
  store.claim(board, item, { agentId: 'web-1', lane: 'web', leaseMs: 3_600_000, freeze });
  store.submit(board, item, { agentId: 'web-1', commit: 'b'.repeat(40), tree: 'tree:concurrent' });
  store.verify(board, item, { agentId: 'web-2', decision: 'ACCEPT', note: 'the check passed', head: 'b'.repeat(40), digest: 'digest:written during export', policy: 'any' });
}

test('import refuses a board with rows and leaves it unchanged [A7]', () => {
  const directory = tempDirectory();
  const source = populatedBoard(join(directory, 'source.sqlite'));
  const target = store.openBoard(join(directory, 'target.sqlite'));
  try {
    store.register(target, { lane: 'coordinator', path: '/target' });
    store.addItem(target, { by: 'coordinator', lane: 'web', title: 'real work makes this board nonempty' });
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
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Exchange Test',
    GIT_AUTHOR_EMAIL: 'exchange@example.invalid',
    GIT_COMMITTER_NAME: 'Exchange Test',
    GIT_COMMITTER_EMAIL: 'exchange@example.invalid',
    PULLBOARD_HOME: join(directory, 'home'),
  };
  const cli = (cwd, ...args) => spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
  try {
    const initialized = cli(targetRoot, 'init');
    assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
    assert.match(initialized.stdout, /coordinator/i);

    const exported = cli(sourceRoot, 'export', '--json');
    assert.equal(exported.status, 0, exported.stderr || exported.stdout);
    const document = JSON.parse(exported.stdout);
    writeFileSync(join(directory, 'board.json'), JSON.stringify(document));
    const imported = cli(targetRoot, 'import', join(directory, 'board.json'));
    assert.equal(imported.status, 0, imported.stderr || imported.stdout);
    assert.match(imported.stdout, /imported version 1 board tables/);

    const reexported = cli(targetRoot, 'export', '--json');
    assert.equal(reexported.status, 0, reexported.stderr || reexported.stdout);
    assert.deepEqual(JSON.parse(reexported.stdout), document, 'a board initialized by pullboard can receive the full export');

    const importedBoard = store.openBoard(join(targetRoot, '.git', 'pullboard', 'board.sqlite'));
    try {
      assert.deepEqual(JSON.parse(JSON.stringify(exportBoard(importedBoard))), document);
    } finally {
      store.closeBoard(importedBoard);
    }
    const status = cli(targetRoot, 'status');
    assert.equal(status.status, 0, status.stderr || status.stdout);
    const listed = cli(targetRoot, 'list', '--all');
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
