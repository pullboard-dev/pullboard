/** Codemap, doctrine and sandbox throwaway folders are created under the scratch root [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { withCellLintParser } from '../../../../packages/codemap/index.js';
import { holdDoctrine } from '../../../../packages/doctrine/index.js';
import { captureTestRuntimes } from '../../../../packages/sandbox/light.js';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';
import { fixtureCommittedGraph } from '../../tests/fixtures/testkit.js';

/** Runs the body with PULLBOARD_SCRATCH set (or cleared), then restores it. */
function withScratch(value, body) {
  const before = process.env.PULLBOARD_SCRATCH;
  if (value === undefined) delete process.env.PULLBOARD_SCRATCH; else process.env.PULLBOARD_SCRATCH = value;
  try { return body(); } finally { if (before === undefined) delete process.env.PULLBOARD_SCRATCH; else process.env.PULLBOARD_SCRATCH = before; }
}

/** A private box with an empty scratch folder inside it. */
function box(t) {
  const { root } = privateFixtureFiles('pullboard-scratch-tools-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scratch = join(root, 'scratch');
  mkdirSync(scratch);
  return { root, scratch: realpathSync(scratch) };
}

/** Runs a parse inside a cell lint parser and returns the parser folder seen in `parent` while it ran. */
function parserFolder(parent) {
  return withCellLintParser(parse => {
    parse(['export const one = 1;']);
    return readdirSync(parent).find(name => name.startsWith('pullboard-cell-parser-'));
  });
}

/** A repository whose submit rule records the folder every check runs in. */
function doctrineRepo(log, t) {
  const graph = fixtureCommittedGraph('pullboard-scratch-tools-repo-');
  t.after(() => rmSync(graph.root, { recursive: true, force: true }));
  graph.put('probe.js', `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(log)}, process.cwd() + '\\n');\n`);
  graph.put('DOCTRINE.md', '## C · Code\n- C1 [approved, must] Probe. | gate: check node probe.js | count: 0\n');
  const frozen = graph.commit();
  graph.put('a.txt', 'a\n');
  return { repo: graph.root, frozen, head: graph.commit() };
}

test('with scratch set, codemap parse, doctrine base and sandbox runtime folders are created under it [C7]', t => {
  const { root, scratch } = box(t);
  assert.ok(withScratch(scratch, () => parserFolder(scratch)), 'the parser folder is under scratch');
  const log = join(root, 'probe.log');
  writeFileSync(log, '');
  const { repo, frozen, head } = doctrineRepo(log, t);
  withScratch(scratch, () => holdDoctrine(repo, { mainCommit: frozen, commit: head, timeoutMs: 60000 }));
  const ran = readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => realpathSync(line));
  assert.ok(ran.some(line => line.startsWith(`${scratch}/pullboard-doctrine-base-`)), ran.join('\n'));
  const capture = withScratch(scratch, () => captureTestRuntimes({}));
  t.after(() => capture.finish());
  assert.ok(realpathSync(capture.env.PULLBOARD_RUNTIME_CAPTURE_DIR).startsWith(`${scratch}/pullboard-test-runtimes-`), capture.env.PULLBOARD_RUNTIME_CAPTURE_DIR);
  assert.ok(existsSync(capture.env.PULLBOARD_RUNTIME_CAPTURE_DIR));
});

test('unset: codemap parse and sandbox runtime folders use os.tmpdir() as before [C7]', t => {
  assert.ok(withScratch(undefined, () => parserFolder(tmpdir())), 'the parser folder is under os.tmpdir()');
  const capture = withScratch(undefined, () => captureTestRuntimes({}));
  t.after(() => capture.finish());
  assert.ok(realpathSync(capture.env.PULLBOARD_RUNTIME_CAPTURE_DIR).startsWith(realpathSync(tmpdir())));
});
