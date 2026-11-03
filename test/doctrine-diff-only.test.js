/** Submit's doctrine step reads only the changed files, in-process, and still refuses a rise [C7,D1,D3]. */
import { holdDoctrineAsync, submitRulesNarrowable } from '../packages/doctrine/index.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { runFixtureGit } from './fixture-child.js';

const sandboxes = [];
after(() => { for (const directory of sandboxes) rmSync(directory, { recursive: true, force: true }); });

const SCAN = pathToFileURL(new URL('../bin/checks/scan.js', import.meta.url).pathname).href;
const CHECK = `#!/usr/bin/env node
/** A file-local fixture check built on the real walk. @file-local */
import { readText, report, rootOf, walk } from '${SCAN}';
const problems = [];
for (const path of walk(rootOf(), /\\.js$/u)) readText(rootOf(), path).split('\\n').forEach((text, at) => { if (text.includes('TODO')) problems.push({ path, line: at + 1, text: 'a TODO marker' }); });
report(problems);
`;
const DOCTRINE = '# Doctrine\n\n## Q · Quality\n- Q1 [approved, must] No TODO markers. | gate: check node bin/checks/todo.js | count: 2\n';

/** A real repo whose main carries the rule and two TODOs in one file, with many untouched files. */
function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-doctrine-fast-')));
  sandboxes.push(root);
  const git = (...args) => runFixtureGit(args, { cwd: root });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'a');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(root, 'bin', 'checks'), { recursive: true });
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'bin', 'checks', 'todo.js'), CHECK);
  writeFileSync(join(root, 'DOCTRINE.md'), DOCTRINE);
  writeFileSync(join(root, 'src', 'old.js'), '// TODO one\n// TODO two\n');
  writeFileSync(join(root, 'src', 'clean.js'), 'export const clean = 1;\n');
  for (let at = 0; at < 100; at += 1) writeFileSync(join(root, 'src', `bulk${at}.js`), `export const bulk${at} = ${at};\n`);
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: main');
  return { root, git, main: git('rev-parse', 'HEAD') };
}

/** Commit one file change and return the options for a hold of it. */
function change(box, file, text) {
  writeFileSync(join(box.root, file), text);
  box.git('add', '-A');
  box.git('commit', '-q', '-m', 'feat: change');
  return { mainCommit: box.main, commit: box.git('rev-parse', 'HEAD'), fast: true };
}

test('a one-file change holds doctrine in under 2 s over the changed file only [C7]', async () => {
  const box = repo();
  assert.equal(submitRulesNarrowable(box.root, box.main, 'DOCTRINE.md'), true);
  const options = change(box, 'src/clean.js', 'export const clean = 2;\n');
  const started = performance.now();
  const results = await holdDoctrineAsync(box.root, options);
  assert.ok(performance.now() - started < 2000, 'the hold finishes inside 2 s'); // budget: declared by item 2532's frozen bar
  assert.deepEqual(results.map(row => [row.id, row.state, row.count, row.problems.length]), [['Q1', 'holding', 2, 0]]);
});

test('a TODO added to a changed file is refused naming file:line [C7,D1,D3]', async () => {
  const box = repo();
  const options = change(box, 'src/clean.js', 'export const clean = 1;\n// TODO new\n');
  await assert.rejects(holdDoctrineAsync(box.root, options), error => error.code === 'RATCHET_ROSE'
    && error.message.includes('Q1 No TODO markers') && error.message.includes('src/clean.js:2:'));
});

test('removing a problem lowers the count and an old problem in a changed file is not new [C7,D1]', async () => {
  const box = repo();
  const lowered = change(box, 'src/old.js', '// TODO one\n');
  assert.equal((await holdDoctrineAsync(box.root, lowered))[0].count, 1);
  const moved = change(box, 'src/old.js', 'export const pad = 0;\n// TODO one\n');
  assert.equal((await holdDoctrineAsync(box.root, moved))[0].state, 'holding', 'a moved problem is not new');
});

test('a rule that is not file-local keeps the established full run [C7]', () => {
  const box = repo();
  writeFileSync(join(box.root, 'DOCTRINE.md'), DOCTRINE.replace('node bin/checks/todo.js', 'grep -rn TODO src'));
  box.git('add', '-A');
  box.git('commit', '-q', '-m', 'chore: grep rule');
  assert.equal(submitRulesNarrowable(box.root, box.git('rev-parse', 'HEAD'), 'DOCTRINE.md'), false);
});
