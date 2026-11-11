/** Runner-hosted submit: the runner pushes the item branch to the coordinator, which runs the ordinary submit as the one board writer [C7]. */
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  join,
} from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { fileFixtureItem } from '../../../tests/fixtures/testkit.js';

/**
 * Put an `ssh` stand-in first on the fixture PATH: it logs each destination host and runs the remote command from the runner's home.
 * @param {{ dir: string }} box The e2e fixture.
 * @param {string} runnerHome The directory standing in for the runner user's home.
 * @param {string} log The file that records each destination host.
 * @returns {void}
 */
function fakeSsh(box, runnerHome, log) {
  const path = join(box.dir, 'bin/ssh');
  writeFileSync(path, `#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nprintf '%s\\n' "$1" >> '${log}'\nshift\ncd '${runnerHome}' && exec /bin/sh -c "$1"\n`);
  chmodSync(path, 0o755);
}

/**
 * Make a registered runner builder-only: measured too small for any gate slot, so it hosts item folders while the
 * fixture's gate stays local; this file proves the hosted push and the coordinator submit, not runner gate cells.
 * @param {{ env: Record<string, string> }} box The e2e fixture.
 * @param {string} host The registered runner.
 * @returns {void}
 */
function builderOnlyRunner(box, host) {
  for (const home of [box.env.PULLBOARD_MACHINE_HOME, box.env.PULLBOARD_HOME]) {
    if (!existsSync(home)) continue;
    for (const name of readdirSync(home, { recursive: true })) {
      const file = join(home, String(name));
      if (!file.endsWith('.json')) continue;
      let settings;
      try { settings = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
      const runner = settings.runners?.find(row => row.host === host);
      if (!runner) continue;
      delete runner.fixed;
      Object.assign(runner, { cores: 1, memoryMB: 1024 });
      settings.gate = { ...settings.gate, measuredSlots: true };
      writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
      return;
    }
  }
  throw new Error(`no machine settings name runner ${host}`);
}

/**
 * A claimed item whose folder lives only on a fixture runner, with one commit built there.
 * @param {import('node:test').TestContext} t The test.
 * @returns {{ box: any, id: number, branch: string, runnerFolder: string, local: string, log: string, head: string }} The fixture.
 */
function hostedItem(t) {
  const helpers = createE2eHelpers();
  t.after(() => helpers.cleanup());
  const box = helpers.project('true');
  const runnerHome = join(box.dir, 'runner-home');
  mkdirSync(runnerHome);
  const log = join(box.dir, 'ssh.log');
  fakeSsh(box, runnerHome, log);
  const registered = box.run(box.repo, 'runner', 'add', 'runner-a', '--slots', '1', '--browser', '0', '--node', process.execPath, '--json');
  assert.equal(registered.code, 0, registered.err || registered.out);
  builderOnlyRunner(box, 'runner-a');
  const id = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Runner-hosted submit fixture' }).item_id;
  const claimed = box.run(box.web, 'claim', String(id));
  assert.equal(claimed.code, 0, claimed.err || claimed.out);
  const branch = `web/item-${id}`;
  const folder = join(dirname(box.web), `${basename(box.web)}-item-${id}`);
  // The folder lives on the runner only, as a runner-hosted claim leaves it (#3656).
  if (existsSync(folder)) box.git(box.repo, 'worktree', 'remove', '--force', folder);
  const runnerFolder = join(runnerHome, '.pullboard-runner', 'builders', `item-${id}`);
  mkdirSync(dirname(runnerFolder), { recursive: true });
  box.git(runnerHome, 'clone', '--quiet', join(box.repo, '.git'), runnerFolder);
  box.git(runnerFolder, 'checkout', '--quiet', '-b', branch, 'origin/main');
  mkdirSync(join(runnerFolder, 'web'), { recursive: true });
  writeFileSync(join(runnerFolder, 'web', 'page.html'), '<h1>Built on the runner</h1>\n');
  box.git(runnerFolder, 'add', '-A');
  box.git(runnerFolder, 'commit', '--quiet', '-m', `feat(web): page built on the runner [G1]\n\nPullboard-Item: #${id}`);
  writeFileSync(log, '');
  box.env.PULLBOARD_ITEM_FOLDER_RUNNER = 'runner-a';
  return { box, id, branch, runnerFolder, local: folder, log, head: box.git(runnerFolder, 'rev-parse', 'HEAD') };
}

/** The item's board history, so a refusal can be shown to have written nothing. */
function boardHistory(box, id) {
  const shown = box.run(box.repo, 'show', String(id), '--json');
  assert.equal(shown.code, 0, shown.err || shown.out);
  const item = JSON.parse(shown.out);
  return { status: item.item_status, owner: item.item_owner, thread: JSON.stringify(item.thread ?? item.events ?? null), outcome: item.item_submit_outcome ?? null };
}

test('clause 1: from a runner-hosted item folder, pullboard submit pushes the item branch from the runner to the coordinator and runs the ordinary submit there on the pushed commit [C7]', t => {
  const { box, id, branch, local, log, head } = hostedItem(t);
  const submitted = box.run(box.web, 'submit', String(id));
  assert.equal(submitted.code, 0, submitted.err || submitted.out);
  assert.match(submitted.out, new RegExp(`runner runner-a pushed ${branch} at ${head.slice(0, 12)}`));
  assert.match(submitted.out, new RegExp(`submitted #${id} at `));
  assert.ok(readFileSync(log, 'utf8').trim().split('\n').includes('runner-a'), 'the push ran over ssh on the registered runner');
  assert.equal(box.git(box.repo, 'merge-base', '--is-ancestor', head, `refs/heads/${branch}`), '', 'the coordinator branch holds the runner commit');
  const item = JSON.parse(box.run(box.repo, 'show', String(id), '--json').out);
  assert.equal(item.item_status, 'submitted');
  assert.equal(box.git(box.repo, 'merge-base', '--is-ancestor', head, item.item_commit), '', 'the gate judged the pushed commit');
  assert.equal(box.git(local, 'branch', '--show-current'), branch, 'the ordinary submit ran in the coordinator item folder on the claimed branch');
});

test('clause 2: a runner folder off the claimed branch refuses HOSTED_BRANCH_MISMATCH before any board write [C7]', t => {
  const { box, id, branch, runnerFolder } = hostedItem(t);
  box.git(runnerFolder, 'checkout', '--quiet', '-b', 'web/elsewhere');
  const before = boardHistory(box, id);
  const refused = box.run(box.web, 'submit', String(id));
  assert.equal(refused.code, 1, refused.out);
  assert.match(refused.err, new RegExp(`HOSTED_BRANCH_MISMATCH\\] runner runner-a folder .*item-${id} is on web/elsewhere, not the claimed branch ${branch}`));
  assert.deepEqual(boardHistory(box, id), before, 'the refusal wrote nothing to the board');
  assert.equal(box.tryGit(box.repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/web/elsewhere').status, 1, 'nothing was pushed');
});

test('clause 2: a push the coordinator does not take refuses HOSTED_PUSH_FAILED before any board write [C7]', t => {
  const { box, id, branch, runnerFolder, head } = hostedItem(t);
  box.git(runnerFolder, 'remote', 'set-url', 'origin', join(box.dir, 'no-such-coordinator.git'));
  const before = boardHistory(box, id);
  const refused = box.run(box.web, 'submit', String(id));
  assert.equal(refused.code, 1, refused.out);
  assert.match(refused.err, new RegExp(`HOSTED_PUSH_FAILED\\] runner runner-a folder .*item-${id} could not push ${branch} to the coordinator`));
  assert.deepEqual(boardHistory(box, id), before, 'the refusal wrote nothing to the board');
  assert.notEqual(box.tryGit(box.repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).stdout.trim(), head, 'the coordinator branch did not move');
});
