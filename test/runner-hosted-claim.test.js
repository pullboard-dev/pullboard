/** Runner-hosted claim: a seat set to runner-hosted gets its item folder on the runner, never in the coordinator repository [C7]. */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { fileFixtureItem } from './testkit-fixture.js';

/**
 * Put an `ssh` stand-in first on the fixture PATH: it logs each destination host and runs the remote command from the runner's home.
 * @param {{ dir: string }} box The e2e fixture.
 * @param {string} runnerHome The directory standing in for the runner user's home.
 * @param {string} log The file that records each destination host.
 * @returns {void}
 */
function fakeSsh(box, runnerHome, log) {
  const path = join(box.dir, 'bin', 'ssh');
  writeFileSync(path, `#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nprintf '%s\\n' "$1" >> '${log}'\nshift\ncd '${runnerHome}' && exec /bin/sh -c "$1"\n`);
  chmodSync(path, 0o755);
}

test('clause 1: with a seat set to runner-hosted, pullboard claim calls the runner-hosted worktree module instead of openItemFolder locally, and the item folder exists only on the runner [C7]', t => {
  const helpers = createE2eHelpers();
  t.after(() => helpers.cleanup());
  const box = helpers.project('true');
  const runnerHome = join(box.dir, 'runner-home');
  mkdirSync(runnerHome);
  const log = join(box.dir, 'ssh.log');
  fakeSsh(box, runnerHome, log);
  const registered = box.run(box.repo, 'runner', 'add', 'runner-a', '--slots', '1', '--browser', '0', '--node', process.execPath, '--json');
  assert.equal(registered.code, 0, registered.err || registered.out);
  const id = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Runner-hosted claim fixture' }).item_id;
  const worktreesBefore = box.git(box.repo, 'worktree', 'list', '--porcelain');
  writeFileSync(log, '');

  box.env.PULLBOARD_ITEM_FOLDER_RUNNER = 'runner-a';
  const claimed = box.run(box.web, 'claim', String(id), '--json');
  assert.equal(claimed.code, 0, claimed.err || claimed.out);
  assert.equal(JSON.parse(claimed.out).itemFolder, `runner-a:.pullboard-runner/builders/item-${id}`, 'claim names the folder on the runner');

  const runnerFolder = join(runnerHome, '.pullboard-runner', 'builders', `item-${id}`);
  assert.ok(existsSync(join(runnerFolder, 'pullboard.json')), 'the item folder is checked out on the runner');
  assert.equal(box.git(runnerFolder, 'branch', '--show-current'), `web/item-${id}`);
  assert.equal(box.git(runnerFolder, 'rev-parse', 'HEAD'), box.git(box.repo, 'rev-parse', 'main'));
  assert.ok(readFileSync(log, 'utf8').trim().split('\n').includes('runner-a'), 'the folder was made over ssh on the registered runner');

  assert.equal(existsSync(join(dirname(box.web), `${basename(box.web)}-item-${id}`)), false, 'no local item folder beside the seat checkout');
  assert.equal(box.git(box.repo, 'worktree', 'list', '--porcelain'), worktreesBefore, 'the coordinator repository gained no item worktree');
});

test('a runner-hosted seat naming an unregistered runner is refused before any folder is made [C7]', t => {
  const helpers = createE2eHelpers();
  t.after(() => helpers.cleanup());
  const box = helpers.project('true');
  const id = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Unregistered runner fixture' }).item_id;
  box.env.PULLBOARD_ITEM_FOLDER_RUNNER = 'runner-missing';
  const claimed = box.run(box.web, 'claim', String(id));
  assert.notEqual(claimed.code, 0);
  assert.match(claimed.err + claimed.out, /item folder runner runner-missing is not registered/u);
  assert.equal(existsSync(join(dirname(box.web), `${basename(box.web)}-item-${id}`)), false);
});
