/** Keep the format guide aligned with parser behavior and the live SQLite schema [A5]. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { COORDINATOR } from '../src/config.js';
import { JSON_SHAPES } from '../src/json.js';
import {
  ACCEPT_REASON,
  answerDecision,
  addItem,
  claim,
  closeBoard,
  editItem,
  EVENT_LOG_VERSION,
  ensureCoordinator,
  escalate,
  events,
  holdLane,
  merged,
  openBoard,
  passDecision,
  PERSON,
  recordAttempt,
  refreeze,
  register,
  release,
  releaseLane,
  reserveReview,
  SCHEMA_VERSION,
  submit,
  shout,
  verify,
  withdraw,
} from '../src/board.js';
import { ID_RE, SPEC_GRAMMAR_VERSION, STATUSES, TIERS, lintSpec, parseSpec } from '../src/spec.js';

const guide = readFileSync(new URL('./formats.md', import.meta.url), 'utf8');

/** Return the text inside a named marked documentation block. */
function block(start, end) {
  const begin = guide.indexOf(start);
  const finish = guide.indexOf(end, begin + start.length);
  assert.notEqual(begin, -1, `guide has block start ${start}`);
  assert.notEqual(finish, -1, `guide has block end ${end}`);
  return guide.slice(begin + start.length, finish);
}

/** Read names from the first code-formatted cell of each row in a marked table. */
function listedValues(start, end) {
  return block(start, end).split(/\r?\n/).flatMap((line) => {
    const match = /^\| `([^`]+)` \|/.exec(line);
    return match ? [match[1]] : [];
  });
}

/** Parse table, column, type and rules from the documented live schema. */
function documentedColumns(start, end) {
  const result = {};
  for (const line of block(start, end).split(/\r?\n/)) {
    const row = /^\| `([^`]+)` \| `([^`]+)` \| `([^`]+)` \| (.+) \|$/.exec(line);
    if (!row) continue;
    const [, table, column, type, cell] = row;
    const fields = result[table] ?? [];
    fields.push({ column, type, rules: [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]) });
    result[table] = fields;
  }
  return result;
}

/** Describe live columns from SQLite's null, default, key and reference metadata. */
function liveColumns(db, schema) {
  const tables = db.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all();
  return Object.fromEntries(tables.map(({ name }) => {
    const columns = db.prepare(`PRAGMA ${schema}.table_info(${name})`).all();
    const foreignKeys = db.prepare(`PRAGMA ${schema}.foreign_key_list(${name})`).all();
    const indexes = db.prepare(`PRAGMA ${schema}.index_list(${name})`).all();
    const uniqueColumns = indexes.filter((index) => index.unique && index.origin !== 'pk')
      .flatMap((index) => db.prepare(`PRAGMA ${schema}.index_info(${index.name})`).all())
      .map((column) => column.name);
    return [name, columns.map((column) => {
      const rules = [];
      if (column.pk) rules.push('PRIMARY KEY');
      else rules.push(column.notnull ? 'NOT NULL' : 'nullable');
      if (column.dflt_value !== null) rules.push(`DEFAULT ${column.dflt_value}`);
      if (uniqueColumns.includes(column.name)) rules.push('UNIQUE');
      for (const foreignKey of foreignKeys.filter((key) => key.from === column.name)) {
        rules.push(`REFERENCES ${foreignKey.table}(${foreignKey.to})`);
      }
      return { column: column.name, type: column.type, rules };
    })];
  }));
}

/** Read persistent and connection-local trigger declarations from SQLite. */
function liveTriggers(db, schema) {
  return db.prepare(`SELECT name, tbl_name FROM ${schema}.sqlite_master WHERE type = 'trigger' ORDER BY name`)
    .all().map(({ name, tbl_name }) => [name, tbl_name]);
}

/** Parse documented persistent or temporary trigger names and target tables. */
function documentedTriggers(start, end) {
  return block(start, end).split(/\r?\n/).flatMap((line) => {
    const row = /^\| `([^`]+)` \| `([^`]+)` \|$/.exec(line);
    return row ? [[row[1], row[2]]] : [];
  });
}

/** Read named indexes and their fields from the live database. */
function liveIndexes(db) {
  const indexes = db.prepare("SELECT name, tbl_name FROM main.sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return indexes.map(({ name, tbl_name }) => ({
    name,
    table: tbl_name,
    columns: db.prepare(`PRAGMA main.index_info(${name})`).all().map((column) => column.name),
    unique: db.prepare(`PRAGMA main.index_list(${tbl_name})`).all().find((index) => index.name === name).unique ? 'yes' : 'no',
  }));
}

/** Parse documented columns for an index. */
function documentedIndexes() {
  return block('<!-- board-indexes:start -->', '<!-- board-indexes:end -->').split(/\r?\n/).flatMap((line) => {
    const row = /^\| `([^`]+)` \| `([^`]+)` \| (.+) \| (yes|no) \|$/.exec(line);
    return row ? [{ name: row[1], table: row[2], columns: [...row[3].matchAll(/`([^`]+)`/g)].map((match) => match[1]), unique: row[4] }] : [];
  });
}

/** Exercise each board event through the public API and return the rows it actually records. */
function recordEventContract() {
  const board = openBoard(':memory:');
  const coordinator = ensureCoordinator(board, '/coordinator');
  const builder = register(board, { lane: 'docs', path: '/builder' });
  register(board, { lane: 'docs', path: '/builder', family: 'codex' });
  const reviewer = register(board, { lane: 'tests', path: '/reviewer' });
  register(board, { lane: 'small', path: '/small', route: 'light' });
  ensureCoordinator(board, '/coordinator-moved');
  shout(board, { from: builder, to: 'all', text: 'sample announcement', lanes: ['docs', 'tests'] });
  const passed = shout(board, { from: builder, to: coordinator, text: 'sample decision', lanes: ['docs', 'tests'], decision: true });
  passDecision(board, passed, { agentId: coordinator, note: 'ask the person', lanes: ['docs', 'tests'] });
  const personQuestion = shout(board, { from: coordinator, to: PERSON, text: 'sample person decision', lanes: ['docs', 'tests'], decision: true });
  answerDecision(board, personQuestion, { agentId: coordinator, text: 'approved', lanes: ['docs', 'tests'], asPerson: true });
  const request = shout(board, { from: PERSON, to: coordinator, text: 'sample request', lanes: ['docs', 'tests'], request: true });
  answerDecision(board, request, { agentId: coordinator, text: 'done', lanes: ['docs', 'tests'] });
  const freeze = (digest) => () => ({ text: `criterion-${digest}`, digest });
  const first = addItem(board, { by: coordinator, lane: 'docs', title: 'Accepted example', criterion: 'Initial', specIds: ['A1'], route: 'strong' });
  editItem(board, first, { agentId: coordinator, brief: 'Files: docs/formats.md\nTest: docs/formats.test.js', route: 'mid', criterion: 'Changed', check: 'node test' });
  recordAttempt(board, first, { agentId: builder, n: 1, seconds: 2, result: 'failed' });
  claim(board, first, { agentId: builder, lane: 'docs', leaseMs: 60_000, freeze: freeze('first') });
  claim(board, first, { agentId: builder, lane: 'docs', leaseMs: 60_000, freeze: freeze('unused') });
  escalate(board, first, { agentId: builder, note: 'attempted once', attempt: '1' });
  claim(board, first, { agentId: builder, lane: 'docs', leaseMs: 60_000, freeze: freeze('unused') });
  release(board, first, builder);
  editItem(board, first, { agentId: coordinator, criterion: 'Updated after claim' });
  refreeze(board, first, { agentId: coordinator, freeze: freeze('second') });
  claim(board, first, { agentId: builder, lane: 'docs', leaseMs: 60_000, freeze: freeze('unused') });
  const acceptedCommit = 'a'.repeat(40);
  submit(board, first, { agentId: builder, commit: acceptedCommit, tree: 'b'.repeat(40), files: ['docs/formats.md'] });
  reserveReview(board, first, { agentId: reviewer, leaseMs: 60_000, policy: 'agents' });
  verify(board, first, { agentId: reviewer, decision: 'ACCEPT', reason: ACCEPT_REASON, note: 'checked the example', head: acceptedCommit, digest: 'second', policy: 'agents' });
  merged(board, first, { agentId: coordinator, commit: 'c'.repeat(40) });

  const rejected = addItem(board, { by: coordinator, lane: 'docs', title: 'Rejected example' });
  claim(board, rejected, { agentId: builder, lane: 'docs', leaseMs: 60_000, freeze: freeze('rejected') });
  const rejectedCommit = 'd'.repeat(40);
  submit(board, rejected, { agentId: builder, commit: rejectedCommit, tree: 'e'.repeat(40) });
  verify(board, rejected, { agentId: reviewer, decision: 'REJECT', reason: 'TEST_FAILURE', note: 'the fixture failed', head: rejectedCommit, digest: 'rejected', policy: 'agents' });

  const withdrawn = addItem(board, { by: coordinator, lane: 'docs', title: 'Withdrawn example' });
  withdraw(board, withdrawn, { agentId: coordinator, reason: 'duplicate fixture' });
  holdLane(board, 'view', { agentId: coordinator, reason: 'fixture hold' });
  releaseLane(board, 'view', { agentId: coordinator });
  const rows = events(board).map((row) => ({ ...row, detail: JSON.parse(row.event_detail) }));
  closeBoard(board);
  return { rows, actors: { [coordinator]: 'coordinator', [builder]: 'builder', [reviewer]: 'reviewer', board: 'board' } };
}

/** Reopen a file after removing old-format objects and report the repaired guard event. */
function exerciseUpgrade() {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-formats-'));
  const file = join(directory, 'board.sqlite');
  let board;
  try {
    board = openBoard(file);
    assert.equal(board.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION,
      'opening an older board advances its schema version in place');
    ensureCoordinator(board, join(directory, 'coordinator'));
    addItem(board, { by: COORDINATOR, lane: 'docs', title: 'Preserved row' });
    assert.equal(board.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    const originalEvents = events(board).length;
    closeBoard(board);
    board = null;

    const old = new DatabaseSync(file);
    old.exec('ALTER TABLE shout DROP COLUMN shout_evidence_kind; DROP TABLE hold; DROP INDEX item_lane_status; DROP TRIGGER machine_event_update; CREATE TRIGGER machine_old_extra AFTER INSERT ON item BEGIN SELECT 1; END; PRAGMA user_version = 1;');
    old.close();

    board = openBoard(file);
    assert.equal(board.db.prepare("SELECT item_title FROM item").get().item_title, 'Preserved row');
    assert.ok(board.db.prepare('PRAGMA table_info(shout)').all().some((column) => column.name === 'shout_evidence_kind'));
    assert.ok(board.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'hold'").get());
    assert.ok(board.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'item_lane_status'").get());
    assert.equal(board.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'machine_old_extra'").get(), undefined);
    const repair = events(board).find((row) => row.event_kind === 'guards');
    assert.ok(repair, 'reopening reports repaired/missing/stale guards in the event log');
    assert.equal(events(board).length, originalEvents + 1, 'reopening preserves old events and appends one guard-repair event');
    assert.deepEqual(JSON.parse(repair.event_detail), {
      missing: ['machine_event_update'], changed: [], stale: ['machine_old_extra'],
    });
    return events(board).map((row) => ({ ...row, detail: JSON.parse(row.event_detail) }));
  } finally {
    if (board) closeBoard(board);
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Parse the event manifest and compare it with event rows produced by real board operations. */
function documentedEvents() {
  const lines = block('<!-- events:start -->', '<!-- events:end -->').split(/\r?\n/);
  const result = {};
  for (const line of lines) {
    const row = /^\| `([^`]+)` \| ([^|]+) \| (.+) \|$/.exec(line);
    if (!row) continue;
    const [, kind, actor, fields] = row;
    result[kind] = { actor: actor.trim(), fields: [...fields.matchAll(/`([^`]+)`/g)].map((match) => match[1]).sort() };
  }
  return result;
}

test('[A5] the grammar table describes values the parser actually reads', () => {
  assert.equal(ID_RE.source, '^[A-Za-z]+\\d+(?:\\.\\d+)*$');
  assert.deepEqual(listedValues('<!-- statuses:start -->', '<!-- statuses:end -->'), STATUSES);
  assert.deepEqual(listedValues('<!-- tiers:start -->', '<!-- tiers:end -->'), TIERS);

  const source = [
    '# Example',
    'intro before a section',
    '## Sample section',
    '- A1 [approved, must] Requirement text. | gate: node test | serves: B2, C3 | signers: co@example.invalid, AB | custom: preserved',
  ].join('\n');
  const parsed = parseSpec(source);
  assert.equal(parsed.sections[0].name, 'Sample section');
  assert.deepEqual(parsed.rows[0], {
    id: 'A1', status: 'approved', tier: 'must', text: 'Requirement text.', gate: 'node test',
    serves: ['B2', 'C3'], signers: ['co@example.invalid', 'AB'], unknown: ['custom: preserved'], section: 'Sample section', line: 4,
  });
  assert.deepEqual(listedValues('<!-- parser-fields:start -->', '<!-- parser-fields:end -->'), Object.keys(parsed.rows[0]));
  assert.match(guide, /\| gate: <command> \| serves: <ID, ID> \| signers: <principal, principal>/);

  const noTier = parseSpec('## Plain\n- A1 [draft] Row without a tier.\n');
  assert.equal(noTier.rows[0].tier, '');
  assert.deepEqual(lintSpec(parseSpec('## Must\n- A1 [approved, must] Must names a gate.\n')).filter((finding) => finding.level === 'error').map((finding) => finding.message), [
    'an approved must-row names its gate: | gate: <the test or check that proves it>',
  ]);
});

test('[A5] SPEC.md and PRACTICE.md use the exported grammar version', () => {
  assert.equal(SPEC_GRAMMAR_VERSION, 1);
  const versions = block('<!-- format-versions:start -->', '<!-- format-versions:end -->');
  const versionOf = (name) => {
    const match = new RegExp('^\\| `' + name + '` \\| `(\\d+)` \\|', 'm').exec(versions);
    assert.ok(match, `guide declares ${name} version`);
    return Number(match[1]);
  };
  assert.equal(versionOf('CLI JSON envelope'), JSON_SHAPES.version);
  assert.equal(versionOf('row grammar'), SPEC_GRAMMAR_VERSION);
  assert.equal(versionOf('board schema'), SCHEMA_VERSION);
  assert.equal(versionOf('event log'), EVENT_LOG_VERSION);
  assert.match(versions, /`SPEC_GRAMMAR_VERSION`/);
  assert.match(versions, /`JSON_SHAPES\.version`/);
  assert.match(versions, /`SCHEMA_VERSION`/);
  assert.match(versions, /`EVENT_LOG_VERSION`/);

  for (const file of ['SPEC.md', 'PRACTICE.md']) {
    const body = `## Sample\n- A1 [draft] Row text.\n`;
    assert.equal(parseSpec(body).grammarVersion, SPEC_GRAMMAR_VERSION, `${file} without a marker defaults to the current grammar`);
    assert.equal(parseSpec(`<!-- pullboard-grammar ${SPEC_GRAMMAR_VERSION} -->\n${body}`).grammarVersion, SPEC_GRAMMAR_VERSION, `${file} accepts the current marker`);
    assert.throws(
      () => parseSpec(`<!-- pullboard-grammar ${SPEC_GRAMMAR_VERSION + 1} -->\n${body}`),
      (error) => error?.code === 'A5_GRAMMAR_VERSION'
        && error.message.includes(`grammar ${SPEC_GRAMMAR_VERSION + 1}`)
        && error.message.includes(`reads grammar ${SPEC_GRAMMAR_VERSION}`)
        && error.message.includes('upgrade Pullboard'),
      `${file} refuses a different declared grammar with a usable next step`,
    );
    assert.throws(() => parseSpec(`<!-- pullboard-grammar invalid -->\n${body}`), (error) => error?.code === 'A5_GRAMMAR_VERSION', `${file} refuses an invalid marker`);
    assert.equal(parseSpec(`\`\`\`text\n<!-- pullboard-grammar ${SPEC_GRAMMAR_VERSION + 1} -->\n\`\`\`\n${body}`).grammarVersion, SPEC_GRAMMAR_VERSION, `${file} ignores a marker in a fenced example`);
  }
});

test('[A5] schema, versions, event kinds and event detail fields match live behavior', () => {
  const board = openBoard(':memory:');
  try {
    const version = board.db.prepare('PRAGMA user_version').get().user_version;
    assert.equal(version, SCHEMA_VERSION);
    assert.deepEqual(documentedColumns('<!-- board-columns:start -->', '<!-- board-columns:end -->'), liveColumns(board.db, 'main'));
    assert.deepEqual(documentedColumns('<!-- temp-columns:start -->', '<!-- temp-columns:end -->'), liveColumns(board.db, 'temp'));
    assert.deepEqual(documentedTriggers('<!-- board-triggers:start -->', '<!-- board-triggers:end -->'), liveTriggers(board.db, 'main'));
    assert.deepEqual(documentedTriggers('<!-- temp-triggers:start -->', '<!-- temp-triggers:end -->'), liveTriggers(board.db, 'temp'));
    assert.deepEqual(documentedIndexes(), liveIndexes(board.db));
    const versions = block('<!-- format-versions:start -->', '<!-- format-versions:end -->');
    const versionOf = (name) => {
      const match = new RegExp('^\\| `' + name + '` \\| `(\\d+)` \\|', 'm').exec(versions);
      assert.ok(match, `guide declares ${name} version`);
      return Number(match[1]);
    };
    assert.equal(versionOf('CLI JSON envelope'), JSON_SHAPES.version);
    assert.equal(versionOf('row grammar'), SPEC_GRAMMAR_VERSION);
    assert.equal(versionOf('board schema'), SCHEMA_VERSION);
    assert.equal(versionOf('event log'), EVENT_LOG_VERSION);
  } finally {
    closeBoard(board);
  }

  const { rows, actors } = recordEventContract();
  const repairedRows = exerciseUpgrade();
  const actualRows = [...rows, ...repairedRows];
  const actual = {};
  const actorByKind = {
    join: 'joining agent',
    family: 'agent',
    moved: 'coordinator',
    add: 'item creator',
    edit: 'editor',
    attempt: 'reporting agent',
    guards: 'board',
    shout: 'sender',
    pass: 'coordinator',
    answer: 'answerer',
  };
  for (const row of actualRows) {
    const kind = row.event_kind;
    const entry = actual[kind] ?? { actors: new Set(), fields: new Set() };
    const actor = actorByKind[kind] ?? actors[row.event_by] ?? 'unknown';
    entry.actors.add(actor);
    for (const field of Object.keys(row.detail)) entry.fields.add(field);
    actual[kind] = entry;
  }
  const documented = documentedEvents();
  assert.deepEqual(Object.keys(documented).sort(), Object.keys(actual).sort());
  for (const [kind, expected] of Object.entries(documented)) {
    assert.deepEqual([...actual[kind].actors].sort(), [expected.actor]);
    assert.deepEqual([...actual[kind].fields].sort(), expected.fields);
  }
});
