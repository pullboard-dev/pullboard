/** A doctrine rule can carry a check whose count only falls, held at submit [D1,D3]. */
import assert from 'node:assert/strict';
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

