/** With submit.regenerateDeclared on, a submit regenerates a stale declared generated file in the composed tree; off, it leaves it (#8876) [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { commit } from '../../tests/fixtures/guards.js';
import { e2e } from '../../tests/fixtures/guards.js';
import { put } from '../../tests/fixtures/guards.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

after(e2e.cleanup);

/** A project that declares gen/out.txt as made from gen/in.txt; the item edits the input only, then submits with the setting on or off. Returns the box. */
async function submitted(regenerateDeclared) {
  const box = e2e.project('true');
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  config.lanes.web.owns.push('gen/');
  config.submit = { ...(config.submit ?? {}), regenerateDeclared };
  config.generated = [{ file: 'gen/out.txt', generator: 'cp gen/in.txt gen/out.txt', inputs: ['gen/in.txt'] }];
  put(box.repo, 'pullboard.json', JSON.stringify(config));
  put(box.repo, 'gen/in.txt', 'one\n');
  put(box.repo, 'gen/out.txt', 'one\n');
  put(box.repo, 'web/item.test.js', "import { test } from 'node:test';\ntest('item works [G1]', () => {});\n");
  commit(box, box.repo, 'test: accepted generated policy');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const made = await fixtureAdd(box.runLocal, box.repo, 'web', 'generated fixture', '--specs', 'G1',
    '--criterion', 'The item passes.', '--check', 'node --test web/item.test.js', '--json');
  assert.equal(made.code, 0, made.err + made.out);
  const id = JSON.parse(made.out).item.item_id;
  assert.equal((await box.runLocal(box.web, 'claim', String(id))).code, 0);
  put(box.web, 'gen/in.txt', 'two\n');
  commit(box, box.web, 'feat(core): change the generator input [G1]');
  const sent = await box.runLocal(box.web, 'submit', String(id));
  assert.equal(sent.code, 0, sent.err + sent.out);
  return box;
}

test('clause 1: with submit.regenerateDeclared on, a submit whose diff changes a declared input commits the regenerated file [C7]', async () => {
  const box = await submitted(true);
  assert.equal(box.git(box.web, 'show', 'HEAD:gen/out.txt').trim(), 'two');
  assert.match(box.git(box.web, 'log', '-1', '--format=%s'), /regenerate gen\/out\.txt/u);
});

test('clause 2: with submit.regenerateDeclared at its default (off), the same submit leaves the generated file as committed [C7]', async () => {
  const box = await submitted(false);
  assert.equal(box.git(box.web, 'show', 'HEAD:gen/out.txt').trim(), 'one');
});
