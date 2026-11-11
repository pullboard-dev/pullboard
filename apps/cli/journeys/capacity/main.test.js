import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { openBoardForRead } from '../../../lib/index.js';
/** Exact collision-model numbers from committed Git paths and a private SQLite event journal [R1,R2]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureBoard } from '../../tests/fixtures/board.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import * as store from '../../../../packages/store/index.js';
import { readCarryingCapacity } from '../../../../packages/stats/index.js';
import { carryingCapacity } from '../../../../packages/stats/index.js';

const BASE = Date.parse('2026-11-01T00:00:00Z');
const HOUR = 3_600_000;

/** Compare rational fixture answers without hiding meaningful numerical drift. */
function near(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`); }

/** Real Git bytes and SQLite records; lifecycle fragments are observations, never forged gate/verification receipts. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-carrying-capacity-'));
  let at = BASE;
  const board = fixtureBoard(t, { clock: { now: () => new Date(at) } });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  /** Execute Git only against this test-owned repository. */
  const git = args => String(runFixtureGit(args, { cwd: root, encoding: 'utf8', stdio: 'pipe' })).trim();
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  git(['config', 'user.name', 'Capacity fixture']);
  for (const cell of ['one', 'two']) mkdirSync(join(root, 'packages', cell), { recursive: true });
  const a = 'packages/one/a.js', b = 'packages/two/b.js';
  writeFileSync(join(root, a), 'seed a\n'); writeFileSync(join(root, b), 'seed b\n');
  git(['add', '.']); git(['commit', '-qm', 'seed']);
  store.register(board, { lane: 'coordinator', path: root });
  const ids = Array.from({ length: 4 }, (_, index) => store.addItem(board,
    { by: 'coordinator', lane: 'core', title: `Observed change ${index}` }));
  /** Append explicit fixture observations through the real journal, not live lifecycle authorization. */
  function observe(hour, kind, item, detail = {}) {
    at = BASE + hour * HOUR;
    store.logEvent(board, kind === 'merged' ? 'coordinator' : 'fixture-observer', kind, item, detail);
  }
  for (let index = 0; index < ids.length; index++) {
    const base = git(['rev-parse', 'HEAD']);
    writeFileSync(join(root, a), `a ${index}\n`);
    if (index % 2) writeFileSync(join(root, b), `b ${index}\n`);
    git(['add', '.']); git(['commit', '-qm', `change ${index}`]);
    const commit = git(['rev-parse', 'HEAD']);
    observe(index, 'claim', ids[index]);
    if (index % 2) observe(index + 0.1, 'reopen', ids[index], { conflict: { files: [index === 1 ? a : b], trunk: base } });
    observe(index + 0.25, 'submit', ids[index], { commit, submissionSize: { base, head: commit } });
    observe(index + 0.5, 'merged', ids[index], { commit });
  }
  return { root, board, git, a, b, observe, window: { from: new Date(BASE).toISOString(), to: new Date(BASE + 4 * HOUR).toISOString() } };
}

test('capacity pins landings, per-file pressure, Little law, cells and held-out error on actual committed paths [R1,R2]', t => {
  const f = fixture(t);
  const before = store.events(f.board);
  writeFileSync(join(f.root, 'untracked.js'), 'not in any submitted tree\n');
  const status = f.git(['status', '--porcelain']);
  const report = readCarryingCapacity(f.root, before, f.window);
  assert.equal(report.landings, 4); assert.equal(report.conflicts, 2);
  near(report.conflictsPerLanding, 0.5); near(report.landingRate, 1);
  near(report.lifetimeHours, 0.5); near(report.buildHours, 0.25); near(report.waitingHours, 0.25);
  near(report.inFlight, 0.5); near(report.buildingInFlight, 0.25); near(report.waitingInFlight, 0.25);
  near(report.cellsPerItem, 1.5);
  const a = report.files.find(row => row.file === f.a), b = report.files.find(row => row.file === f.b);
  assert.deepEqual([a.touches, a.conflicts, b.touches, b.conflicts], [4, 1, 2, 1]);
  near(a.sharedTouches, 2); near(b.sharedTouches, 0.5);
  near(a.rate, 0.65); near(b.rate, 1.04); near(a.pressure, 0.65); near(b.pressure, 0.26);
  near(report.k, 0.91); near(report.agentsAtFivePercent, 1 + 0.05 / 0.91);
  near(report.peakAgents, 1 / 1.82); near(report.peakOutput, 1 / 3.64);
  assert.equal(report.files[0].file, f.a);
  assert.equal(report.validation.trainingLandings, 2); assert.equal(report.validation.heldOutLandings, 2);
  assert.equal(report.validation.actualFileConflicts, 1);
  near(report.validation.predictedFileConflicts, 47 / 45);
  near(report.validation.error, 2 / 45); near(report.validation.relativeError, 2 / 45);
  assert.deepEqual(report.missing, { landingFiles: 0, conflictFiles: 0, lifetimes: 0 });
  assert.deepEqual(store.events(f.board), before, 'reading cannot warm the board or append metrics');
  assert.equal(f.git(['status', '--porcelain']), status, 'reading cannot change Git or include untracked bytes');
});

test('empty or incomplete evidence stays unknown; held-out outcomes never influence fitted rates [R1,R2]', () => {
  const window = { from: new Date(BASE).toISOString(), to: new Date(BASE + 4 * HOUR).toISOString() };
  const empty = carryingCapacity(window);
  assert.equal(empty.k, null); assert.equal(empty.peakAgents, null); assert.equal(empty.cellsPerItem, null);
  const landings = [0.5, 1.5, 2.5, 3.5].map(hour => ({ at: BASE + hour * HOUR, files: ['packages/a/a.js'],
    lifetimeHours: 0.5, buildHours: 0.25, waitingHours: 0.25 }));
  const conflicts = [{ at: BASE + HOUR, files: ['packages/a/a.js'] }];
  const original = carryingCapacity({ ...window, landings, conflicts });
  const more = carryingCapacity({ ...window, landings, conflicts: [...conflicts,
    { at: BASE + 3 * HOUR, files: ['packages/a/a.js'] }] });
  near(original.validation.predictedFileConflicts, more.validation.predictedFileConflicts);
  const missing = carryingCapacity({ ...window, landings: landings.map(row => ({ ...row, files: null })), conflicts });
  assert.equal(missing.k, null); assert.equal(missing.cellsPerItem, null); assert.equal(missing.missing.landingFiles, 4);
});

test('native capacity text and JSON expose the selected read-only window while retaining test-cost outputs [R1,R2]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true', helpers.sandbox(), { withWorktree: false });
  /** Inspect the private journal through a real read-only board connection. */
  function journal() {
    const board = openBoardForRead(join(box.repo, '.git/pullboard/board.sqlite'));
    try { return store.events(board); } finally { store.closeBoard(board); }
  }
  const before = journal();
  const json = box.run(box.repo, 'capacity', '--window', '4h', '--json');
  assert.equal(json.code, 0, json.out + json.err);
  const report = JSON.parse(json.out).report;
  assert.ok(report.suite && report.builds, 'existing capacity consumers retain their reports');
  assert.equal(Date.parse(report.carryingCapacity.to) - Date.parse(report.carryingCapacity.from), 4 * HOUR);
  assert.equal(report.carryingCapacity.landings, 0);
  const text = box.run(box.repo, 'capacity');
  assert.equal(text.code, 0, text.out + text.err);
  assert.match(text.out, /carrying capacity.*0 landings/u);
  assert.match(text.out, /held-out file conflicts/u);
  assert.deepEqual(journal(), before);
});

test('a historical landing without captured base measures the merge first parent rather than a false empty diff [R1,R2]', t => {
  const f = fixture(t);
  f.git(['checkout', '-qb', 'private-side']);
  writeFileSync(join(f.root, f.a), 'side contribution\n');
  f.git(['add', '.']); f.git(['commit', '-qm', 'side source']);
  f.git(['checkout', '-q', 'main']);
  writeFileSync(join(f.root, f.b), 'prior trunk contribution\n');
  f.git(['add', '.']); f.git(['commit', '-qm', 'trunk source']);
  f.git(['merge', '--no-ff', '-qm', 'actual merge', 'private-side']);
  const commit = f.git(['rev-parse', 'HEAD']);
  const id = store.addItem(f.board, { by: 'coordinator', lane: 'core', title: 'Historical merge sample' });
  f.observe(4, 'claim', id);
  f.observe(4.25, 'submit', id, { commit });
  f.observe(4.5, 'merged', id, { commit });
  const report = readCarryingCapacity(f.root, store.events(f.board), { ...f.window, to: new Date(BASE + 5 * HOUR).toISOString() });
  assert.equal(report.landings, 5);
  assert.equal(report.files.find(row => row.file === f.a).touches, 5, 'the actual first-parent merge contribution is counted');
  assert.equal(report.files.find(row => row.file === f.b).touches, 2, 'the prior trunk contribution is not misattributed to this item');
});
