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


test('zdiag [D1,D3]', async t => {
  const dump = {};
  let box = await checkedProject('count: 2', [NARROWED, UNCOUNTABLE]);
  rmSync(join(box.web, 'web', 'keep.txt'));
  box.git(box.web, 'add', '-A');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): drop the keep file [G1]');
  const un = await box.inProcess(box.web, 'submit', '1', '--json');
  dump.uncountedSubmit = { code: un.code, out: un.out.slice(0, 600), err: un.err.slice(0, 600) };
  const unShown = await box.inProcess(box.repo, 'show', '1', '--json', '--no-next');
  const unDoc = JSON.parse(unShown.out);
  dump.uncounted = { status: unDoc.item_status, gateJob: JSON.stringify(unDoc.gateJob).slice(0, 2500), thread: JSON.stringify(unDoc.thread.slice(-4)).slice(0, 2500) };
  assert.equal((await box.inProcess(box.web, 'claim', '1')).code, 0);
  commitWeb(box, { 'b.html': 'TODO three\n', 'keep.txt': 'keep\n' }, 'feat(web): add a page [G1]');
  const rose = await box.inProcess(box.web, 'submit', '1', '--json');
  dump.roseSubmit = { code: rose.code, out: rose.out.slice(0, 400) };
  const rShown = JSON.parse((await box.inProcess(box.repo, 'show', '1', '--json', '--no-next')).out);
  dump.rose = { status: rShown.item_status, gateJob: JSON.stringify(rShown.gateJob).slice(0, 3500), thread: JSON.stringify(rShown.thread.slice(-4)).slice(0, 2500) };
  assert.fail(JSON.stringify(dump, null, 1));
});
