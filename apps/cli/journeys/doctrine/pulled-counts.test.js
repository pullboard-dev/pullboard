/** A pulled submit prints each doctrine rule's count line as N, was M, holding, as the controller submit did [D1,D3,C7]. */
import assert from 'node:assert/strict';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';
import { settleSubmit } from '../../tests/fixtures/submit/settle.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { project } = e2e;

const RULE = '- Q1 [approved, must] Web pages carry no TODO markers. | gate: check grep -rn TODO web';
const NARROWED = '- Q3 [approved, must] Api work keeps the TODO count. | gate: check grep -rn TODO web | count: 2 | files: api';
const UNCOUNTABLE = '- Q4 [approved, must] The keep file stays. | gate: check test -f web/keep.txt || exit 3 | count: 0 | files: web/keep.txt';

/**
 * A project whose doctrine has one check rule with the given trailing fields, two problems on
 * main, a web worktree that carries main, and a claimed web item.
 */
async function checkedProject(fields, extraRows = []) {
  const box = project();
  appendFileSync(join(box.repo, 'DOCTRINE.md'), `\n## Q · Quality\n${[`${RULE} | ${fields}`, ...extraRows].join('\n')}\n`);
  mkdirSync(join(box.repo, 'web'));
  writeFileSync(join(box.repo, 'web', 'a.html'), 'TODO one\nTODO two\n');
  writeFileSync(join(box.repo, 'web', 'keep.txt'), 'keep\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: add the quality doctrine');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  assert.equal((await fixtureAdd(box.inProcess, box.repo, 'web', 'Page', '--specs', 'G1')).code, 0);
  assert.equal((await box.inProcess(box.web, 'claim', '1')).code, 0);
  return box;
}

/** Create and claim a fresh web item from main so it cannot stack on an unverified candidate. */
async function nextWebItem(box, title) {
  const added = await fixtureAdd(box.inProcess, box.repo, 'web', title, '--specs', 'G1', '--json');
  assert.equal(added.code, 0, added.err);
  const id = JSON.parse(added.out).item.item_id;
  assert.ok(Number.isSafeInteger(id) && id > 0, `the board returns a real item id: ${added.out}`);
  const web = join(box.dir, `web-${id}`);
  const source = box.git(box.repo, 'rev-parse', 'HEAD');
  box.git(box.repo, 'worktree', 'add', '-q', '-b', `web/fixture-${id}`, web, source);
  assert.match((await fixtureJoin(box.inProcess, web, 'web', '--model', 'Fixture Opus')).out, /joined as web-/);
  assert.equal((await box.inProcess(web, 'claim', String(id))).code, 0, `#${id} is claimed in its own worktree`);
  return { id, web };
}

/** Write a scenario's files in its own native item worktree and commit them through hooks. */
async function commitWebAt(box, web, files, message) {
  for (const [name, text] of Object.entries(files)) writeFileSync(join(web, 'web', name), text);
  box.git(web, 'add', '-A');
  const committed = await box.tryGit(web, 'commit', '-q', '-m', message);
  assert.equal(committed.status, 0, `${committed.stdout}${committed.stderr}`);
}

/** Submit from a worktree and wait for the pulled gate's receipt; the refusals and notes a red or green gate reports are under gate.analysis [P7,C7]. */
async function settled(t, box, web, id) {
  const sent = await box.inProcess(web, 'submit', String(id), '--json');
  assert.equal(sent.code, 0, sent.err + sent.out);
  return settleSubmit(t, box, JSON.parse(sent.out));
}

/** Preserve exact doctrine rows while accounting only for the CLI's navigation footer. */
function assertDoctrineReport(output, expected) {
  const text = output.endsWith('\n') ? output.slice(0, -1) : output;
  const footer = /\nnext: pullboard next$/u.exec(text);
  assert.ok(footer, 'doctrine check appends its exact navigation footer');
  assert.equal(text.slice(0, footer.index), expected);
}

/** Replace the rule's committed fields on main and try to commit them through the hooks. */
async function editRule(box, from, to) {
  const file = join(box.repo, 'DOCTRINE.md');
  const before = readFileSync(file, 'utf8');
  assert.ok(before.includes(from), `the doctrine holds ${from}`);
  writeFileSync(file, before.replace(from, to));
  box.git(box.repo, 'add', 'DOCTRINE.md');
  return await box.tryGit(box.repo, 'commit', '-q', '-m', 'chore: change the quality count');
}

test('cli.journeys-doctrine-pulled-counts.a-pulled-submit-prints-each-doctrine: clause 1: a pulled submit prints each doctrine count line as N, was M, holding [D1,D3,C7]', async t => {
  const box = await checkedProject('count: 2', [NARROWED, UNCOUNTABLE]);

  // A fall passes and is shown as N, was M.
  const fellItem = await nextWebItem(box, 'Finish the page');
  await commitWebAt(box, fellItem.web, { 'a.html': 'TODO two\n', 'b.html': 'done\n' }, 'feat(web): finish the page [G1]');
  const fell = await settled(t, box, fellItem.web, fellItem.id);
  assert.equal(fell.gate.green, true, JSON.stringify(fell.gate.analysis));
  assert.ok(fell.gate.analysis.notes.includes('doctrine: Q1 Web pages carry no TODO markers. · 1, was 2 · holding'), fell.gate.analysis.notes.join('\n'));
  const report = await box.inProcess(fellItem.web, 'doctrine', 'check');
  assert.equal(report.code, 0, report.err);
  assertDoctrineReport(report.out, [
    'Q1 Web pages carry no TODO markers. · 1, was 2 · holding',
    'Q3 Api work keeps the TODO count. · 1, was 2 · holding',
    'Q4 The keep file stays. · 0, was 0 · holding',
  ].join('\n'));
  const json = JSON.parse((await box.inProcess(fellItem.web, 'doctrine', 'check', '--json')).out);
  assert.deepEqual(json.rules.map(({ id, count, committed, holds }) => ({ id, count, committed, holds })),
    [{ id: 'Q1', count: 1, committed: 2, holds: true }, { id: 'Q3', count: 1, committed: 2, holds: true }, { id: 'Q4', count: 0, committed: 0, holds: true }]);
  assert.deepEqual(json.rules[0].problems, ['web/a.html:1:TODO two']);

  // Raising count: needs the person's signature; lowering it is a normal commit.
  const raised = await editRule(box, 'count: 2', 'count: 3');
  assert.notEqual(raised.status, 0, 'an unsigned raise is refused');
  assert.match(raised.stderr, /Q1 raises count: from 2 to 3 without the person's signature/);
  const lowered = await editRule(box, 'count: 3', 'count: 1');
  assert.equal(lowered.status, 0, `${lowered.stdout}${lowered.stderr}`);
  writeFileSync(join(box.repo, 'DOCTRINE.md'), readFileSync(join(box.repo, 'DOCTRINE.md'), 'utf8').replace('count: 1', 'count: 4'));
  const approved = await box.inProcess(box.repo, 'spec', 'approve', 'doctrine:Q1');
  assert.equal(approved.code, 0, approved.err);
  box.git(box.repo, 'add', 'DOCTRINE.md');
  const signed = await box.tryGit(box.repo, 'commit', '-q', '-m', 'chore: the person raises the quality count');
  assert.equal(signed.status, 0, `a raise the person approved commits: ${signed.stdout}${signed.stderr}`);
});
