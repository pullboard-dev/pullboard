import { holdDoctrine } from '../../../../packages/doctrine/index.js';
import { holdDoctrineAsync } from '../../../../packages/doctrine/index.js';
/** A doctrine rule can carry a check whose count only falls, held at submit [D1,D3]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { createCheckedHelpers } from '../../tests/fixtures/doctrine-checked.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { project } = e2e;

const { checkedProject, commitWeb, settled } = createCheckedHelpers(project);

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
