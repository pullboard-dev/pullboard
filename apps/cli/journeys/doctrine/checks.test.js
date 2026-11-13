import { holdDoctrine } from '../../../../packages/doctrine/index.js';
import { holdDoctrineAsync } from '../../../../packages/doctrine/index.js';
/** A doctrine rule can carry a check whose count only falls, held at submit [D1,D3]. */
import assert from 'node:assert/strict';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
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

/** Write web files in the worktree and commit them through its hooks. */
function commitWeb(box, files, message) {
  for (const [name, text] of Object.entries(files)) writeFileSync(join(box.web, 'web', name), text);
  box.git(box.web, 'add', '-A');
  const committed = box.tryGit(box.web, 'commit', '-q', '-m', message);
  assert.equal(committed.status, 0, `${committed.stdout}${committed.stderr}`);
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
function commitWebAt(box, web, files, message) {
  for (const [name, text] of Object.entries(files)) writeFileSync(join(web, 'web', name), text);
  box.git(web, 'add', '-A');
  const committed = box.tryGit(web, 'commit', '-q', '-m', message);
  assert.equal(committed.status, 0, `${committed.stdout}${committed.stderr}`);
}

/** Preserve exact doctrine rows while accounting only for the CLI's navigation footer. */
function assertDoctrineReport(output, expected) {
  const text = output.endsWith('\n') ? output.slice(0, -1) : output;
  const footer = /\nnext: pullboard next$/u.exec(text);
  assert.ok(footer, 'doctrine check appends its exact navigation footer');
  assert.equal(text.slice(0, footer.index), expected);
}

/** Replace the rule's committed fields on main and try to commit them through the hooks. */
function editRule(box, from, to) {
  const file = join(box.repo, 'DOCTRINE.md');
  const before = readFileSync(file, 'utf8');
  assert.ok(before.includes(from), `the doctrine holds ${from}`);
  writeFileSync(file, before.replace(from, to));
  box.git(box.repo, 'add', 'DOCTRINE.md');
  return box.tryGit(box.repo, 'commit', '-q', '-m', 'chore: change the quality count');
}

test("clause 1: a doctrine rule's check holds its count [D1,D3]", async () => {
  const box = await checkedProject('count: 2', [NARROWED, UNCOUNTABLE]);

  // A check that exits other than 0 or 1 cannot count, so it refuses by name.
  rmSync(join(box.web, 'web', 'keep.txt'));
  box.git(box.web, 'add', '-A');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): drop the keep file [G1]');
  const uncounted = await box.inProcess(box.web, 'submit', '1');
  assert.match(uncounted.err, /RATCHET_UNCOUNTED/);
  assert.match(uncounted.err, /Q4 The keep file stays\. cannot count: its check exited 3/);
  assert.equal(uncounted.code, 1, uncounted.out);

  // A rise reports what it would refuse during this rule's twenty-clean-gate trial.
  assert.equal((await box.inProcess(box.web, 'claim', '1')).code, 0, 'the refused uncounted check reopened item 1');
  commitWeb(box, { 'b.html': 'TODO three\n', 'keep.txt': 'keep\n' }, 'feat(web): add a page [G1]');
  const rose = await box.inProcess(box.web, 'submit', '1');
  const roseOutput = `${rose.out}${rose.err}`;
  assert.doesNotMatch(roseOutput, /Q3 Api work/, 'files: api keeps a web-only change from running the rule');
  assert.equal(rose.code, 0, rose.err);
  assert.match(roseOutput, /would refuse RATCHET_ROSE \(report-only, 0\/20 clean gates\)/);
  assert.match(roseOutput, /Q1 Web pages carry no TODO markers\. rose to 3, was 2/);
  assert.match(roseOutput, /web\/b\.html:1:TODO three/);
  assert.doesNotMatch(roseOutput, /web\/a\.html:1:TODO one/, 'only the new problem lines are named');

  // A later gate reports a new per-file problem even when the total falls.
  const gainedItem = await nextWebItem(box, 'Clear the old markers');
  commitWebAt(box, gainedItem.web, { 'a.html': 'done\n', 'b.html': 'TODO three\n' }, 'feat(web): clear the old markers [G1]');
  const gained = await box.inProcess(gainedItem.web, 'submit', String(gainedItem.id));
  const gainedOutput = `${gained.out}${gained.err}`;
  assert.equal(gained.code, 0, gained.err);
  assert.match(gainedOutput, /would refuse RATCHET_ROSE \(report-only, 1\/20 clean gates\)/);
  assert.match(gainedOutput, /web\/b\.html gains 1 problem/);
  assert.match(gainedOutput, /web\/b\.html:1:TODO three/);

  // A fall passes and is shown as N, was M.
  const fellItem = await nextWebItem(box, 'Finish the page');
  commitWebAt(box, fellItem.web, { 'a.html': 'TODO two\n', 'b.html': 'done\n' }, 'feat(web): finish the page [G1]');
  const fell = await box.inProcess(fellItem.web, 'submit', String(fellItem.id));
  assert.equal(fell.code, 0, fell.err);
  assert.match(fell.out, /Q1 Web pages carry no TODO markers\. · 1, was 2 · holding/);
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
  const raised = editRule(box, 'count: 2', 'count: 3');
  assert.notEqual(raised.status, 0, 'an unsigned raise is refused');
  assert.match(raised.stderr, /Q1 raises count: from 2 to 3 without the person's signature/);
  const lowered = editRule(box, 'count: 3', 'count: 1');
  assert.equal(lowered.status, 0, `${lowered.stdout}${lowered.stderr}`);
  writeFileSync(join(box.repo, 'DOCTRINE.md'), readFileSync(join(box.repo, 'DOCTRINE.md'), 'utf8').replace('count: 1', 'count: 4'));
  const approved = await box.inProcess(box.repo, 'spec', 'approve', 'doctrine:Q1');
  assert.equal(approved.code, 0, approved.err);
  box.git(box.repo, 'add', 'DOCTRINE.md');
  const signed = box.tryGit(box.repo, 'commit', '-q', '-m', 'chore: the person raises the quality count');
  assert.equal(signed.status, 0, `a raise the person approved commits: ${signed.stdout}${signed.stderr}`);
});

test("a doctrine rule's check holds its count in watch mode and nightly [D1,D3]", async () => {
  const box = await checkedProject('count: 0 | mode: watch',
    ['- Q2 [approved, must] Web pages stay TODO-free overnight. | gate: check grep -rn TODO web | count: 3 | runs: nightly']);
  commitWeb(box, { 'b.html': 'TODO three\n' }, 'feat(web): add a page [G1]');
  const watched = await box.inProcess(box.web, 'submit', '1');
  assert.doesNotMatch(`${watched.out}${watched.err}`, /Q2 Web pages/, 'a nightly rule does not run at submit');
  assert.equal(watched.code, 0, watched.err);
  assert.match(watched.out, /Q1 Web pages carry no TODO markers\. · 3, was 0 · watching/);
  const report = await box.inProcess(box.web, 'doctrine', 'check');
  assert.equal(report.code, 0, 'a watched rule never fails doctrine check');
  assert.match(report.out, /^Q1 Web pages carry no TODO markers\. · 3, was 0 · watching$/m);
  assert.match(report.out, /^Q2 Web pages stay TODO-free overnight\. · 3, was 3 · holding$/m, 'doctrine check runs the nightly rule');

  // doctrine check reports a rule that rose and exits 1, with no submit involved.
  commitWeb(box, { 'c.html': 'TODO four\n' }, 'feat(web): add another page [G1]');
  const rose = await box.inProcess(box.web, 'doctrine', 'check');
  assert.equal(rose.code, 1, 'a rule that rose fails doctrine check');
  assert.match(rose.out, /^Q2 Web pages stay TODO-free overnight\. · 4, was 3 · rose$/m);
});

test("clause 2: a doctrine rule's check holds its count when its row is demoted [D1,D3]", async () => {
  const box = await checkedProject('count: 2');
  const file = join(box.repo, 'DOCTRINE.md');
  const committed = readFileSync(file, 'utf8');

  // A status-only demotion would switch the rule off, so it needs the person's approval too.
  const demoted = editRule(box, 'Q1 [approved, must]', 'Q1 [draft, must]');
  assert.notEqual(demoted.status, 0, 'an unsigned demotion is refused at commit');
  assert.match(demoted.stderr, /Q1 takes its check out of force \(draft\) without the person's signature/);
  writeFileSync(file, committed.replace(/^- Q1 .*\n/mu, ''));
  box.git(box.repo, 'add', 'DOCTRINE.md');
  const deleted = box.tryGit(box.repo, 'commit', '-q', '-m', 'chore: drop the quality rule');
  assert.notEqual(deleted.status, 0, 'deleting the rule is refused at commit');
  assert.match(deleted.stderr, /approved row Q1 is missing/);
  writeFileSync(file, committed);
  box.git(box.repo, 'add', 'DOCTRINE.md');
  assert.equal(box.git(box.repo, 'status', '--porcelain', '--', 'DOCTRINE.md'), '', 'main keeps the approved rule');

  const report = await box.inProcess(box.web, 'doctrine', 'check');
  assert.equal(report.code, 0, report.err);
  assertDoctrineReport(report.out, 'Q1 Web pages carry no TODO markers. · 2, was 2 · holding');

  commitWeb(box, { 'b.html': 'TODO three\n' }, 'feat(web): add a page [G1]');
  const rose = await box.inProcess(box.web, 'submit', '1');
  const roseOutput = `${rose.out}${rose.err}`;
  assert.equal(rose.code, 0, rose.err);
  assert.match(roseOutput, /would refuse RATCHET_ROSE \(report-only, 0\/20 clean gates\)/);
  assert.match(roseOutput, /Q1 Web pages carry no TODO markers\. rose to 3, was 2/);
});


test('the asynchronous doctrine hold preserves candidate and base ratchet decisions [D1,D3,C7]', async () => {
  const box = await checkedProject('count: 2');
  commitWeb(box, { 'a.html': 'TODO retained\n' }, 'feat(web): lower the count [G1]');
  const options = { mainCommit: box.git(box.repo, 'rev-parse', 'HEAD'), commit: box.git(box.web, 'rev-parse', 'HEAD') };
  assert.deepEqual(await holdDoctrineAsync(box.web, options), holdDoctrine(box.web, options));
  commitWeb(box, { 'a.html': 'TODO one\nTODO two\nTODO three\n' }, 'feat(web): expose a new problem [G1]');
  options.commit = box.git(box.web, 'rev-parse', 'HEAD');
  await assert.rejects(holdDoctrineAsync(box.web, options), error => error.code === 'RATCHET_ROSE' && error.message.includes('rose to 3'));
});

test('a submit hold runs scoped checks only for affected paths or checker code [D1,D3,C7]', async () => {
  const box = await checkedProject('count: 2 | files: web/a.html', [
    '- Q5 [approved, must] A local checker stays green. | gate: check node web/checker.js | count: 0 | files: api',
    '- Q6 [approved, must] An unscoped check stays green. | gate: check true | count: 0',
  ]);
  writeFileSync(join(box.repo, 'web', 'checker.js'), 'process.exit(0);\n');
  box.git(box.repo, 'add', 'web/checker.js');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: add checker');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const mainCommit = box.git(box.repo, 'rev-parse', 'HEAD');
  const seen = [];
  const run = async () => holdDoctrineAsync(box.web, { mainCommit, commit: box.git(box.web, 'rev-parse', 'HEAD'),
    // Main's own measure runs once per main commit (#2575); only the candidate's runs show the scoping.
    runCheck: async (commit, command) => { if (commit !== mainCommit) seen.push(command); return { problems: [], broken: '', seconds: 0 }; } });
  commitWeb(box, { 'unrelated.txt': 'unrelated\n' }, 'feat(web): unrelated [G1]');
  await run();
  assert.deepEqual(seen, ['true']);
  seen.length = 0;
  await run();
  assert.deepEqual(seen, [], 'the same tree reuses the unscoped rule receipt');
  commitWeb(box, { 'a.html': 'done\n' }, 'feat(web): touch a gated path [G1]');
  await run();
  assert.deepEqual(seen, ['grep -rn TODO web', 'true']);
  seen.length = 0;
  commitWeb(box, { 'checker.js': 'process.exit(1);\n' }, 'feat(web): change checker [G1]');
  await run();
  assert.deepEqual(seen, ['grep -rn TODO web', 'node web/checker.js', 'true']);
});
