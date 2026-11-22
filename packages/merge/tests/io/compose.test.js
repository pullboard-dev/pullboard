/** @pullboard-world-pin builds real git repositories in a private root; each composition is a real merge of two branches. */
/** A retained source composition keeps the work's thrown error as the cause of its unknown-custody refusal, and folders stay or go as before [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { withSourceComposition } from '../../index.js';
import { fixture } from '../../../landing/tests/fixtures/plan.js';
import { git } from '../../../landing/tests/fixtures/plan.js';

const CONFIG = 'src/config.js';

/** Keep the historical fixture path, comments, and nested defaults used by config's original merge proof. */
function defaults(extra = '') {
  return `export function defaults() {
  return {
    spec: 'SPEC.md',
    // Explains the next setting.
    map: { slice: false },${extra}
    lanes: {},
    commits: {
      maxHeader: 72,
    },
  };
}
`;
}

/** Build one real base commit and two branch heads that change the config independently. */
function configBranches(t, base, left, right) {
  const { root, put } = fixture(t);
  git(root, 'config', 'user.name', 'Compose fixture');
  git(root, 'config', 'user.email', 'compose@example.invalid');
  put(CONFIG, base);
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'base');
  const main = git(root, 'rev-parse', 'HEAD').trim();
  const heads = [left, right].map((source, index) => {
    git(root, 'checkout', '-q', '-b', `side${index}`, main);
    put(CONFIG, source);
    git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', `side ${index}`);
    return git(root, 'rev-parse', 'HEAD').trim();
  });
  return { root, heads };
}

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

test('merge.io-defaults-compose.disjoint-and-same-key: clause 1: disjoint default keys retain comments and nested defaults in both orders, while divergent existing or same new keys conflict [C7]', async t => {
  const alpha = defaults().replace('    lanes: {},', '    alpha: { on: false },\n    lanes: {},');
  const beta = defaults().replace('    spec: ', "    // Beta's comment.\n    beta: {\n      on: true,\n    },\n    spec: ");
  const { root, heads } = configBranches(t, defaults(), alpha, beta);
  for (const [ours, theirs] of [heads, [...heads].reverse()]) {
    await withSourceComposition(root, ours, theirs, async composition => {
      const source = readFileSync(join(composition.directory, CONFIG), 'utf8');
      assert.match(source, /\/\/ Explains the next setting\./u);
      assert.match(source, /\/\/ Beta's comment\./u);
      assert.match(source, /alpha: \{ on: false \}/u);
      assert.match(source, /beta: \{\n      on: true,/u);
      assert.match(source, /commits: \{\n      maxHeader: 72,/u);
      assert.match(source, /map: \{ slice: false \}/u);
    });
  }

  for (const [left, right] of [
    [defaults().replace('slice: false', 'slice: true'), defaults().replace('slice: false', 'slice: 1')],
    [alpha, alpha.replace('alpha: { on: false }', 'alpha: { on: true }')],
  ]) {
    const conflict = configBranches(t, defaults(), left, right);
    for (const [ours, theirs] of [conflict.heads, [...conflict.heads].reverse()]) {
      await assert.rejects(withSourceComposition(conflict.root, ours, theirs, async () => assert.fail('divergent defaults must not compose')),
        error => error.code === 'MERGE_CONFLICT' && error.message.includes(CONFIG));
    }
  }
});

test('merge.io-defaults-compose.delete-versus-edit: clause 2: deleting a default while the other branch edits it conflicts in both orders [C7]', async t => {
  const removed = defaults().replace('    // Explains the next setting.\n    map: { slice: false },\n', '');
  const edited = defaults().replace('slice: false', 'slice: true');
  const { root, heads } = configBranches(t, defaults(), removed, edited);
  for (const [ours, theirs] of [heads, [...heads].reverse()]) {
    await assert.rejects(withSourceComposition(root, ours, theirs, async () => assert.fail('a deleted and edited default must not compose')),
      error => error.code === 'MERGE_CONFLICT' && error.message.includes(CONFIG));
  }
});
