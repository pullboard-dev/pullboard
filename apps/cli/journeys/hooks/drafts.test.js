/** Lane and coordinator spec drafts keep distinct ids [S1,B26]. */
import assert from 'node:assert/strict';
import { runFixtureChildAsync } from '../../tests/fixtures/child.js';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

test('clause 1: a lane agent drafts a row and cites it without leaving its lane [S1,B26]', async () => {
  const box = e2e.project('pullboard spec check');
  assert.equal((await fixtureAdd(box.runLocal, box.repo, 'web', 'Show the list', '--criterion', 'web/list.html exists')).code, 0);
  const claimed = (await box.runLocal(box.web, 'claim', '1'));
  assert.equal(claimed.code, 0, claimed.out + claimed.err);
  const drafted = (await box.runLocal(box.web, 'spec', 'draft', 'A person sees their list', '--json'));
  assert.equal(drafted.code, 0, drafted.out + drafted.err);
  const id = JSON.parse(drafted.out).id;
  assert.match(id, /^G\d+$/u, `spec draft prints the new id: ${drafted.out}`);
  assert.equal(box.tryGit(box.web, 'status', '--porcelain').stdout, '', 'drafting from the lane leaves its worktree clean');
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web', 'list.html'), '<ul></ul>\n');
  box.git(box.web, 'add', 'web/list.html');
  const commit = box.tryGit(box.web, 'commit', '-q', '-m', `feat(web): show the list [${id}]`);
  assert.equal(commit.status, 0, `the lane cites its drafted row in a feature commit: ${commit.stderr}`);
  const submitted = (await box.runLocal(box.web, 'submit', '1'));
  assert.equal(submitted.code, 0, `the lane submits with the gate pullboard spec check: ${submitted.out}${submitted.err}`);

  // The coordinator's spec apply writes the board draft into SPEC.md as a draft row, and the person approves it there.
  const row = () => readFileSync(join(box.repo, 'SPEC.md'), 'utf8').split('\n').find((line) => line.startsWith(`- ${id} `));
  assert.equal(row(), undefined, 'until apply, SPEC.md does not hold the lane draft');
  const applied = (await box.runLocal(box.repo, 'spec', 'apply'));
  assert.equal(applied.code, 0, applied.out + applied.err);
  assert.match(applied.out, new RegExp(`${id} drafted from a lane, for the person to approve`, 'u'));
  assert.equal(row(), `- ${id} [draft, must] A person sees their list | gate: review`, 'spec apply writes the draft at its own id');
  assert.equal((await box.runLocal(box.repo, 'spec', 'approve', id)).code, 0, 'the person approves the drafted row as before');
  assert.equal((await box.runLocal(box.repo, 'spec', 'apply')).code, 0);
  assert.match(row(), /\[approved, must\]/u, 'the approved row is applied');
});

test('clause 2: a lane draft and a coordinator draft never share an id, in either order [S1,B26]', async () => {
  const box = e2e.project('pullboard spec check');
  const draft = async (cwd, text) => {
    const result = (await box.runLocal(cwd, 'spec', 'draft', text, '--json'));
    assert.equal(result.code, 0, result.out + result.err);
    return JSON.parse(result.out).id;
  };
  // Lane first: the coordinator's next id skips the lane's board draft.
  const laneFirst = (await draft(box.web, 'A lane row drafted first'));
  const coordinatorAfter = (await draft(box.repo, 'A coordinator row drafted after'));
  // Coordinator first, committed through the installed hooks: the lane's older files lack it, and its next id still skips it.
  const coordinatorFirst = (await draft(box.repo, 'A coordinator row drafted first'));
  box.git(box.repo, 'add', 'SPEC.md');
  const committed = box.tryGit(box.repo, 'commit', '-q', '-m', `docs(spec): draft two rows [${coordinatorAfter},${coordinatorFirst}]`);
  assert.equal(committed.status, 0, committed.stderr);
  const laneAfter = (await draft(box.web, 'A lane row drafted after'));
  const ids = [laneFirst, coordinatorAfter, coordinatorFirst, laneAfter];
  assert.equal(new Set(ids).size, 4, `every proposal keeps its own id: ${ids.join(', ')}`);
  assert.equal(box.tryGit(box.web, 'status', '--porcelain').stdout, '', 'the lane edits no file outside its lane');

  const applied = (await box.runLocal(box.repo, 'spec', 'apply'));
  assert.equal(applied.code, 0, applied.out + applied.err);
  assert.doesNotMatch(applied.out, /holds other text/u);
  const spec = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
  for (const [id, text] of [[laneFirst, 'A lane row drafted first'], [coordinatorAfter, 'A coordinator row drafted after'],
    [coordinatorFirst, 'A coordinator row drafted first'], [laneAfter, 'A lane row drafted after']]) {
    assert.ok(spec.includes(`- ${id} [draft, must] ${text} | gate: review`), `${id} keeps its own text as a draft after apply`);
  }
  const approve = (await box.runLocal(box.web, 'spec', 'approve', laneAfter));
  assert.notEqual(approve.code, 0, 'a lane cannot approve its own draft; the person does');
});

test('clause 3: a lane draft and a main-checkout draft started at the same moment keep distinct ids [S1,B26]', async () => {
  const box = e2e.project('pullboard spec check');
  const cli = resolve(import.meta.dirname, '../../pullboard.js');
  /** Start one real spec draft without waiting for it. */
  // Process-level: two separate processes contend for the board lock.
  const start = (cwd, text) => runFixtureChildAsync(process.execPath, [cli, 'spec', 'draft', text, '--json'], { cwd, env: box.env });
  const proposals = [];
  for (let pair = 1; pair <= 4; pair += 1) {
    const texts = [`A lane row from pair ${pair}`, `A coordinator row from pair ${pair}`];
    const results = await Promise.all([start(box.web, texts[0]), start(box.repo, texts[1])]);
    results.forEach((result, index) => {
      assert.equal(result.status, 0, result.context);
      proposals.push({ id: JSON.parse(result.stdout).id, text: texts[index] });
    });
  }
  assert.equal(new Set(proposals.map(({ id }) => id)).size, proposals.length, `every proposal keeps its own id: ${proposals.map(({ id }) => id).join(', ')}`);
  assert.equal(box.tryGit(box.web, 'status', '--porcelain').stdout, '', 'the lane edits no file outside its lane');

  const applied = (await box.runLocal(box.repo, 'spec', 'apply'));
  assert.equal(applied.code, 0, applied.out + applied.err);
  assert.doesNotMatch(applied.out, /holds other text/u);
  const spec = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
  for (const { id, text } of proposals) assert.ok(spec.includes(`- ${id} [draft, must] ${text} | gate: review`), `${id} keeps its own text as a draft after apply`);
  assert.notEqual((await box.runLocal(box.web, 'spec', 'approve', proposals[0].id)).code, 0, 'a lane cannot approve its own draft; the person does');

  // The same headline with a different gate and tier is another proposal: each writer keeps its own definition.
  const headline = 'A row both writers name alike';
  // Process-level: two separate processes contend for the board lock.
  const [lane, main] = await Promise.all([
    runFixtureChildAsync(process.execPath, [cli, 'spec', 'draft', headline, '--gate', 'true', '--aim', '--json'], { cwd: box.web, env: box.env }),
    runFixtureChildAsync(process.execPath, [cli, 'spec', 'draft', headline, '--gate', 'false', '--json'], { cwd: box.repo, env: box.env }),
  ]);
  assert.equal(lane.status, 0, lane.context);
  assert.equal(main.status, 0, main.context);
  const laneRow = JSON.parse(lane.stdout);
  const mainRow = JSON.parse(main.stdout);
  assert.notEqual(laneRow.id, mainRow.id, 'two definitions with one headline get two ids');
  assert.deepEqual([laneRow.row.gate, laneRow.row.tier], ['true', 'aim'], 'the lane gets back its own definition');
  assert.deepEqual([mainRow.row.gate, mainRow.row.tier], ['false', 'must'], 'the main checkout gets back its own definition');
  assert.equal(box.tryGit(box.web, 'status', '--porcelain').stdout, '');
  assert.equal((await box.runLocal(box.repo, 'spec', 'apply')).code, 0);
  const both = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
  assert.ok(both.includes(`- ${laneRow.id} [draft, aim] ${headline} | gate: true`), 'the lane row is applied as it was asked');
  assert.ok(both.includes(`- ${mainRow.id} [draft, must] ${headline} | gate: false`), 'the main row stays as it was written');
  assert.notEqual((await box.runLocal(box.web, 'spec', 'approve', laneRow.id)).code, 0, 'the person alone approves');
});

