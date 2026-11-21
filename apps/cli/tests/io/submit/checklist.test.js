/** An item with no test check is verified only against its review checklist; an item with a check is unchanged (#996) [V19,V8]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import {
  checklistEvidenceProblem,
  namesEvidence,
} from '../../../../../packages/state/index.js';
import { createE2eHelpers } from '../../fixtures/e2e.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);
const CRITERION = 'The page meets its bar:\n1) The page names its title [reasoning]\n2) The page cites its source [reasoning]';

/** Run a command and fail with its output when it is refused. */
async function succeeds(box, cwd, ...args) {
  const result = await box.runIn(cwd, ...args);
  assert.equal(result.code, 0, `${args.join(' ')}: ${result.err}\n${result.out}`);
  return result.out;
}

/** Add, claim, tick, commit and submit one item; leave the reviewer's checkout on its commit. */
async function submitted(box, title, { check, ticks = [] }) {
  const args = ['add', 'web', title, '--specs', 'G1', '--criterion', CRITERION, '--route', 'strong', '--brief', 'Files: web/fixture.txt\nTest: the item is accepted with its recorded proof'];
  if (check) args.push('--check', check);
  const id = Number(/#(\d+)/.exec(await succeeds(box, box.repo, ...args))?.[1]);
  assert.ok(id > 0);
  await succeeds(box, box.web, 'claim', String(id));
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web', `item-${id}.js`), 'export const complete = true;\n');
  box.git(box.web, 'add', '-A');
  box.git(box.web, 'commit', '-q', '-m', `feat(web): complete fixture ${id} [G1]`);
  for (const tick of ticks) await succeeds(box, box.web, 'fact', String(id), 'note', tick);
  await succeeds(box, box.web, 'submit', String(id));
  box.git(box.repo, 'switch', '--detach', 'web/one');
  return id;
}

test('cli.journeys-submit-checklist.which-words-name-evidence-is-decided: clause 1: which words name evidence is decided mechanically: a file, a link or a quoted passage [V19,V8]', () => {
  for (const named of ['read web/page.html', 'package.json line 4', 'see https://example.com/spec#3', 'the heading says "Dashboard"', 'checked `Count: 3` in page.html', 'apps/cli/src/io/commands/check.js:71'])
    assert.equal(namesEvidence(named), true, named);
  for (const bare of ['looks fine', 'I checked it, e.g. by eye', 'done.', 'reviewed and approved', ''])
    assert.equal(namesEvidence(bare), false, bare);
});

test('cli.journeys-submit-checklist.an-item-without-a-test-check: clause 1: an item without a test check is verified only against its checklist, and a line with no evidence refuses the accept [V19,V8]', { timeout: 240_000 }, async () => {
  const box = helpers.project('true');
  const { repo } = box;
  {
    // Submit already refuses a clause with no tick, so the accept rule meets the thread directly for that case.
    const item = { item_id: 7, item_criterion: CRITERION, item_check: null, item_owner: 'web-1' };
    const missing = checklistEvidenceProblem(item, []);
    assert.equal(missing.code, 'CLAUSE_UNTICKED');
    assert.equal(missing.message, '[CLAUSE_UNTICKED] #7 has no test check, so its review checklist is its only proof, and clause 1 (The page names its title [reasoning]) has no evidence; clause 2 (The page cites its source [reasoning]) has no evidence');
    assert.equal(checklistEvidenceProblem({ ...item, item_check: 'test -f web/page.html' }, []), null, 'a check, not a checklist, proves an item that has one');

    const bare = await submitted(box, 'Checklist with a bare tick', { ticks: ['clause 1 [reasoning]: web/page.html holds the title', 'clause 2 [reasoning]: looks fine to me'] });
    const bareRefusal = JSON.parse((await box.runIn(repo, 'verify', String(bare), 'accept', '--as', 'coordinator', '--note', 'read it', '--json')).out).error;
    assert.equal(bareRefusal.code, 'CLAUSE_UNTICKED');
    assert.match(bareRefusal.message, /clause 2 \(The page cites its source \[reasoning\]\) names no file, link or quoted passage: looks fine to me/u);
    assert.doesNotMatch(bareRefusal.message, /clause 1/u, 'the evidenced line is not named');
    assert.match(bareRefusal.next ?? bareRefusal.nextStep ?? JSON.stringify(bareRefusal), /pullboard verify \d+ reject --reason TEST_FAILURE/u);

    // The reviewer rejects the bare line; the builder reworks it with named evidence and the same item then accepts.
    await succeeds(box, repo, 'verify', String(bare), 'reject', '--as', 'coordinator', '--reason', 'TEST_FAILURE', '--clause', 'The page cites its source [reasoning]', '--note', 'clause 2 names no file, link or quoted passage');
    box.git(repo, 'switch', 'main');
    await succeeds(box, box.web, 'claim', String(bare));
    await succeeds(box, box.web, 'fact', String(bare), 'note', 'clause 2 [reasoning]: https://example.com/source is cited in "export const complete"');
    writeFileSync(join(box.web, 'web', `item-${bare}.js`), 'export const complete = true; // cited\n');
    box.git(box.web, 'add', '-A');
    box.git(box.web, 'commit', '-q', '-m', `fix(web): cite the source for fixture ${bare} [G1]`);
    await succeeds(box, box.web, 'submit', String(bare));
    box.git(repo, 'switch', '--detach', 'web/one');
    const full = bare;
    const accepted = await succeeds(box, repo, 'verify', String(full), 'accept', '--as', 'coordinator', '--note', 'read the cited files');
    assert.match(accepted, /review evidence proved it/u);
    const shown = await succeeds(box, repo, 'show', String(full), '--json');
    const verdict = JSON.parse(shown).verdicts.at(-1);
    assert.equal(verdict.check, 'none', 'no test ran');
    assert.match(verdict.verdict_note, /review evidence proved it: 1\. The page names its title \[reasoning\] -> reasoning: web\/page\.html holds the title \| 2\. The page cites its source \[reasoning\] -> reasoning: https:\/\/example\.com\/source/u);
  }
});

test('cli.journeys-submit-checklist.an-item-with-a-normal-check: clause 2: an item with a normal check is unchanged: pullboard check runs it and no checklist is accepted in its place [V19,V8]', { timeout: 240_000 }, async () => {
  const box = helpers.project('true');
  const { repo, web } = box;
  {
    const id = await submitted(box, 'Checked item', { check: 'test -f web/item-1.js', ticks: ['clause 1 [reasoning]: looks fine', 'clause 2 [reasoning]: looks fine'] });
    box.git(repo, 'switch', 'main');
    const checkOut = await box.runIn(web, 'check', String(id), '--yes');
    assert.equal(checkOut.code, 0, checkOut.err);
    assert.match(checkOut.out, /check green/u, 'the frozen check still runs');
    assert.doesNotMatch(checkOut.out, /review evidence/u, 'a checklist never stands in for the check');
    box.git(repo, 'switch', '--detach', 'web/one');
    const accepted = await succeeds(box, repo, 'verify', String(id), 'accept', '--as', 'coordinator', '--note', 'the frozen check passed', '--json');
    const result = JSON.parse(accepted);
    assert.equal(result.check, 'green', 'the frozen check proved it, with no checklist consulted');
    assert.equal(result.reviewEvidence, undefined);
    const note = JSON.parse(await succeeds(box, repo, 'show', String(id), '--json')).verdicts.at(-1).verdict_note;
    assert.doesNotMatch(note, /review evidence proved it/u);
  }
});
