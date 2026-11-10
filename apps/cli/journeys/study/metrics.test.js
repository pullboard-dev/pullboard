/** The case study reads real Git inventory and immutable SQLite event records [C7,D3]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dirname,
  join,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { eventMetrics } from '../../../../docs/tools/case-study/events.js';
import {
  structureMetrics,
  requireFinishedStructure,
} from '../../../../docs/tools/case-study/structure.js';
import {
  caseStudy,
  readCaseStudyBaseline,
  writeCaseStudy,
} from '../../../../docs/tools/case-study/report.js';
import {
  frozenCheckMetrics,
  suiteLogMetrics,
} from '../../../../docs/tools/case-study/durations.js';
import { receiptBody } from '../../../../packages/gate/index.js';
import {
  runFixtureChild,
  runFixtureGit,
} from '../../tests/fixtures/child.js';

const START = '2026-10-01T00:00:00.000Z', END = '2026-10-01T00:10:00.000Z';
const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);

/** Address a fixture minute without wall-clock assumptions. */
function at(minutes) { return new Date(Date.parse(START) + minutes * 60_000).toISOString(); }

/** Persist only owned fixture bytes. */
function put(root, file, value) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), typeof value === 'string' ? value : JSON.stringify(value));
}

/** Make actual Git and SQLite sources; no live board, copied history or global account enters the fixture. */
function fixture(t, entries = []) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-case-study-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root });
  put(root, 'package.json', { type: 'module', bin: { example: 'bin/main.js' } });
  put(root, 'bin/main.js', 'import "../src/a.js";\n');
  put(root, 'src/a.js', 'import { b } from "./b.js";\nexport const a = b;\n');
  put(root, 'src/b.js', 'export const b = 1;\n');
  const cells = ['a', 'b'].map((name, index) => ({ name, order: index + 1,
    root: `packages/${name}`, frontDoor: `packages/${name}/index.js`,
    paths: [[`src/${name}.js`, `packages/${name}/src/core/${name}.js`, 'seed']],
    reexports: [], cuts: index === 0 ? [{ cell: 'b', imports: 1 }] : [] }));
  for (const cell of cells) put(root, `packages/codemap/data/plan/${cell.name}.json`, cell);
  put(root, 'packages/codemap/data/plan/cells.json', { version: 1, base: A, stays: [],
    cells: cells.map(cell => ({ file: `packages/codemap/data/plan/${cell.name}.json` })) });
  runFixtureGit(['add', '.'], { cwd: root });
  runFixtureGit(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'fixture'], { cwd: root });
  // @pullboard-board-file persistence: verify the reporting reader opens a real SQLite file read-only and leaves its exact bytes unchanged.
  const boardPath = join(root, '.git', 'case-study.sqlite');
  const db = new DatabaseSync(boardPath);
  try {
    db.exec('CREATE TABLE event(event_id INTEGER PRIMARY KEY,event_kind TEXT,item_id INTEGER,event_at TEXT,event_detail TEXT)');
    const insert = db.prepare('INSERT INTO event VALUES (?,?,?,?,?)');
    entries.forEach(([minute, kind, item, detail], index) => insert.run(index + 1, kind, item, at(minute), JSON.stringify(detail)));
  } finally { db.close(); }
  return { root, boardPath };
}

/** Hash persisted data before and after a report read. */
function digest(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }

test('case study joins acceptance to submitted source, deduplicates landings, and leaves SQLite unchanged [C7,D3]', t => {
  const { boardPath } = fixture(t, [
    [0, 'claim', 1, {}], [1, 'claim', 1, {}], [2, 'submit', 1, { commit: A }],
    [3, 'accept', 1, { commit: A }], [5, 'merged', 1, { commit: B }], [6, 'merged', 1, { commit: B }],
    [7, 'reopen', 1, { cause: 'conflict:src/a.js' }],
    [8, 'submit', 2, { commit: C }], [9, 'reopen', 2, { note: 'some conflict prose is not a typed cause' }],
  ]);
  const before = digest(boardPath), metrics = eventMetrics(boardPath, { from: START, to: END });
  assert.equal(metrics.landings.n, 1);
  assert.equal(metrics.landings.perHour, 6);
  assert.equal(metrics.claimToLand.medianMs, 4 * 60_000);
  assert.equal(metrics.acceptToLand.medianMs, 2 * 60_000, 'landing SHA B differs from accepted submitted source A');
  assert.equal(metrics.acceptToLand.n, 1);
  assert.equal(metrics.submits.n, 2);
  assert.equal(metrics.submits.perSubmittedItem, 1);
  assert.equal(metrics.conflictReopens.n, 1);
  assert.equal(metrics.conflictReopens.perLanding, 1);
  assert.equal(digest(boardPath), before);
});

test('case study uses receipt timestamps, excludes duplicate receipts and does not infer full suites [C7,D3]', t => {
  const receipt = { id: 'fixture-one', kind: 'submit', at: at(9), durationMs: 5000,
    counts: { passed: 99999, failed: 0 }, environment: { node: '24.21.0' } };
  const { boardPath } = fixture(t, [
    [11, 'proof-run', 1, { receipt }], [12, 'proof-run', 1, { receipt }],
    [9, 'proof-run', 1, { receipt: { ...receipt, id: 'missing-time', at: undefined } }],
  ]);
  const metrics = eventMetrics(boardPath, { from: START, to: END });
  assert.equal(metrics.proofReceipts.n, 1, 'receipt completed inside the window even though recording was delayed');
  assert.equal(metrics.proofReceipts.submitReceiptDuration.n, 1); // budget: derived from one distinct recorded receipt fixture, not a clock.
  assert.equal(metrics.proofReceipts.submitReceiptDuration.medianMs, receipt.durationMs); // budget: derived from the recorded fixture payload, not elapsed execution.
  assert.equal(metrics.proofReceipts.fullSuite.n, 0);
  assert.equal(metrics.proofReceipts.fullSuite.medianMs, null);
  assert.match(metrics.proofReceipts.fullSuite.evidence, /missing/u);
  assert.deepEqual(metrics.proofReceipts.runtimeNodes, ['24.21.0']);
});

test('case study retains unknown stale acceptances and rejects invalid windows or absent databases [C7,D3]', t => {
  const { boardPath } = fixture(t, [
    [1, 'submit', 1, { commit: A }], [2, 'accept', 1, { commit: A }],
    [3, 'submit', 1, { commit: C }], [4, 'merged', 1, { commit: B }],
  ]);
  const metrics = eventMetrics(boardPath, { from: START, to: END });
  assert.equal(metrics.acceptToLand.n, 0);
  assert.equal(metrics.acceptToLand.unknown, 1);
  assert.equal(metrics.acceptToLand.medianMs, null);
  assert.throws(() => eventMetrics(boardPath, { from: END, to: START }), /from < to/u);
  assert.throws(() => eventMetrics(join(dirname(boardPath), 'absent.sqlite'), { from: START, to: END }));
});

test('case study measures planted imports and shims through real lint inventory instead of plan totals [C7,D3]', t => {
  const { root } = fixture(t);
  const before = structureMetrics(root);
  assert.equal(before.importCutsLeft, 1);
  assert.equal(before.lints.legacySource, 2);
  put(root, 'src/a.js', 'export const a = 1;\n');
  const after = structureMetrics(root);
  assert.equal(after.importCutsLeft, 0);
  assert.equal(after.plannedCutImports, 1, 'original plan total is retained rather than rewritten as actual debt');
  put(root, 'src/a.js', 'export { b as a } from "./b.js";\n');
  assert.equal(structureMetrics(root).lints.shims, 1, 'the genuine linter detects the planted forwarding shim');
  assert.throws(() => requireFinishedStructure(after), { code: 'CASE_STUDY_INCOMPLETE' });
});

test('case study writes a reproducible companion pair and binds its retained baseline bytes [C7,D3]', t => {
  const { root, boardPath } = fixture(t);
  const report = caseStudy({ root, boardPath, from: START, to: END });
  const baselineFile = join(root, '.git', 'baseline.json');
  put(root, '.git/baseline.json', { version: 1, source: A, window: report.observation.window,
    structure: report.observation.structure, events: report.observation.events });
  const baseline = readCaseStudyBaseline(baselineFile);
  assert.equal(baseline.sha256, digest(baselineFile));
  const compared = caseStudy({ root, boardPath, from: START, to: END, baseline });
  const output = join(root, '.git', 'report');
  writeCaseStudy(compared, output);
  assert.deepEqual(JSON.parse(readFileSync(join(output, '0.9.4.json'), 'utf8')), compared);
  assert.match(readFileSync(join(output, '0.9.4.md'), 'utf8'), /in-progress/u);
  assert.match(readFileSync(join(output, '0.9.4.md'), 'utf8'), /unknown/u);
  assert.throws(() => caseStudy({ root, boardPath, from: START, to: END, finished: true }), { code: 'CASE_STUDY_INCOMPLETE' });
});

test('case study retains the historical timing population and includes failed log observations [C7,D3]', t => {
  const { root } = fixture(t), file = join(root, '.git', 'durations.tsv');
  const header = 'file\tmtime_utc\tpass\tfail\tduration_ms\n';
  writeFileSync(file, header + 'gate-first.log\t2026-09-01T00:00Z\t10\t0\t1000\n'
    + 'gate-second.log\t2026-09-02T00:00Z\t9\t1\t3000\n');
  const metrics = suiteLogMetrics(file);
  assert.equal(metrics.n, 2);
  assert.equal(metrics.medianMs, 2000);
  assert.equal(metrics.failingSummaries, 1);
  assert.equal(metrics.zeroFailureSummaries, 1);
  assert.equal(metrics.window.from, '2026-09-01T00:00:00.000Z');
  assert.equal(metrics.sourceSHA256, digest(file));
  assert.match(metrics.qualification, /do not prove full coverage/u);
  writeFileSync(file, header + 'same.log\t2026-09-01T00:00Z\t1\t0\t1000\n'.repeat(2));
  assert.throws(() => suiteLogMetrics(file), /unique/u);
});

test('case study frozen timings require canonical source and exact frozen-command bindings [C7,D3]', t => {
  const id = '11111111-1111-4111-8111-111111111111', frozenDigest = 'd'.repeat(64), check = 'node check.js';
  const flat = { id, kind: 'submit', item: 1, commit: A, tree: B, frozenDigest, durationMs: 1234, at: at(9) };
  const { root, boardPath } = fixture(t, [[9, 'proof-run', 1, { receipt: flat }]]);
  const db = new DatabaseSync(boardPath);
  try {
    db.exec('CREATE TABLE item(item_id INTEGER PRIMARY KEY,item_frozen TEXT,item_frozen_digest TEXT)');
    db.prepare('INSERT INTO item VALUES (?,?,?)').run(1, JSON.stringify({ check }), frozenDigest);
  } finally { db.close(); }
  // This is reporting fixture data only. It is never submitted as native execution or a board proof.
  const receipt = { version: 2, id, kind: 'submit', head: A, tree: B, main: null,
    command: createHash('sha256').update(check).digest('hex'), green: true, failures: [], load: null, at: at(9),
    proof: { item: 1, frozenDigest, seat: 'fixture-seat', runner: 'fixture-runner', exitCode: 0,
      environment: { node: '22.13.1', platform: 'linux', arch: 'x64' },
      counts: { passed: 1, failed: 0, skipped: 0 }, durationMs: 1234, sourceClean: true } };
  const encoded = receiptBody(receipt);
  assert.ok(encoded, 'fixture uses the actual canonical receipt schema');
  put(root, `.git/gate-receipts/${id}.json`, encoded);
  const metrics = frozenCheckMetrics(boardPath, { from: START, to: END });
  assert.equal(metrics.n, 1);
  assert.equal(metrics.medianMs, 1234);
  assert.equal(metrics.unknown, 0);
  const replay = new DatabaseSync(boardPath);
  try {
    const insert = replay.prepare('INSERT INTO event VALUES (?,?,?,?,?)');
    insert.run(2, 'proof-run', 1, at(11), JSON.stringify({ receipt: flat }));
    assert.equal(frozenCheckMetrics(boardPath, { from: START, to: END }).n, 1, 'identical replay contributes once');
    insert.run(3, 'proof-run', 1, at(12), JSON.stringify({ receipt: { ...flat, at: at(12), durationMs: 9000 } }));
    const conflict = frozenCheckMetrics(boardPath, { from: START, to: END });
    assert.equal(conflict.n, 0, 'a conflicting replay outside the window invalidates the same receipt ID');
    assert.equal(conflict.unknown, 1);
    assert.equal(conflict.conflictingIds, 1);
    replay.prepare('DELETE FROM event WHERE event_id>1').run();
  } finally { replay.close(); }
  receipt.command = createHash('sha256').update('node a-different-command.js').digest('hex');
  put(root, `.git/gate-receipts/${id}.json`, receiptBody(receipt));
  const mismatched = frozenCheckMetrics(boardPath, { from: START, to: END });
  assert.equal(mismatched.n, 0, 'an unrelated submit phase cannot become a frozen-check duration');
  assert.equal(mismatched.unknown, 1);
});

test('case study executable regenerates the report from the selected real sources [C7,D3]', t => {
  const { root, boardPath } = fixture(t), output = join(root, '.git', 'cli-report');
  const result = runFixtureChild(process.execPath, [join(import.meta.dirname, '../../../../docs/tools/case-study.js'),
    '--root', root, '--board', boardPath, '--from', START, '--to', END, '--output', output], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  const report = JSON.parse(readFileSync(join(output, '0.9.4.json'), 'utf8'));
  assert.equal(report.observation.structure.importCutsLeft, 1);
  assert.equal(report.observation.events.landings.n, 0);
  assert.match(readFileSync(join(output, '0.9.4.md'), 'utf8'), /Starting capture/u);
});

test('case study reads every SQLite event across collection and multiple bounded pages [C7,D3]', t => {
  const entries = Array.from({ length: 385 }, (_, index) => [1, 'claim', index + 1, {}]);
  const { boardPath } = fixture(t, entries);
  const module = pathToFileURL(join(import.meta.dirname, '../../../../docs/tools/case-study/events.js')).href;
  const program = `import {DatabaseSync} from 'node:sqlite';\nimport {eventRows} from ${JSON.stringify(module)};\n`
    + `const db=new DatabaseSync(${JSON.stringify(boardPath)},{readOnly:true});let n=0;\n`
    + 'try {for(const event of eventRows(db)){if(event.event_id!==++n)throw new Error("lost event order");if(n%64===0)globalThis.gc();}}finally{db.close();}\n'
    + 'process.stdout.write(JSON.stringify({n}));\n';
  const result = runFixtureChild(process.execPath, ['--expose-gc', '--input-type=module', '--eval', program], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { n: entries.length });
});

test('case study counts a moved body separately from its remaining forwarding shim [C7,D3]', t => {
  const { root } = fixture(t);
  put(root, 'packages/a/src/core/a.js', 'export const a = 1;\n');
  put(root, 'packages/a/index.js', 'export { a } from "./src/core/a.js";\n');
  put(root, 'src/a.js', 'export * from "../packages/a/src/core/a.js";\n');
  const structure = structureMetrics(root);
  assert.equal(structure.cells.completed, 1);
  assert.equal(structure.lints.shims, 1, 'completed move does not erase its shim debt');
  assert.throws(() => requireFinishedStructure(structure), { code: 'CASE_STUDY_INCOMPLETE' });
});

test('case study binds the selected plan revision separately from the inventoried source [C7,D3]', t => {
  const source = fixture(t), plan = fixture(t);
  const shard = JSON.parse(readFileSync(join(plan.root, 'packages/codemap/data/plan/a.json'), 'utf8'));
  shard.cuts[0].imports = 7;
  put(plan.root, 'packages/codemap/data/plan/a.json', shard);
  runFixtureGit(['add', '.'], { cwd: plan.root });
  runFixtureGit(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'different plan revision'], { cwd: plan.root });
  const metrics = structureMetrics(source.root, { planRoot: plan.root });
  assert.notEqual(metrics.source.head, metrics.planSource.head);
  assert.equal(metrics.planSource.clean, true);
  assert.equal(metrics.plannedCutImports, 7);
  assert.equal(metrics.importCutsLeft, 1, 'different declared cuts do not change the real physical import');
  const bound = metrics.planSource.contentSHA256;
  shard.cuts[0].imports = 8;
  put(plan.root, 'packages/codemap/data/plan/a.json', shard);
  const changed = structureMetrics(source.root, { planRoot: plan.root });
  assert.notEqual(changed.planSource.contentSHA256, bound);
  assert.equal(changed.planSource.head, metrics.planSource.head);
  assert.equal(changed.planSource.clean, false, 'an uncommitted plan edit is not concealed by its HEAD');
});
