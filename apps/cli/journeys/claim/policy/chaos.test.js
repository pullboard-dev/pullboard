/** Fifty commits to pullboard.json while five items each cycle claim, submit and verify give zero NO_POLICY refusals [B4,R2]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';

const ITEMS = 5;
const POLICY_COMMITS = 50;

/** What the one scenario recorded: every refusal seen, the policy commits made, and each item's final status. */
const outcome = { refusals: [], policyCommits: 0, statuses: [] };

/** Run one native fixture command, record any refusal, and fail on a nonzero exit. */
async function step(box, cwd, ...args) {
  const result = await box.runLocal(cwd, ...args);
  if (result.code !== 0 || /NO_POLICY/u.test(`${result.out}${result.err}`)) outcome.refusals.push({ args, code: result.code, text: (result.err || result.out).slice(0, 300) });
  assert.equal(result.code, 0, `${args.join(' ')}: ${result.err || result.out}`);
  return result;
}

/** Commit one change to the lane check in pullboard.json on main, as a person editing policy does. */
function changePolicy(box) {
  const file = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  outcome.policyCommits += 1;
  config.gate = `test ! -f RED-${outcome.policyCommits}`;
  writeFileSync(file, JSON.stringify(config, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', `chore: change the lane check ${outcome.policyCommits} [G1]`);
}

/** Commit the share of the 50 policy changes that falls before call number `call` (0 claim, 1 submit, 2 verify) of item n, so the fifteen calls together see exactly 50. */
function policyBefore(box, n, call) {
  const slot = (n - 1) * 3 + call;
  const share = Math.floor(POLICY_COMMITS * (slot + 1) / (ITEMS * 3)) - Math.floor(POLICY_COMMITS * slot / (ITEMS * 3));
  for (let c = 0; c < share; c += 1) changePolicy(box);
}

test('cli.journeys-claim-policy-chaos.fifty-policy-commits-zero-no-policy: clause 1: while 50 commits to pullboard.json change a lane check, 5 items each cycle claim, submit and verify accept in process and no call returns NO_POLICY [B4,R2]', { timeout: 900_000 }, async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  for (let n = 1; n <= ITEMS; n += 1) await step(box, box.repo, 'add', 'web', `Policy chaos item ${n}`, '--specs', 'G1', '--criterion', 'The page renders.');
  mkdirSync(join(box.web, 'web'), { recursive: true });
  for (let n = 1; n <= ITEMS; n += 1) {
    // The 50 policy commits are spread evenly over the fifteen calls (claim, submit, verify for each of the five items): 3 or 4 before each.
    // Land is not driven here: the main-refusals journeys cover it.
    policyBefore(box, n, 0);
    await step(box, box.web, 'claim', String(n));
    writeFileSync(join(box.web, `web/page${n}.html`), `<h1>Page ${n}</h1>\n`);
    box.git(box.web, 'add', `web/page${n}.html`);
    box.git(box.web, 'commit', '-q', '-m', `feat(web): render page ${n} [G1]`);
    policyBefore(box, n, 1);
    await step(box, box.web, 'submit', String(n), '--no-next');
    const shown = JSON.parse((await step(box, box.repo, 'show', String(n), '--json')).out);
    const submittedAt = shown.item_commit;
    assert.ok(submittedAt, `item ${n} has no submitted commit; status ${shown.item_status}`);
    policyBefore(box, n, 2);
    box.git(box.repo, 'switch', '-q', '--detach', submittedAt);
    await step(box, box.repo, 'verify', String(n), 'accept', '--note', `Policy chaos cycle ${n}`, '--as', 'coordinator', '--no-next');
    box.git(box.repo, 'switch', '-q', 'main');
  }
  for (let n = 1; n <= ITEMS; n += 1) outcome.statuses.push(JSON.parse((await step(box, box.repo, 'show', String(n), '--json')).out).item_status);
  assert.equal(outcome.policyCommits, POLICY_COMMITS, 'the scenario made fifty policy commits');
  assert.deepEqual(outcome.refusals, [], 'no call returned NO_POLICY or any other refusal');
});

test('cli.journeys-claim-policy-chaos.all-five-items-verified-none-stranded: clause 2: the same case ends with all 5 items verified and none stranded [B4,R2]', () => {
  assert.equal(outcome.statuses.length, ITEMS, 'the first case read every item');
  assert.deepEqual(outcome.statuses.filter(status => status !== 'verified'), [], 'every item ends verified');
});
