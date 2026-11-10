/** A landing batch turns a red submit static check on the merged tree into a named refusal that charges only the changing items [C7,#3345]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Refused } from '../../../kernel/index.js';
import { itemRefusalText } from '../../src/logic/refusal.js';
import { entriesTouching } from '../../src/io/static.js';
import { landingStaticRefusal } from '../../src/io/static.js';
import { fixture } from '../fixtures/plan.js';
import { git } from '../fixtures/plan.js';

/** A cells-plan fixture repository (identity set, no hooks) plus two branches each adding one file, and the merge of both. */
function repository(t) {
  const { root, put } = fixture(t);
  put('web/main.txt', 'main\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'chore: base');
  const base = git(root, 'rev-parse', 'HEAD');
  const branch = (name, file) => {
    git(root, 'checkout', '-q', '-b', name, base);
    put(file, `${name}\n`);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', `feat: ${name}`);
    return git(root, 'rev-parse', 'HEAD');
  };
  const first = branch('first', 'web/a.txt');
  const second = branch('second', 'web/b.txt');
  git(root, 'checkout', '-q', '-b', 'merged', base);
  git(root, 'merge', '-q', '--no-edit', first, second);
  return { root, base, first, second };
}

const RED = new Refused('GATE_RED', 'static checks are red; fix the named source before running proof:\nweb/b.txt:1: collides with web/a.txt\nweb/main.txt:4: inherited row');

test('clause 1: a static row green on main and red in a file the batch changed refuses with a code naming the check, file and line [C7]', t => {
  const { root, base } = repository(t);
  const refusal = landingStaticRefusal(root, base, RED, 'node apps/cli/src/io/static/checks.js');
  assert.ok(refusal instanceof Refused);
  assert.equal(refusal.code, 'LAND_STATIC_RED');
  assert.match(refusal.message, /node apps\/cli\/src\/io\/static\/checks\.js/u);
  assert.match(refusal.message, /web\/b\.txt:1: collides with web\/a\.txt/u);
  assert.doesNotMatch(refusal.message, /web\/main\.txt/u, 'a row in a file the batch left alone is main\'s own');
  assert.deepEqual(refusal.files, ['web/b.txt']);
  assert.equal(itemRefusalText(refusal.code, refusal.message), true);
});

test('clause 1: a red static check whose rows are all in untouched files keeps the plain refusal [C7]', t => {
  const { root, base } = repository(t);
  const inherited = new Refused('GATE_RED', 'static checks are red; fix the named source before running proof:\nweb/main.txt:4: inherited row');
  assert.equal(landingStaticRefusal(root, base, inherited), inherited);
});

test('clause 2: only the item that changed the red file is charged, so the rest of the batch can land without it [C7]', t => {
  const { root, base, first, second } = repository(t);
  const entries = [{ id: 1, commit: first }, { id: 2, commit: second }];
  assert.deepEqual(entriesTouching(root, base, entries, ['web/b.txt']).map(entry => entry.id), [2]);
});
