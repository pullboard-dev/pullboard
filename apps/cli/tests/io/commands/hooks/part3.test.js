/**
 * The commit-message rules (C1, C2) and the pre-commit pattern checks on real staged changes.
 */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../fixtures/e2e.js';
import { fixtureSettledMachine } from '../../../fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** A freshly initialised repository with its real git hooks installed and test.inProcessHooks set on the machine as asked, off written explicitly so the off case never rides the fixture default. */
async function hookedRepo(inProcessHooks) {
  const box = e2e.sandbox();
  fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME, { test: { inProcessHooks } });
  const root = join(box.dir, 'hooked');
  mkdirSync(root);
  box.git(root, 'init', '-q', '-b', 'main');
  const initialized = await box.runLocal(root, 'init');
  assert.equal(initialized.code, 0, initialized.err || initialized.out);
  box.git(root, 'add', '-A');
  box.git(root, 'commit', '-q', '-m', 'chore: set up the private board');
  return { box, root };
}

for (const inProcessHooks of [false, true]) {
  const setting = inProcessHooks ? 'on' : 'off';
  test(`clause 1: git runs the real pre-commit hook and refuses a staged env file, with test.inProcessHooks ${setting} [C5,C7]`, async () => {
    const { box, root } = await hookedRepo(inProcessHooks);
    writeFileSync(join(root, '.env'), 'TOKEN=not-a-real-token\n');
    box.git(root, 'add', '-f', '--', '.env');
    const refused = await box.tryGit(root, 'commit', '-q', '-m', 'chore: add the env file');
    assert.notEqual(refused.status, 0, 'the real pre-commit hook blocks the commit');
    assert.match(refused.stderr, /\.env is a blocked file/u, 'the refusal is the hook process own output');
  });

  test(`clause 1: git runs the real commit-msg hook and refuses a malformed header, with test.inProcessHooks ${setting} [C1,C7]`, async () => {
    const { box, root } = await hookedRepo(inProcessHooks);
    writeFileSync(join(root, 'notes.txt'), 'notes\n');
    box.git(root, 'add', '--', 'notes.txt');
    const refused = await box.tryGit(root, 'commit', '-q', '-m', 'Added some notes');
    assert.notEqual(refused.status, 0, 'the real commit-msg hook blocks the commit');
    const allowed = await box.tryGit(root, 'commit', '-q', '-m', 'chore: add some notes');
    assert.equal(allowed.status, 0, allowed.failure || allowed.stderr || allowed.stdout);
  });
}

test('cli.journeys-hooks-main-part3.with-test-inprocesshooks-on-the-installed: clause 2: with test.inProcessHooks on, the installed pre-commit and commit-msg hooks are still the real scripts that start pullboard hook [C7]', async () => {
  const { root } = await hookedRepo(true);
  for (const name of ['pre-commit', 'commit-msg']) {
    assert.match(readFileSync(join(root, '.githooks', name), 'utf8'), new RegExp(`hook ${name}`, 'u'), `${name} runs pullboard hook ${name}`);
  }
});

test('cli.hooks-main-part3.long-header-refused: clause 1: the real commit-msg hook refuses the 79-character header with its length and the limit, and leaves the message file unchanged [C1,C7]', async () => {
  const { box, root } = await hookedRepo(false);
  const header = 'chore(env): jest; speed text; builders only build; guesses become rulings today';
  assert.equal(header.length, 79, 'the header is 79 characters');
  writeFileSync(join(root, 'notes.txt'), 'notes\n');
  box.git(root, 'add', '--', 'notes.txt');
  const refused = await box.tryGit(root, 'commit', '-q', '-m', header);
  assert.equal(refused.status, 1, 'the real commit-msg hook exits 1');
  assert.match(refused.stderr, /79/u, 'the refusal names the header length 79');
  assert.match(refused.stderr, /72/u, 'the refusal names the limit 72');
  assert.equal(readFileSync(join(root, '.git', 'COMMIT_EDITMSG'), 'utf8'), `${header}\n`, 'the commit message file is byte-identical, never cut');
});
