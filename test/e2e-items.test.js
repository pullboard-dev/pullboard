/**
 * End to end on real repos: the CLI runs as its own process, git runs the installed hooks, and
 * worktrees are real worktrees (B1–B3, B6, V3, V4, V7, L3, L4, C3, I1, I2, P2).
 */
import assert from 'node:assert/strict';
import { runFixtureExecFile as execFileSync, startFixtureChild as spawn, runFixtureChild as spawnSync, runFixtureChild } from './fixture-child.js';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { parseSpec } from '../src/spec.js';
import { checkAtCommit } from '../src/trusted-policy.js';
import * as store from '../src/board.js';

import { createE2eHelpers } from './e2e-helpers.js';
const e2e = createE2eHelpers();
after(e2e.cleanup);
const {
  BIN, cockpitSource, sandboxes, sandbox, CONFIG, SPEC, project, holdingGate,
  launch, waitFor, gateEvents, commitFile, attackCommit, privateCheckSubmission,
  startView, LIGHT_BRIEF,
} = e2e;

test('decisions are asked, listed and answered, and evidence attached, from the command line [B21, B22, B26]', () => {
  const box = project();
  box.run(box.repo, 'add', 'web', 'Page', '--specs', 'G1');
  const asked = box.run(box.web, 'shout', 'coordinator', 'ship', 'today?', '--decision');
  assert.equal(asked.code, 0, asked.err);
  const id = /as #(\d+)/.exec(asked.out)?.[1];
  assert.ok(id, asked.out);
  assert.match(box.run(box.repo, 'decisions').out, new RegExp(`#${id} {2}web-1 \\(Test Model\\) -> coordinator \\(unknown\\), \\d+m ago: ship today\\?`));
  assert.match(box.run(box.repo, 'inbox').out, new RegExp(`web-1 \\(Test Model\\) -> coordinator \\(unknown\\): asks for a decision \\(#${id}; pullboard answer ${id}`));
  const wrongActor = box.run(box.repo, 'answer', id, 'yes, today', '--as', 'person');
  assert.notEqual(wrongActor.code, 0);
  assert.match(wrongActor.err, /B26_PERSON_ANSWER.*person mode answers only/);
  assert.match(box.run(box.repo, 'answer', id, 'yes, today').out, new RegExp(`answered #${id} to web-1 \\(Test Model\\) as #\\d+`));
  assert.match(box.run(box.repo, 'decisions').out, /no open decisions/);
  assert.match(box.run(box.web, 'inbox').out, new RegExp(`coordinator \\(unknown\\) -> web-1 \\(Test Model\\): answers #${id}: yes, today`));
  const head = box.git(box.web, 'rev-parse', 'HEAD');
  const proved = box.run(box.web, 'shout', 'coordinator', 'FINISH', 'the page', '--evidence', 'receipt', '--outcome', 'measured', '--item', '1', '--commit', 'HEAD');
  assert.equal(proved.code, 0, proved.err);
  assert.match(box.run(box.repo, 'inbox').out, new RegExp(`web-1 \\(Test Model\\) -> coordinator \\(unknown\\): FINISH the page\\n {2}receipt: measured, #1 at ${head.slice(0, 12)}`));
  assert.match(box.run(box.web, 'shout', 'coordinator', 'x', '--evidence', 'receipt', '--outcome', 'measured', '--item', '1', '--commit', 'nope').err, /BAD_EVIDENCE.*"nope"/);
});

test('decisions default up the chain, pass to the person, and return to the original asker [B25, B26, B27]', () => {
  const box = project();
  const asked = box.run(box.web, 'shout', 'Ship the patch?', '--decision');
  assert.equal(asked.code, 0, asked.err);
  const id = /as #(\d+)/.exec(asked.out)?.[1];
  assert.ok(id, asked.out);
  assert.match(box.run(box.repo, 'decisions').out, new RegExp(`#${id} {2}web-1 \\(Test Model\\) -> coordinator \\(unknown\\)`));
  const passed = box.run(box.repo, 'pass', id, 'the checks are green');
  assert.equal(passed.code, 0, passed.err);
  const personId = /as #(\d+)/.exec(passed.out)?.[1];
  assert.ok(personId, passed.out);
  assert.match(box.run(box.repo, 'decisions', '--as', 'person').out, new RegExp(`#${personId} {2}coordinator \\(unknown\\) -> person`));
  const personModeFromAgent = box.run(box.web, 'decisions', '--as', 'person');
  assert.notEqual(personModeFromAgent.code, 0);
  assert.match(personModeFromAgent.err, /B26_PERSON_ANSWER.*main checkout/);
  const agentPersonAnswer = box.run(box.web, 'answer', personId, 'Ship it.', '--as', 'person');
  assert.notEqual(agentPersonAnswer.code, 0);
  assert.match(agentPersonAnswer.err, /B26_PERSON_ANSWER.*main checkout/);
  const agentAnswer = box.run(box.web, 'answer', personId, 'Ship it.');
  assert.notEqual(agentAnswer.code, 0);
  assert.match(agentAnswer.err, /NOT_YOUR_DECISION/);
  const coordinatorAnswer = box.run(box.repo, 'answer', personId, 'Ship it.', '--json');
  assert.notEqual(coordinatorAnswer.code, 0);
  const answerRefusal = JSON.parse(coordinatorAnswer.out);
  assert.equal(answerRefusal.error.code, 'B26_PERSON_ANSWER');
  assert.match(answerRefusal.error.next, new RegExp(`pullboard answer ${personId} "<answer>" --as person`));
  assert.match(box.run(box.repo, 'answer', personId, 'Ship it.', '--as', 'person').out, new RegExp(`person answered #${personId}; notified web-1`));
  assert.match(box.run(box.web, 'resume').out, new RegExp(`newest from person: Person answered #${personId}: Ship it\\.`));
  assert.match(box.run(box.web, 'inbox').out, new RegExp(`person -> web-1 \\(Test Model\\): answers #${id}: Person answered #${personId}: Ship it\\.`));
  assert.match(box.run(box.repo, 'decisions').out, /no open decisions/);
  const refused = box.run(box.web, 'shout', 'person', 'Ship?', '--decision', '--json');
  assert.notEqual(refused.code, 0);
  const refusal = JSON.parse(refused.out);
  assert.equal(refusal.error.code, 'B26_PERSON_DECISION');
  assert.match(refusal.error.next, /ask your coordinator: pullboard shout coordinator/);
  const coordinatorAsk = box.run(box.repo, 'shout', 'Should we publish?', '--decision');
  assert.equal(coordinatorAsk.code, 0, coordinatorAsk.err);
  assert.match(coordinatorAsk.out, /asked person for a decision/);
  const personDecision = /as #(\d+)/.exec(coordinatorAsk.out)?.[1];
  assert.ok(personDecision, coordinatorAsk.out);
  const defaultPersonAnswer = box.run(box.repo, 'answer', personDecision, 'Yes.');
  assert.notEqual(defaultPersonAnswer.code, 0);
  assert.match(defaultPersonAnswer.err, /B26_PERSON_ANSWER.*--as person/);
  assert.equal(box.run(box.repo, 'answer', personDecision, 'Yes.', '--as', 'person').code, 0);
});

test('pullboard worktree makes a joined worktree for a lane in one command [I4]', () => {
  const box = project();
  const made = box.run(box.repo, 'worktree', 'api');
  assert.equal(made.code, 0, made.err);
  const path = join(box.dir, 'repo-api-1');
  assert.match(made.out, /on branch api\/1, joined as api-1 \(Test Model\) in the api lane/);
  assert.match(made.out, new RegExp(`start every command with: cd ${path} &&\n {2}cd ${path} && pullboard inbox\n {2}cd ${path} && pullboard next`));
  assert.match(box.run(path, 'whoami').out, /^api-1 \(Test Model\) \(api lane\)/);
  assert.match(box.run(box.repo, 'worktree', 'api').out, /repo-api-2 on branch api\/2, joined as api-2/);
  assert.match(box.run(box.repo, 'worktree', 'nope').err, /NO_LANE/);
});

test("a worktree starts only from a commit that holds pullboard's files as the main checkout has them [I4, C4]", () => {
  const box = sandbox();
  const repo = join(box.dir, 'repo');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  assert.equal(box.run(repo, 'init').code, 0);
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify(CONFIG, null, 2));
  writeFileSync(join(repo, 'SPEC.md'), SPEC);
  writeFileSync(join(repo, 'notes.txt'), 'mine\n');
  const nothingMade = () => {
    assert.ok(!existsSync(join(box.dir, 'repo-web-1')), 'no folder');
    assert.notEqual(box.tryGit(repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/web/1').status, 0, 'no branch');
  };
  /** Refused, with the files it names; returns the command it gives. */
  const refused = (pattern, named) => {
    const said = box.run(repo, 'worktree', 'web');
    assert.equal(said.code, 1, said.out);
    assert.match(said.err, pattern);
    for (const file of named) assert.ok(said.err.includes(file), `names ${file}: ${said.err}`);
    assert.ok(!said.err.includes('notes.txt'), 'leaves the person\'s own files out');
    nothingMade();
    const [, command] = said.err.match(/Commit them first: (.*)\n/);
    assert.ok(command.startsWith(`cd ${repo} && git add -- `), command);
    return command;
  };
  const sh = (command) => execFileSync('sh', ['-c', command], { env: box.env, encoding: 'utf8', stdio: 'pipe' });

  const first = refused(/\[NOT_COMMITTED\] this repo has no commit yet, and a new worktree starts from one; not committed: /, [
    '.githooks/pre-commit',
    'AGENTS.md',
    'DOCTRINE.md',
    'SPEC.md',
    'pullboard.json',
  ]);
  sh(first);
  for (const file of ['.githooks/pre-commit', 'AGENTS.md', 'DOCTRINE.md', 'SPEC.md', 'pullboard.json']) {
    assert.equal(box.git(repo, 'ls-tree', '--name-only', 'HEAD', '--', file), file, `${file} is committed`);
  }
  assert.equal(box.git(repo, 'ls-tree', '--name-only', 'HEAD', '--', 'notes.txt'), '', 'the command commits only those files');

  writeFileSync(join(repo, 'SPEC.md'), `${SPEC}- G3 [draft, aim] A third goal. | gate: test\n`);
  writeFileSync(join(repo, '.githooks', 'post-checkout'), '#!/bin/sh\n');
  rmSync(join(repo, 'DOCTRINE.md'));
  box.git(repo, 'add', 'notes.txt');
  refused(/\[NOT_COMMITTED\] a new worktree starts from the last commit, and these differ from it here: /, [
    '.githooks/post-checkout (not committed)',
    'DOCTRINE.md (deleted)',
    'SPEC.md (changed)',
  ]);
  box.git(repo, 'checkout', '--', 'DOCTRINE.md');
  sh(refused(/these differ from it here: \.githooks\/post-checkout \(not committed\), SPEC\.md \(changed\)\. /, []));
  assert.equal(box.git(repo, 'diff', '--cached', '--name-only'), 'notes.txt', "the person's staged file stays staged, and out of the commit");

  const made = box.run(repo, 'worktree', 'web');
  assert.equal(made.code, 0, made.err);
  assert.match(made.out, /repo-web-1 on branch web\/1, joined as web-1 \(Test Model\) in the web lane/, 'the refusals made nothing and joined no one');
  const web = join(box.dir, 'repo-web-1');
  assert.ok(readFileSync(join(web, 'SPEC.md'), 'utf8').includes('- G3 [draft'), 'it starts with the spec as committed');
  const foreign = commitFile(box, web, 'api/a.js', 'a', 'feat(web): page [G1]');
  assert.match(foreign.stderr, /outside the web lane: api\/a.js/, 'its hooks run');
});

test('a hook git ignores is committed by force before a worktree; a deleted config is restored, never re-initialized [I4, C4]', () => {
  const box = project();
  const sh = (command) => execFileSync('sh', ['-c', command], { env: box.env, encoding: 'utf8', stdio: 'pipe' });
  writeFileSync(join(box.repo, '.gitignore'), '.githooks/post-checkout\n');
  box.git(box.repo, 'add', '.gitignore');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: ignore a local hook');
  writeFileSync(join(box.repo, '.githooks', 'post-checkout'), '#!/bin/sh\n');
  const ignored = box.run(box.repo, 'worktree', 'web');
  assert.equal(ignored.code, 1, ignored.out);
  assert.match(ignored.err, /\[NOT_COMMITTED\] a new worktree starts from the last commit, and these differ from it here: \.githooks\/post-checkout \(not committed; git ignores it\)\. /);
  assert.ok(!existsSync(join(box.dir, 'repo-web-1')), 'no folder');
  const [, command] = ignored.err.match(/Commit them first: (.*)\n/);
  assert.ok(command.includes(' && git add -f -- .githooks/post-checkout && git commit '), command);
  sh(command);
  assert.equal(box.git(box.repo, 'ls-tree', '--name-only', 'HEAD', '--', '.githooks/post-checkout'), '.githooks/post-checkout', 'the ignored hook is committed');
  const made = box.run(box.repo, 'worktree', 'web');
  assert.equal(made.code, 0, made.err);
  assert.ok(existsSync(join(box.dir, 'repo-web-1', '.githooks', 'post-checkout')), 'the worktree has the hook the main checkout runs');

  box.git(box.repo, 'rm', '-q', 'pullboard.json');
  const restore = `cd ${box.repo} && git checkout HEAD -- pullboard.json`;
  for (const args of [['worktree', 'web'], ['status'], ['next']]) {
    const said = box.run(box.repo, ...args);
    assert.equal(said.code, 1, said.out);
    assert.ok(said.err.includes(`[NO_CONFIG] pullboard.json is deleted here, though this checkout's last commit has it: restore it: ${restore}\n`), said.err);
    assert.ok(!said.err.includes('pullboard init'), `${args[0]} never says to run init`);
  }
  assert.ok(!existsSync(join(box.dir, 'repo-web-2')), 'the refused worktree made nothing');
  sh(restore);
  assert.equal(box.run(box.repo, 'status').code, 0, 'restored, the board works again');
  rmSync(join(box.web, 'pullboard.json'));
  assert.ok(box.run(box.web, 'next').err.includes(`restore it: cd ${box.web} && git checkout HEAD -- pullboard.json`), 'a linked worktree restores its own');
});

test('a worktree whose commit has no pullboard.json is sent to the main checkout, never told to run init [C4]', () => {
  const box = sandbox();
  const repo = join(box.dir, 'repo');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# app\n');
  box.git(repo, 'add', 'README.md');
  box.git(repo, 'commit', '-q', '-m', 'docs: readme');
  assert.equal(box.run(repo, 'init').code, 0);
  const old = join(box.dir, 'old');
  box.git(repo, 'worktree', 'add', '-q', '--detach', old, 'HEAD');
  for (const command of [['next'], ['status'], ['join', 'web']]) {
    const said = box.run(old, ...command);
    assert.equal(said.code, 1, said.out);
    assert.match(said.err, /\[NO_CONFIG\] this worktree's commit has no pullboard\.json, though the main checkout has one: /);
    assert.ok(said.err.includes(`which says what to commit first: cd ${repo} && pullboard worktree <lane>`), said.err);
    assert.ok(!said.err.includes('pullboard init'), `${command[0]} never says to run init`);
  }
  const plain = join(box.dir, 'plain');
  mkdirSync(plain);
  box.git(plain, 'init', '-q');
  assert.match(box.run(plain, 'next').err, /\[NO_CONFIG\] no pullboard\.json in .*; run: pullboard init/, 'a repo with no pullboard is still told to init');
});

test('a red gate refuses submit [V4]', () => {
  const box = project();
  writeFileSync(join(box.repo, 'RED'), 'red');
  box.git(box.repo, 'add', 'RED');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: turn the gate red');
  box.run(box.repo, 'add', 'coordinator', 'Coordinator work');
  box.run(box.repo, 'claim', '1');
  const refused = box.run(box.repo, 'submit', '1');
  assert.equal(refused.code, 1);
  assert.match(refused.err, /GATE_RED/);
});

test('verify runs at the submitted commit, against the criterion frozen at claim [V3, V7, V9, V19]', () => {
  const box = project();
  box.run(box.repo, 'add', 'web', 'Page', '--specs', 'G1', '--criterion', 'renders a heading');
  box.run(box.web, 'claim', '1');
  commitFile(box, box.web, 'web/a.html', '<h1>Hi</h1>', 'feat(web): page [G1]');
  assert.equal(box.run(box.web, 'submit', '1').code, 0);
  assert.match(box.run(box.web, 'verify', '1', 'accept').err, /SELF_VERIFY/);
  const unsaid = box.run(box.repo, 'verify', '1', 'accept', '--note', 'ran it');
  assert.match(unsaid.err, /MAIN_IS_COORDINATOR\] this is the main checkout, so this verdict would be the coordinator's/);
  assert.match(unsaid.err, new RegExp(`Agent worktrees: web-1 \\(Test Model\\) at ${box.web}`));
  assert.match(box.run(box.web, 'verify', '1', 'accept', '--as', 'coordinator').err, /USAGE.*only in the main checkout/);
  assert.match(box.run(box.repo, 'verify', '1', 'accept', '--as', 'coordinator').err, /NOT_AT_COMMIT/);
  box.git(box.repo, 'merge', '-q', '--ff-only', 'web/one');
  writeFileSync(join(box.repo, 'SPEC.md'), SPEC.replace('The page renders.', 'The page renders a heading.'));
  assert.equal(box.run(box.repo, 'spec', 'approve', 'G1').code, 0);
  box.git(box.repo, 'commit', '-qam', 'docs: tighten G1');
  assert.match(box.run(box.repo, 'verify', '1', 'accept', '--as', 'coordinator').err, /CRITERIA_CHANGED/);
  assert.match(box.run(box.repo, 'refreeze', '1').out, /refrozen/);
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  box.run(box.web, 'claim', '1');
  assert.equal(box.run(box.web, 'submit', '1').code, 0);
  assert.match(box.run(box.repo, 'verify', '1', 'accept', '--as', 'coordinator').err, /PROOF_REQUIRED/);
  assert.match(box.run(box.repo, 'verify', '1', 'accept', '--as', 'coordinator', '--note', 'removed the heading; the page test failed').out, /verified #1: CRITERION_MET/);
  const show = box.run(box.repo, 'show', '1').out;
  assert.match(show, /G1: The page renders a heading\./);
  assert.match(show, /ACCEPT CRITERION_MET by coordinator/);
  const ledger = box.run(box.repo, 'ledger').out;
  assert.match(ledger, /1 verified by a second agent/);
  assert.match(ledger, /\| 1 \| web \| Page \| G1 \| web-1 \(Test Model\) \| coordinator \(unknown\) \|/);
});

test('unsupported spec grammar keeps claim, refreeze, submit and verify refusals typed [A5,A1,M1]', () => {
  const marker = '<!-- pullboard-grammar 2 -->\n';
  const setup = () => {
    const box = project();
    assert.equal(box.run(box.repo, 'add', 'web', 'Page', '--specs', 'G1', '--criterion', 'renders').code, 0);
    return box;
  };
  const claimBox = setup();
  writeFileSync(join(claimBox.web, 'SPEC.md'), marker + SPEC);
  for (const args of [['claim', '1'], ['next']]) {
    const refused = claimBox.run(claimBox.web, ...args);
    assert.equal(refused.code, 1);
    assert.match(refused.err, /A5_GRAMMAR_VERSION.*grammar 2.*grammar 1/);
  }
  const claimJson = claimBox.run(claimBox.web, 'claim', '1', '--json');
  assert.equal(claimJson.code, 1);
  assert.equal(JSON.parse(claimJson.out).error.code, 'A5_GRAMMAR_VERSION');
  writeFileSync(join(claimBox.repo, 'SPEC.md'), marker + SPEC);
  const refreeze = claimBox.run(claimBox.repo, 'refreeze', '1');
  assert.equal(refreeze.code, 1);
  assert.match(refreeze.err, /A5_GRAMMAR_VERSION/);
  const refreezeJson = claimBox.run(claimBox.repo, 'refreeze', '1', '--json');
  assert.equal(refreezeJson.code, 1);
  assert.equal(JSON.parse(refreezeJson.out).error.code, 'A5_GRAMMAR_VERSION');

  const submitBox = setup();
  assert.equal(submitBox.run(submitBox.web, 'claim', '1').code, 0);
  commitFile(submitBox, submitBox.web, 'web/page.html', '<h1>Page</h1>', 'feat(web): add page [G1]');
  writeFileSync(join(submitBox.web, 'SPEC.md'), marker + SPEC);
  const submit = submitBox.run(submitBox.web, 'submit', '1');
  assert.equal(submit.code, 1);
  assert.match(submit.err, /A5_GRAMMAR_VERSION/);
  const submitJson = submitBox.run(submitBox.web, 'submit', '1', '--json');
  assert.equal(submitJson.code, 1);
  assert.equal(JSON.parse(submitJson.out).error.code, 'A5_GRAMMAR_VERSION');

  const verifyBox = setup();
  assert.equal(verifyBox.run(verifyBox.web, 'claim', '1').code, 0);
  commitFile(verifyBox, verifyBox.web, 'web/page.html', '<h1>Page</h1>', 'feat(web): add page [G1]');
  assert.equal(verifyBox.run(verifyBox.web, 'submit', '1').code, 0);
  verifyBox.git(verifyBox.repo, 'switch', '--detach', 'web/one');
  writeFileSync(join(verifyBox.repo, 'SPEC.md'), marker + SPEC);
  const verify = verifyBox.run(verifyBox.repo, 'verify', '1', 'accept', '--as', 'coordinator', '--note', 'checked');
  assert.equal(verify.code, 1);
  assert.match(verify.err, /A5_GRAMMAR_VERSION/);
  const verifyJson = verifyBox.run(verifyBox.repo, 'verify', '1', 'accept', '--as', 'coordinator', '--note', 'checked', '--json');
  assert.equal(verifyJson.code, 1);
  assert.equal(JSON.parse(verifyJson.out).error.code, 'A5_GRAMMAR_VERSION');
});

test('pre-push runs the gate once per tree and pushes only the checked-out commit [C3]', () => {
  const box = project();
  const remote = join(box.dir, 'remote.git');
  box.git(box.dir, 'init', '-q', '--bare', remote);
  box.git(box.repo, 'remote', 'add', 'origin', remote);
  const first = box.tryGit(box.repo, 'push', '-q', 'origin', 'main');
  assert.equal(first.status, 0, first.stderr);
  assert.ok(existsSync(join(box.repo, '.git', 'pullboard-gate-green')));
  assert.match(box.run(box.repo, 'gate').out, /this tree already passed/);
  const elsewhere = box.tryGit(box.repo, 'push', '-q', 'origin', 'web/one:web/one');
  assert.equal(elsewhere.status, 0, 'web/one is at the same commit as main, so it is what is checked out');
  assert.match(`${elsewhere.stdout}${elsewhere.stderr}`, /the gate passed on this exact tree; not running it twice/, 'the second push of a passed tree skips the gate');
  commitFile(box, box.web, 'web/b.html', 'b', 'feat(web): second page [G1]');
  const notHere = box.tryGit(box.repo, 'push', '-q', 'origin', 'web/one');
  assert.notEqual(notHere.status, 0);
  assert.match(notHere.stderr, /is not checked out/);
});

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

test('a linked-worktree commit isolates fixers while its own staged index still works [C5]', () => {
  const box = project();
  const probe = foreignGitScript(box, 'fixer', { fixer: true });
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...CONFIG, fix: [{ run: `node ${JSON.stringify(probe.file)}`, files: ['*.js'] }] }));
  box.git(box.repo, 'commit', '-qam', 'chore: a fixer with foreign git commands');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web', 'probe.js'), 'const value = 1;   \n');
  box.git(box.web, 'add', 'web/probe.js');
  const committed = box.tryGit(box.web, 'commit', '-q', '-m', 'feat(web): a formatted probe [G1]');
  assert.equal(box.git(box.repo, 'config', '--get', 'core.bare'), 'false');
  assert.equal(committed.status, 0, committed.stderr);
  assert.equal(box.git(probe.bare, 'rev-parse', '--is-bare-repository'), 'true');
  assert.equal(box.git(probe.ordinary, 'log', '-1', '--format=%s'), 'chore: foreign probe');
  assert.equal(box.git(box.web, 'show', 'HEAD:web/probe.js'), 'const value = 1;', 'the parent hook restaged the formatted file through its own index');
  assert.equal(box.git(box.web, 'status', '--porcelain'), '');
});

/**
 * Run `pullboard claim` from two worktrees at once, so both race for the same lock.
 */
function race(box, first, second, id) {
  const one = (cwd) =>
    new Promise((done) => {
      const child = spawn(process.execPath, [BIN, 'claim', String(id)], { cwd, env: box.env });
      let err = '';
      child.stderr.on('data', (chunk) => {
        err += chunk;
      });
      child.on('close', (code) => done({ cwd, code, err }));
    });
  return Promise.all([one(first), one(second)]);
}

test('two agents racing for one item: exactly one wins, every time [B2]', async () => {
  const box = project();
  const second = join(box.dir, 'web-2');
  box.git(box.repo, 'worktree', 'add', '-q', second, '-b', 'web/two');
  assert.match(box.run(second, 'join', 'web').out, /joined as web-2/);
  for (let round = 1; round <= 6; round += 1) {
    box.run(box.repo, 'add', 'web', `Item ${round}`);
    const results = await race(box, box.web, second, round);
    const winners = results.filter((result) => result.code === 0);
    const losers = results.filter((result) => result.code !== 0);
    assert.equal(winners.length, 1, `round ${round}: ${JSON.stringify(results)}`);
    assert.match(losers[0].err, /HELD/);
    assert.equal(box.run(winners[0].cwd, 'release', String(round)).code, 0);
  }
});

test('next claims the next free item; --verify names the next to check [N2]', () => {
  const box = project();
  box.run(box.repo, 'add', 'web', 'Page', '--specs', 'G1');
  box.run(box.repo, 'add', 'web', 'Second page', '--specs', 'G1', '--after', '1');
  const first = box.run(box.web, 'next');
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /claimed #1: Page/);
  assert.match(first.out, /G1: The page renders\./);
  assert.match(first.out, new RegExp(`when it is built and committed: cd ${box.web} && pullboard submit 1`));
  assert.match(box.run(box.web, 'next').out, /you hold #1: Page/);
  commitFile(box, box.web, 'web/a.html', 'a', 'feat(web): page [G1]');
  box.run(box.web, 'submit', '1');
  const blocked = box.run(box.web, 'next');
  assert.equal(blocked.code, 1);
  assert.match(blocked.err, /NOTHING_FREE\] #2 waits on #1 \(submitted, web lane\)/);
  assert.match(box.run(box.repo, 'next', '--verify').err, /MAIN_IS_COORDINATOR/);
  const named = box.run(box.repo, 'next', '--verify', '--as', 'coordinator').out;
  assert.match(named, /next to verify: #1 Page, built by web-1/);
  assert.match(named, new RegExp(`check out exactly that commit, here: cd ${box.repo} && git switch --detach [0-9a-f]{40}`));
  assert.match(named, /pullboard verify 1 accept --as coordinator --note/);
  assert.match(box.run(box.web, 'next', '--verify').err, /NOTHING_FREE/);
});

test('next --verify can reserve a named submitted review and default to the lowest free one [V15]', () => {
  const box = project();
  const reviewers = ['api-1', 'api-2'].map((name) => {
    const path = join(box.dir, name);
    box.git(box.repo, 'worktree', 'add', '-q', '--detach', path);
    const joined = box.run(path, 'join', 'api');
    assert.equal(joined.code, 0, joined.err);
    return path;
  });
  const board = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  let first;
  let second;
  try {
    const commit = box.git(box.repo, 'rev-parse', 'HEAD');
    const tree = box.git(box.repo, 'rev-parse', 'HEAD^{tree}');
    /** Create and submit an item through the real SQLite board state. */
    const submit = (title) => {
      const id = store.addItem(board, { by: 'coordinator', lane: 'web', title });
      store.claim(board, id, {
        agentId: 'web-1', lane: 'web', leaseMs: 60 * 60_000,
        freeze: (item) => ({ text: item.item_title, digest: `digest:${item.item_title}` }),
      });
      store.submit(board, id, { agentId: 'web-1', commit, tree });
      return id;
    };
    first = submit('First review');
    second = submit('Second review');
  } finally {
    store.closeBoard(board);
  }

  const named = box.run(reviewers[0], 'next', '--verify', String(second));
  assert.equal(named.code, 0, named.err);
  assert.match(named.out, new RegExp(`next to verify: #${second} Second review, built by web-1`));
  assert.match(named.out, new RegExp(`check out exactly that commit, here: cd ${reviewers[0]} && git switch --detach [0-9a-f]{40}`));
  const namedJson = box.run(reviewers[0], 'next', '--verify', String(second), '--json');
  assert.equal(namedJson.code, 0, namedJson.err);
  const result = JSON.parse(namedJson.out);
  assert.equal(result.version, 1);
  assert.equal(result.item.item_id, second);
  assert.equal(result.review, true);
  assert.equal(result.held, false);
  assert.deepEqual(result.shared, []);
  const reserved = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    assert.equal(store.getItem(reserved, second).item_review_by, 'api-1', 'the named item is reserved for the caller');
  } finally {
    store.closeBoard(reserved);
  }

  const held = box.run(reviewers[1], 'next', '--verify', String(second));
  assert.equal(held.code, 1, held.out);
  assert.match(held.err, /REVIEW_HELD/);
  const builder = box.run(box.web, 'next', '--verify', String(first));
  assert.equal(builder.code, 1, builder.out);
  assert.match(builder.err, /SELF_VERIFY/);

  const lowest = box.run(reviewers[1], 'next', '--verify');
  assert.equal(lowest.code, 0, lowest.err);
  assert.match(lowest.out, new RegExp(`next to verify: #${first} First review, built by web-1`));
});

test('a deleted spec row is refused at commit; spec check finds any id gone from history or cited [S8, S9]', () => {
  const box = project();
  const spec = join(box.repo, 'SPEC.md');
  writeFileSync(spec, SPEC.replace(/- G2 .*\n/, ''));
  box.git(box.repo, 'add', 'SPEC.md');
  const refused = box.tryGit(box.repo, 'commit', '-q', '-m', 'docs(spec): drop the api row');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /SPEC.md: G2 is gone; ids are permanent: keep the row and mark it wont/);
  box.git(box.repo, 'commit', '-q', '--no-verify', '-m', 'docs(spec): drop the api row');
  box.git(box.repo, 'commit', '-q', '--no-verify', '--allow-empty', '-m', 'feat(web): ghost [G7]');
  writeFileSync(spec, `${SPEC.replace(/- G2 .*\n/, '')}- G3 [draft, must] Not committed yet.\n`);
  assert.equal(box.run(box.repo, 'add', 'web', 'Uses G3', '--specs', 'G3').code, 0);
  writeFileSync(spec, SPEC.replace(/- G2 .*\n/, ''));
  const check = box.run(box.repo, 'spec', 'check');
  assert.equal(check.code, 1);
  assert.match(check.out, /SPEC.md: G2 error: was committed in [0-9a-f]{12} and is gone/);
  assert.match(check.out, /SPEC.md: G7 error: commit [0-9a-f]{7,} cites it, but it was never committed/);
  assert.match(check.out, /SPEC.md: G3 error: item #1 cites it, but it was never committed/);
  writeFileSync(spec, `${SPEC.replace('- G2 [approved, must]', '- G2 [wont, must]')}- G3 [retired] Planned before the spec settled.\n- G7 [retired] Cited by mistake.\n`);
  const fixed = box.run(box.repo, 'spec', 'check');
  assert.equal(fixed.code, 0, fixed.out);
  box.git(box.repo, 'add', 'SPEC.md');
  assert.equal(box.tryGit(box.repo, 'commit', '-q', '-m', 'docs(spec): keep every id').status, 0);
  const cited = commitFile(box, box.repo, 'docs/api.md', 'x', 'feat(api): call the api [G2]');
  assert.notEqual(cited.status, 0);
  assert.match(cited.stderr, /G2 is marked won't build/);
});
