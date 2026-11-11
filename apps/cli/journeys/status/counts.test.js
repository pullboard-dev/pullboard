import { viewApiPorts } from '../../../view/index.js';
import { apiBoardOpeners } from '../../tests/fixtures/board.js';
import { gateRuns as nativeGateRuns } from '../../../../packages/flakes/index.js';
import { recordGateRun as nativeRecordGateRun } from '../../../../packages/flakes/index.js';
/** Rule proof counts come from trunk gate evidence, not a row merely naming a test [S1,A1,A2]. */
import assert from 'node:assert/strict';
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import {
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { serveApi } from '../../../../packages/api/index.js';
import { refusalDocument } from '../../index.js';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { main } from '../../tests/fixtures/native.js';
import { receiptBody } from '../../../../packages/gate/index.js';
import { clearProofCounters } from '../../../../packages/verify/index.js';
import {
  ruleProofCounts,
  ruleProofWindow,
} from '../../../../packages/verify/index.js';
import { loadSpec } from '../../../../packages/spec/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fetchFresh } from '../../tests/fixtures/http.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';

const helpers = createE2eHelpers();
test.after(helpers.cleanup);
const GATE = 'node --test test/proven.test.js test/both.test.js';
const SPEC = `# Rule proof fixture

## P · Rules
- P1 [approved, must] The first test has proof. | gate: test/proven.test.js
- P2 [approved, must] An unexecuted test has no proof. | gate: test/unproven.test.js
- P3 [approved, must] A recent trunk failure is remembered. | gate: test/contradicted.test.js
- P4 [approved, must] Current green does not erase a recent red. | gate: test/both.test.js
- P5 [approved, must] A review is not machine evidence. | gate: review
- P6 [approved, must] An ungated row remains visible.
- P7 [draft, aim] A draft is outside approved counts. | gate: test/draft.test.js
`;

/** A real private Git/SQLite project; historical receipts below are seeded fixture records, not claimed executions. */
function fixture(spec = SPEC) {
  const box = helpers.sandbox();
  const root = join(box.dir, 'repo');
  mkdirSync(root);
  box.git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'SPEC.md'), spec);
  assert.equal(box.run(root, 'init').code, 0);
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ ...helpers.CONFIG, gate: GATE }));
  mkdirSync(join(root, 'test'), { recursive: true });
  for (const file of ['proven', 'unproven', 'contradicted', 'both', 'draft']) {
    writeFileSync(join(root, `test/${file}.test.js`), `import { test } from 'node:test';\ntest('${file}', () => {});\n`);
  }
  box.git(root, 'add', '-A');
  box.git(root, 'commit', '-q', '-m', 'chore(fixture): initialize rule proof fixture');
  const original = box.git(root, 'rev-parse', 'HEAD').trim();
  writeFileSync(join(root, 'advance.txt'), 'a new trunk tree\n');
  box.git(root, 'add', 'advance.txt');
  box.git(root, 'commit', '-q', '-m', 'chore(fixture): advance the rule proof trunk');
  const head = box.git(root, 'rev-parse', 'HEAD').trim();
  const board = openBoard(join(root, '.git', 'pullboard', 'board.sqlite'), undefined, { isMain: true });
  return { ...box, root, board, original, head };
}

/** Append a bound, schema-valid historical fixture receipt through the board's ordinary recording operation. */
function seedRun(box, { head = box.head, main = head, green = true, days = 0, command = GATE, failures = [], kind = 'gate' } = {}) {
  const receipt = { version: 1, id: randomUUID(), kind, head, main,
    tree: box.git(box.root, 'rev-parse', `${head}^{tree}`).trim(),
    command: createHash('sha256').update(command).digest('hex'), green, failures,
    at: new Date(Date.now() - days * 86_400_000).toISOString(), load: { average: [0, 0, 0], cpus: 1, freeMB: 100 } };
  const folder = join(box.root, '.git', 'pullboard', 'gate-receipts');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${receipt.id}.json`), receiptBody(receipt));
  nativeRecordGateRun(box.board, { agentId: 'coordinator', receipt, lane: 'web' });
}

/** Read the public status JSON and actual authenticated HTTP state for the same board. */
async function documents(box, api) {
  const result = box.run(box.root, 'status', '--json');
  assert.equal(result.code, 0, result.err);
  const headers = { 'x-pullboard-key': new URL(api.url).searchParams.get('k') };
  const origin = new URL(api.url).origin;
  const response = await fetchFresh(`${origin}/api/v1/boards/${store.boardId(box.board)}/state`, { headers });
  assert.equal(response.status, 200);
  const body = await response.json();
  return [JSON.parse(result.out), body.state];
}

test('the server reports how many rule rows are proven, unproven and contradicted [S1,A1,A2]', async (t) => {
  const box = fixture();
  const empty = fixture('# No approved rules\n');
  t.after(() => { store.closeBoard(box.board); store.closeBoard(empty.board); });
  seedRun(box, { head: box.original }); // Green on the previous tree is not current proof.
  seedRun(box, { command: 'true' }); // A different opaque green command proves none of these test files.
  seedRun(box, { green: false, days: 2, failures: [
    { file: 'test/contradicted.test.js', name: 'contradicted' },
    { file: 'test/contradicted.test.js', name: 'another failure in the same row' },
    { file: 'test/both.test.js', name: 'both' },
  ] });
  seedRun(box, { green: false, days: 8, failures: [{ file: 'test/unproven.test.js', name: 'too old' }] });
  seedRun(box, { green: false, main: box.original, failures: [{ file: 'test/unproven.test.js', name: 'branch failure' }] });
  const api = await serveApi({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument, runCommand: main, isMain: true,
    projects: () => [{ root: box.root, name: 'Rule proof fixture' }, { root: empty.root, name: 'Empty rule fixture' }] });
  t.after(() => api.close());
  const before = await documents(box, api);
  const unproven = { approved: 6, gated: 5, ungated: 1, proven: 0, unproven: 5, contradicted: 2 };
  assert.deepEqual(before.map(document => document.ruleCounts), [unproven, unproven]);
  seedRun(box);
  const after = await documents(box, api);
  const proven = { ...unproven, proven: 2, unproven: 3 };
  assert.deepEqual(after.map(document => document.ruleCounts), [proven, proven], 'current green and this-week red are independent counts; API event invalidation refreshes both');
  const none = { approved: 0, gated: 0, ungated: 0, proven: 0, unproven: 0, contradicted: 0 };
  assert.deepEqual((await documents(empty, api)).map(document => document.ruleCounts), [none, none]);
});

test('a read-only legacy board retains recent red counts and exact expiry without warming proof indexes [S1,A1,A2,C7]', (t) => {
  const box = fixture();
  t.after(() => store.closeBoard(box.board));
  seedRun(box, { green: false, days: 2,
    failures: [{ file: 'test/contradicted.test.js', name: 'legacy recent red' }] });
  seedRun(box, { green: false, days: 1, kind: 'submit',
    failures: [{ file: 'test/unproven.test.js', name: 'submission is not trunk gate proof' }] });
  seedRun(box);
  const runs = nativeGateRuns(box.board);
  const red = runs.find(run => run.kind === 'gate' && !run.green);
  const submit = runs.find(run => run.kind === 'submit');
  assert.ok(red && submit, 'the private board has validated historical receipts of both kinds');
  // A pre-projection board or a disposable cache loss keeps its authoritative native history.
  clearProofCounters(box.board);
  const rows = loadSpec(box.root, { spec: 'SPEC.md' }).rows;
  const snapshot = box.board.db.prepare('SELECT event_id,event_detail FROM event ORDER BY event_id').all();
  const changes = box.board.db.prepare('SELECT total_changes() AS n').get().n;
  box.board.db.exec('PRAGMA query_only=ON');
  const week = 7 * 86_400_000;
  const end = Date.parse(red.at) + week;
  const atBoundary = ruleProofCounts(box.root, box.board, rows, { now: end });
  assert.equal(atBoundary.contradicted, 1, 'recent native trunk red remains visible at the inclusive seven-day boundary');
  assert.equal(atBoundary.proven, 0, 'missing coverage projection never invents green proof');
  assert.deepEqual(ruleProofWindow(box.board, new Date(end).toISOString()), {
    events: [red.eventId, submit.eventId], nextExpiry: new Date(end + 1).toISOString(),
  }, 'the window deliberately retains submit-red invalidation while proof counts exclude it');
  const expired = ruleProofCounts(box.root, box.board, rows, { now: end + 1 });
  assert.equal(expired.contradicted, 0, 'the native red expires one millisecond after seven days without a write');
  assert.deepEqual(ruleProofWindow(box.board, new Date(end + 1).toISOString()), {
    events: [submit.eventId], nextExpiry: new Date(Date.parse(submit.at) + week + 1).toISOString(),
  });
  assert.equal(box.board.db.prepare('SELECT total_changes() AS n').get().n, changes);
  assert.deepEqual(box.board.db.prepare('SELECT event_id,event_detail FROM event ORDER BY event_id').all(), snapshot);
});

/** Simulate only a private reader's parser context after imports; the child still runs the real current Node. */
function simulatedReaderContext(box, identity) {
  const script = `
import * as store from ${JSON.stringify(new URL('../../../../packages/store/index.js', import.meta.url).href)};
import { openBoard } from ${JSON.stringify(new URL("../../../lib/src/logic/native.js", import.meta.url).href)};
import { ruleProofCounts } from ${JSON.stringify(new URL('../../../../packages/verify/src/io/rule/proof/counts.js', import.meta.url).href)};
import { loadSpec } from ${JSON.stringify(new URL('../../../../packages/spec/src/io/main.js', import.meta.url).href)};
const root = ${JSON.stringify(box.root)};
const actualRuntime = { execPath: process.execPath, version: process.version };
const board = openBoard(${JSON.stringify(join(box.root, '.git', 'pullboard', 'board.sqlite'))}, undefined, { isMain: false });
const rows = loadSpec(root, { spec: 'SPEC.md' }).rows;
const simulated = ${JSON.stringify(identity)};
Object.defineProperty(process, 'execPath', { value: simulated.execPath });
Object.defineProperty(process, 'version', { value: simulated.version });
board.db.exec('PRAGMA query_only=ON');
try {
  const before = board.db.prepare('SELECT total_changes() AS n').get().n;
  const ruleCounts = ruleProofCounts(root, board, rows);
  const after = board.db.prepare('SELECT total_changes() AS n').get().n;
  console.log(JSON.stringify({ actualRuntime, simulated, ruleCounts, writes: after - before }));
} finally { store.closeBoard(board); }
`;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script], {
    cwd: box.root, env: box.env, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.failure ?? result.stderr);
  const document = JSON.parse(result.stdout.trim());
  assert.deepEqual(document.actualRuntime, { execPath: process.execPath, version: process.version },
    'this fixture simulates read-context properties; it does not claim an alternate runtime executed');
  assert.equal(document.writes, 0);
  return document.ruleCounts;
}

test('literal-node rule proof survives simulated reader runtime changes while absolute-node proof stays path-bound [S1,A1,A2,C7]', (t) => {
  const literal = fixture();
  const absolute = fixture();
  t.after(() => { store.closeBoard(literal.board); store.closeBoard(absolute.board); });
  seedRun(literal);
  const changedContext = { execPath: process.execPath + '.other-installation', version: 'v24.0.0' };
  assert.equal(simulatedReaderContext(literal, changedContext).proven, 2,
    'literal node coverage is independent of the reader installation path and supported version');
  const command = JSON.stringify(process.execPath) + ' --test test/proven.test.js test/both.test.js';
  writeFileSync(join(absolute.root, 'pullboard.json'), JSON.stringify({ ...helpers.CONFIG, gate: command }));
  absolute.git(absolute.root, 'add', 'pullboard.json');
  absolute.git(absolute.root, 'commit', '-q', '-m', 'chore(fixture): configure absolute Node gate');
  absolute.head = absolute.git(absolute.root, 'rev-parse', 'HEAD').trim();
  seedRun(absolute, { command });
  const samePath = { execPath: process.execPath, version: 'v24.0.0' };
  assert.equal(simulatedReaderContext(absolute, samePath).proven, 2,
    'an unchanged absolute command path keeps its proof across reader version labels');
  assert.equal(simulatedReaderContext(absolute, changedContext).proven, 0,
    'a reader with another executable path does not reinterpret the absolute command');
  assert.equal(simulatedReaderContext(literal, changedContext).proven, 2,
    'separate absolute-command records never downgrade the literal-node board');
});

test('a gate command with npm flags counts as opaque [S1,A1,A2]', async (t) => {
  const script = 'node --test test/proven.test.js';
  const scripts = { test: script, 'integration-test': script, '--if-present': script, '--silent': script, '-s': script, '--': script };
  const cases = [
    ['npm test', 1],
    ['npm run test', 1],
    ["npm run 'integration-test'", 1],
    ['npm run test && node --test test/proven.test.js', 1],
    ['npm run --if-present', 0],
    ['npm run --silent', 0],
    ['npm run -s', 0],
    ['npm run --', 0],
    ["npm run '--if-present'", 0],
    ['npm run --if-present test', 0],
    ['npm run test --if-present', 0],
    ['npm --silent run test', 0],
    ['npm test --if-present', 0],
    ['npm run test -- --test-name-pattern=proven', 0],
    ['npm run --if-present && node --test test/proven.test.js', 0],
    ['node --test test/proven.test.js && npm run --silent', 0],
  ];
  for (const [command, proven] of cases) {
    const box = fixture();
    t.after(() => store.closeBoard(box.board));
    writeFileSync(join(box.root, 'package.json'), JSON.stringify({ private: true, type: 'module', scripts }));
    writeFileSync(join(box.root, 'pullboard.json'), JSON.stringify({ ...helpers.CONFIG, gate: command }));
    box.git(box.root, 'add', '-A');
    box.git(box.root, 'commit', '-q', '-m', 'chore(fixture): configure the npm gate');
    box.head = box.git(box.root, 'rev-parse', 'HEAD').trim();
    // These historical records are seeded classification inputs, never a claim that npm ran the script.
    seedRun(box, { command });
    const api = await serveApi({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument, runCommand: main, isMain: true,
      projects: () => [{ root: box.root, name: 'Npm gate proof fixture' }] });
    try {
      const seen = await documents(box, api);
      const expected = { approved: 6, gated: 5, ungated: 1, proven, unproven: 5 - proven, contradicted: 0 };
      assert.deepEqual(seen.map(document => document.ruleCounts), [expected, expected], command);
    } finally { await api.close(); }
  }
});
