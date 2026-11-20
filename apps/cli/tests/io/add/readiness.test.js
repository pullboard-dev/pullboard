/** add --readiness stores the item readiness command and edit --readiness replaces or clears it [C7,#8840]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createE2eHelpers } from '../../fixtures/e2e.js';

/** Run the real CLI and require its successful versioned JSON result. */
async function json(box, ...args) {
  const result = await box.runLocal(box.repo, ...args, '--json');
  assert.equal(result.code, 0, result.out + result.err);
  return JSON.parse(result.out);
}

test('cli.journeys-add-readiness.add-readiness-stores-the-command-on: clause 1: add --readiness stores the command on the item and show --json reports it [C7]', async t => {
  const helpers = createE2eHelpers(); t.after(helpers.cleanup);
  const box = helpers.project('true');
  const added = (await json(box, 'add', 'web', 'Ready check', '--criterion', 'the handler returns the canonical result [test]', '--readiness', 'node --version')).item;
  const shown = await json(box, 'show', String(added.item_id));
  assert.equal(shown.item_readiness_command, 'node --version');
  const plain = (await json(box, 'add', 'web', 'No readiness', '--criterion', 'the handler returns the canonical result [test]')).item;
  assert.equal((await json(box, 'show', String(plain.item_id))).item_readiness_command, '');
});

test('cli.journeys-add-readiness.edit-readiness-replaces-the-command-and: clause 2: edit --readiness replaces the command and an empty string clears it [C7]', async t => {
  const helpers = createE2eHelpers(); t.after(helpers.cleanup);
  const box = helpers.project('true');
  const added = (await json(box, 'add', 'web', 'Ready check', '--criterion', 'the handler returns the canonical result [test]', '--readiness', 'node --version')).item;
  const id = String(added.item_id);
  await json(box, 'edit', id, '--readiness', 'git --version');
  assert.equal((await json(box, 'show', id)).item_readiness_command, 'git --version');
  await json(box, 'edit', id, '--readiness', '');
  assert.equal((await json(box, 'show', id)).item_readiness_command, '');
});
