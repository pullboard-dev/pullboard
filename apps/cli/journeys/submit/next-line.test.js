/** The next-step line of join, submit and claim is plain `pullboard next` and never `next --wait`, whatever the outcome [N2,N42,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cli,
  fixture,
} from '../../tests/fixtures/next/take.js';

/** Every next-step line a result carries: its success next, its refusal's next, and its message. */
function nextLines(result) {
  const document = result.document ?? {};
  return [document.next, document.nextStep, document.error?.next, document.error?.message].filter(line => typeof line === 'string');
}

test('cli.journeys-submit-next-line.join-claim-and-submit-never-print: clause 1: join, claim and submit never print next --wait, on success or any refusal in the matrix [N2,N42]', async t => {
  const box = await fixture(t);
  const outcomes = [];
  /** Run one command and keep the outcome label with every next-step line it printed. */
  async function run(label, cwd, args) {
    const result = await cli(box, cwd, args);
    outcomes.push({ label, code: result.code, lines: nextLines(result), raw: result.out + result.err });
    return result;
  }
  const builder = box.seats.builder.path, actor = box.seats.actor.path;
  const open = box.add('Open item for the matrix');
  const second = box.add('Second item for the matrix');
  const held = box.add('Held item for the matrix');
  await run('join again', builder, ['join', 'web']);
  await run('claim ok', builder, ['claim', String(open)]);
  await run('claim a second item', builder, ['claim', String(second)]);
  await run('submit with nothing committed', builder, ['submit', String(open), '--no-next']);
  await run('submit an item not claimed', actor, ['submit', String(second), '--no-next']);
  await run('claim an item that does not exist', actor, ['claim', '99999']);
  await run('claim in another lane', box.seats.sibling.path, ['claim', String(second)]);
  await run('hold item', box.root, ['hold', String(held), '--reason', 'matrix item hold']);
  await run('claim a held item', actor, ['claim', String(held)]);
  await run('hold lane', box.root, ['hold', 'web', '--reason', 'matrix lane hold']);
  await run('claim in a held lane', actor, ['claim', String(second)]);
  const named = outcomes.filter(row => !/^hold /u.test(row.label));
  assert.ok(named.filter(row => row.lines.length > 0).length >= 5, 'most outcomes in the matrix print a next-step line: ' + JSON.stringify(named.map(row => [row.label, row.code])));
  for (const row of named) {
    assert.doesNotMatch(row.lines.join('\n'), /next --wait/u, `${row.label}: ${row.raw}`);
    assert.doesNotMatch(row.raw, /next --wait/u, `${row.label}: ${row.raw}`);
  }
});
