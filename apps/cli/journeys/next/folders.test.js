/** next opens and prints each claimed item's own folder; one seat lands two items from two folders [B5,N2]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';

/** Require real command success before reading its versioned JSON. */
function json(result) {
  assert.equal(result.code, 0, `${result.out}\n${result.err}`);
  return JSON.parse(result.out);
}

test('one seat builds, submits and lands two items from the folders next prints [B5,N2]', t => {
  const helpers = createE2eHelpers();
  t.after(() => helpers.cleanup());
  const box = helpers.sandbox();
  const repo = join(box.dir, 'folders-repo');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  assert.equal(box.run(repo, 'init').code, 0);
  const configFile = join(repo, 'pullboard.json');
  box.git(repo, 'add', 'pullboard.json');
  const config = JSON.parse(box.git(repo, 'show', ':pullboard.json')); // read the staged config through Git
  writeFileSync(configFile, JSON.stringify({ ...config, gate: 'true', verify: 'any', lanes: { web: { owns: ['web/'], specs: ['G1'] } } }, null, 2));
  writeFileSync(join(repo, 'SPEC.md'), '# Folder fixture\n\n## Goals\n- G1 [approved, must] Each result exists. | gate: true\n');
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: configure folder landing');
  const ids = ['first', 'second'].map(name => json(fixtureAdd(box.run, repo, 'web', `The ${name} result`, '--specs', 'G1',
    '--criterion', `web/${name}.txt exists.`, '--check', `test -f web/${name}.txt`, '--wait', '--json')).item.item_id);
  const opened = json(box.run(repo, 'worktree', 'web', '--model', 'folder-builder', '--json'));
  const seat = opened.path, seatId = json(box.run(seat, 'whoami', '--json')).id;
  const reviewer = join(box.dir, 'folders-reviewer');
  box.git(repo, 'worktree', 'add', '-q', '--detach', reviewer, 'main');
  assert.equal(fixtureJoin(box.run, reviewer, 'web', '--model', 'folder-reviewer', '--route', 'strong').code, 0);
  const landed = [];
  for (const [index, name] of ['first', 'second'].entries()) {
    const next = json(box.run(seat, 'next', '--build', '--json'));
    assert.equal(next.item.item_id, ids[index]);
    assert.equal(next.itemFolder, `${seat}-item-${ids[index]}`, 'next opens the claimed item\'s own folder');
    assert.ok(existsSync(next.itemFolder));
    assert.equal(next.holder, seatId, 'the claim lands on the calling seat, and next says so');
    const text = box.run(seat, 'next', '--build');
    assert.equal(text.code, 0, text.out + text.err);
    assert.match(text.out, new RegExp(`you hold #${ids[index]}\\b`, 'u'), 'next resumes the held item');
    assert.ok(text.out.includes(`item folder: ${next.itemFolder}; seat ${seatId};`), 'and prints its existing folder and seat');
    assert.equal(helpers.commitFile(box, next.itemFolder, `web/${name}.txt`, `${name}\n`, `feat(web): ${name} result [G1]`).status, 0);
    assert.match(box.git(next.itemFolder, 'log', '-1', '--format=%B'), new RegExp(`Pullboard-Item: #${ids[index]}\\b`));
    const head = json(box.run(next.itemFolder, 'submit', String(ids[index]), '--no-next', '--json')).commit;
    box.git(reviewer, 'switch', '-q', '--detach', head);
    const accepted = box.run(reviewer, 'verify', String(ids[index]), 'accept', '--no-next', '--note', `web/${name}.txt exists at the submitted commit.`);
    assert.equal(accepted.code, 0, accepted.out + accepted.err);
    const shown = json(box.run(repo, 'show', String(ids[index]), '--json'));
    assert.ok(shown.item_merged_commit, `#${ids[index]} landed`);
    assert.equal(box.git(repo, 'show', `${shown.item_merged_commit}:web/${name}.txt`), name, 'its landing carries its own commit');
    landed.push(shown.item_merged_commit);
  }
  assert.notEqual(landed[0], landed[1]);
  assert.equal(box.git(repo, 'merge-base', '--is-ancestor', landed[0], landed[1]), '', 'the second landing builds on the first');
});
