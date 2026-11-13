/** A pulled gate refuses an uncountable doctrine check and reports a rise during its report-only trial [D1,D3,C7]. */
import assert from 'node:assert/strict';
import {
  appendFileSync,
  mkdirSync,
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

/** Submit from a worktree and wait for the pulled gate's receipt; the refusals and notes a red or green gate reports are under gate.analysis [P7,C7]. */
async function settled(t, box, web, id) {
  const sent = await box.inProcess(web, 'submit', String(id), '--json');
  assert.equal(sent.code, 0, sent.err + sent.out);
  return settleSubmit(t, box, JSON.parse(sent.out));
}

/** The item's thread as text, where the board records a pulled gate's refusal-trial lines [C7]. */
async function threadText(box, id) {
  const shown = JSON.parse((await box.inProcess(box.repo, 'show', String(id), '--json', '--no-next')).out);
  return shown.thread.map(row => row.text ?? '').join('\n');
}

test("a pulled gate refuses an uncountable check and reports rises during the report-only trial [D1,D3,C7]", async t => {
  const box = await checkedProject('count: 2', [NARROWED, UNCOUNTABLE]);

  // A check that exits other than 0 or 1 cannot count, so it refuses by name.
  rmSync(join(box.web, 'web', 'keep.txt'));
  box.git(box.web, 'add', '-A');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): drop the keep file [G1]');
  const uncounted = await settled(t, box, box.web, 1);
  assert.equal(uncounted.gate.green, false);
  const refusal = uncounted.gate.analysis.refusals.find(row => row.part === 'doctrine');
  assert.equal(refusal?.code, 'RATCHET_UNCOUNTED');
  assert.match(refusal.message, /Q4 The keep file stays\. cannot count: its check exited 3/);

  // A rise reports what it would refuse during this rule's twenty-clean-gate trial; the red pulled gate left item 1 claimed.
  commitWeb(box, { 'b.html': 'TODO three\n', 'keep.txt': 'keep\n' }, 'feat(web): add a page [G1]');
  const rose = await settled(t, box, box.web, 1);
  const roseOutput = `${rose.gate.analysis.notes.join('\n')}\n${await threadText(box, 1)}`;
  assert.doesNotMatch(roseOutput, /Q3 Api work/, 'files: api keeps a web-only change from running the rule');
  assert.equal(rose.gate.green, true, JSON.stringify(rose.gate.analysis));
  assert.match(roseOutput, /would refuse RATCHET_ROSE \(report-only, 0\/20 clean gates\)/);
  assert.match(roseOutput, /Q1 Web pages carry no TODO markers\. rose to 3, was 2/);
  assert.match(roseOutput, /web\/b\.html:1:TODO three/);
  assert.doesNotMatch(roseOutput, /web\/a\.html:1:TODO one/, 'only the new problem lines are named');

  // A later gate reports a new per-file problem even when the total falls.
  const gainedItem = await nextWebItem(box, 'Clear the old markers');
  commitWebAt(box, gainedItem.web, { 'a.html': 'done\n', 'b.html': 'TODO three\n' }, 'feat(web): clear the old markers [G1]');
  const gained = await settled(t, box, gainedItem.web, gainedItem.id);
  const gainedOutput = await threadText(box, gainedItem.id);
  assert.equal(gained.gate.green, true, JSON.stringify(gained.gate.analysis));
  assert.match(gainedOutput, /would refuse RATCHET_ROSE \(report-only, 1\/20 clean gates\)/);
  assert.match(gainedOutput, /web\/b\.html gains 1 problem/);
  assert.match(gainedOutput, /web\/b\.html:1:TODO three/);
});
