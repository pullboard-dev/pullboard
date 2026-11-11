/** @pullboard-test-input source-tree */
/**
 * Pullboard's first Rigor checks (D1, C7): packages/gate holds four scripts a doctrine row's
 * `gate: check` can count. Each prints one `path:line: text` line per problem, sorted, and exits 0
 * with none or 1 with some. The census is pinned to the main commit this item merged, so it never
 * goes stale as main moves; the live checkout is held to the format, the timing and, for file size,
 * an independent recount. Fixtures prove each check adds exactly one line for one new problem.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dirname,
  join,
  resolve,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
// Imported so the affected-test selection sees an edge to every check; importing runs nothing.
import { fileSizeProblems } from '../../../../packages/gate/src/io/file/size.js';
import { testNameProblems } from '../../../../packages/gate/src/io/test/names.js';
import { emptyCatchProblems } from '../../../../packages/gate/src/io/catch.js';
import { testInputProblems } from '../../../../packages/gate/src/io/test/inputs.js';
import * as store from '../../../../packages/store/index.js';
import {
  openBoard,
  draftSpecRow,
} from '../../../lib/index.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { loadDoctrine } from '../../../../packages/doctrine/index.js';
import { loadConfig } from '../../../../packages/config/index.js';
import { draftConflictSplits } from '../../../../packages/rigor/index.js';
import { proposeDoctrine } from '../../../../packages/doctrine/index.js';
import { conflictNote } from '../../../../packages/kernel/index.js';
import {
  conflictNoteFiles,
  conflictReport,
} from '../../../../packages/rigor/index.js';
import { RIGOR_AUTO_ENGINE } from '../../../../packages/state/light.js';
import {
  breachLine,
  changeRange,
  qualityBreaches,
} from '../../../../packages/rigor/index.js';

const conflictE2e = createE2eHelpers();
after(conflictE2e.cleanup);

const ROOT = resolve(import.meta.dirname, '../../../..');
const CHECK_PATHS = { 'file-size': 'file/size.js', 'test-names': 'test/names.js', 'empty-catch': 'catch.js', 'test-inputs': 'test/inputs.js' };
const CHECKS = Object.keys(CHECK_PATHS);
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-rigor-')));
after(() => rmSync(dir, { recursive: true, force: true }));

/** The main commit whose census this item counted; moved forward when the item merges main. */
const PINNED = '59a6e2b286ee852add0d68a659f1a1e6b3257c44';

/** Today's over-cap files on the pinned main, with their line counts. */
const PINNED_SIZES = { 'src/board.js': 2796, 'src/cli.js': 3794, 'src/cockpit.js': 3332, 'test/api-http.test.js': 1991,
  'test/api.test.js': 1958, 'test/cockpit/demo.test.js': 1719, 'test/run-tests.test.js': 1672 };

const NO_ID = 'test name has no spec row id: ';
const BARE = 'empty catch names no reason: handle the error or say in a comment why it is ignored';
const UNDECLARED = 'reads source files without /** @pullboard-test-input source-tree */ at the top';

/** Today's problems on the pinned main for the three checks that are not about size. */
const PINNED_PROBLEMS = {
  'test-names': [
    ['test/board.test.js', 139, 'agents are numbered per lane; one coordinator; a worktree joins once'],
    ['test/board.test.js', 168, 'the coordinator follows the main checkout when the repo moves'],
    ['test/board.test.js', 286, 'submit needs your claim and finished children'],
    ['test/board.test.js', 353, 'under verify: coordinator, lane work is the coordinator\'s to verify'],
    ['test/board.test.js', 535, 'merged and withdraw are the coordinator\'s, and only for the right states'],
    ['test/hooks.test.js', 116, 'comments are dropped; merges, reverts and fixups are exempt'],
    ['test/hooks.test.js', 122, 'opt-in rules: filler words, emoji, co-author trailers'],
    ['test/hooks.test.js', 129, 'blocked paths: env files by name, examples allowed, patterns with a slash mat...'],
    ['test/hooks.test.js', 139, 'secrets are named by kind and place, never echoed'],
    ['test/lanes.test.js', 29, 'a lane may change its own paths and shared ones; the coordinator may change a...'],
    ['test/lanes.test.js', 55, 'config merges nested groups over the defaults, and leases read as durations'],
    ['test/spec.test.js', 226, 'rows inside code fences are examples, not rows'],
    ['test/spec.test.js', 251, 'bad status, bad tier and unknown fields are errors; long rows warn'],
    ['test/spec.test.js', 262, 'cited ids must exist and must not be retired'],
    ['test/view.test.js', 200, 'row text is escaped, so a row cannot inject markup'],
  ].map(([path, line, name]) => `${path}:${line}: ${NO_ID}${name}`),
  'empty-catch': [
    ['src/api.js', 214], ['src/api.js', 222], ['src/board.js', 166], ['src/board.js', 224], ['src/runner-worker.js', 1190],
    ['test/cockpit/items.test.js', 1159], ['test/land.test.js', 170], ['test/land.test.js', 172], ['test/land.test.js', 673],
    ['test/land.test.js', 760], ['test/land.test.js', 762], ['test/land.test.js', 906], ['test/runners.test.js', 1250],
  ].map(([path, line]) => `${path}:${line}: ${BARE}`),
  'test-inputs': [
    ['test/api-http.test.js', 428], ['test/blueprint.test.js', 13], ['test/cockpit/layout.test.js', 146],
    ['test/cockpit/relay.test.js', 131], ['test/doctrine.test.js', 28], ['test/e2e-private-checks.test.js', 113],
    ['test/gate-profile.test.js', 16], ['test/gate.test.js', 13], ['test/help.test.js', 33], ['test/resources.test.js', 131],
    ['test/resume-flow.test.js', 27], ['test/run-tests.test.js', 119], ['test/seal.test.js', 90], ['test/settings.test.js', 11],
    ['test/test-resources.test.js', 86], ['test/test-runner.test.js', 108],
  ].map(([path, line]) => `${path}:${line}: ${UNDECLARED}`),
};

/** Git for the test, without any GIT_* the suite inherited. */
function git(args, options = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  const result = spawnSync('git', ['-C', ROOT, ...args], { env, maxBuffer: 512 * 1024 * 1024, ...options });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

/**
 * Run one check as a doctrine row runs it, from `cwd` (or on `root` when given), timed.
 *
 * @returns {{ status: number|null, lines: string[], stderr: string, ms: number }}
 */
function runCheck(name, { cwd = ROOT, root } = {}) {
  const started = performance.now();
  const result = spawnSync(process.execPath, [join(ROOT, 'packages/gate/src/io', CHECK_PATHS[name]), ...(root ? [root] : [])], { cwd, encoding: 'utf8' });
  const ms = performance.now() - started;
  return { status: result.status, lines: result.stdout.split('\n').filter(Boolean), stderr: result.stderr, ms };
}

/** The problem lines the size rule expects for files of these lengths. */
function sizeLines(sizes) {
  const lines = [];
  for (const [path, count] of Object.entries(sizes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    for (let first = 1501; first <= count; first += 100) lines.push(`${path}:${first}: lines ${first}-${first + 99} are over the 1500-line cap`);
  }
  return lines;
}

/** Sort problem lines as the checks promise: path, then line number, then text. */
function sortedProblems(lines) {
  const parts = (line) => /^(.*?):(\d+): (.*)$/su.exec(line);
  return [...lines].sort((a, b) => {
    const [, pathA, lineA, textA] = parts(a);
    const [, pathB, lineB, textB] = parts(b);
    return (pathA < pathB ? -1 : pathA > pathB ? 1 : 0) || Number(lineA) - Number(lineB) || (textA < textB ? -1 : textA > textB ? 1 : 0);
  });
}

/** Write a fixture file under a fixture root, making its folders. */
function put(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** A fixture tree with no problems for any check yet. */
function fixture(name) {
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  return root;
}

/** Record synthetic conflict history through public board moves, without claiming gates ran. */
function conflictHistory({ automatic = true } = {}) {
  const box = conflictE2e.project('true');
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  if (!automatic) board.executionEngineVersion = RIGOR_AUTO_ENGINE - 1;
  try {
    const builder = store.register(board, { lane: 'web', path: join(box.dir, 'history-builder'), model: 'Fixture builder' });
    const reviewer = store.register(board, { lane: 'web', path: join(box.dir, 'history-reviewer'), model: 'Fixture reviewer' });
    /** Accept a synthetic submission, then record its typed conflict reopen. */
    const collision = (title, files) => {
      const id = store.addItem(board, { by: 'coordinator', lane: 'web', title });
      store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: 7_200_000,
        freeze: item => ({ text: item.item_title, digest: `fixture:${item.item_id}` }) });
      const commit = id.toString(16).padStart(40, '0');
      submitFixture(board, id, { agentId: builder, commit, tree: 'a'.repeat(40) });
      store.verify(board, id, { agentId: reviewer, decision: 'ACCEPT', note: 'synthetic accepted-history fixture; no gate claim',
        head: commit, digest: store.getItem(board, id).item_frozen_digest, policy: 'any' });
      store.reopen(board, id, { agentId: 'coordinator', conflict: { files, trunk: 'b'.repeat(40) } });
      return id;
    };
    const first = collision('First collision', ['src/cli.js', 'src/rare.js']);
    const second = collision('Second collision', ['src/cli.js']);
    const held = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'An unrelated hold' });
    store.holdItem(board, held, { agentId: 'coordinator', reason: 'a discussion mentions a conflict in src/unrelated.js' });
    return { ...box, ids: [first, second] };
  } finally { store.closeBoard(board); }
}

test('rigor reports a file that keeps causing merge conflicts [D1,C7]', () => {
  const box = conflictHistory();
  const before = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
  const run = box.run(box.repo, 'rigor', '--json');
  assert.equal(run.code, 0, run.out + run.err);
  const report = JSON.parse(run.out);
  assert.ok(Array.isArray(report.hotFiles), 'rigor exposes its per-file conflict history');
  assert.deepEqual(report.hotFiles.map(file => file.file), ['src/cli.js'], 'one-off and prose-only paths never become hot files');
  assert.deepEqual(report.hotFiles[0].items, box.ids, 'the report names the actual colliding items');
  assert.equal(report.hotFiles[0].reopens, 2, 'each typed reopen counts once for this file');
  assert.deepEqual(report.causes, [], 'architectural collisions do not pretend to be proved code-rule failures');
  assert.equal(readFileSync(join(box.repo, 'SPEC.md'), 'utf8'), before, 'reporting alone does not draft or approve a rule');
});


test('a hot file becomes a draft split proposal [D1,C7]', () => {
  const box = conflictHistory();
  const original = loadDoctrine(box.repo).repo.rows;
  const beforeSpec = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
  const run = box.run(box.repo, 'rigor', '--draft-splits', '--json');
  assert.equal(run.code, 0, run.out + run.err);
  const report = JSON.parse(run.out);
  assert.equal(report.splitDrafts.length, 1);
  const draft = report.splitDrafts[0];
  const doctrine = loadDoctrine(box.repo);
  const row = doctrine.repo.rows.find(row => row.id === draft.row.id);
  assert.equal(row.status, 'draft', 'the person has not approved this architectural advice');
  assert.equal(row.gate, 'review', 'a suggestion has no fabricated executable proof');
  assert.match(row.text, /splitting "src\/cli\.js"/u);
  assert.match(row.text, /one module per command/u);
  assert.match(row.text, /Source: rigor-auto:/u, 'the explicit command materializes the advice already created by the failure move');
  assert.doesNotMatch(row.text, /Source: rigor:/u);
  assert.deepEqual(doctrine.repo.rows.filter(row => row.id !== draft.row.id), original, 'existing judgments remain unchanged');
  assert.equal(readFileSync(join(box.repo, 'SPEC.md'), 'utf8'), beforeSpec);
  const written = readFileSync(doctrine.repo.file, 'utf8');
  const again = box.run(box.repo, 'rigor', '--draft-splits', '--json');
  assert.equal(again.code, 0, again.out + again.err);
  assert.deepEqual(JSON.parse(again.out).splitDrafts, [], 'restarts do not duplicate pending advice');
  assert.equal(readFileSync(doctrine.repo.file, 'utf8'), written);
  const lane = box.run(box.web, 'rigor', '--draft-splits', '--json');
  assert.equal(lane.code, 1, lane.out + lane.err);
  assert.match(lane.out + lane.err, /COORDINATOR_ONLY/u);
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  try {
    const reservation = store.rowDrafts(board).find(row => row.id === draft.row.id);
    assert.equal(reservation.target, 'doctrine', 'the ordinary draft is durably reserved on the project board');
    assert.equal(reservation.gate, 'review');
  } finally { store.closeBoard(board); }
});

test('conflict history counts exact notes and exposes unattributed holds [D1]', () => {
  const now = new Date('2026-10-20T12:00:00Z');
  /** An ordinary event-shaped fixture, with no synthetic database writes. */
  const event = (id, item, kind, detail, at = now.toISOString()) => ({ event_id: id, item_id: item, event_kind: kind, event_at: at, event_detail: JSON.stringify(detail) });
  const typed = event(1, 1, 'reopen', { conflict: { files: ['src/cli.js', 'src/one.js'], trunk: 'a'.repeat(40) } });
  const held = event(2, 2, 'hold_item', { reason: conflictNote({ files: ['src/cli.js'], trunk: 'b'.repeat(40) }) });
  const history = [typed, held, held, event(3, 2, 'unhold_item', {}),
    event(4, 3, 'hold_item', { reason: 'a merge conflict somewhere in src/guess.js' }),
    event(5, 4, 'hold_item', { reason: 'waiting for a person' }),
    event(6, 5, 'reopen', { conflict: { files: ['src/old.js'], trunk: 'a'.repeat(40) } }, '2026-10-06T11:59:59Z'),
    event(7, 6, 'hold_item', { reason: conflictNote({ files: ['src/future.js'], trunk: 'b'.repeat(40) }) }, '2026-10-20T12:00:01Z'),
    event(8, 7, 'hold_item', { reason: conflictNote({ files: ['src/boundary.js'], trunk: 'b'.repeat(40) }) }, '2026-10-06T12:00:00Z')];
  const report = conflictReport(history, { now });
  assert.deepEqual(report.hotFiles.map(file => [file.file, file.reopens, file.holds, file.items]), [['src/cli.js', 1, 1, [1, 2]]]);
  assert.deepEqual(report.hotFiles[0].events.map(event => event.source), ['typed-conflict', 'machine-note-syntax']);
  assert.deepEqual(report.unattributedHolds.map(entry => entry.item), [3]);
  assert.deepEqual(report.conflictFiles.map(file => file.file).sort(), ['src/boundary.js', 'src/cli.js', 'src/one.js']);
  assert.equal(conflictReport([typed, event(9, 1, 'hold_item', { reason: conflictNote({ files: ['src/cli.js'], trunk: 'b'.repeat(40) }) })], { now }).hotFiles.length, 0, 'repeated events on one item cannot meet the distinct-item threshold');
});

test('canonical conflict notes preserve exact quoted paths [D1]', () => {
  const files = ['src/plain.js', 'src/a, b.js', 'src/"quoted".js', 'src/a|b.js', 'src/line\nend.js', 'src/日本語.js'];
  const note = conflictNote({ files, trunk: 'a'.repeat(40) });
  assert.deepEqual(conflictNoteFiles(note), files);
  for (const invalid of [note + ' extra', 'discussion: ' + note, note.replace(', ', ',')]) assert.equal(conflictNoteFiles(invalid), null);
  assert.equal(conflictNoteFiles(conflictNote({ files: ['', 'src/a.js'], trunk: 'a'.repeat(40) })), null);
  assert.equal(conflictNoteFiles(conflictNote({ files: ['src/a.js', 'src/a.js'], trunk: 'a'.repeat(40) })), null);
  assert.equal(conflictNoteFiles(conflictNote({ files: ['src/\0bad.js'], trunk: 'a'.repeat(40) })), null);
});

test('Pullboard\'s four checks count what main has [D1, C7]', async (t) => {
  assert.equal(typeof fileSizeProblems, 'function', 'the size check imports without running');
  assert.equal([testNameProblems, emptyCatchProblems, testInputProblems].every((find) => typeof find === 'function'), true);

  await t.test('on the pinned main each check prints exactly its census and exits 1, in under 10s [D1, C7]', () => {
    const pinned = join(dir, 'pinned');
    mkdirSync(pinned);
    const archive = git(['archive', '--format=tar', PINNED]);
    const unpacked = spawnSync('tar', ['-x', '-C', pinned], { input: archive });
    assert.equal(unpacked.status, 0, `tar: ${unpacked.stderr}`);
    const expected = Object.fromEntries(Object.entries({ 'file-size': sizeLines(PINNED_SIZES), ...PINNED_PROBLEMS })
      .map(([name, lines]) => [name, sortedProblems(lines)]));
    assert.equal(Object.keys(PINNED_SIZES).length, 7, 'seven files are over the cap');
    assert.equal(Math.max(...Object.values(PINNED_SIZES)), PINNED_SIZES['src/cli.js'], 'the largest is src/cli.js');
    for (const name of CHECKS) {
      const run = runCheck(name, { cwd: pinned });
      assert.deepEqual(run.lines, expected[name], `${name} counts the pinned main's problems exactly`);
      assert.equal(run.status, 1, `${name} exits 1 with problems`);
      assert.equal(run.stderr, '', `${name} writes nothing else`);
      assert.ok(run.ms < 10_000, `${name} took ${Math.round(run.ms)}ms on the pinned main`); // budget: the bar's 10s ceiling per check run; each takes well under 1s.
      assert.deepEqual(runCheck(name, { cwd: dir, root: pinned }).lines, expected[name], `${name} scans its argument the same`);
    }
    assert.deepEqual(Object.fromEntries(CHECKS.map((name) => [name, expected[name].length])),
      { 'file-size': 70, 'test-names': 15, 'empty-catch': 13, 'test-inputs': 16 }, 'today\'s counts');
  });

  await t.test('on this checkout each check prints sorted path:line: text lines, exits 0 or 1, in under 10s [D1, C7]', () => {
    const tracked = git(['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
    const sizes = {};
    for (const path of tracked.filter((name) => /\.(?:[cm]?js|css)$/u.test(name))) {
      const bytes = readFileSync(join(ROOT, path));
      let count = bytes.filter((byte) => byte === 10).length;
      if (bytes.length && bytes[bytes.length - 1] !== 10) count += 1;
      if (count > 1500) sizes[path] = count;
    }
    const trackedSet = new Set(tracked);
    for (const name of CHECKS) {
      const run = runCheck(name);
      assert.ok(run.status === 0 || run.status === 1, `${name} exits 0 or 1, not ${run.status}`);
      assert.equal(run.status, run.lines.length ? 1 : 0, `${name} exits 1 exactly when it prints problems`);
      assert.equal(run.stderr, '', `${name} writes nothing else`);
      assert.ok(run.ms < 10_000, `${name} took ${Math.round(run.ms)}ms`); // budget: the bar's 10s ceiling per check run; each takes well under 1s.
      for (const line of run.lines) assert.match(line, /^[^\s:/][^:]*:[1-9]\d*: \S/u, `${name} prints path:line: text`);
      assert.deepEqual(run.lines, sortedProblems(run.lines), `${name} sorts its output`);
      assert.equal(new Set(run.lines).size, run.lines.length, `${name} prints each problem once`);
      assert.equal(run.lines.some((line) => line.startsWith('apps/cli/journeys/rigor/checks.test.js:') || line.startsWith('bin/checks/')), false,
        `${name} finds nothing in this item's own files`);
      if (name === 'file-size') {
        const ours = run.lines.filter((line) => trackedSet.has(line.slice(0, line.indexOf(':'))));
        assert.deepEqual(ours, sizeLines(sizes), 'the size check agrees with an independent recount of every tracked file');
      }
    }
  });

  await t.test('adding 100 lines to an over-cap file adds exactly one line [D1, C7]', () => {
    const root = fixture('size');
    const lines = (count) => Array.from({ length: count }, (_, index) => `export const value${index} = ${index};\n`).join('');
    put(root, 'src/at-cap.js', lines(1500));
    put(root, 'src/view.css', 'a { color: red; }\n'.repeat(1500));
    put(root, 'work/scratch.js', lines(4000));
    put(root, 'node_modules/dep/index.js', lines(4000));
    put(root, '.git/hooks/huge.js', lines(4000));
    put(root, 'docs/page.html', '<p>\n'.repeat(4000));
    const clean = runCheck('file-size', { root });
    assert.deepEqual([clean.status, clean.lines], [0, []], 'a file at the cap, and skipped folders, print nothing and exit 0');
    put(root, 'src/big.js', lines(1650));
    const before = runCheck('file-size', { root });
    assert.deepEqual(before.lines, ['src/big.js:1501: lines 1501-1600 are over the 1500-line cap', 'src/big.js:1601: lines 1601-1700 are over the 1500-line cap']);
    assert.equal(before.status, 1);
    put(root, 'src/big.js', lines(1750));
    const grown = runCheck('file-size', { root });
    assert.equal(grown.lines.length, before.lines.length + 1, 'one more line for 100 more lines');
    assert.deepEqual(grown.lines.filter((line) => !before.lines.includes(line)), ['src/big.js:1701: lines 1701-1800 are over the 1500-line cap']);
    put(root, 'src/one-over.js', `${lines(1500)}last line without a newline`);
    assert.deepEqual(runCheck('file-size', { root }).lines.filter((line) => line.startsWith('src/one-over.js')),
      ['src/one-over.js:1501: lines 1501-1600 are over the 1500-line cap'], 'one line over the cap is one problem');
  });

  await t.test('adding a bare empty catch adds exactly one line [D1, C7]', () => {
    const root = fixture('catch');
    const reasoned = [
      'export function close(db) {',
      '  try { db.close(); } catch { /* already closed: closing twice is harmless */ }',
      '  try { db.close(); } catch (error) {} // a second close is harmless',
      '  try { db.close(); } catch (error) { console.error(error); }',
      '  db.ready.catch(() => {});',
      "  const text = 'try { x(); } catch {}';",
      '  const template = `${text} catch (error) {}`;',
      '  // try { x(); } catch {}',
      '  return /catch {}/u.test(template);',
      '}',
      '',
    ].join('\n');
    put(root, 'src/close.js', reasoned);
    put(root, 'work/scratch.js', 'try { x(); } catch {}\n');
    const clean = runCheck('empty-catch', { root });
    assert.deepEqual([clean.status, clean.lines], [0, []], 'catches that say why, handle the error or are not code print nothing');
    put(root, 'src/close.js', `${reasoned}export function quiet(db) {\n  try { db.close(); } catch (error) {\n  }\n}\n`);
    const bare = runCheck('empty-catch', { root });
    assert.deepEqual(bare.lines, [`src/close.js:12: ${BARE}`], 'one bare empty catch is one line, at its catch');
    assert.equal(bare.status, 1);
  });

  await t.test('adding a test name without a spec row id adds exactly one line [D1, C7]', () => {
    const root = fixture('names');
    const named = [
      "import { test } from 'node:test';",
      "test('a name with an id [G1.2]', async (t) => {",
      "  await t.test('a subtest nests under its parent', () => {});",
      "  const fixture = \"test('a fixture test written out', () => {});\";",
      '});',
      "describe.skip('a suite with ids [V4, C7]', () => it(`a template name [A1]`, () => {}));",
      'test(nameFromSomewhere, () => {});',
      '',
    ].join('\n');
    put(root, 'test/named.test.js', named);
    put(root, 'src/helper.js', "test('not a test file', () => {});\n");
    const clean = runCheck('test-names', { root });
    assert.deepEqual([clean.status, clean.lines], [0, []], 'named tests, subtests, fixtures and non-test files print nothing');
    put(root, 'test/named.test.js', `${named}test('a [note] without an id', () => {});\n`);
    const unnamed = runCheck('test-names', { root });
    assert.deepEqual(unnamed.lines, [`test/named.test.js:8: ${NO_ID}a [note] without an id`], 'one name without an id is one line');
    assert.equal(unnamed.status, 1);
  });

  await t.test('adding an undeclared source reader adds exactly one line [D1, C7]', () => {
    const root = fixture('inputs');
    const reader = [
      "import { readFileSync } from 'node:fs';",
      "import { test } from 'node:test';",
      "test('reads the seal source [S1]', () => readFileSync(new URL('../../../../packages/kernel/src/logic/seal.js', import.meta.url), 'utf8'));",
      '',
    ].join('\n');
    const splitVariable = [
      "import { readFileSync } from 'node:fs';",
      "const source = new URL('../src/x.js', import.meta.url);",
      'export const text = readFileSync(source, \'utf8\');',
      '',
    ].join('\n');
    const queuedWalk = [
      "import { readFileSync } from 'node:fs';",
      "import { resolve } from 'node:path';",
      "const ROOT = resolve(import.meta.dirname, '../../../..');",
      "const pending = [[resolve(ROOT, 'src/queued-walk-target.js')]];",
      'for (const file of pending.pop()) readFileSync(file, \'utf8\');',
      '',
    ].join('\n');
    put(root, 'test/declared.test.js', `/** @pullboard-test-input test-tree */\n/** @pullboard-test-input source-tree */\n${reader}`);
    put(root, 'test/fixture-copy.test.js', "import { readFileSync } from 'node:fs';\nconst copy = (lane) => readFileSync(join(lane, 'src/board.js'), 'utf8');\n");
    put(root, 'test/imports.test.js', "import { seal } from '../../../../packages/kernel/index.js';\nconst note = \"readFileSync(new URL('../src/a.js', import.meta.url))\";\n");
    put(root, 'test/module-url.test.js', [
      "import { readFileSync } from 'node:fs';",
      "const board = new URL('../../../../packages/store/index.js', import.meta.url).href;",
      "const cli = pathToFileURL(resolve(import.meta.dirname, '../src/cli.js')).href;",
      "const api = await import(new URL('../src/api.js', import.meta.url));",
      "export const config = readFileSync('pullboard.json', 'utf8');",
      '',
    ].join('\n'));
    put(root, 'test/no-read.test.js', "export const worker = resolve(import.meta.dirname, '../src/worker.js');\n");
    const clean = runCheck('test-inputs', { root });
    assert.deepEqual([clean.status, clean.lines], [0, []], 'a declared reader, a fixture copy, an import, module URLs and a path never read print nothing');
    put(root, 'test/undeclared.test.js', reader);
    const undeclared = runCheck('test-inputs', { root });
    assert.deepEqual(undeclared.lines, [`test/undeclared.test.js:3: ${UNDECLARED}`], 'one undeclared reader is one line');
    assert.equal(undeclared.status, 1);
    rmSync(join(root, 'test/undeclared.test.js'));
    put(root, 'test/split-variable.test.js', splitVariable);
    assert.deepEqual(runCheck('test-inputs', { root }).lines, [`test/split-variable.test.js:2: ${UNDECLARED}`],
      'a source path built on one line and read on the next is one line');
    rmSync(join(root, 'test/split-variable.test.js'));
    put(root, 'test/queued-walk.test.js', queuedWalk);
    assert.deepEqual(runCheck('test-inputs', { root }).lines, [`test/queued-walk.test.js:4: ${UNDECLARED}`],
      'a ROOT-anchored path queued and read later, as help.test.js does, is one line');
    put(root, 'test/late.test.js', `import { readFileSync } from 'node:fs';\n/** @pullboard-test-input source-tree */\n${reader.split('\n').slice(1).join('\n')}`);
    assert.deepEqual(runCheck('test-inputs', { root }).lines.map((line) => line.slice(0, line.indexOf(':'))),
      ['test/late.test.js', 'test/queued-walk.test.js'], 'a declaration below the first code line is not read, as the selection reads it');
  });
});

test('a legacy split draft resumes after its row is reserved [D1,H16]', async () => {
  const box = conflictHistory({ automatic: false });
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  try {
    const report = conflictReport(store.events(board));
    const ctx = { info: { root: box.repo, isMain: true }, config: loadConfig(box.repo) };
    const before = readFileSync(loadDoctrine(box.repo).repo.file, 'utf8');
    let interrupted = false;
    let calls = 0;
    const dependencies = {
      read: () => ({ coordinator: true, rows: store.rowDrafts(board), decisions: store.rowDecisions(board) }),
      /** Interrupt once after the real durable reservation, before the ordinary file write. */
      reserve: row => {
        calls += 1;
        const entry = draftSpecRow(board, { agentId: 'coordinator', row, written: true });
        if (!interrupted) { interrupted = true; throw new Error('fixture interruption after durable reservation'); }
        return entry;
      },
    };
    await assert.rejects(draftConflictSplits(ctx, report, dependencies), /fixture interruption after durable reservation/u);
    assert.equal(readFileSync(loadDoctrine(box.repo).repo.file, 'utf8'), before);
    const reserved = store.rowDrafts(board);
    assert.equal(reserved.length, 1, 'the reservation survived the interrupted file write');
    const recovered = await draftConflictSplits(ctx, report, dependencies);
    assert.equal(recovered.length, 1, 'a board reservation alone cannot pretend the file draft exists');
    assert.equal(recovered[0].row.id, reserved[0].id, 'recovery keeps the exact reserved identity');
    assert.equal(calls, 1, 'recovery does not reserve another identity');
    const row = loadDoctrine(box.repo).repo.rows.find(row => row.id === reserved[0].id);
    assert.equal(row.status, 'draft');
    assert.equal(row.text, reserved[0].text, 'recovery preserves the original pending judgment and source');
    assert.equal(row.gate, 'review');
    assert.equal(store.rowDrafts(board).length, 1);
    assert.deepEqual(await draftConflictSplits(ctx, report, dependencies), []);
    const declined = box.run(box.repo, 'spec', 'decline', 'doctrine:' + row.id, '--reason', 'choose another split');
    assert.equal(declined.code, 0, declined.out + declined.err);
    writeFileSync(loadDoctrine(box.repo).repo.file, before);
    await assert.rejects(draftConflictSplits(ctx, report, dependencies), error => error.code === 'STALE_ROW_DECISION', 'an interrupted retry never recreates a row with a person decision');
    assert.equal(readFileSync(loadDoctrine(box.repo).repo.file, 'utf8'), before);
  } finally { store.closeBoard(board); }
});


test('concurrent legacy split proposals keep one reserved row [D1,H16]', async () => {
  const box = conflictHistory({ automatic: false });
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  try {
    const report = conflictReport(store.events(board));
    const ctx = { info: { root: box.repo, isMain: true }, config: loadConfig(box.repo) };
    const dependencies = {
      read: () => ({ coordinator: true, rows: store.rowDrafts(board), decisions: store.rowDecisions(board) }),
      reserve: row => draftSpecRow(board, { agentId: 'coordinator', row, written: true }),
    };
    // The first await leaves an actual reservation; the second call recovers it before the first writes.
    await Promise.all([draftConflictSplits(ctx, report, dependencies), draftConflictSplits(ctx, report, dependencies)]);
    const doctrine = loadDoctrine(box.repo);
    assert.deepEqual(doctrine.repo.problems, [], 'concurrent identical writes never duplicate a row id');
    const proposed = doctrine.repo.rows.filter(row => row.text.includes('Source: conflict-split:'));
    assert.equal(proposed.length, 1);
    assert.equal(proposed[0].status, 'draft');
    assert.equal(store.rowDrafts(board).length, 1);
    const before = readFileSync(doctrine.repo.file, 'utf8');
    assert.throws(() => proposeDoctrine({ ...ctx, doctrine }, { source: 'fixture', gate: 'review' }, 'Different judgment', { id: proposed[0].id }), error => error.code === 'ROW_DRAFT');
    assert.equal(readFileSync(doctrine.repo.file, 'utf8'), before, 'a fixed-id retry cannot overwrite a different judgment');
  } finally { store.closeBoard(board); }
});


/**
 * A real git repo on main with `files` committed, then a work branch, for the quality rules [D1,D3].
 * commit(subject, files) writes and commits on the branch and returns the commit id.
 */
function qualityRepo(name, files) {
  const root = fixture(name);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  /** Git in the fixture, with a fixed identity and no hooks. */
  const run = (...args) => {
    const result = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  /** Write files and commit them with this subject. */
  const commit = (subject, changes) => {
    for (const [path, text] of Object.entries(changes)) put(root, path, text);
    run('add', '-A');
    run('commit', '-q', '-m', subject);
    return run('rev-parse', 'HEAD');
  };
  run('init', '-q', '-b', 'main');
  commit('feat: start', files);
  run('checkout', '-q', '-b', 'work');
  return { root, commit };
}

test('rigor reports a fix with no reproducing test [D1,D3]', () => {
  const start = { 'src/parse.js': 'export function parse(text) {\n  return text.split(\',\');\n}\n',
    'test/parse.test.js': 'import { test } from \'node:test\';\ntest(\'parses [G1]\', () => {});\n' };
  const bare = qualityRepo('quality-fix-bare', start);
  bare.commit('feat(parse): count fields', { 'src/count.js': 'export const count = (text) => text.length;\n' });
  const fix = bare.commit('fix(parse): ignore empty input', { 'src/parse.js': 'export function parse(text) {\n  if (!text) return [];\n  return text.split(\',\');\n}\n' });
  const breaches = qualityBreaches(bare.root, changeRange(bare.root), { rules: ['fix-test'] });
  assert.deepEqual(breaches.map((breach) => breachLine(breach)),
    [`src/parse.js:2: fix-test: fix ${fix.slice(0, 12)} "fix(parse): ignore empty input" changes no test that reproduces its failure`],
    'the fix is named at its file and first changed line with the rule it breaks; a feature commit with no test is not a fix');
  assert.deepEqual(breachLine(breaches[0], new Map([['fix-test', 'T7']])).split(': ').slice(1, 2), ['T7 fix-test'], 'a drafted row names its id beside the rule');
  const tested = qualityRepo('quality-fix-tested', start);
  tested.commit('fix(parse): ignore empty input', { 'src/parse.js': 'export function parse(text) {\n  if (!text) return [];\n  return text.split(\',\');\n}\n',
    'test/parse.test.js': 'import { test } from \'node:test\';\ntest(\'parses [G1]\', () => {});\ntest(\'empty input [G1]\', () => {});\n' });
  assert.deepEqual(qualityBreaches(tested.root, changeRange(tested.root), { rules: ['fix-test'] }), [], 'a fix that ships a test passes');
  assert.deepEqual(qualityBreaches(bare.root, changeRange(bare.root, { base: 'HEAD' }), { rules: ['fix-test'] }), [], 'an empty change has nothing to judge');
});

test('rigor reports a silent catch [D1,D3]', () => {
  const old = 'export function old() {\n  try { return 1; } catch { return 0; }\n}\n';
  const repo = qualityRepo('quality-catch', { 'src/load.js': old });
  repo.commit('feat(load): read settings', { 'src/load.js': [
    old.trimEnd(),
    'export function settings(read) {',
    '  try { return read(); } catch { return null; }',
    '}',
    'export function loud(read) {',
    '  try { return read(); } catch (error) { console.warn(`settings unreadable: ${error.message}`); return null; }',
    '}',
    'export function strict(read) {',
    '  try { return read(); } catch (error) { throw new Error(`settings: ${error.message}`); }',
    '}',
    'export const later = (load) => load().catch(() => null);',
    'export const told = (load) => load().catch((error) => log(`load failed: ${error.message}`));',
    'export const words = \'a catch { } in a string is not code\';',
    '',
  ].join('\n'), 'test/load.test.js': 'try { JSON.parse(\'{\'); } catch { }\n' });
  const breaches = qualityBreaches(repo.root, changeRange(repo.root), { rules: ['silent-catch'] });
  assert.deepEqual(breaches.map((breach) => breachLine(breach)), [
    'src/load.js:5: silent-catch: catch is silent: it neither throws nor logs a line that names its subject',
    'src/load.js:13: silent-catch: .catch handler is silent: it neither throws nor logs a line that names its subject',
  ], 'only the added silent catches are named: the old one, the logged one, the rethrow, a string and a test file are not');
});

test('rigor reports a catch the change made silent [D1,D3]', () => {
  const start = [
    'export function settings(read) {',
    '  try {',
    '    return read();',
    '  } catch (error) {',
    '    console.warn(`settings unreadable: ${error.message}`);',
    '    return null;',
    '  }',
    '}',
    'export function cached(read) {',
    '  try {',
    '    return read();',
    '  } catch {',
    '    return {};',
    '  }',
    '}',
    '',
  ];
  const repo = qualityRepo('quality-catch-edited', { 'src/settings.js': start.join('\n') });
  const edited = [...start];
  edited.splice(4, 2, '    return {};');
  edited[edited.indexOf('    return {};', 8)] = '      return {};';
  repo.commit('fix(settings): fall back to defaults', { 'src/settings.js': edited.join('\n') });
  const breaches = qualityBreaches(repo.root, changeRange(repo.root), { rules: ['silent-catch'] });
  assert.deepEqual(breaches.map((breach) => breachLine(breach)), [
    'src/settings.js:4: silent-catch: catch is silent: it neither throws nor logs a line that names its subject',
  ], 'the catch whose logged body became a silent fallback is named at its header; the old silent catch, only reindented, is not');
});

test('rigor reports a catch whose log line alone is deleted [D1,D3]', () => {
  const start = [
    'export function settings(read) {',
    '  try {',
    '    return read();',
    '  } catch (error) {',
    '    console.warn(`settings unreadable: ${error.message}`);',
    '    return null;',
    '  }',
    '}',
    'export function other(read) {',
    '  try {',
    '    return read();',
    '  } catch (error) {',
    '    console.warn(`other unreadable: ${error.message}`);',
    '    return null;',
    '  }',
    '}',
    '',
  ];
  const repo = qualityRepo('quality-catch-deleted', { 'src/settings.js': start.join('\n') });
  repo.commit('fix(settings): quieter reads', { 'src/settings.js': start.filter((line) => !line.includes('settings unreadable')).join('\n') });
  const breaches = qualityBreaches(repo.root, changeRange(repo.root), { rules: ['silent-catch'] });
  assert.deepEqual(breaches.map((breach) => breachLine(breach)), [
    'src/settings.js:4: silent-catch: catch is silent: it neither throws nor logs a line that names its subject',
  ], 'a change that only deletes a catch log names that catch; the untouched logged catch is not named');
});

test('rigor matches a catch to its earlier self when a new one shares its header [D1,D3]', () => {
  const start = [
    'export function strict(read) {',
    '  try {',
    '    return read();',
    '  } catch (error) {',
    '    throw new Error(`strict read failed: ${error.message}`);',
    '  }',
    '}',
    'export function old(read) {',
    '  try {',
    '    return read();',
    '  } catch (error) {',
    '    return null;',
    '  }',
    '}',
    '',
  ];
  const repo = qualityRepo('quality-catch-shifted', { 'src/read.js': start.join('\n') });
  const edited = [
    'export function logged(read) {',
    '  try {',
    '    return read();',
    '  } catch (error) {',
    '    console.warn(`logged read failed: ${error.message}`);',
    '    return null;',
    '  }',
    '}',
    ...start.slice(0, 4),
    '    return null;',
    ...start.slice(5),
  ];
  repo.commit('fix(read): softer strict reads', { 'src/read.js': edited.join('\n') });
  const breaches = qualityBreaches(repo.root, changeRange(repo.root), { rules: ['silent-catch'] });
  assert.deepEqual(breaches.map((breach) => breachLine(breach)), [
    'src/read.js:12: silent-catch: catch is silent: it neither throws nor logs a line that names its subject',
  ], 'the strict catch made silent is named at its kept header; the new logged catch and the old silent catch are not');
});
