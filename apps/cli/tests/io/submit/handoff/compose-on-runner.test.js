/** With submit.composeOnRunner on, the submit command merges neither main nor trunk and sends the unmerged head to the gate job; off, it merges as before [C7,#10756]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixtureMachineSettings } from '../../../../../../packages/gate/tests/fixtures/testkit.js';
import { runFixtureGit } from '../../../../../../packages/gate/tests/fixtures/child.js';
import { jobsOf } from '../../../../../../packages/jobs/index.js';
import { pullProject } from '../../../fixtures/pull.js';
import { pullQueue } from '../../../fixtures/pull.js';

/** Claim item 1, commit one file in its folder, move main on, and submit with submit.composeOnRunner set as `on` says; with `declared`, accepted main also declares gen/out.txt as made from gen/in.txt with submit.regenerateDeclared on, and the item edits only gen/in.txt. */
async function submitted(t, { on, declared = false }) {
  const box = await pullProject(t, 1);
  if (declared) {
    const configFile = join(box.repo, 'pullboard.json');
    const config = JSON.parse(readFileSync(configFile, 'utf8'));
    config.lanes.web.owns.push('gen/');
    config.submit = { ...(config.submit ?? {}), regenerateDeclared: true };
    config.generated = [{ file: 'gen/out.txt', generator: 'cp gen/in.txt gen/out.txt', inputs: ['gen/in.txt'] }];
    assert.equal((await box.helpers.commitFile(box, box.repo, 'gen/in.txt', 'one\n', 'chore: declare a generated file [G1]')).status, 0);
    assert.equal((await box.helpers.commitFile(box, box.repo, 'gen/out.txt', 'one\n', 'chore: its generated output [G1]')).status, 0);
    assert.equal((await box.helpers.commitFile(box, box.repo, 'pullboard.json', JSON.stringify(config), 'chore: accept the generated policy [G1]')).status, 0);
    box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  }
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { gate: { localRunner: false, runnerDispatch: 'pull' }, ...(on ? { submit: { composeOnRunner: true } } : {}) });
  const [id] = box.ids;
  const claimed = await box.runLocal(box.web, 'claim', String(id), '--json');
  assert.equal(claimed.code, 0, claimed.err);
  const folder = JSON.parse(claimed.out).itemFolder ?? box.web;
  if (declared) assert.equal((await box.helpers.commitFile(box, folder, 'gen/in.txt', 'two\n', `feat(web): change the generator input ${id} [G1]`)).status, 0);
  assert.equal((await box.helpers.commitFile(box, folder, `web/${id}.txt`, `compose ${id}\n`, `feat(web): runner composed submit ${id} [G1]`)).status, 0);
  assert.equal((await box.helpers.commitFile(box, box.repo, 'web/newer-main.txt', 'newer\n', 'feat(web): main moved on [G1]')).status, 0);
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env: box.env }).trim();
  const head = git(folder, 'rev-parse', 'HEAD');
  const main = git(box.repo, 'rev-parse', 'refs/heads/main');
  const result = await box.runLocal(folder, 'submit', String(id));
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  const { board } = await pullQueue(t, box);
  const [row] = jobsOf(board.db, { kind: 'gate', item: id });
  return { folder, git, head, main, id, result, row };
}

test('cli.io-submit-handoff-compose-on-runner.with-the-setting-on-submit-merges: clause 1: with submit.composeOnRunner on, submit runs no main merge, compose or trunk merge and queues the unmerged head [C7,#10756]', async t => {
  const { folder, git, head, main, id, result, row } = await submitted(t, { on: true });
  assert.equal(row.candidate, head, 'the gate job carries the head, not a composition');
  assert.equal(git(folder, 'rev-parse', 'HEAD'), head, 'HEAD did not move');
  assert.equal(git(folder, 'rev-list', '--merges', head), '', 'the branch got no merge commit');
  assert.equal(git(folder, 'for-each-ref', 'refs/pullboard/compose'), '', 'no compose ref was written');
  assert.doesNotMatch(result.out, /Composed main|Merged main/u, 'the command printed no merge line');
  assert.notEqual(main, head);
  assert.ok(id);
});

test('cli.io-submit-handoff-compose-on-runner.with-the-setting-off-submit-merges-as: clause 2: with submit.composeOnRunner off, submit still merges main into the builder source as before [C7,#10756]', async t => {
  const { git, folder, head, main, result, row } = await submitted(t, { on: false });
  assert.notEqual(row.candidate, head, 'the gate job carries the merged commit');
  assert.equal(git(folder, 'show', '-s', '--format=%P', row.candidate), `${head} ${main}`, 'parents are head then main');
  assert.match(result.out, /Merged main .* into the builder source/u);
});

test('cli.io-submit-handoff-compose-on-runner.on-a-stale-declared-file-no-regeneration: clause 1: with submit.composeOnRunner on and submit.regenerateDeclared on, a submit whose declared generated file is stale does not regenerate it and sends the builder head unchanged [C7,#10757]', async t => {
  const { folder, git, head, result, row } = await submitted(t, { on: true, declared: true });
  assert.equal(row.candidate, head, 'the gate job carries the builder head');
  assert.equal(git(folder, 'rev-parse', 'HEAD'), head, 'HEAD did not move');
  assert.equal(git(folder, 'show', `${head}:gen/out.txt`), 'one', 'the stale output is left for the runner');
  assert.doesNotMatch(result.out, /Regenerated gen\/out\.txt/u, 'the command printed no regeneration line');
});

test('cli.io-submit-handoff-compose-on-runner.off-a-stale-declared-file-regenerates: clause 2: with submit.composeOnRunner off on the same fixture, submit still regenerates the declared file and sends the regenerated head [C7,#10757]', async t => {
  const { git, folder, head, result, row } = await submitted(t, { on: false, declared: true });
  assert.notEqual(row.candidate, head, 'the gate job carries a new head');
  assert.equal(git(folder, 'show', `${row.candidate}:gen/out.txt`), 'two', 'the regenerated output is committed');
  assert.match(result.out, /Regenerated gen\/out\.txt from its declared generator/u);
});
