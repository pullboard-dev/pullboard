/** A doctrine rule's check holds its count when its row is demoted, shown at submit [D1,D3,C7]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import {
  checkedProject as checkedProjectOf,
  commitWeb,
} from '../../tests/fixtures/doctrine/checked-project.js';
import { settleSubmit } from '../../tests/fixtures/submit/settle.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { project } = e2e;

const checkedProject = (fields, extraRows) => checkedProjectOf(project, fields, extraRows);

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
