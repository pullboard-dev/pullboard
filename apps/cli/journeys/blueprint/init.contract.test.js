/**
 * The real-process contract for blueprint init and add: one journey per command through node pullboard.js, so argv,
 * exit codes and output streams stay proven through a real process while init.test.js answers its permutations in-process [S1,I1,C7].
 */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { PUBLISHED } from '../../tests/fixtures/blueprint.js';
import { boardCreated } from '../../tests/fixtures/blueprint.js';
import { emptyRepo } from '../../tests/fixtures/blueprint.js';
import { json } from '../../tests/fixtures/blueprint.js';

test('contract: init --blueprint, add, starters and a refusal behave through a real process [S1,I1]', () => {
  // A refusal exits nonzero with its code on stdout, and writes nothing.
  const bare = emptyRepo({ mode: 'process' });
  const refused = bare.run('init', '--blueprint', 'no-such-blueprint', '--json');
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.equal(JSON.parse(refused.stdout).error.code, 'NO_BLUEPRINT');
  assert.deepEqual(readdirSync(bare.repo).filter((name) => name !== '.git'), [], 'nothing is written');
  assert.equal(boardCreated(bare.repo), false, 'no board is created');

  // init --blueprint exits zero, prints its summary on stdout, and files every starter once.
  const started = bare.run('init', '--blueprint', 'web-app', '--verbose');
  assert.equal(started.status, 0, started.stdout + started.stderr);
  assert.match(started.stdout, new RegExp(`^added the ${PUBLISHED.title} blueprint:`, 'mu'));
  assert.equal(started.stderr, '', 'a clean init prints nothing on stderr');
  assert.equal((json(bare, 'list').items ?? []).length, PUBLISHED.items.length);

  // starters and a repeat add run through the shim the hooks use; a repeat adds nothing.
  const starters = bare.run('blueprint', 'starters', 'web-app');
  assert.equal(starters.status, 0, starters.stdout + starters.stderr);
  for (const item of PUBLISHED.items) assert.match(starters.stdout, new RegExp(`#\\d+ open  ${item.title.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'));
  assert.equal(json(bare, 'blueprint', 'add', 'web-app').items.length, 0, 'a repeat add files nothing');
  assert.match(readFileSync(join(bare.repo, 'SPEC.md'), 'utf8'), /pullboard-blueprint web-app 1/u);
});
