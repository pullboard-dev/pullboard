/** @pullboard-world-pin builds real git repositories in a private root; each composition is a real merge of two branches. */
/** A retained source composition keeps the work's thrown error as the cause of its unknown-custody refusal, and folders stay or go as before [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { withSourceComposition } from '../../index.js';
import { fixture } from '../../../landing/tests/fixtures/plan.js';
import { git } from '../../../landing/tests/fixtures/plan.js';

/** One real repository whose two branches each add a different file, so the merge is clean. */
function twoBranches(t) {
  const { root, put } = fixture(t);
  git(root, 'config', 'user.name', 'Compose fixture');
  git(root, 'config', 'user.email', 'compose@example.invalid');
  put('base.txt', 'base\n');
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'base');
  const main = git(root, 'rev-parse', 'HEAD').trim();
  const heads = ['one', 'two'].map(name => {
    git(root, 'checkout', '-q', '-b', name, main);
    put(`${name}.txt`, `${name}\n`);
    git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', name);
    return git(root, 'rev-parse', 'HEAD').trim();
  });
  return { root, heads };
}

test('merge.compose.custody-unknown-keeps-cause: clause 1: a source composition whose controller started and then threw rejects with the retained path in its message and the thrown error as cause, and keeps the folder [C7]', async t => {
  const { root, heads } = twoBranches(t);
  const thrown = new Error('gate threw after start');
  let directory;
  t.after(() => rmSync(dirname(directory), { recursive: true, force: true }));
  await assert.rejects(withSourceComposition(root, heads[0], heads[1], async (composition, controller) => {
    directory = composition.directory;
    controller.started();
    throw thrown;
  }), error => {
    assert.match(error.message, /controller custody is unknown/u);
    assert.ok(error.message.includes(directory), 'the message names the retained path');
    assert.equal(error.cause, thrown);
    return true;
  });
  assert.ok(existsSync(directory), 'the unknown-custody folder is kept');
});

test('merge.compose.custody-terminal-removes: clause 2: a composition that confirmed terminal custody, or never started, removes its folder [C7]', async t => {
  const { root, heads } = twoBranches(t);
  const folders = [];
  await withSourceComposition(root, heads[0], heads[1], async (composition, controller) => {
    folders.push(composition.directory);
    controller.started(); controller.terminal();
  });
  await assert.rejects(withSourceComposition(root, heads[0], heads[1], async composition => {
    folders.push(composition.directory);
    throw new Error('failed before any controller started');
  }), /failed before any controller started/u);
  assert.equal(folders.length, 2);
  for (const folder of folders) assert.equal(existsSync(folder), false, 'the folder is removed');
});
