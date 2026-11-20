/** The commit-msg hook logic run in-process refuses, prints and rewrites exactly as the real hook does through git commit [C7,#9212]. */
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { runCommitMsgInProcess } from '../../fixtures/hook/commit-msg.js';
import { fixtureAdd } from '../../fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

const BIN = resolve(import.meta.dirname, '../../../pullboard.js');

/** A hooks folder holding only the commit-msg line of the repository's own hook, so the commit prints that hook and nothing else. */
function realHooks() {
  const dir = join(privateFixtureFiles('pullboard-commit-msg-hooks-').root, 'hooks');
  mkdirSync(dir);
  writeFileSync(join(dir, 'commit-msg'), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" hook commit-msg "$1"\n`);
  chmodSync(join(dir, 'commit-msg'), 0o755);
  return dir;
}

/** The real hook's answer through an empty git commit: status, stderr and the message file as the hook left it. */
function realAnswer(box, cwd, message) {
  const commit = box.tryGit(cwd, '-c', `core.hooksPath=${realHooks()}`, 'commit', '-q', '--allow-empty', '--allow-empty-message', '-m', message);
  const file = box.tryGit(cwd, 'rev-parse', '--git-path', 'COMMIT_EDITMSG').stdout.trim();
  return { status: commit.status === 0 ? 0 : 1, stderr: commit.stderr, message: readFileSync(resolve(cwd, file), 'utf8').trimEnd() };
}

/** A project whose web seat holds one claimed item, so a valid message gets its item trailer. */
async function claimedProject() {
  const box = e2e.project('true');
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'Parity item', '--criterion', 'the hooks agree', '--json');
  assert.equal(added.code, 0, added.err);
  const claimed = await box.runLocal(box.web, 'claim', String(JSON.parse(added.out).item.item_id));
  assert.equal(claimed.code, 0, claimed.err);
  return box;
}

const MESSAGES = [
  ['valid with an item trailer', 'feat(web): add the page [G1]', 0],
  ['no conventional type', 'add the page [G1]', 1],
  ['an unknown row id', 'feat(web): add the page [G9]', 1],
  ['a header the hook fixes up', 'feat(web): Add the page. [G1]', 0],
  ['an empty message', '', 1],
];

for (const [name, message, status] of MESSAGES) {
  test(`clause 2: for ${name} the in-process commit-msg status, stderr and final message equal the real hook's through git commit [C7,#9212]`, async () => {
    const box = await claimedProject();
    const inProcess = await runCommitMsgInProcess(box, box.web, message);
    const real = realAnswer(box, box.web, message);
    assert.equal(real.status, status, `the real hook answers ${status} for ${name}: ${real.stderr}`);
    assert.equal(inProcess.status, real.status, `status: in-process ${inProcess.status}, real ${real.status}\n${real.stderr}`);
    assert.equal(inProcess.stderr, real.stderr);
    assert.equal(inProcess.message, real.message);
  });
}

test('cli.io-hook-commit-msg-parity.runcommitmsginprocess-returns-status-stderr-and-the-message: clause 1: runCommitMsgInProcess returns status, stderr and the message as the hook left it, with the item trailer added [C7,#9212]', async () => {
  const box = await claimedProject();
  const answer = await runCommitMsgInProcess(box, box.web, 'feat(web): Add the page. [G1]');
  assert.deepEqual(Object.keys(answer).sort(), ['message', 'status', 'stderr']);
  assert.equal(answer.status, 0, answer.stderr);
  assert.match(answer.message, /^feat\(web\): add the page \[G1\]/u);
  assert.match(answer.message, /Pullboard-Item: #\d+/u);
});
