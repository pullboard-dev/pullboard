/** A claim made while the seat's last submit waits in its gate replays alike on every computer after an outage (#7775) [C7,B26,H16]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { waitForState } from '../../tests/fixtures/check-baseline.js';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';

const LANE = 'fixture-build';
const GATE = 'node --check src/relay-gate-fixture.js';

/** Run one fixture command, naming the step when the fixture itself throws. */
async function step(name, run) {
  try { return await run(); } catch (error) { error.message = `${name}: ${error.message}`; throw error; }
}

/** Run git in a fixture checkout and require it to succeed. */
function git(box, cwd, args) {
  const run = spawnSync('git', args, { cwd, env: box.env, encoding: 'utf8' });
  assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}${run.stdout}`);
}

/**
 * A board with one seat on N = 1 claims and two items in its lane; a linked one also has a paired second computer.
 * N is pinned so the seat may hold a second claim only while its first waits in the gate.
 */
async function seatBoard(t, linked) {
  const box = await relayClientFixture(t);
  const configPath = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.gate = GATE;
  config.lanes[LANE] = { owns: ['src/'], specs: ['G'] };
  config.claims = { ...config.claims, perSeat: 1 };
  config.relay = { ...config.relay, outbox: true };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  const specPath = join(box.root, 'SPEC.md');
  writeFileSync(specPath, readFileSync(specPath, 'utf8').replace('\n## K · Constraints',
    `\n- G1 [approved, must] The gate fixture parses. | gate: ${GATE}\n\n## K · Constraints`));
  const items = [];
  for (const title of ['first gate fixture work', 'second gate fixture work']) {
    const added = await box.cliLocal('add', LANE, title, '--specs', 'G1', '--criterion', 'the fixture source parses',
      '--brief', 'Files: src/relay-gate-fixture.js\nTest: the fixture source parses', '--check', GATE);
    assert.equal(added.code, 0, added.failure);
    items.push(added.document.item.item_id);
  }
  // The board's own commit hook runs pullboard, so this private PATH gets the CLI under test.
  symlinkSync(resolve(import.meta.dirname, '../../pullboard.js'), join(box.env.PATH, 'pullboard'));
  git(box, box.root, ['add', '-A']);
  git(box, box.root, ['commit', '-q', '-m', 'chore(test): prepare gate fixture']);
  const seat = join(box.root, '..', 'gate-fixture-seat');
  git(box, box.root, ['worktree', 'add', '-q', '-b', 'fixture-gate-seat', seat, 'HEAD']);
  let other = null;
  if (linked) {
    await step('link', () => box.link());
    other = await step('pair', async () => box.otherDeviceJoin((await box.cliLocal('relay', 'pair')).document.code));
  }
  const joined = await box.cliAtLocal(seat, 'join', LANE);
  assert.equal(joined.code, 0, joined.failure);
  return { box, other, seat, items };
}

/** The seat claims, commits and submits the first item, then claims the second while the first's gate waits. */
async function claimSubmitClaim({ box, seat, items: [first, second] }) {
  const claimed = await step('claim first', () => box.cliAtLocal(seat, 'claim', String(first)));
  assert.equal(claimed.code, 0, claimed.failure);
  mkdirSync(join(seat, 'src'), { recursive: true });
  writeFileSync(join(seat, 'src/relay-gate-fixture.js'), 'export const gate = true;\n');
  git(box, seat, ['add', 'src/relay-gate-fixture.js']);
  git(box, seat, ['commit', '-q', '-m', 'feat(fixture-build): complete gate fixture work [G1]']);
  const submitted = await step('submit first', () => box.cliAtLocal(seat, 'submit', String(first), '--no-next'));
  assert.equal(submitted.code, 0, submitted.failure);
  const waiting = (await box.cliLocal('export')).document.tables.item.find(row => row.item_id === first);
  assert.equal(waiting.item_status, 'claimed', 'the first item still waits in its gate when the seat claims again');
  const again = await step('claim second', () => box.cliAtLocal(seat, 'claim', String(second)));
  assert.equal(again.code, 0, again.failure);
}

/** One item's status on this computer's own board file, read without a command. */
function localStatus(box, id) {
  const db = new DatabaseSync(join(box.root, '.git', 'pullboard', 'board.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT item_status FROM item WHERE item_id = ?').get(id)?.item_status; } finally { db.close(); }
}

/** Wait until the first item's gate has finished on this computer, so its submit is recorded before boards compare. */
async function gateFinished(box, id) {
  await waitForState(() => localStatus(box, id) !== 'claimed', `the gate for #${id} finished`);
}

/** Each item's status and holder on one computer's board. */
function states(exported, items) {
  return items.map(id => {
    const row = exported.tables.item.find(item => item.item_id === id);
    return [id, row.item_status, row.item_owner];
  });
}

test('clause 1: claim, submit and claim again while the relay is down end alike on both computers and match an unlinked board [C7,B26,H16]', async t => {
  const unlinked = await seatBoard(t, false);
  await claimSubmitClaim(unlinked);
  await gateFinished(unlinked.box, unlinked.items[0]);
  const expected = states((await unlinked.box.cliLocal('export')).document, unlinked.items);
  assert.deepEqual(expected.map(([, status]) => status), ['submitted', 'claimed'], 'unlinked, the first item is submitted and the seat holds the second');

  const linked = await seatBoard(t, true);
  await linked.box.stopRelay();
  await claimSubmitClaim(linked);
  await linked.box.restartRelay();
  await gateFinished(linked.box, linked.items[0]);
  const drained = await step('status up', () => linked.box.cli('status'));
  assert.equal(drained.code, 0, drained.failure);
  assert.equal(drained.document.relay.outbox, undefined, 'the outbox drains');
  assert.deepEqual(drained.document.relay.outboxRefusals ?? [], [], 'no queued move is refused when it replays');

  const here = states((await step('export here', () => linked.box.cliLocal('export'))).document, linked.items);
  const there = states((await step('export there', () => linked.other.cli('export'))).document, linked.items);
  assert.deepEqual(here, there, 'both computers show the same item states');
  assert.deepEqual(here.map(([, status, owner]) => [status, owner.replace(/-\d+$/u, '')]),
    expected.map(([, status, owner]) => [status, owner.replace(/-\d+$/u, '')]), 'the linked computers match the unlinked board');
});
