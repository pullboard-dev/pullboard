import { AGENT_GRANT_ENGINE } from '../src/agent-grant-engine.js';
/**
 * The v1 board exchange keeps each SQLite row, including lifecycle history and sequence counters.
 */
import { submitFixture } from './board-submit-fixture.js';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  runFixtureChild,
  runFixtureGit,
} from './fixture-child.js';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import { test } from 'node:test';
import * as store from '../src/board.js';
import {
  exportBoard,
  importBoard,
  isInitialBoard,
} from '../src/exchange.js';
import { SIGNED_EVENT_LOG_VERSION } from '../src/board.js';

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
  submitFixture(board, submitted, { agentId: 'web-2', commit: SHA, tree: 'tree:submitted' });
  const verified = add('verified');
  store.claim(board, verified, { agentId: 'web-3', lane: 'web', leaseMs: 3_600_000, freeze: FREEZE });
  submitFixture(board, verified, { agentId: 'web-3', commit: SHA, tree: 'tree:verified' });
  store.verify(board, verified, { agentId: 'web-4', decision: 'ACCEPT', note: 'removed the proof; its test failed', head: SHA, digest: `digest:verified`, policy: 'any' });
  const rejected = add('rejected then reopened');
  store.claim(board, rejected, { agentId: 'web-5', lane: 'web', leaseMs: 3_600_000, freeze: FREEZE });
  submitFixture(board, rejected, { agentId: 'web-5', commit: SHA, tree: 'tree:rejected' });
  store.verify(board, rejected, { agentId: 'web-2', decision: 'REJECT', reason: 'TEST_FAILURE', note: 'the check fails', clause: 'rejected then reopened', head: SHA, digest: `digest:rejected then reopened`, policy: 'any' });
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
  runFixtureGit(['init', '-q'], { cwd: root, encoding: 'utf8' });
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

test('[A5] imported event logs refuse future formats and upgrade older formats', () => {
  const directory = tempDirectory();
  const source = populatedBoard(join(directory, 'source.sqlite'));
  const target = store.openBoard(join(directory, 'target.sqlite'));
  try {
    const before = exportBoard(target);
    const future = structuredClone(exportBoard(source));
    const futureVersion = future.tables.board_meta.find((row) => row.meta_key === 'event_log_version');
    futureVersion.meta_value = String(SIGNED_EVENT_LOG_VERSION + 1); // Format 2 is a signed board's, which this Pullboard reads [E22].
    assert.throws(() => importBoard(target, future), (error) => {
      assert.equal(error.code, 'EVENT_LOG_VERSION');
      assert.match(error.message, new RegExp(`version ${SIGNED_EVENT_LOG_VERSION + 1}.*version ${SIGNED_EVENT_LOG_VERSION}`));
      assert.match(error.message, /upgrade pullboard/i);
      return true;
    });
    assert.deepEqual(exportBoard(target), before, 'a future export refusal leaves the target unchanged');

    const older = structuredClone(exportBoard(source));
    older.tables.board_meta.find((row) => row.meta_key === 'event_log_version').meta_value = '0';
    importBoard(target, older);
    assert.equal(
      exportBoard(target).tables.board_meta.find((row) => row.meta_key === 'event_log_version').meta_value,
      String(store.EVENT_LOG_VERSION),
      'an older event-log export upgrades its marker on import',
    );
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
  submitFixture(board, item, { agentId: 'web-1', commit: 'b'.repeat(40), tree: 'tree:concurrent' });
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
    const before = exportBoard(target);
    document.version = 2;
    assert.throws(() => importBoard(target, document), /IMPORT_VERSION.*version 1/);
    assert.deepEqual(exportBoard(target), before);
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
  const cli = (cwd, ...args) => runFixtureChild(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
  try {
    // An import recipient starts without its own declared coordinator metadata.
    const initEnv = { ...env };
    delete initEnv.PULLBOARD_MODEL;
    const initialized = runFixtureChild(process.execPath, [BIN, 'init', '--verbose'], { cwd: targetRoot, env: initEnv, encoding: 'utf8' });
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


test('import preserves other metadata and refuses malformed fresh identities [A2,A7]', () => {
  const directory = tempDirectory();
  const source = populatedBoard(join(directory, 'source.sqlite'));
  try {
    for (const [index, change] of [
      "INSERT INTO board_meta VALUES ('retained', 'repo setting')",
      "UPDATE board_meta SET meta_value = 'invalid' WHERE meta_key = 'board_id'",
    ].entries()) {
      const target = store.openBoard(join(directory, `target-${index}.sqlite`));
      try {
        store.register(target, { lane: 'coordinator', path: '/target' });
        target.db.exec(change);
        const before = exportBoard(target);
        assert.throws(() => importBoard(target, exportBoard(source)), /IMPORT_NOT_EMPTY.*empty board/);
        assert.deepEqual(exportBoard(target), before, 'a refusal preserves every target row');
      } finally {
        store.closeBoard(target);
      }
    }
  } finally {
    store.closeBoard(source);
    rmSync(directory, { recursive: true, force: true });
  }
});


test('fresh-init approval baselines are disposable only with exact setup history [A2,A7,S1]', () => {
  const directory = tempDirectory();
  const source = populatedBoard(join(directory, 'source.sqlite'));
  const setup = store.openBoard(join(directory, 'setup.sqlite'));
  /** An exact valid source snapshot, deliberately different on the two boards. */
  const baseline = text => ({ version: 1, file: 'SPEC.md', anchor: null,
    rows: [{ id: 'G1', text, source: `- G1 [approved, must] ${text}` }] });
  try {
    store.recordSpecApprovalBaseline(source, { agentId: 'coordinator', baseline: baseline('The imported source governs.') });
    const incoming = exportBoard(source);
    store.register(setup, { lane: 'coordinator', path: '/fresh' });
    store.recordSpecApprovalBaseline(setup, { agentId: 'coordinator', baseline: baseline('Local setup is disposable.') });
    for (let index = 0; index < 6; index += 1) {
      const target = store.openBoard(join(directory, `fresh-${index}.sqlite`));
      try {
        // A trusted restore can carry malformed old state; no append-only guard is bypassed here.
        const initial = exportBoard(setup);
        if (index === 1) initial.tables.board_meta.push({ meta_key: 'retained', meta_value: 'repo setting' });
        if (index === 2) initial.tables.event[1].event_by = 'machine';
        if (index === 3) initial.tables.event[1].item_id = 42;
        if (index === 4) initial.tables.board_meta.find(row => row.meta_key === 'spec_approval_baseline').meta_value = '{}';
        if (index === 5) {
          initial.tables.event.push({ ...initial.tables.event[0], event_id: 3, event_kind: 'unrelated', event_detail: '{}' });
          initial.tables.sqlite_sequence.find(row => row.name === 'event').seq = 3;
        }
        importBoard(target, initial);
        if (index) {
          const before = exportBoard(target);
          assert.throws(() => importBoard(target, incoming), /IMPORT_NOT_EMPTY/u);
          assert.deepEqual(exportBoard(target), before, 'non-setup history and metadata remain untouched');
        } else {
          importBoard(target, incoming);
          assert.deepEqual(exportBoard(target), incoming, 'the source baseline and every source row replace local setup');
          assert.equal(store.specApprovalBaseline(target).rows[0].text, 'The imported source governs.');
        }
      } finally { store.closeBoard(target); }
    }
  } finally {
    store.closeBoard(setup);
    store.closeBoard(source);
    rmSync(directory, { recursive: true, force: true });
  }
});


test('fresh-init grant markers permit pairing without admitting other history [A2,A7,E21]', () => {
  const directory = tempDirectory();
  const source = populatedBoard(join(directory, 'source.sqlite'));
  const setup = store.openBoard(join(directory, 'setup.sqlite'));
  try {
    store.register(setup, { lane: 'coordinator', path: '/fresh' });
    const incoming = exportBoard(source);
    const cases = [
      { detail: JSON.parse(exportBoard(setup).tables.event[0].event_detail), allowed: true },
      { detail: { lane: 'coordinator' }, allowed: true },
      { detail: { lane: 'coordinator', grantEngine: AGENT_GRANT_ENGINE }, allowed: true },
      { detail: { lane: 'coordinator', grantEngine: AGENT_GRANT_ENGINE, model: 'unknown', family: null }, allowed: true },
      { detail: { lane: 'coordinator', family: 'openai' }, allowed: false },
      { detail: { lane: 'coordinator', family: '' }, allowed: false },
      { detail: { lane: 'coordinator', family: false }, allowed: false },
      { detail: { lane: 'coordinator', family: {} }, allowed: false },
      { detail: { lane: 'coordinator', grantEngine: String(AGENT_GRANT_ENGINE) }, allowed: false },
      { detail: { lane: 'coordinator', grantEngine: AGENT_GRANT_ENGINE + 1 }, allowed: false },
      { detail: { lane: 'coordinator', grantEngine: AGENT_GRANT_ENGINE, grant: 'stored authority' }, allowed: false },
    ];
    for (const [index, entry] of cases.entries()) {
      const target = store.openBoard(join(directory, `marker-${index}.sqlite`));
      try {
        const initial = exportBoard(setup);
        initial.tables.event[0].event_detail = JSON.stringify(entry.detail);
        importBoard(target, initial);
        const before = exportBoard(target);
        assert.equal(isInitialBoard(target), entry.allowed, JSON.stringify(entry.detail));
        if (entry.allowed) {
          importBoard(target, incoming);
          assert.deepEqual(exportBoard(target), incoming);
        } else {
          assert.throws(() => importBoard(target, incoming), /IMPORT_NOT_EMPTY/u);
          assert.deepEqual(exportBoard(target), before, 'invalid setup remains untouched');
        }
      } finally { store.closeBoard(target); }
    }
  } finally {
    store.closeBoard(setup);
    store.closeBoard(source);
    rmSync(directory, { recursive: true, force: true });
  }
});
