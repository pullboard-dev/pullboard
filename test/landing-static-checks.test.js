/** A landing batch turns a red submit static check on the merged tree into a named refusal that charges only the changing items [C7,#3345]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Refused } from '../packages/kernel/index.js';
import { itemRefusalText } from '../packages/landing/src/core/item-refusal.js';
import { entriesTouching } from '../packages/landing/src/shell/landing-static-checks.js';
import { landingStaticRefusal } from '../packages/landing/src/shell/landing-static-checks.js';
import { privateRepo } from './submit-gate-fixture.js';

/** A private repository with main plus two branches, each adding one file, and the merge of both checked out. */
function repository(t) {
  const { root, git } = privateRepo(t);
  const put = (file, text) => { mkdirSync(join(root, 'web'), { recursive: true }); writeFileSync(join(root, file), text); };
  put('web/main.txt', 'main\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: base');
  const base = git('rev-parse', 'HEAD');
  const branch = (name, file) => {
    git('checkout', '-q', '-b', name, base);
    put(file, `${name}\n`);
    git('add', '-A');
    git('commit', '-q', '-m', `feat: ${name}`);
    return git('rev-parse', 'HEAD');
  };
  const first = branch('first', 'web/a.txt');
  const second = branch('second', 'web/b.txt');
  git('checkout', '-q', '-b', 'merged', base);
  git('merge', '-q', '--no-edit', first, second);
  return { root, base, first, second };
}

const RED = new Refused('GATE_RED', 'static checks are red; fix the named source before running proof:\nweb/b.txt:1: collides with web/a.txt\nweb/main.txt:4: inherited row');

test('clause 1: a static row green on main and red in a file the batch changed refuses with a code naming the check, file and line [C7]', t => {
  const { root, base } = repository(t);
  const refusal = landingStaticRefusal(root, base, RED, 'node bin/static-style-checks.js');
  assert.ok(refusal instanceof Refused);
  assert.equal(refusal.code, 'LAND_STATIC_RED');
  assert.match(refusal.message, /node bin\/static-style-checks\.js/u);
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
