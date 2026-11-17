/** With test.inProcessHooks on, box.tryGit commit runs both hooks in-process and answers as the real hooks do; off, the real hooks run [C7,#9215]. */
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { parityText } from '../../fixtures/e2e.js';
import { plainCommitArgs } from '../../fixtures/hook/commit.js';
import { fixtureAdd } from '../../fixtures/testkit.js';
import { fixtureSettledMachine } from '../../fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

const BIN = resolve(import.meta.dirname, '../../../pullboard.js');

/** Hooks that record each start in `marks` and then run the repository's own hook logic, so a started real hook is visible. */
function spyHooks(marks) {
  const dir = join(privateFixtureFiles('pullboard-commit-wiring-hooks-').root, 'hooks');
  mkdirSync(dir);
  for (const [name, arg] of [['pre-commit', ''], ['commit-msg', ' "$1"']]) {
    writeFileSync(join(dir, name), `#!/bin/sh\necho ${name} >> "${marks}"\nPULLBOARD_HOOK_STATIC= exec "${process.execPath}" "${BIN}" hook ${name}${arg}\n`);
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}

/** A project whose web seat holds one claimed item, with the spy hooks installed and the setting on or off. */
async function project(inProcess) {
  const box = e2e.project('true');
  const marks = join(box.dir, 'hook-marks');
  box.git(box.web, 'config', 'core.hooksPath', spyHooks(marks));
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'Wiring item', '--criterion', 'the wiring agrees', '--json');
  assert.equal(added.code, 0, added.err);
  const claimed = await box.runLocal(box.web, 'claim', String(JSON.parse(added.out).item.item_id));
  assert.equal(claimed.code, 0, claimed.err);
  if (inProcess) fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME, { test: { inProcessHooks: true } });
  return { box, marks, started: () => (existsSync(marks) ? readFileSync(marks, 'utf8').split('\n').filter(Boolean) : []) };
}

/** Stage `path` in the web seat and commit it with `message` through box.tryGit; the answer may be a promise. */
async function commit(box, path, message) {
  mkdirSync(join(box.web, path, '..'), { recursive: true });
  writeFileSync(join(box.web, path), 'a change\n');
  box.git(box.web, 'add', '-A');
  const answer = await box.tryGit(box.web, 'commit', '-q', '-m', message);
  const log = box.tryGit(box.web, 'log', '-1', '--format=%B');
  return { status: answer.status === 0 ? 0 : 1, stderr: parityText(answer.stderr?.toString(), box.dir), message: answer.status === 0 ? log.stdout.toString().trim() : '' };
}

const CASES = [
  ['one clean commit', 'web/clean.txt', 'feat(web): add the page [G1]', 0],
  ['a path outside the lane', 'api/outside.txt', 'feat(web): add the page [G1]', 1],
  ['a message with no conventional type', 'web/a.txt', 'add the page [G1]', 1],
  ['a message with an unknown row id', 'web/b.txt', 'feat(web): add the page [G9]', 1],
];

for (const [name, path, message, status] of CASES) {
  test(`clause 1: with the setting on, box.tryGit commit for ${name} runs both hooks in-process and answers as with it off [C7,#9215]`, async () => {
    const off = await project(false);
    const real = await commit(off.box, path, message);
    const on = await project(true);
    const inProcess = await commit(on.box, path, message);
    assert.equal(real.status, status, `the real hooks answer ${status}: ${real.stderr}`);
    assert.deepEqual(inProcess, real);
    assert.deepEqual(on.started(), [], 'no real hook started with the setting on');
    assert.ok(off.started().includes('pre-commit'), 'the real pre-commit started with the setting off');
  });
}

test('clause 2: with the setting off a commit starts the real hooks, and --amend, -F, -e or no -m take them with it on [C7,#9215]', async () => {
  const off = await project(false);
  assert.equal((await commit(off.box, 'web/off.txt', 'feat(web): add the page [G1]')).status, 0);
  assert.deepEqual(off.started(), ['pre-commit', 'commit-msg']);
  assert.equal(plainCommitArgs(['commit', '-q', '-m', 'x']).message, 'x');
  for (const args of [['commit', '--amend', '-m', 'x'], ['commit', '-F', 'msg'], ['commit', '-e', '-m', 'x'], ['commit', '-q'], ['commit', '-a', '-m', 'x'], ['commit', '-m', 'x', '-m', 'y']]) {
    assert.equal(plainCommitArgs(args), null, `${args.join(' ')} keeps the real hooks`);
  }
  const on = await project(true);
  writeFileSync(join(on.box.web, 'web', 'amend.txt'), 'x\n');
  on.box.git(on.box.web, 'add', '-A');
  assert.equal(on.box.tryGit(on.box.web, 'commit', '-q', '--amend', '-m', 'feat(web): amend the page [G1]').status, 0);
  assert.deepEqual(on.started(), ['pre-commit', 'commit-msg'], 'an --amend with the setting on starts the real hooks');
});
