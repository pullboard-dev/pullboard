/** Measure commands honestly and reduce avoidable claim/submit friction [R1,R2,C7,V4]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import * as store from '../src/board.js';
import { openBoard } from '../src/native-board.js';
import { exportBoard, importBoard } from '../src/exchange.js';
import { main } from '../src/cli.js';
import { movesStats, movesLines, moveTranscripts } from '../src/stats-moves.js';
import { importOnlyChange } from '../src/import-only-change.js';
import { infraNote } from '../packages/commits/src/core/infra-note.js';
import { runFixtureGit } from './fixture-child.js';
import { commandOutput } from '../src/json-output.js';
import { createE2eHelpers } from './e2e-helpers.js';

/** A private real Git/SQLite board with recorded event identities and no provider files. */
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-moves-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => runFixtureGit(args, { cwd: root, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ lanes: { core: { owns: ['src/', 'test/'] } } }));
  writeFileSync(join(root, 'PRACTICE.md'), '');
  const seed = openBoard(':memory:');
  store.register(seed, { lane: 'coordinator', path: root });
  for (let id = 1; id <= 3; id += 1) store.addItem(seed, { by: 'coordinator', lane: 'core', title: `Moves ${id}` });
  const document = exportBoard(seed); store.closeBoard(seed);
  const entries = [[1, 'claim'], [1, 'renew'], [1, 'submit'], [1, 'reopen'], [1, 'claim'], [1, 'submit'], [1, 'merged'],
    [2, 'claim'], [2, 'submit'], [2, 'merged'], [1, 'claim'], [3, 'claim']];
  document.tables.event = entries.map(([id, kind], index) => ({ event_id: index + 1, event_at: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
    event_by: 'coordinator', event_kind: kind, item_id: id, event_detail: '{}' }));
  document.tables.sqlite_sequence.find(row => row.name === 'event').seq = entries.length;
  // @pullboard-board-file persistence: the real CLI reopens this exact fixture database.
  const board = openBoard(join(root, '.git', 'pullboard', 'board.sqlite'));
  importBoard(board, document); t.after(() => store.closeBoard(board));
  return { root, git, board, history: store.events(board) };
}

/** Capture one actual CLI invocation without a subprocess or provider discovery. */
async function command(root, args) {
  let stdout = '', stderr = '';
  const code = await main(args, { cwd: root, stdout: { isTTY: false, write(value) { stdout += value; } }, stderr: { write(value) { stderr += value; } } });
  return { code, stdout, stderr };
}

test('moves exact native counts keep unrecorded commands and numeric targets unknown [R1,R2,C7]', t => {
  const { history } = fixture(t), before = JSON.stringify(history);
  const report = movesStats(history);
  assert.deepEqual(report.landedItems, [2, 1]);
  assert.equal(report.eventMoves.count, 10);
  assert.equal(report.eventMoves.perLandedItem, 5);
  assert.equal(report.eventMoves.byCommand.find(row => row.command === 'claim').count, 3);
  assert.equal(report.polling.status, null); assert.equal(report.polling.show, null);
  assert.deepEqual(report.suppliedCommands.unmeasuredItems, [2, 1]);
  assert.equal(report.numericTarget, null);
  assert.match(movesLines(report).join('\n'), /not CLI invocation counts/u);
  assert.equal(JSON.stringify(history), before);
  assert.equal(movesStats(history, { limit: 1 }).eventMoves.count, 3);
});

test('supplied transcripts measure exact commands and sequences without joining seats or inventing coverage [R1,R2,C7]', t => {
  const { history } = fixture(t);
  const transcripts = { version: 1, sessions: [
    { id: 'a', item: 1, seat: 'core-a', commands: ['claim', 'status', 'show', 'status', 'show', 'submit'] },
    { id: 'b', item: 1, seat: 'core-b', commands: ['status', 'show'] },
    { id: 'unfinished', item: 3, seat: 'core-a', commands: ['status'] },
  ] };
  const report = movesStats(history, { transcripts });
  assert.equal(report.suppliedCommands.count, 8); assert.equal(report.suppliedCommands.perLandedItem, 8);
  assert.deepEqual(report.suppliedCommands.coveredItems, [1]); assert.deepEqual(report.suppliedCommands.unmeasuredItems, [2]);
  assert.equal(report.suppliedCommands.ignoredSessions, 1);
  assert.equal(report.polling.status, 3); assert.equal(report.polling.show, 3);
  assert.deepEqual(report.polling.repeated.find(row => row.commands.join(',') === 'status,show'), { commands: ['status', 'show'], count: 3 });
  assert.ok(!report.suppliedCommands.repeatedSequences.some(row => row.commands.join(',') === 'submit,status'));
  assert.throws(() => moveTranscripts({ version: 1, sessions: [transcripts.sessions[0], transcripts.sessions[0]] }), { code: 'USAGE' });
  assert.throws(() => moveTranscripts({ version: 1, sessions: [{ id: 'private', item: 1, seat: 'a', commands: ['status --token secret'] }] }), { code: 'USAGE' });
});

test('moves real CLI reads explicit transcript file and leaves native history untouched [R1,R2,A1,A2]', async t => {
  const { root, board, history } = fixture(t);
  const transcripts = { version: 1, sessions: [{ id: 'a', item: 1, seat: 'core-a', commands: ['show', 'show', 'show', 'submit'] }] };
  writeFileSync(join(root, 'commands.json'), JSON.stringify(transcripts));
  const result = await command(root, ['stats', 'moves', '--transcripts', 'commands.json', '--json']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).moves, movesStats(history, { transcripts }));
  assert.deepEqual(store.events(board), history);
  const missing = await command(root, ['stats', 'moves', '--transcripts', 'absent.json', '--json']);
  assert.equal(missing.code, 1); assert.equal(JSON.parse(missing.stdout).error.code, 'USAGE');
});

test('automatic infra proof permits only import-path contents, preserving bindings and assertion bytes [C7,V4]', t => {
  const { root, git } = fixture(t);
  const path = 'test/example.test.js';
  mkdirSync(dirname(join(root, path)), { recursive: true });
  const before = "import { value } from '../src/a.js';\nassert.equal(value, 1);\n";
  writeFileSync(join(root, path), before); git('add', '.'); git('commit', '-qm', 'chore: fixture');
  const claimHead = git('rev-parse', 'HEAD').trim();
  const options = { root, claimHead, files: [path], gates: [], requireInfraNote: true };
  const changed = before.replace('../src/a.js', '../src/b.js');
  writeFileSync(join(root, path), changed); git('add', path); git('commit', '-qm', 'chore: relocate import');
  const commit = git('rev-parse', 'HEAD').trim();
  assert.deepEqual(infraNote({ ...options, commit }), { note: 'Updated static test import paths; test bindings, assertions and other source bytes are unchanged.', files: [path] });
  // A mutable checkout cannot override the immutable candidate blobs.
  writeFileSync(join(root, path), changed.replace('value, 1', 'value, 0'));
  assert.ok(infraNote({ ...options, commit }));
  git('add', path); git('commit', '-qm', 'chore: alter assertion');
  assert.throws(() => infraNote({ ...options, commit: git('rev-parse', 'HEAD').trim() }), { code: 'INFRA_NOTE_REQUIRED' });
  assert.equal(importOnlyChange(before, before.replace('{ value }', '{ other }'), { specifiersOnly: true }), false);
  assert.equal(importOnlyChange(before, before.replace('1);\n', '1);'), { specifiersOnly: true }), false);
  assert.equal(importOnlyChange("import('../a.js');", "import('../b.js');", { specifiersOnly: true }), false);
  assert.equal(importOnlyChange(before, changed + '// explanation\n', { specifiersOnly: true }), false);
  assert.throws(() => infraNote({ ...options }), { code: 'INFRA_NOTE_REQUIRED' }, 'an absent candidate identity cannot authorize a draft');
});

test('claim states header and infra rules once in real text and JSON [C7,V4]', t => {
  const helpers = createE2eHelpers(); t.after(helpers.cleanup);
  const box = helpers.project('true');
  const added = box.run(box.repo, 'add', 'web', 'Measure claim guidance', '--specs', 'G1', '--check', 'true');
  assert.equal(added.code, 0, added.err);
  const claimed = box.run(box.web, 'claim', '1', '--json');
  assert.equal(claimed.code, 0, claimed.err);
  const document = JSON.parse(claimed.out);
  assert.match(document.commitRules, /at most 72 characters/u);
  assert.match(document.commitRules, /import-path-only/u);
  assert.match(document.commitRules, /assertion.*--infra/u);
  assert.equal(document.next, 'git status');
  const renewed = box.run(box.web, 'claim', '1');
  assert.equal(renewed.code, 0, renewed.err);
  assert.equal(renewed.out.match(/Commit headers must/gu)?.length, 1);
  assert.equal(renewed.out.match(/Submit drafts --infra/gu)?.length, 1);
  assert.match(renewed.out, /\nnext: git status\n$/u);
});

test('finite output ends with one next move while raw export and refusal wire retain their contracts [A1,A2,C7]', () => {
  /** Exercise the actual collector with a deterministic refusal renderer. */
  const output = (args, work, code = 0) => {
    let text = '', errors = '';
    const io = commandOutput(args, { stdout: { write(value) { text += value; } }, stderr: { write(value) { errors += value; } } },
      { refusalDocument: error => ({ version: 1, error }) });
    work(io); io.flush(code); io.flush(code);
    return { text, errors };
  };
  for (const name of ['stats', 'status', 'show', 'inbox', 'claim', 'help', 'version']) {
    const human = output([name], io => { io.say('result'); io.say('next: an older action'); io.say('next: the chosen action'); });
    assert.equal(human.text.match(/^next:/gmu)?.length, 1, name);
    assert.match(human.text, /next: the chosen action\n$/u);
    const json = JSON.parse(output([name, '--json', '--fields', 'value'], io => io.result({ value: 1, hidden: true })).text);
    assert.equal(Object.keys(json).at(-1), 'next');
    assert.equal(typeof json.next, 'string'); assert.equal(json.hidden, undefined);
  }
  const held = JSON.parse(output(['submit', '--json'], io => io.result({ id: 1, next: { item: { item_id: 2 }, held: true } })).text);
  assert.equal(held.next.action, 'pullboard show 2'); assert.equal(held.next.held, true);
  const raw = '{"version":1,"tables":{}}';
  assert.equal(output(['export'], io => io.say(raw)).text, raw + '\n');
  assert.deepEqual(JSON.parse(output(['export', '--json'], io => io.say(raw)).text), JSON.parse(raw));
  assert.equal(output(['--version'], io => io.say('0.9.3')).text, '0.9.3\n', 'installed hook version handshake stays byte-compatible');
  const refused = JSON.parse(output(['show', '--json'], io => io.refusal({ code: 'NO_ITEM', message: 'missing', next: 'pullboard list' }), 1).text);
  assert.deepEqual(refused, { version: 1, error: { code: 'NO_ITEM', message: 'missing', next: 'pullboard list' } });
});
