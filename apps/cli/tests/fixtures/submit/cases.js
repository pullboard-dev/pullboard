/** @pullboard-test-input source-tree */
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
import { testClosures } from '../../../../../packages/gate/index.js';
import { copyPackageFiles } from '../../../../../packages/runners/index.js';
import { createE2eHelpers } from '../e2e.js';
import { fixtureAdd } from '../testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** Write only inside this test's disposable repository. */
function put(root, path, source) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), source);
}

/** Commit private inputs through their real installed hooks. */
function commit(box, root, message) {
  box.git(root, 'add', '-A');
  box.git(root, 'commit', '-qm', message);
}

/** Configure a real scanner using unchanged production lint bytes and the native submit path. */
function fixture() {
  const box = e2e.project('true');
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
    "import { boardFileProblems } from '../../../../../packages/gate/src/io/board/files.js';",
    "test('no growing file-board debt [G1]', () => {",
    '  const problems = boardFileProblems(process.cwd(), {});',
    "  assert.deepEqual(problems, [], problems.map(p => `${p.path}:${p.line}: ${p.text}`).join('\\n'));",
    '});',
  ].join('\n'));
  put(box.repo, 'web/item.test.js', "import {test} from 'node:test'; test('item works [G1]', () => {});\n");
  commit(box, box.repo, 'test: accepted repository scanner');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const made = fixtureAdd(box.run, box.repo, 'web', 'test tree guard fixture', '--specs', 'G1',
    '--criterion', 'The item and repository test scanner pass.', '--check', 'node --test web/item.test.js', '--json');
  assert.equal(made.code, 0, made.err + made.out);
  const id = JSON.parse(made.out).item.item_id;
  assert.equal(box.run(box.web, 'claim', String(id)).code, 0);
  return { ...box, id };
}

/** Install only through the frozen affected-tests wrapper; this helper is not another test root. */
export function installSubmitTestTreeCases() {
  for (const mode of ['large selection', 'full fallback']) {
    test(`submit names the new board-open file and line before ${mode} defers [C7]`, () => {
      const box = fixture();
      const source = ["import {test} from 'node:test';", "import {DatabaseSync as openBoard} from 'node:sqlite';",
        "test('file-backed board [G1]', () => { const db = new openBoard('board.sqlite'); db.close(); });", ''].join('\n');
      put(box.web, 'test/new-board.test.js', source);
      if (mode === 'full fallback') put(box.web, 'web/opaque.data', 'unknown input requires full fallback\n');
      commit(box, box.web, 'test: add an unclassified board-file open');
      const result = box.run(box.web, 'submit', String(box.id));
      assert.equal(result.code, 1, result.err + result.out);
      assert.match(result.err + result.out, /test\/new-board\.test\.js:3:/u, 'native submit names the actual lint location');
      assert.match(result.err + result.out, /unclassified file board open/u);
      const state = box.run(box.web, 'show', String(box.id), '--json');
      assert.equal(state.code, 0, state.err);
      assert.equal(JSON.parse(state.out).item_status, 'claimed', 'no false green submission is recorded');
      put(box.web, 'test/new-board.test.js', source.replace("'board.sqlite'", "':memory:'"));
      commit(box, box.web, 'test: use a memory-only SQLite fixture');
      const repaired = box.run(box.web, 'submit', String(box.id));
      assert.equal(repaired.code, 0, repaired.err + repaired.out);
      const exported = box.run(box.web, 'export', '--json');
      assert.equal(exported.code, 0, exported.err);
      const event = JSON.parse(exported.out).tables.event.findLast(row => row.event_kind === 'submit');
      assert.ok(JSON.parse(event.event_detail).submissionProof.files.includes('packages/gate/tests/io/board/baseline/guard.test.js'));
    });
  }
}
