import { holdDoctrine } from '../../../../packages/doctrine/index.js';
import { holdDoctrineAsync } from '../../../../packages/doctrine/index.js';
/** A doctrine rule can carry a check whose count only falls, held at submit [D1,D3]. */
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
import { settleSubmit } from '../../tests/fixtures/submit/settle.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { project } = e2e;

const RULE = '- Q1 [approved, must] Web pages carry no TODO markers. | gate: check grep -rn TODO web';

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
function editRule(box, from, to) {
  const file = join(box.repo, 'DOCTRINE.md');
  const before = readFileSync(file, 'utf8');
  assert.ok(before.includes(from), `the doctrine holds ${from}`);
  writeFileSync(file, before.replace(from, to));
  box.git(box.repo, 'add', 'DOCTRINE.md');
  return box.tryGit(box.repo, 'commit', '-q', '-m', 'chore: change the quality count');
}

test("a doctrine rule's check holds its count in watch mode and nightly at submit [D1,D3,C7]", async t => {
  const box = await checkedProject('count: 0 | mode: watch',
    ['- Q2 [approved, must] Web pages stay TODO-free overnight. | gate: check grep -rn TODO web | count: 3 | runs: nightly']);
  commitWeb(box, { 'b.html': 'TODO three\n' }, 'feat(web): add a page [G1]');
  const watched = await settled(t, box, box.web, 1);
  const notes = watched.gate.analysis.notes.join('\n');
  assert.doesNotMatch(JSON.stringify(watched.gate.analysis), /Q2 Web pages/, 'a nightly rule does not run at submit');
  assert.equal(watched.gate.green, true, JSON.stringify(watched.gate.analysis));
  assert.match(notes, /^doctrine: Q1 Web pages carry no TODO markers\. · 3, was 0 · watching$/m);
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

test("clause 2: a doctrine rule's check holds its count when its row is demoted, shown at submit [D1,D3,C7]", async t => {
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

  // A pulled gate's rise meets the board's refusal-trial ledger: it reports what it would refuse and the gate settles green.
  commitWeb(box, { 'b.html': 'TODO three\n' }, 'feat(web): add a page [G1]');
  const rose = await settled(t, box, box.web, 1);
  assert.equal(rose.gate.green, true, JSON.stringify(rose.gate.analysis));
  const shown = JSON.parse((await box.inProcess(box.repo, 'show', '1', '--json', '--no-next')).out);
  assert.equal(shown.item_status, 'submitted', 'a rise on trial never settles red');
  const thread = shown.thread.map(row => row.text ?? '').join('\n');
  assert.match(thread, /would refuse RATCHET_ROSE \(report-only, 0\/20 clean gates\)/);
  assert.match(thread, /Q1 Web pages carry no TODO markers\. rose to 3, was 2/);
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
