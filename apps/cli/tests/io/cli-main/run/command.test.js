/** @pullboard-test-input apps/cli/src/io/cli-main/run/command.js */
/** --route prints one stderr line naming --level, and never touches the stdout document [C7,#10966]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../fixtures/e2e.js';
import { withFixtureBoard } from '../../../fixtures/board.js';
import { fileFixtureItem } from '../../../fixtures/testkit.js';
import { runCommand } from '../../../../src/io/cli-main/run/command.js';

/** Run one command against a recording io: what it said, what its document held, and what went to stderr. */
async function run(argv) {
  const seen = { say: [], result: [], err: [] };
  const io = { jsonMode() {}, say: line => seen.say.push(line), result: document => seen.result.push(document), err: line => seen.err.push(line) };
  seen.code = await runCommand(argv, io);
  return seen;
}

test('cli.io-cli-main-run-command.route-prints-one-deprecation-line-naming-level: clause 1: --route prints one stderr line naming --level, and --level prints none [C7,#10966]', async () => {
  for (const argv of [['version', '--route', 'mid'], ['version', '--route=mid']]) {
    const seen = await run(argv);
    assert.equal(seen.code, 0);
    assert.equal(seen.err.length, 1, 'one line');
    assert.match(seen.err[0], /--level/);
  }
  const level = await run(['version', '--level', 'mid']);
  assert.equal(level.code, 0);
  assert.deepEqual(level.err, []);
});

test('cli.io-cli-main-run-command.the-deprecation-line-stays-out-of-json-output: clause 2: with --json the stdout document and said lines are the same with --route as without it [C7,#10966]', async () => {
  const plain = await run(['version', '--json']);
  const routed = await run(['version', '--json', '--route', 'mid']);
  assert.deepEqual(routed.result, plain.result);
  assert.deepEqual(routed.say, plain.say);
  assert.equal(routed.err.length, 1, 'the line still goes to stderr, never to stdout');
});

/** A box whose seat web-1 built an item a verifier rejected: open, REJECT, built by web-1, with its verdict row; the seeded rows stand in for a gate and a review [C7,#2220]. */
async function boxWithReturnedItem(t, setting) {
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.project('true');
  const item = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Returned to its builder' });
  const file = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  const settings = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify(setting === undefined ? settings : { ...settings, next: { returnedFirst: setting } }));
  const commit = box.git(box.repo, 'rev-parse', 'HEAD').trim();
  withFixtureBoard(join(box.repo, '.git/pullboard/board.sqlite'), board => {
    board.db.prepare("UPDATE item SET item_status = 'open', item_verdict = 'REJECT', item_built_by = 'web-1', item_owner = NULL WHERE item_id = ?").run(item.item_id);
    board.db.prepare("INSERT INTO verdict (item_id, verdict_by, verdict_decision, verdict_reason, verdict_note, verdict_commit, verdict_digest, verdict_head, verdict_at) VALUES (?, 'reviewer-1', 'REJECT', 'BEHAVIOR_MISMATCH', 'the clause is not proven', ?, 'd', ?, '2026-11-19T00:00:00Z')").run(item.item_id, commit, commit);
  });
  return { box, id: item.item_id };
}

const SAID = /^rejected #\d+ Returned to its builder: BEHAVIOR_MISMATCH: the clause is not proven$/mu;

test('cli.io-cli-main-run-command.rejection-echo-first: clause 1: with next.returnedFirst on, runCommand for next, claim, submit, show and fact says the returned rejection line before the command lines, and none once a seat has claimed the item [C7,#2220]', async t => {
  const { box, id } = await boxWithReturnedItem(t, true);
  for (const command of [['show', String(id)], ['fact', String(id), 'note', 'x'], ['submit', String(id)]]) {
    const seen = await box.runLocal(box.web, ...command);
    assert.match(seen.out.split('\n')[0], SAID, `${command[0]} says it first`);
  }
  const taken = await boxWithReturnedItem(t, true);
  const next = await taken.box.runLocal(taken.box.web, 'next');
  assert.match(next.out.split('\n')[0], SAID, 'next says it first');
  const claimed = await box.runLocal(box.web, 'claim', String(id));
  assert.match(claimed.out.split('\n')[0], SAID, 'claim says it first');
  const after = await box.runLocal(box.web, 'show', String(id));
  assert.doesNotMatch(after.out, SAID, 'a claimed item is no longer returned');
});

test('cli.io-cli-main-run-command.rejection-echo-off: clause 2: with next.returnedFirst off or unset, and for every other command, the said lines are those of today [C7,#2220]', async t => {
  for (const setting of [false, undefined]) {
    const { box, id } = await boxWithReturnedItem(t, setting);
    for (const command of [['next'], ['show', String(id)]]) {
      const seen = await box.runLocal(box.web, ...command);
      assert.doesNotMatch(seen.out + seen.err, SAID, `setting ${setting}: ${command.join(' ')}`);
    }
  }
  const { box } = await boxWithReturnedItem(t, true);
  const other = await box.runLocal(box.web, 'whoami');
  assert.doesNotMatch(other.out + other.err, SAID, 'whoami is not a returned-first command');
});
