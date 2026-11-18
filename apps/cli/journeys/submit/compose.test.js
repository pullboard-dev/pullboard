/** With submit.composeAsObject on, submit composes main with the head as a throwaway object under refs/pullboard/compose and never writes a branch commit [C7,U159]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureMachineSettings } from '../../../../packages/gate/tests/fixtures/testkit.js';
import { runFixtureGit } from '../../../../packages/gate/tests/fixtures/child.js';
import { jobsOf } from '../../../../packages/jobs/index.js';
import { pullProject } from '../../tests/fixtures/pull.js';
import { pullQueue } from '../../tests/fixtures/pull.js';

/** Claim item 1, commit one file in its folder, then move main on, with submit.composeAsObject set as `on` says. */
async function readySubmit(t, { on }) {
  const box = await pullProject(t, 1);
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { gate: { localRunner: false, runnerDispatch: 'pull' }, ...(on ? { submit: { composeAsObject: true } } : {}) });
  const [id] = box.ids;
  const claimed = await box.runLocal(box.web, 'claim', String(id), '--json');
  assert.equal(claimed.code, 0, claimed.err);
  const folder = JSON.parse(claimed.out).itemFolder ?? box.web;
  assert.equal((await box.helpers.commitFile(box, folder, `web/${id}.txt`, `compose ${id}\n`, `feat(web): composed submit ${id} [G1]`)).status, 0);
  assert.equal((await box.helpers.commitFile(box, box.repo, 'web/newer-main.txt', 'newer\n', 'feat(web): main moved on [G1]')).status, 0);
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env: box.env }).trim();
  const branch = git(folder, 'rev-parse', '--symbolic-full-name', 'HEAD');
  const before = { head: git(folder, 'rev-parse', 'HEAD'), branch, ref: branch === 'HEAD' ? '' : git(folder, 'rev-parse', branch),
    index: git(folder, 'write-tree'), status: git(folder, 'status', '--porcelain', '--untracked-files=all') };
  return { box, id, folder, git, before, main: git(box.repo, 'rev-parse', 'refs/heads/main') };
}

/**
 * Submit item `id` from its folder and return the output, the queued gate job's commit and the item thread's submit fact.
 * A pulled submit is recorded on the board as its queued gate job; item_commit is written only when a runner's receipt lands.
 */
async function submitted(t, { box, id, folder }) {
  const result = await box.runLocal(folder, 'submit', String(id));
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  const { board } = await pullQueue(t, box);
  const [row] = jobsOf(board.db, { kind: 'gate', item: id });
  const shown = await box.runLocal(folder, 'show', String(id));
  assert.equal(shown.code, 0, shown.err);
  const fact = shown.out.split('\n').find(line => /automatic main merge: source /u.test(line)) ?? '';
  return { result, candidate: row.candidate, main: row.base, fact };
}

test('cli.journeys-submit-compose.with-submit-composeasobject-on-submit-leaves: clause 1: with submit.composeAsObject on, submit leaves the branch, HEAD, index and checkout alone and submits a composition object with parents main then head under refs/pullboard/compose [C7,U159]', async t => {
  const ready = await readySubmit(t, { on: true });
  const { folder, git, before, main, id } = ready;
  const { candidate } = await submitted(t, ready);
  assert.equal(git(folder, 'rev-parse', 'HEAD'), before.head, 'HEAD did not move');
  if (before.branch !== 'HEAD') assert.equal(git(folder, 'rev-parse', before.branch), before.ref, 'the branch ref did not move');
  assert.equal(git(folder, 'write-tree'), before.index, 'the index did not change');
  assert.equal(git(folder, 'status', '--porcelain', '--untracked-files=all'), before.status, 'the checkout did not change');
  assert.equal(git(folder, 'rev-list', '--merges', `${main}..${before.head}`), '', 'the branch got no sync merge');
  assert.equal(git(folder, 'rev-list', '--merges', before.head), '', 'the branch history holds no merge at all');
  assert.notEqual(candidate, before.head, 'the submitted commit is the composition, not the bare head');
  assert.equal(git(folder, 'show', '-s', '--format=%P', candidate), `${main} ${before.head}`, 'parents are main then head');
  const merged = git(folder, 'merge-tree', '--write-tree', main, before.head).split('\n')[0];
  assert.equal(git(folder, 'rev-parse', `${candidate}^{tree}`), merged, 'the tree is git merge-tree of main and head');
  assert.equal(git(folder, 'show', '-s', '--format=%an|%cn', candidate), 'Pullboard compose|Pullboard compose');
  assert.equal(git(folder, 'rev-parse', `refs/pullboard/compose/${id}/${main.slice(0, 12)}`), candidate, 'the compose ref keeps the composition');
});

test('cli.journeys-submit-compose.the-composition-is-the-commit-the: clause 2: the composition is the commit the board records for the submit, and the submit names it a composition, not a merge into the builder source [C7,U159]', async t => {
  const ready = await readySubmit(t, { on: true });
  const { folder, before, main, id } = ready;
  const { result, candidate, main: jobMain, fact } = await submitted(t, ready);
  assert.equal(jobMain, main, 'the gate job is pinned to the main the composition used');
  assert.equal(ready.git(folder, 'rev-parse', `refs/pullboard/compose/${id}/${main.slice(0, 12)}`), candidate, 'the gate job proves the kept composition');
  assert.match(fact, new RegExp(`composed main ${main} with head ${before.head} as an object under refs/pullboard/compose/${id}/${main.slice(0, 12)}`, 'u'));
  assert.match(fact, new RegExp(`source ${before.head}, main ${main}, merge ${candidate}\\.`, 'u'), 'the fact names the submitted composition');
  assert.match(result.out, new RegExp(`Composed main ${main.slice(0, 12)} with head ${before.head.slice(0, 12)} as ${candidate.slice(0, 12)}`, 'u'));
  assert.doesNotMatch(result.out, /into the builder source/u);
});

test('cli.journeys-submit-compose.with-the-setting-off-default-submit: clause 3: with the setting off (default), submit records the object merge with parents head then main and writes no compose ref [C7,U159]', async t => {
  const ready = await readySubmit(t, { on: false });
  const { folder, git, before, main } = ready;
  const { result, candidate, fact } = await submitted(t, ready);
  assert.match(fact, new RegExp(`source ${before.head}, main ${main}, merge ${candidate}\\.`, 'u'));
  assert.doesNotMatch(fact, /composed main/u);
  assert.equal(git(folder, 'show', '-s', '--format=%P', candidate), `${before.head} ${main}`, 'parents are head then main, as before');
  assert.equal(git(folder, 'for-each-ref', 'refs/pullboard/compose'), '', 'no compose ref is written');
  assert.match(result.out, /into the builder source/u);
  assert.equal(git(folder, 'rev-parse', 'HEAD'), before.head, 'HEAD did not move');
});
