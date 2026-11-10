/** An attached companion applies three-way from the head it was written against; only a true overlap refuses (#2625, #2087) [C7]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { composeItemPatches } from '../index.js';
import { runFixtureGit } from '../../../apps/cli/tests/fixtures/child.js';

const IDENTITY = ['-c', 'user.name=Companion Test', '-c', 'user.email=companion@example.test', '-c', 'commit.gpgsign=false'];
const FILE = 'web/serve.js';
const lines = (edits = {}) => Array.from({ length: 20 }, (_, index) => edits[index + 1] ?? `export const line${index + 1} = ${index + 1};`).join('\n') + '\n';

/** Commit the file's text and return the commit. */
function commit(root, text) {
  writeFileSync(join(root, FILE), text);
  runFixtureGit(['add', '-A'], { cwd: root });
  runFixtureGit([...IDENTITY, 'commit', '-q', '-m', 'change'], { cwd: root });
  return runFixtureGit(['rev-parse', 'HEAD'], { cwd: root });
}

/** The diff of the working file against HEAD with its blob-id line removed, as a normalized companion carries it. */
function plainDiff(root) {
  return runFixtureGit(['diff', '--', FILE], { cwd: root }).split('\n').filter(line => !line.startsWith('index ')).join('\n') + '\n';
}

/** A companion record bound to the moved head, remembering the head it was written against. */
function record(patch, head, origin) {
  return { key: 'view-half', commit: head, attachedCommit: origin, patch, digest: createHash('sha256').update(patch).digest('hex'),
    author: { agentId: 'view-1', parentSession: null, session: null } };
}

/** Write the companion's change on the origin and capture it as a plain diff. */
function companion(root) {
  writeFileSync(join(root, FILE), lines({ 10: "export const line10 = 'companion';" }));
  const patch = plainDiff(root);
  runFixtureGit(['checkout', '-q', '--', FILE], { cwd: root });
  return patch;
}

test('main changing an unrelated hunk of the companion\'s file still composes, with no coordinator step [C7]', t => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-companion-3way-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root });
  mkdirSync(join(root, 'web'));
  const origin = commit(root, lines());
  const patch = companion(root);
  // Line 12 sits inside the companion's context, so a plain apply refuses; the lines between are unchanged.
  const head = commit(root, lines({ 12: "export const line12 = 'main';" }));
  const composed = composeItemPatches(root, { item_commit: head }, [record(patch, head, origin)]);
  const text = runFixtureGit(['show', `${composed.commit}:${FILE}`], { cwd: root });
  assert.match(text, /line10 = 'companion'/u);
  assert.match(text, /line12 = 'main'/u);
  assert.deepEqual([...composed.paths], [FILE]);
});

test('a true overlap is refused, naming the conflicting file and hunk [C7]', t => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-companion-3way-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root });
  mkdirSync(join(root, 'web'));
  const origin = commit(root, lines());
  const patch = companion(root);
  const head = commit(root, lines({ 10: "export const line10 = 'main';" }));
  assert.throws(() => composeItemPatches(root, { item_commit: head }, [record(patch, head, origin)]), error => error.code === 'ITEM_PATCH'
    && /conflicts with the head: file web\/serve\.js; hunk @@ -7,7 \+7,7 @@/u.test(error.message));
});

test('matching deletions are clean when another companion change remains [C7]', t => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-companion-delete-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root });
  mkdirSync(join(root, 'web'));
  writeFileSync(join(root, 'web/other.js'), 'export const other = 1;\n');
  const origin = commit(root, lines());
  rmSync(join(root, FILE));
  writeFileSync(join(root, 'web/other.js'), 'export const other = 2;\n');
  const patch = runFixtureGit(['diff', '--', 'web'], { cwd: root }).split('\n').filter(line => !line.startsWith('index ')).join('\n') + '\n';
  runFixtureGit(['checkout', '-q', '--', 'web'], { cwd: root });
  rmSync(join(root, FILE));
  runFixtureGit(['add', '-A'], { cwd: root });
  runFixtureGit([...IDENTITY, 'commit', '-q', '-m', 'matching deletion'], { cwd: root });
  const head = runFixtureGit(['rev-parse', 'HEAD'], { cwd: root });
  const composed = composeItemPatches(root, { item_commit: head }, [record(patch, head, origin)]);
  assert.equal(runFixtureGit(['ls-tree', composed.commit, '--', FILE], { cwd: root }), '');
  assert.match(runFixtureGit(['show', `${composed.commit}:web/other.js`], { cwd: root }), /other = 2/u);
});

test('an executable-bit change survives an unrelated content merge [C7]', t => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-companion-mode-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root });
  mkdirSync(join(root, 'web'));
  const origin = commit(root, lines());
  writeFileSync(join(root, FILE), lines({ 10: "export const line10 = 'companion';" }));
  chmodSync(join(root, FILE), 0o755);
  const patch = plainDiff(root);
  runFixtureGit(['checkout', '-q', '--', FILE], { cwd: root });
  const head = commit(root, lines({ 12: "export const line12 = 'main';" }));
  const composed = composeItemPatches(root, { item_commit: head }, [record(patch, head, origin)]);
  assert.match(runFixtureGit(['ls-tree', composed.commit, '--', FILE], { cwd: root }), /^100755 blob /u);
  const text = runFixtureGit(['show', `${composed.commit}:${FILE}`], { cwd: root });
  assert.match(text, /line10 = 'companion'/u);
  assert.match(text, /line12 = 'main'/u);
});
