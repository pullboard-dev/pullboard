/**
 * End to end on real repos: the CLI answers in this process through runIn (a real process under
 * PULLBOARD_JOURNEY_MODE=process, which the gate's parity check compares), git runs the installed hooks, and
 * worktrees are real worktrees (B1–B3, B6, V3, V4, V7, L3, L4, C3, I1, I2, P2).
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();

after(e2e.cleanup);

const {
  BIN, cockpitSource, sandboxes, sandbox, CONFIG, SPEC, project, holdingGate,
  launch, waitFor, gateEvents, commitFile, attackCommit, privateCheckSubmission,
  startView, LIGHT_BRIEF,
} = e2e;

/**
 * A gate/fixer that runs Git in two other folders. Even a failed ordinary-repo probe ends by
 * initializing the bare probe, so removing isolation visibly corrupts only this private fixture.
 */
function foreignGitScript(box, name, { fixer = false } = {}) {
  const file = join(box.dir, `${name}.cjs`);
  const ordinary = join(box.dir, `${name}-repo`);
  const bare = join(box.dir, `${name}-bare.git`);
  writeFileSync(file, [
    "const fs = require('node:fs'); const cp = require('node:child_process');",
    `const ordinary = ${JSON.stringify(ordinary)}; const bare = ${JSON.stringify(bare)};`,
    "fs.mkdirSync(ordinary); fs.mkdirSync(bare);",
    "let failed = false;",
    "const run = (cwd, args) => { const started = Date.now(); const r = cp.spawnSync('git', args, { cwd, encoding: 'utf8' }); if (r.status !== 0) { failed = true; console.error(JSON.stringify({command: ['git', ...args], status: r.status, signal: r.signal, elapsed: Date.now() - started, stderr: r.stderr})); } };",
    "run(ordinary, ['init', '-q', '-b', 'main']);",
    "fs.writeFileSync(ordinary + '/probe.txt', 'its own repository\\n');",
    "run(ordinary, ['add', 'probe.txt']); run(ordinary, ['commit', '-q', '-m', 'chore: foreign probe']);",
    "run(bare, ['init', '-q', '--bare']);",
    ...(fixer ? ["if (!failed) for (const file of process.argv.slice(2)) fs.writeFileSync(file, fs.readFileSync(file, 'utf8').trimEnd() + '\\n');"] : []),
    "process.exitCode = failed ? 1 : 0;",
  ].join('\n'));
  return { file, ordinary, bare };
}

test('decisions default up the chain, pass to the person, and return to the original asker [B25, B26, B27]', async () => {
  const box = project();
  const asked = await box.runIn(box.web, 'shout', 'Ship the patch?', '--kind', 'question', '--decision');
  assert.equal(asked.code, 0, asked.err);
  const id = /as #(\d+)/.exec(asked.out)?.[1];
  assert.ok(id, asked.out);
  assert.match((await box.runIn(box.repo, 'decisions')).out, new RegExp(`#${id} {2}web-1 \\(fixture-model\\) -> coordinator \\(unknown\\)`));
  const passed = await box.runIn(box.repo, 'pass', id, 'the checks are green');
  assert.equal(passed.code, 0, passed.err);
  const personId = /as #(\d+)/.exec(passed.out)?.[1];
  assert.ok(personId, passed.out);
  assert.match((await box.runIn(box.repo, 'decisions', '--as', 'person')).out, new RegExp(`#${personId} {2}coordinator \\(unknown\\) -> person`));
  const personModeFromAgent = await box.runIn(box.web, 'decisions', '--as', 'person');
  assert.notEqual(personModeFromAgent.code, 0);
  assert.match(personModeFromAgent.err, /B26_PERSON_ANSWER.*main checkout/);
  const agentPersonAnswer = await box.runIn(box.web, 'answer', personId, 'Ship it.', '--as', 'person');
  assert.notEqual(agentPersonAnswer.code, 0);
  assert.match(agentPersonAnswer.err, /B26_PERSON_ANSWER.*main checkout/);
  const agentAnswer = await box.runIn(box.web, 'answer', personId, 'Ship it.');
  assert.notEqual(agentAnswer.code, 0);
  assert.match(agentAnswer.err, /NOT_YOUR_DECISION/);
  const coordinatorAnswer = await box.runIn(box.repo, 'answer', personId, 'Ship it.', '--json');
  assert.notEqual(coordinatorAnswer.code, 0);
  const answerRefusal = JSON.parse(coordinatorAnswer.out);
  assert.equal(answerRefusal.error.code, 'B26_PERSON_ANSWER');
  assert.match(answerRefusal.error.next, new RegExp(`pullboard answer ${personId} "<answer>" --as person`));
  assert.match((await box.runIn(box.repo, 'answer', personId, 'Ship it.', '--as', 'person')).out, new RegExp(`person answered #${personId}; notified web-1`));
  assert.match((await box.runIn(box.web, 'resume')).out, new RegExp(`newest from person: Person answered #${personId}: Ship it\\.`));
  assert.match((await box.runIn(box.web, 'inbox')).out, new RegExp(`person -> web-1 \\(fixture-model\\): answers #${id}: Person answered #${personId}: Ship it\\.`));
  assert.match((await box.runIn(box.repo, 'decisions')).out, /no open decisions/);
  const refused = await box.runIn(box.web, 'shout', 'person', 'Ship?', '--kind', 'question', '--decision', '--json');
  assert.notEqual(refused.code, 0);
  const refusal = JSON.parse(refused.out);
  assert.equal(refusal.error.code, 'B26_PERSON_DECISION');
  assert.match(refusal.error.next, /ask your coordinator: pullboard shout coordinator/);
  const coordinatorAsk = await box.runIn(box.repo, 'shout', 'Should we publish?', '--kind', 'question', '--decision');
  assert.equal(coordinatorAsk.code, 0, coordinatorAsk.err);
  assert.match(coordinatorAsk.out, /asked person for a decision/);
  const personDecision = /as #(\d+)/.exec(coordinatorAsk.out)?.[1];
  assert.ok(personDecision, coordinatorAsk.out);
  const defaultPersonAnswer = await box.runIn(box.repo, 'answer', personDecision, 'Yes.');
  assert.notEqual(defaultPersonAnswer.code, 0);
  assert.match(defaultPersonAnswer.err, /B26_PERSON_ANSWER.*--as person/);
  assert.equal((await box.runIn(box.repo, 'answer', personDecision, 'Yes.', '--as', 'person')).code, 0);
});

test('clause 1: pullboard worktree makes a joined worktree for a lane in one command [I4]', async () => {
  const box = project();
  const made = await box.runIn(box.repo, 'worktree', 'api');
  assert.equal(made.code, 0, made.err);
  const path = join(box.dir, 'repo-api-1');
  assert.match(made.out, /on branch api\/1, joined as api-1 \(fixture-model\) in the api lane/);
  assert.match(made.out, new RegExp(`start every command with: cd ${path} &&\n {2}cd ${path} && pullboard inbox\n {2}cd ${path} && pullboard next`));
  const apiSeat = JSON.parse((await box.runIn(path, 'whoami', '--json')).out);
  assert.deepEqual([apiSeat.id, apiSeat.lane, apiSeat.model], ['api-1', 'api', 'fixture-model']);
  assert.match((await box.runIn(box.repo, 'worktree', 'api')).out, /repo-api-2 on branch api\/2, joined as api-2/);
  assert.match((await box.runIn(box.repo, 'worktree', 'nope')).err, /NO_LANE/);
});

test('a worktree without config names uncommitted init files and committed main guidance [I1,I2]', async () => {
  const box = sandbox();
  const repo = join(box.dir, 'repo');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# app\n');
  box.git(repo, 'add', 'README.md');
  box.git(repo, 'commit', '-q', '-m', 'docs: readme');
  assert.equal((await box.runIn(repo, 'init')).code, 0);
  const old = join(box.dir, 'old');
  box.git(repo, 'worktree', 'add', '-q', '--detach', old, 'HEAD');
  for (const command of [['next'], ['status'], ['join', 'web']]) {
    const said = await box.runIn(old, ...command);
    assert.equal(said.code, 1, said.out);
    assert.match(said.err, /\[NO_CONFIG\] this worktree has no pullboard\.json, and the main checkout has uncommitted Pullboard setup files:/);
    assert.ok(said.err.includes(`Commit them in the main checkout first: cd ${repo} && git add --`), said.err);
    for (const path of ['pullboard.json', 'SPEC.md', 'DOCTRINE.md']) assert.ok(said.err.includes(path), said.err);
    assert.ok(!said.err.includes('pullboard worktree <lane>'), said.err);
    assert.ok(!said.err.includes('pullboard init'), `${command[0]} never says to run init`);
  }
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: commit pullboard init files');
  const committedMain = await box.runIn(old, 'next');
  assert.equal(committedMain.code, 1, committedMain.out);
  assert.match(committedMain.err, /\[NO_CONFIG\] this worktree's commit has no pullboard\.json, though the main checkout has one: /);
  assert.ok(committedMain.err.includes(`which says what to commit first: cd ${repo} && pullboard worktree <lane>`), committedMain.err);
  const plain = join(box.dir, 'plain');
  mkdirSync(plain);
  box.git(plain, 'init', '-q');
  assert.match((await box.runIn(plain, 'next')).err, /\[NO_CONFIG\] no pullboard\.json in .*; run: pullboard init/, 'a repo with no pullboard is still told to init');
});

test('unsupported spec grammar keeps claim, refreeze, submit and verify refusals typed [A5,A1,M1]', async () => {
  const marker = '<!-- pullboard-grammar 2 -->\n';
  const setup = async () => {
    const box = project();
    assert.equal((await fixtureAdd(box.runIn, box.repo, 'web', 'Page', '--specs', 'G1', '--criterion', 'renders')).code, 0);
    return box;
  };
  const claimBox = await setup();
  writeFileSync(join(claimBox.web, 'SPEC.md'), marker + SPEC);
  for (const args of [['claim', '1'], ['next']]) {
    const refused = await claimBox.runIn(claimBox.web, ...args);
    assert.equal(refused.code, 1);
    assert.match(refused.err, /A5_GRAMMAR_VERSION.*grammar 2.*grammar 1/);
  }
  const claimJson = await claimBox.runIn(claimBox.web, 'claim', '1', '--json');
  assert.equal(claimJson.code, 1);
  assert.equal(JSON.parse(claimJson.out).error.code, 'A5_GRAMMAR_VERSION');
  writeFileSync(join(claimBox.repo, 'SPEC.md'), marker + SPEC);
  const refreeze = await claimBox.runIn(claimBox.repo, 'refreeze', '1');
  assert.equal(refreeze.code, 1);
  assert.match(refreeze.err, /A5_GRAMMAR_VERSION/);
  const refreezeJson = await claimBox.runIn(claimBox.repo, 'refreeze', '1', '--json');
  assert.equal(refreezeJson.code, 1);
  assert.equal(JSON.parse(refreezeJson.out).error.code, 'A5_GRAMMAR_VERSION');

  const submitBox = await setup();
  assert.equal((await submitBox.runIn(submitBox.web, 'claim', '1')).code, 0);
  await commitFile(submitBox, submitBox.web, 'web/page.html', '<h1>Page</h1>', 'feat(web): add page [G1]');
  writeFileSync(join(submitBox.web, 'SPEC.md'), marker + SPEC);
  const submit = await submitBox.runIn(submitBox.web, 'submit', '1');
  assert.equal(submit.code, 1);
  assert.match(submit.err, /A5_GRAMMAR_VERSION/);
  const submitJson = await submitBox.runIn(submitBox.web, 'submit', '1', '--json');
  assert.equal(submitJson.code, 1);
  assert.equal(JSON.parse(submitJson.out).error.code, 'A5_GRAMMAR_VERSION');

  const verifyBox = await setup();
  assert.equal((await verifyBox.runIn(verifyBox.web, 'claim', '1')).code, 0);
  await commitFile(verifyBox, verifyBox.web, 'web/page.html', '<h1>Page</h1>', 'feat(web): add page [G1]');
  assert.equal((await verifyBox.runIn(verifyBox.web, 'submit', '1')).code, 0);
  verifyBox.git(verifyBox.repo, 'switch', '--detach', 'web/one');
  writeFileSync(join(verifyBox.repo, 'SPEC.md'), marker + SPEC);
  const verify = await verifyBox.runIn(verifyBox.repo, 'verify', '1', 'accept', '--as', 'coordinator', '--note', 'checked');
  assert.equal(verify.code, 1);
  assert.match(verify.err, /A5_GRAMMAR_VERSION/);
  const verifyJson = await verifyBox.runIn(verifyBox.repo, 'verify', '1', 'accept', '--as', 'coordinator', '--note', 'checked', '--json');
  assert.equal(verifyJson.code, 1);
  assert.equal(JSON.parse(verifyJson.out).error.code, 'A5_GRAMMAR_VERSION');
});

// Process-level: git itself runs the installed pre-push hook, which starts the CLI through the PATH shim.
test('a linked-worktree push isolates the gate from Git hook variables and leaves both repos intact [C3]', () => {
  const box = project();
  const probe = foreignGitScript(box, 'gate');
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...CONFIG, gate: `node ${JSON.stringify(probe.file)}` }));
  box.git(box.repo, 'commit', '-qam', 'chore: a gate with foreign git commands');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const remote = join(box.dir, 'remote.git');
  box.git(box.dir, 'init', '-q', '--bare', remote);
  box.git(box.repo, 'remote', 'add', 'origin', remote);
  const head = box.git(box.web, 'rev-parse', 'HEAD');
  const pushed = box.tryGit(box.web, 'push', '-q', 'origin', 'web/one');
  assert.equal(box.git(box.repo, 'config', '--get', 'core.bare'), 'false', 'the real hook repo stays non-bare; without isolation this is true');
  assert.equal(pushed.status, 0, `${pushed.stdout}${pushed.stderr}`);
  assert.equal(box.git(remote, 'rev-parse', 'refs/heads/web/one'), head, 'the checked-out commit reached the private local remote');
  assert.equal(box.git(probe.bare, 'rev-parse', '--is-bare-repository'), 'true');
  assert.equal(box.git(probe.ordinary, 'log', '-1', '--format=%s'), 'chore: foreign probe');
  assert.equal(readFileSync(join(probe.ordinary, 'probe.txt'), 'utf8'), 'its own repository\n');
  assert.equal(box.git(box.web, 'status', '--porcelain'), '');
});

// Process-level: git itself runs the installed pre-commit hook, which starts the CLI through the PATH shim.
test('a linked-worktree commit isolates fixers while its own staged index still works [C5]', async () => {
  const box = project();
  const probe = foreignGitScript(box, 'fixer', { fixer: true });
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...CONFIG, fix: [{ run: `node ${JSON.stringify(probe.file)}`, files: ['*.js'] }] }));
  box.git(box.repo, 'commit', '-qam', 'chore: a fixer with foreign git commands');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web', 'probe.js'), 'const value = 1;   \n');
  box.git(box.web, 'add', 'web/probe.js');
  const committed = await box.tryGit(box.web, 'commit', '-q', '-m', 'feat(web): a formatted probe [G1]');
  assert.equal(box.git(box.repo, 'config', '--get', 'core.bare'), 'false');
  assert.equal(committed.status, 0, committed.stderr);
  assert.equal(box.git(probe.bare, 'rev-parse', '--is-bare-repository'), 'true');
  assert.equal(box.git(probe.ordinary, 'log', '-1', '--format=%s'), 'chore: foreign probe');
  assert.equal(box.git(box.web, 'show', 'HEAD:web/probe.js'), 'const value = 1;', 'the parent hook restaged the formatted file through its own index');
  assert.equal(box.git(box.web, 'status', '--porcelain'), '');
});
