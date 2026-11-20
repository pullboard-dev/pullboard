/** @pullboard-test-input packages/gate/tests/io/board/baseline/guard.test.js */
/** Real private submissions keep declared test scanners even when other proofs defer [C7]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  join,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { fileURLToPath } from 'node:url';
import { testClosures } from '../../../../../packages/gate/heavy.js';
import { copyPackageFiles } from '../../../../../packages/runners/index.js';
import { createE2eHelpers } from '../e2e.js';
import { fixtureAdd } from '../testkit.js';
import { fixtureSettledMachine } from '../testkit.js';
import { whenRunnerSettles } from '../runner/local-start.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** The item's shown document once `ready` accepts it, read again on each change to the fixture's local runner folder. */
function whenShown(box, ready, what) {
  return whenRunnerSettles(box.env, async () => {
    const shown = await box.runIn.read(box.web, 'show', String(box.id), '--json', '--no-next');
    const doc = shown.code === 0 ? JSON.parse(shown.out) : null;
    return doc && ready(doc) ? doc : null;
  }, { deadlineMs: 100_000, what }); // budget: hang ceiling for one pulled gate, never a speed assertion.
}

/** Write only inside this test's disposable repository. */
function put(root, path, source) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), source);
}

/**
 * Commit private inputs through their real installed hooks, run in this process while test.inProcessHooks is on (fixture()).
 * Why: each commit started the hook CLI twice as node processes [C7,#10460].
 */
async function commit(box, root, message) {
  box.git(root, 'add', '-A');
  const committed = await box.tryGit(root, 'commit', '-qm', message);
  assert.equal(committed.status, 0, `${committed.stdout}${committed.stderr}`);
}

/** Configure a real scanner using unchanged production lint bytes and the native submit path. */
async function fixture() {
  const box = e2e.project('true');
  fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME, { test: { inProcessHooks: true } });
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  config.lanes.web.owns.push('test/', 'bin/');
  config.affectedTests = 'env -u NODE_TEST_CONTEXT node --test --test-reporter=tap';
  config.submitGate = 'landing';
  config.submitDeferAbove = 1;
  put(box.repo, 'pullboard.json', JSON.stringify(config));
  put(box.repo, 'package.json', '{"type":"module"}\n');
  const toolRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
  const scanner = testClosures(toolRoot).closures.get('packages/gate/tests/io/board/baseline/guard.test.js');
  assert.ok(scanner?.files, scanner?.reason || 'the actual board-file scanner needs a complete committed closure');
  copyPackageFiles(toolRoot, box.repo, { files: scanner.files.filter(file => !file.startsWith('test/') && file !== 'packages/gate/tests/io/board/baseline/guard.test.js') });
  put(box.repo, 'packages/gate/tests/io/board/baseline/guard.test.js', [
    '/** @pullboard-test-input test-tree */',
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    "import { boardFileProblems } from '../../../../../../packages/gate/src/io/board/files.js';",
    "test('no growing file-board debt [G1]', () => {",
    '  const problems = boardFileProblems(process.cwd(), {});',
    "  assert.deepEqual(problems, [], problems.map(p => `${p.path}:${p.line}: ${p.text}`).join('\\n'));",
    '});',
  ].join('\n'));
  put(box.repo, 'web/item.test.js', "import {test} from 'node:test'; test('item works [G1]', () => {});\n");
  await commit(box, box.repo, 'test: accepted repository scanner');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const made = await fixtureAdd(box.runIn, box.repo, 'web', 'test tree guard fixture', '--specs', 'G1',
    '--criterion', 'The item and repository test scanner pass.', '--check', 'node --test web/item.test.js', '--json');
  assert.equal(made.code, 0, made.err + made.out);
  const id = JSON.parse(made.out).item.item_id;
  assert.equal((await box.runIn(box.web, 'claim', String(id))).code, 0);
  return { ...box, id };
}

/** Install only through the affected-tests wrappers, one mode per file (#4939); this helper is not another test root. */
export function installSubmitTestTreeCases(modes = ['large selection', 'full fallback']) {
  for (const mode of modes) {
    test(`submit names the new board-open file and line before ${mode} defers [C7]`, async () => {
      const box = await fixture();
      const source = ["import {test} from 'node:test';", "import {DatabaseSync as openBoard} from 'node:sqlite';",
        "test('file-backed board [G1]', () => { const db = new openBoard('board.sqlite'); db.close(); });", ''].join('\n');
      put(box.web, 'test/new-board.test.js', source);
      if (mode === 'full fallback') put(box.web, 'web/opaque.data', 'unknown input requires full fallback\n');
      await commit(box, box.web, 'test: add an unclassified board-file open');
      // A pulled submit returns queued; the gate's red lands on the item as the job's receipt [C7].
      const result = await box.runIn(box.web, 'submit', String(box.id));
      assert.equal(result.code, 0, result.err + result.out);
      // The pulled gate's receipt names the failing scanner proof; the file and line sit in the runner's full log [C7].
      const red = JSON.stringify((await whenShown(box, doc => /Gate job \S+ red at/u.test(JSON.stringify(doc.thread)), 'the pulled gate red')).thread);
      assert.match(red, /new: proof packages\/gate\/tests\/io\/board\/baseline\/guard\.test\.js \(no growing file-board debt/u, 'the gate names the board-file scanner as the new red');
      const state = await box.runIn(box.web, 'show', String(box.id), '--json');
      assert.equal(state.code, 0, state.err);
      assert.equal(JSON.parse(state.out).item_status, 'claimed', 'no false green submission is recorded');
      put(box.web, 'test/new-board.test.js', source.replace("'board.sqlite'", "':memory:'"));
      await commit(box, box.web, 'test: use a memory-only SQLite fixture');
      const repaired = await box.runIn(box.web, 'submit', String(box.id));
      assert.equal(repaired.code, 0, repaired.err + repaired.out);
      await whenShown(box, doc => doc.item_status === 'submitted', 'the repaired submit');
      const exported = await box.runIn(box.web, 'export', '--json');
      assert.equal(exported.code, 0, exported.err);
      const event = JSON.parse(exported.out).tables.event.findLast(row => row.event_kind === 'submit');
      assert.ok(JSON.parse(event.event_detail).submissionProof.files.includes('packages/gate/tests/io/board/baseline/guard.test.js'));
    });
  }
}
