/** @pullboard-test-loads src/coordinator-shout-purpose.js src/commands/shout.js src/lane-lead.js */
/** Explicit coordinator kinds keep item progress on facts without classifying prose [C7]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createE2eHelpers } from './e2e-helpers.js';
import { runFixtureChild } from './fixture-child.js';

const fixtures = createE2eHelpers();
after(fixtures.cleanup);

test('coordinator shouts require explicit kinds while status uses item facts [C7]', () => {
  const box = fixtures.project('true');
  const lead = box.run(box.repo, 'lanes', 'lead', 'web', 'web-1');
  assert.equal(lead.code, 0, lead.err + lead.out);
  const before = box.run(box.repo, 'export', '--json');
  assert.equal(before.code, 0, before.err);
  const count = JSON.parse(before.out).tables.shout.length;

  for (const args of [
    ['The item is implemented and 68 checks are green.'],
    ['Which check should run next?'],
    ['The outage is not resolved; coordinator intervention is needed.'],
    ['Choose the next check.', '--decision'],
    ['The gate is blocked by an unavailable runner.', '--kind', 'status'],
  ]) {
    const refused = box.run(box.web, 'shout', 'coordinator', ...args, '--json');
    assert.equal(refused.code, 1, refused.err + refused.out);
    const error = JSON.parse(refused.out).error;
    assert.equal(error.code, 'COORDINATOR_STATUS_FACT');
    assert.match(error.message + ' ' + error.next, /pullboard fact <id> note/u);
  }
  const unchanged = box.run(box.repo, 'export', '--json');
  assert.equal(unchanged.code, 0, unchanged.err);
  assert.equal(JSON.parse(unchanged.out).tables.shout.length, count, 'refusals record no shout');

  for (const args of [
    ['Which check should run next?', '--kind', 'question'],
    ['Main red on current main: cockpit/snapshot.test.js fails.', '--kind', 'blocker'],
    ['Choose the next check.', '--kind', 'decision', '--decision'],
    ['The outage is not resolved; coordinator intervention is needed.', '--kind', 'exception'],
    ['idea: add a visual diff for review receipts', '--kind', 'idea'],
  ]) {
    const sent = box.run(box.web, 'shout', 'coordinator', ...args, '--json');
    assert.equal(sent.code, 0, sent.err + sent.out);
  }
  const typed = box.run(box.repo, 'export', '--json');
  assert.equal(typed.code, 0, typed.err);
  assert.equal(JSON.parse(typed.out).tables.shout.length, count + 5, 'four coordination kinds and idea intake reach the coordinator');
  assert.deepEqual(JSON.parse(typed.out).tables.shout.slice(count).map(row => row.shout_to),
    Array(5).fill('coordinator'), 'every declared kind reaches the coordinator');

  const apiModule = pathToFileURL(resolve(import.meta.dirname, '../src/api.js')).href;
  const cliModule = pathToFileURL(resolve(import.meta.dirname, '../src/cli.js')).href;
  const person = runFixtureChild(process.execPath, ['--input-type=module', '-e', `
    const { executeMove } = await import(${JSON.stringify(apiModule)});
    const { main } = await import(${JSON.stringify(cliModule)});
    const response = await executeMove(process.cwd(), { verb: 'shout', args: { to: 'coordinator', text: 'A person asks the coordinator.' } }, main);
    process.stdout.write(JSON.stringify(response));
  `], { cwd: box.repo, env: box.env, encoding: 'utf8' });
  assert.equal(person.status, 0, person.failure ?? person.stderr);
  assert.equal(JSON.parse(person.stdout).status, 200, person.stdout);
  const afterPerson = box.run(box.repo, 'export', '--json');
  assert.equal(afterPerson.code, 0, afterPerson.err);
  const personRow = JSON.parse(afterPerson.out).tables.shout.at(-1);
  assert.deepEqual([personRow.shout_from, personRow.shout_to, personRow.shout_text],
    ['person', 'coordinator', 'A person asks the coordinator.'], 'the view-origin person request needs no kind');

  const peer = box.run(box.web, 'shout', 'api', 'The API lane can review the patch.', '--json');
  assert.equal(peer.code, 0, peer.err + peer.out);
  const broadcast = box.run(box.web, 'shout', 'all', 'The whole team can review the patch.', '--json');
  assert.equal(broadcast.code, 0, broadcast.err + broadcast.out);
  const afterShouts = box.run(box.repo, 'export', '--json');
  assert.equal(afterShouts.code, 0, afterShouts.err);
  assert.equal(JSON.parse(afterShouts.out).tables.shout.length, count + 8, 'person, peer and all shouts remain untyped');
});
