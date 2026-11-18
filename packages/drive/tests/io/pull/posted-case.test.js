/** A runner's posted log line for a red test job names the first failing case, behind runners.postedLineNamesCase, off by default (#9084) [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { serveRunner } from '../../../index.js';
import { testGit as pullGit } from '../../fixtures/git.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../gate/tests/fixtures/child.js';

const BOARD = 'http://board.invalid/api/v1/boards/b?k=x';
const FRAME = '# pullboard test outcomes ';
const RUN_ID = '11111111-2222-3333-4444-555555555555';

/** One outcome frame line, as the test reporter prints it. */
function frame(file, name, passed) { return `${FRAME}${JSON.stringify({ version: 1, id: RUN_ID, tests: [{ file, name, passed, skipped: false }] })}`; }

/** A one-commit trunk and a one-job board stand-in whose job prints `lines` and exits `status`; the posted lines are kept. */
async function serveRedJob(t, lines, status, setting) {
  const { root: trunk } = privateFixtureFiles('pullboard-posted-case-');
  const { root: cache } = privateFixtureFiles('pullboard-posted-cache-');
  t.after(() => { rmSync(trunk, { recursive: true, force: true }); rmSync(cache, { recursive: true, force: true }); });
  const sh = (...args) => runFixtureGit(['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', ...args], { cwd: trunk });
  sh('init', '-q', '-b', 'main');
  writeFileSync(join(trunk, 'file.txt'), 'one\n');
  sh('add', '.'); sh('commit', '-q', '-m', 'one');
  const commit = sh('rev-parse', 'HEAD');
  const script = `process.stdout.write(${JSON.stringify(lines.join('\n') + '\n')}); process.exit(${status});`;
  let claimed = false;
  const fetchImpl = async (_url, { body }) => {
    const call = JSON.parse(body);
    let reply = { recorded: true };
    if (call.action === 'claim') {
      reply = claimed ? { claim: null } : { trunk, claim: { job: 'test:red', kind: 'test', needs: [], run: [process.execPath, '-e', script], candidate: commit, base: commit, attempt: 1, token: 'r:1' } };
      claimed = true;
    } else if (call.action === 'renew') reply = { renewed: true };
    return { status: 200, json: async () => reply };
  };
  const said = [];
  await serveRunner({ git: pullGit, board: BOARD, runner: 'r-case', capabilities: [], cache, once: true, fetchImpl, trunkPack: async () => {}, say: line => said.push(line),
    postedLineNamesCase: setting === true });
  return said.find(line => line.startsWith('posted test:red'));
}

const RED = [frame('apps/a.test.js', 'clause 1: alpha', true), frame('apps/b.test.js', 'clause 2: beta', false), frame('apps/c.test.js', 'clause 3: gamma', false), frame('apps/d.test.js', 'clause 4: delta', false)];

test('drive.posted-case.with-runners-postedlinenamescase-on-the: clause 1: with runners.postedLineNamesCase on, the posted line for a red test job ends with the first failing case and a count of the other failing cases (#9084) [C7]', { timeout: 60_000 }, // budget: one node job and a git checkout.
async t => {
  const line = await serveRedJob(t, RED, 1, true);
  assert.ok(line?.startsWith('posted test:red: exit 1'), line);
  assert.ok(line.endsWith('; first failing case: apps/b.test.js::clause 2: beta, +2 more'), line);
});

test('drive.posted-case.with-runners-postedlinenamescase-off-the: clause 2: with runners.postedLineNamesCase off the posted line is the unchanged one, and a red job with no outcome frame posts it with no case named, also when the setting is on (#9084) [C7]', { timeout: 120_000 }, // budget: two node jobs and two git checkouts.
async t => {
  assert.equal(await serveRedJob(t, RED, 1, undefined), 'posted test:red: exit 1');
  assert.equal(await serveRedJob(t, RED, 1, false), 'posted test:red: exit 1');
  assert.equal(await serveRedJob(t, ['not ok 1 - something'], 1, true), 'posted test:red: exit 1');
});
