/** The tour's scripted commit runs its pre-commit and commit-msg hooks in its own process, then commits with git's hooks off [N10,#10408]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { commitWithHooks } from '../../src/io/tour-commit.js';
import { privateFixtureFiles } from '../fixtures/child.js';

/** Fake ports that record, in order, every real command and every in-process pullboard command the commit asked for. */
function ports(t, { refuse = null } = {}) {
  const dir = privateFixtureFiles('pullboard-tour-commit-').root;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  return {
    calls,
    messageFile: join(dir, 'message'),
    run: (file, args, options) => { calls.push(['run', file, ...args]); return `ran ${options.label}`; },
    pb: async args => {
      calls.push(['pb', ...args]);
      if (args[1] === refuse) throw new Error(`the ${refuse} hook refused`);
      return '';
    },
  };
}

test('clause 1: a scripted commit runs pre-commit, then commit-msg on the message file, in this process, then commits with git\'s hooks off [N10,#10408]', async t => {
  const fake = ports(t);
  const shown = await commitWithHooks({ ...fake, message: 'feat(app): greet by name [G1]', label: 'git commit -q -m "feat(app): greet by name [G1]"' });
  assert.deepEqual(fake.calls, [
    ['pb', 'hook', 'pre-commit'],
    ['pb', 'hook', 'commit-msg', fake.messageFile],
    ['run', 'git', '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-F', fake.messageFile],
  ]);
  assert.equal(readFileSync(fake.messageFile, 'utf8'), 'feat(app): greet by name [G1]\n');
  assert.equal(shown, 'ran git commit -q -m "feat(app): greet by name [G1]"', 'the tour still shows the git commit line');
});

test('clause 1: a commit of every tracked change stages them first, so the hook reads the index git commits [N10,#10408]', async t => {
  const fake = ports(t);
  await commitWithHooks({ ...fake, message: 'fix(app): x [G1]', label: 'git commit', all: true });
  assert.deepEqual(fake.calls.map(call => call.slice(0, 3).join(' ')), ['run git add', 'pb hook pre-commit', 'pb hook commit-msg', 'run git -c']);
  assert.deepEqual(fake.calls[0], ['run', 'git', 'add', '-u']);
});

test('clause 1: a hook refusal stops the tour before git commits anything [N10,#10408]', async t => {
  for (const refuse of ['pre-commit', 'commit-msg']) {
    const fake = ports(t, { refuse });
    await assert.rejects(commitWithHooks({ ...fake, message: 'feat: x [G1]', label: 'git commit' }), new RegExp(`the ${refuse} hook refused`, 'u'));
    assert.equal(fake.calls.some(call => call[0] === 'run' && call.includes('commit')), false, `${refuse}: git never committed`);
  }
});

test('clause 1: with real hooks asked for, the commit is one plain git commit that runs git\'s own hook scripts [N10,#10408]', async t => {
  const fake = ports(t);
  await commitWithHooks({ ...fake, message: 'feat: x [G1]', label: 'git commit', real: true });
  assert.deepEqual(fake.calls, [['run', 'git', 'commit', '-q', '-m', 'feat: x [G1]']]);
  const all = ports(t);
  await commitWithHooks({ ...all, message: 'fix: y [G1]', label: 'git commit', real: true, all: true });
  assert.deepEqual(all.calls, [['run', 'git', 'commit', '-q', '-am', 'fix: y [G1]']]);
});
