/** A landing around a review's gate leaves the verdict standing or refuses it, by when it lands [V8,Q4]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import * as store from "../../../../packages/store/src/io/board.js";
import { openCellBoard as openBoard } from "../../../../packages/store/tests/fixtures/cell.js";
import { runFixtureChildAsync } from '../../tests/fixtures/child.js';
import { sandbox } from '../../tests/fixtures/verdict-check.js';
import { project } from '../../tests/fixtures/verdict-check.js';
import { succeeds } from '../../tests/fixtures/verdict-check.js';
import { submitted } from '../../tests/fixtures/verdict-check.js';
import { clean } from '../../tests/fixtures/verdict-check.js';

const BIN = resolve(import.meta.dirname, "../../pullboard.js");

/** Read the verdicts of one item from the repo's board, opening it read-only for the assertion. */
function verdictsOf(repo, id) {
  // @pullboard-board-file journey: read verdicts from the board file the real CLI wrote
  const board = openBoard(join(repo, '.git', 'pullboard', 'board.sqlite'));
  try { return store.verdictsFor(board, id); }
  finally { store.closeBoard(board); }
}

/** Poll until a condition holds, failing with what the test was waiting for. */
async function until(condition, what, timeoutMs = 20_000) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test('a landing while a review waits for its gate slot leaves the verdict standing [V8,Q4]', async (t) => {
  // With verify.composeAtAdmission on, verify composes against main once the gate admits it (#929). A landing
  // while the review waits in the queue must not void it; the verdict records the main it judged.
  const box = sandbox();
  t.after(() => clean(box));
  const { repo, web } = await project(box);
  const config = JSON.parse(readFileSync(join(repo, 'pullboard.json'), 'utf8'));
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ ...config, verify: { ...config.verify, composeAtAdmission: true } }, null, 2) + '\n');
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: verify composes at admission');
  box.git(web, 'merge', '-q', 'main');
  await succeeds(box, repo, 'settings', 'gateSlots', '1');
  const { id, commit } = await submitted(box, repo, web, 'Queued review', 'true');
  const reviewer = join(box.dir, 'queued-reviewer');
  box.git(repo, 'worktree', 'add', '-q', '--detach', reviewer, commit);
  await succeeds(box, reviewer, 'join', 'web');
  // A second repo holds the machine's only gate slot until its flag file says it has started.
  const holder = join(box.dir, 'holder');
  mkdirSync(holder);
  box.git(holder, 'init', '-q', '-b', 'main');
  assert.equal((await box.run(holder, 'init')).code, 0);
  const flag = join(box.dir, 'holder-started');
  writeFileSync(join(holder, 'hold.js'), `require('fs').writeFileSync(${JSON.stringify(flag)}, '1'); setTimeout(() => {}, 4000);\n`);
  const holderConfig = JSON.parse(readFileSync(join(holder, 'pullboard.json'), 'utf8'));
  writeFileSync(join(holder, 'pullboard.json'), JSON.stringify({ ...holderConfig, gate: 'node hold.js' }, null, 2) + '\n');
  box.git(holder, 'add', '-A');
  box.git(holder, 'commit', '-q', '-m', 'chore: holder');
  // Process-level by nature (2 launches below): the holder and the queued review must run concurrently as other processes
  // contending for the one gate slot, which serialized in-process dispatch cannot do.
  const holding = runFixtureChildAsync(process.execPath, [BIN, 'gate'], { cwd: holder, env: box.env, encoding: 'utf8' });
  await until(() => existsSync(flag), 'the holder to own the only gate slot');
  const verifying = runFixtureChildAsync(process.execPath, [BIN, 'verify', String(id), 'accept', '--note', 'Verified while queued'], {
    cwd: reviewer, env: box.env, encoding: 'utf8',
  });
  // The holder's check runs for four seconds; the review queues behind it. Land while both are still pending.
  let holderSettled = false;
  holding.then(() => { holderSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(holderSettled, false, 'the holder still owns the only slot when main moves');
  box.git(repo, 'switch', '-q', 'main');
  writeFileSync(join(repo, 'landed-while-queued.txt'), 'landed\n');
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'feat: land while the review queues [G1]');
  const held = await holding;
  assert.equal(held.status, 0, held.failure ?? held.stderr);
  const verified = await verifying;
  assert.equal(verified.status, 0, verified.failure ?? `${verified.stdout}${verified.stderr}`);
  const verdicts = verdictsOf(repo, id);
  assert.equal(verdicts.length, 1, 'the verdict stands after the landing');
  assert.equal(verdicts[0].verdict_decision, 'ACCEPT');
});

test('a landing during the check itself still refuses the verdict [V8]', async (t) => {
  // With verify.composeAtAdmission on, a main that moves while the frozen check runs still voids the verdict (#929).
  const box = sandbox();
  t.after(() => clean(box));
  const { repo, web } = await project(box);
  const config = JSON.parse(readFileSync(join(repo, 'pullboard.json'), 'utf8'));
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ ...config, verify: { ...config.verify, composeAtAdmission: true } }, null, 2) + '\n');
  mkdirSync(join(repo, 'web'), { recursive: true });
  writeFileSync(join(repo, 'web', 'review-input.txt'), 'before submit\n');
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: verify composes at admission');
  box.git(web, 'merge', '-q', 'main');
  // The landing changes the item's own file with the bytes it reviewed (so the composition merges cleanly), and only once the review checkout exists (an earlier empty landing keeps the submit proof from being reused): an empty or unrelated landing no longer voids a verdict (61b93a7c77).
  const reviewer = join(box.dir, 'moving-check-reviewer');
  const landing = `test -f web/review-input.txt && { [ -d '${reviewer}' ] || { git -C '${repo}' -c user.name=Fixture -c user.email=fixture@example.invalid commit --allow-empty -q -m 'feat: land before the review [G1]'; exit 0; }; mkdir -p '${repo}/web' && printf 'export const complete = true;\\n' > '${repo}/web/item-1.js' && git -C '${repo}' add web/item-1.js && git -C '${repo}' -c user.name=Fixture -c user.email=fixture@example.invalid commit --allow-empty -q -m 'feat: land during the check [G1]'; }`;
  const { id, commit } = await submitted(box, repo, web, 'Moving check', landing);
  box.git(repo, 'switch', '-q', 'main');
  writeFileSync(join(repo, 'web', 'review-input.txt'), 'after submit\n');
  box.git(repo, 'add', 'web/review-input.txt');
  box.git(repo, 'commit', '-q', '-m', 'chore: change the checked review input');
  box.git(repo, 'worktree', 'add', '-q', '--detach', reviewer, commit);
  await succeeds(box, reviewer, 'join', 'web');
  const refused = await box.run(reviewer, 'verify', String(id), 'accept', '--note', 'Verified while main moves during the check');
  assert.equal(refused.code, 1, refused.out + refused.err);
  assert.match(refused.err, /VERDICT_TRUNK_MOVED/u);
  assert.deepEqual(verdictsOf(repo, id), [], 'a verdict is not recorded for a check that saw a moved main');
});

