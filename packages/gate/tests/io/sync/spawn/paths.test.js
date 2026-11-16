/** The selector counts the CLI entry only where this tree's CLI is launched, not where its path is named [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { fixtureCommittedGraph } from '../../../fixtures/testkit.js';
import { selectAffectedTests } from '../../../../index.js';

/** Make a real committed ES-module graph with a CLI, a launcher and the modules the CLI imports. */
function graph(t) {
  const box = fixtureCommittedGraph('pullboard-spawn-paths-');
  t.after(() => rmSync(box.root, { recursive: true, force: true }));
  const { put } = box;
  put('package.json', '{"type":"module"}\n');
  put('apps/cli/pullboard.js', "import '../../src/cli.js';\n");
  put('src/cli.js', "import '../apps/cli/src/io/cockpit.js';\n");
  put('apps/cli/src/io/cockpit.js', 'export const version = 1;\n');
  // A product module that only names the entry path as text, as seven package modules do.
  put('src/names-cli.js', "export const ENTRY = 'apps/cli/pullboard.js';\nexport const run = root => root;\n");
  // A test the changes below never reach, so a focused selection is never the whole suite.
  put('src/other.js', 'export const other = 1;\n');
  put('test/other.test.js', "import '../src/other.js';\n");
  return box;
}

test('clause 1: a product module that only names apps/cli/pullboard.js no longer puts the CLI into the closure of a test that imports it [C7]', (t) => {
  const box = graph(t);
  box.put('test/names-only.test.js', "import { ENTRY } from '../src/names-cli.js';\nvoid ENTRY;\n");
  box.put('test/unrelated.test.js', "import '../apps/cli/src/io/cockpit.js';\n");
  const base = box.commit();
  box.put('apps/cli/src/io/cockpit.js', 'export const version = 2;\n');
  const selected = selectAffectedTests(box.root, { base, commit: box.commit() });
  assert.equal(selected.full, false);
  assert.ok(selected.files.includes('test/unrelated.test.js'), 'a test importing the changed module is selected');
  assert.ok(!selected.files.includes('test/names-only.test.js'), 'a test whose only link is a product module naming the path is not');
});

test('clause 1: a test that launches the CLI from the repo root still has the CLI in its closure [C7]', (t) => {
  const box = graph(t);
  box.put('test/from-root.test.js', "import { run } from '../src/names-cli.js';\nconst ROOT = process.cwd();\nrun(ROOT);\n");
  box.put('test/direct-cli.test.js', "const BIN = '../apps/cli/pullboard.js';\nvoid BIN;\n");
  const base = box.commit();
  box.put('apps/cli/src/io/cockpit.js', 'export const version = 2;\n');
  const selected = selectAffectedTests(box.root, { base, commit: box.commit() });
  assert.equal(selected.full, false, selected.reason);
  assert.ok(selected.files.includes('test/from-root.test.js'), 'a test handing the repo root to a launcher module is selected by what the CLI imports');
  assert.ok(selected.files.includes('test/direct-cli.test.js'), 'a test naming the entry itself is still selected');
});
