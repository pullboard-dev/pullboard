/** @pullboard-test-input apps/cli/tests/fixtures/template.js apps/cli/tests/fixtures/e2e.js */
/** The fixture project is built once per process and each case gets its own copy [C7,#8088]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { join } from 'node:path';
import { createE2eHelpers } from './fixtures/e2e.js';
import { templateOrigins } from './fixtures/template.js';
import { templateStats } from './fixtures/template.js';

/** Every file under a directory except git objects, as absolute paths. */
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return path.endsWith('/.git/objects') ? [] : files(path);
    return entry.isFile() ? [path] : [];
  });
}

test('cli.template.the-project-template-is-built-once-per: the project template is built once per process and later cases copy it [C7,#8088]', t => {
  const first = createE2eHelpers();
  const second = createE2eHelpers();
  const third = createE2eHelpers();
  t.after(first.cleanup); t.after(second.cleanup); t.after(third.cleanup);
  const before = templateStats();
  first.project('true');
  second.project('true');
  third.project('true');
  const after = templateStats();
  assert.equal(after.builds - before.builds, 1, 'one build serves three cases');
  assert.equal(after.copies - before.copies, 2, 'the other two cases copy the template');
  assert.equal(after.templates, 1, 'the process holds one template for the shape');
});

test('cli.template.a-case-with-another-gate-builds-its: a case with another gate builds its own template; a copy keeps its own gate [C7,#8088]', t => {
  const a = createE2eHelpers();
  const b = createE2eHelpers();
  t.after(a.cleanup); t.after(b.cleanup);
  const red = a.project('test ! -f RED');
  const green = b.project('true');
  assert.equal(JSON.parse(readFileSync(join(red.repo, 'pullboard.json'), 'utf8')).gate, 'test ! -f RED');
  assert.equal(JSON.parse(readFileSync(join(green.repo, 'pullboard.json'), 'utf8')).gate, 'true');
});

test('cli.template.a-copied-project-is-isolated-its-paths: a copied project is isolated: its paths, seat and writes belong to it alone [C7,#8088]', t => {
  const first = createE2eHelpers();
  const second = createE2eHelpers();
  t.after(first.cleanup); t.after(second.cleanup);
  const a = first.project('true');
  const b = second.project('true');
  assert.notEqual(a.dir, b.dir);
  writeFileSync(join(a.repo, 'only-in-a.txt'), 'a\n');
  a.git(a.repo, 'add', 'only-in-a.txt');
  a.git(a.repo, 'commit', '-q', '-m', 'chore: only the first case has this [G1]');
  assert.equal(b.tryGit(b.repo, 'cat-file', '-e', 'HEAD:only-in-a.txt').status === 0, false, 'the second case never sees the first case commit');
  assert.equal(a.git(a.repo, 'rev-list', '--count', 'HEAD').trim(), '2');
  assert.equal(b.git(b.repo, 'rev-list', '--count', 'HEAD').trim(), '1');
  // Tracked files keep the path their commit holds; git metadata, the board and the machine home name only the copy.
  const stored = [...files(join(b.repo, '.git')), ...files(join(b.dir, 'machine-home')), join(b.web, '.git')];
  for (const origin of templateOrigins()) for (const file of stored) assert.equal(readFileSync(file).includes(origin), false, `${file} still names the template directory`);
  const whoami = b.run(b.web, 'whoami');
  assert.equal(whoami.code, 0, whoami.err);
  assert.match(whoami.out, new RegExp(`web-1.*${b.web.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'), 'the copied seat reports its own worktree path');
  assert.equal(a.git(a.web, 'rev-parse', '--show-toplevel').trim(), a.web);
  assert.equal(b.git(b.web, 'rev-parse', '--show-toplevel').trim(), b.web);
});

test('cli.template.the-template-is-built-once-and-each: clause 1: the template is built once and each later case gets a copy-on-write clone, or a copy where clones are unsupported [C7,#8319]', t => {
  const boxes = [createE2eHelpers(), createE2eHelpers(), createE2eHelpers()];
  for (const box of boxes) t.after(box.cleanup);
  const before = templateStats();
  for (const box of boxes) box.project('test -f CLONED');
  const after = templateStats();
  assert.equal(after.builds - before.builds, 1, 'one build serves three cases');
  assert.equal(after.copies - before.copies, 2, 'the other two cases take the template');
  assert.ok(['clone', 'copy'].includes(after.method), after.method);
  // A clone the file system refused falls back to a copy, so a clone count is only owed where cloning works.
  if (after.method === 'clone') assert.ok(after.clones - before.clones >= 2, 'every taken template is a clone');
  if (process.platform === 'darwin') assert.equal(after.method, 'clone', 'APFS clones');
});

test('cli.template.two-cases-writing-to-their-clones-never: clause 2: two cases writing to their clones never see each other files [C7,#8319]', t => {
  const [builder, first, second] = [createE2eHelpers(), createE2eHelpers(), createE2eHelpers()];
  t.after(builder.cleanup); t.after(first.cleanup); t.after(second.cleanup);
  builder.project('test -f WRITES'); // builds the template, so both cases below are clones of it
  const a = first.project('test -f WRITES');
  const b = second.project('test -f WRITES');
  const shared = join('.git', 'description'); // a file both clones took from the template's blocks
  const original = readFileSync(join(b.repo, shared), 'utf8');
  writeFileSync(join(a.repo, shared), 'only the first case\n');
  writeFileSync(join(a.repo, 'only-in-a.txt'), 'a\n');
  writeFileSync(join(b.repo, 'only-in-b.txt'), 'b\n');
  assert.equal(readFileSync(join(b.repo, shared), 'utf8'), original, 'an overwrite in one clone leaves the other clone file as it was');
  assert.equal(readdirSync(b.repo).includes('only-in-a.txt'), false);
  assert.equal(readdirSync(a.repo).includes('only-in-b.txt'), false);
});
