/** Keep the coordinator's handoff brief short, ordered, and derived from real Git and board state [N19,B3]. */
import assert from 'node:assert/strict';
import { runFixtureExecFile as execFileSync } from '../../tests/fixtures/child.js';
import { runFixtureChild as spawnSync } from '../../tests/fixtures/child.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureSettledMachine } from '../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';

const BIN = resolve(import.meta.dirname, '../../pullboard.js');
const sandboxes = [];
const SPEC = `# Resume fixture\n\n## G · Goals\n- G1 [approved, must] The first feature works. | gate: test\n- G2 [approved, must] The second feature works. | gate: test\n`;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

after(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

/** Make an isolated real-Git repo, initialized board, coordinator and strong builder. */
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-coordinator-resume-')));
  sandboxes.push(dir);
  const shims = join(dir, 'bin');
  mkdirSync(shims);
  writeFileSync(join(shims, 'pullboard'), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`, { mode: 0o755 });
  chmodSync(join(shims, 'pullboard'), 0o755);
  const env = {
    ...process.env,
    PATH: `${shims}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.com',
    PULLBOARD_HOME: join(dir, 'home'), PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
  };
  delete env.PULLBOARD_RELAY_TOKEN;
  fixtureSettledMachine(env.PULLBOARD_MACHINE_HOME);
  // The fixture is a shell with no agent session: an inherited session id would make the builder's session judge its own work.
  for (const name of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'AI_AGENT', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_CI', 'CODEX_SHELL']) delete env[name];
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  /** Run Git in this private fixture with its isolated identity. */
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env });
  /** Run the actual CLI in a fixture checkout and retain both output streams. */
  /** Fixture setup stays one synchronous real process; every case call below runs in-process. */
  const setup = (cwd, ...args) => {
    const result = runFixtureChild(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
    return { code: result.status, out: result.stdout ?? '', err: result.failure ?? result.stderr ?? '', failure: result.failure };
  };
  const run = async (cwd, ...args) => {
    const result = await runCliInProcess(args, { cwd, env });
    return { code: result.status, out: result.stdout, err: result.stderr, failure: null };
  };
  git(repo, 'init', '-q', '-b', 'main');
  assert.equal(setup(repo, 'init').code, 0);
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({
    gate: 'true', spec: 'SPEC.md', verify: 'any', lease: '2h', landing: { manualOverride: true },
    lanes: { web: { owns: ['web/'], specs: ['G1', 'G2'] } },
  }, null, 2));
  writeFileSync(join(repo, 'SPEC.md'), SPEC);
  write(repo, 'web/shared.txt', 'base\n');
  commit(git, repo, 'chore: create resume fixture');
  const made = setup(repo, 'worktree', 'web', '--route', 'strong', '--json');
  assert.equal(made.code, 0, made.err || made.out);
  const web = JSON.parse(made.out).path;
  return { dir, env, repo, web, git, run: setup, inProcess: run };
}

/** Write a fixture file and create its parent directory. */
function write(root, path, text) {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** Stage and commit the fixture's current tree through its installed hooks. */
function commit(git, cwd, message) {
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

/** Ask real Git whether one fixture commit contains another. */
function isAncestor(box, cwd, ancestor, commitId) {
  return runFixtureChild('git', ['merge-base', '--is-ancestor', ancestor, commitId], { cwd, env: box.env }).status === 0;
}

/** Add a separately joined strong builder so each item's accepted commit has an isolated branch. */
function addBuilder(box, name) {
  const cwd = join(box.dir, name);
  box.git(box.repo, 'worktree', 'add', '-q', '-b', `web/${name}`, cwd, 'main');
  const joined = fixtureJoin(box.run, cwd, 'web', '--route', 'strong');
  assert.equal(joined.code, 0, joined.err || joined.out);
  return cwd;
}

/** Add and claim a strong item with the complete brief shape expected by production. */
async function addAndClaim(box, cwd, title, row) {
  const brief = `Files:\n- web/fixture.txt\nTest:\n- inspect the committed fixture history`;
  const added = fixtureAdd(box.run, box.repo, 'web', title, '--route', 'strong', '--specs', row,
    '--criterion', 'the cited row holds', '--check', 'true', '--brief', brief);
  assert.equal(added.code, 0, added.err || added.out);
  const id = Number(/#(\d+)/u.exec(added.out)?.[1]);
  assert.ok(id > 0, added.out);
  const claimed = await box.inProcess(cwd, 'claim', String(id));
  assert.equal(claimed.code, 0, claimed.err || claimed.out);
  return id;
}

/** Submit one builder commit with a valid row-citing header. */
async function submitFile(box, cwd, id, row, path, text, subject) {
  write(cwd, path, text);
  const head = commit(box.git, cwd, `feat(web): ${subject} [${row}]`);
  const submitted = await box.inProcess(cwd, 'submit', String(id), '--no-next');
  assert.equal(submitted.code, 0, submitted.err || submitted.out);
  return head;
}

/** Verify an exact submitted commit from the main checkout, then return it to main. */
async function acceptAt(box, id, commitId) {
  box.git(box.repo, 'switch', '-q', '--detach', commitId);
  const accepted = await box.inProcess(box.repo, 'verify', String(id), 'accept', '--note', 'the frozen row holds', '--as', 'coordinator');
  assert.equal(accepted.code, 0, accepted.err || accepted.out);
  box.git(box.repo, 'switch', '-q', 'main');
}

/** Record structured integration evidence independently of the human-readable shout text. */
async function integrationEvidence(box, cwd, id, kind, outcome, commitId, text) {
  const result = await box.inProcess(cwd, 'shout', 'coordinator', text, '--evidence', kind, '--outcome', outcome,
    '--item', String(id), '--commit', commitId, '--json');
  assert.equal(result.code, 0, result.err || result.out);
  return JSON.parse(result.out).id;
}

test("clause 1: the coordinator's handoff brief orders current work and leaves agent resumes unchanged [N19,B3,C7]", async () => {
  const box = fixture();
  const cleanBuilder = box.web;
  const cleanId = await addAndClaim(box, cleanBuilder, 'Clean item', 'G1');
  const cleanHead = await submitFile(box, cleanBuilder, cleanId, 'G1', 'web/clean.txt', 'clean\n', 'add clean file');
  await acceptAt(box, cleanId, cleanHead);

  const conflictBuilder = addBuilder(box, 'conflict-builder');
  const conflictId = await addAndClaim(box, conflictBuilder, 'Conflict item', 'G1');
  const conflictHead = await submitFile(box, conflictBuilder, conflictId, 'G1', 'web/shared.txt', 'builder side\n', 'change shared file');
  await acceptAt(box, conflictId, conflictHead);

  const activeBuilder = addBuilder(box, 'active-builder');
  const activeId = await addAndClaim(box, activeBuilder, 'Typed integration', 'G1');
  const activeHead = await submitFile(box, activeBuilder, activeId, 'G1', 'web/active.txt', 'accepted base\n', 'prepare integration');
  await acceptAt(box, activeId, activeHead);
  write(activeBuilder, 'web/descendant.txt', 'later integration work\n');
  const descendant = commit(box.git, activeBuilder, 'chore(web): prepare integration descendant [G1]');
  assert.equal(isAncestor(box, activeBuilder, activeHead, descendant), true, 'the evidence SHA is a descendant of the accepted head');
  await integrationEvidence(box, activeBuilder, activeId, 'attempt', 'integrating', descendant, 'The worktree is ready for coordinator integration.');

  const supersededBuilder = addBuilder(box, 'superseded-builder');
  const supersededId = await addAndClaim(box, supersededBuilder, 'Superseded integration', 'G2');
  const supersededHead = await submitFile(box, supersededBuilder, supersededId, 'G2', 'web/superseded.txt', 'accepted\n', 'prepare superseded integration');
  await acceptAt(box, supersededId, supersededHead);
  write(supersededBuilder, 'web/superseded-descendant.txt', 'descendant\n');
  const supersededDescendant = commit(box.git, supersededBuilder, 'chore(web): prepare superseded descendant [G2]');
  await integrationEvidence(box, supersededBuilder, supersededId, 'attempt', 'integrating', supersededDescendant, 'Begin integration.');
  await integrationEvidence(box, supersededBuilder, supersededId, 'receipt', 'superseded', supersededDescendant, 'The same actor has a later receipt.');

  const plainBuilder = addBuilder(box, 'plain-builder');
  const plainId = await addAndClaim(box, plainBuilder, 'Plain text only', 'G2');
  const plainHead = await submitFile(box, plainBuilder, plainId, 'G2', 'web/plain.txt', 'plain\n', 'prepare plain evidence');
  await acceptAt(box, plainId, plainHead);
  const plain = await box.inProcess(plainBuilder, 'shout', 'coordinator', `#${plainId} integrated at ${plainHead}; does this need a follow-up?`, '--kind', 'question');
  assert.equal(plain.code, 0, plain.err || plain.out);

  const factBuilder = addBuilder(box, 'fact-builder');
  const factId = await addAndClaim(box, factBuilder, 'Fact text only', 'G2');
  const factHead = await submitFile(box, factBuilder, factId, 'G2', 'web/fact.txt', 'fact\n', 'prepare fact evidence');
  await acceptAt(box, factId, factHead);
  const fact = await box.inProcess(box.repo, 'fact', String(factId), 'note', `#${factId} integrated at ${factHead}`, '--ref', `web/fact.txt:1@${factHead}`);
  assert.equal(fact.code, 0, fact.err || fact.out);

  const unrelatedBuilder = addBuilder(box, 'unrelated-builder');
  const unrelatedId = await addAndClaim(box, unrelatedBuilder, 'Non-ancestor evidence', 'G2');
  const unrelatedHead = await submitFile(box, unrelatedBuilder, unrelatedId, 'G2', 'web/unrelated.txt', 'accepted\n', 'prepare non-ancestor evidence');
  await acceptAt(box, unrelatedId, unrelatedHead);
  const unrelatedTree = box.git(box.repo, 'rev-parse', 'main^{tree}');
  const unrelatedCommit = box.git(box.repo, 'commit-tree', unrelatedTree, '-m', 'unrelated integration evidence');
  assert.equal(isAncestor(box, box.repo, unrelatedHead, unrelatedCommit), false, 'the evidence SHA does not contain the accepted head');
  await integrationEvidence(box, unrelatedBuilder, unrelatedId, 'attempt', 'integrating', unrelatedCommit, 'This SHA is not descended from the accepted head.');
  await integrationEvidence(box, activeBuilder, activeId, 'attempt', 'integrating', unrelatedCommit, 'An invalid newer attempt cannot close the earlier valid claim.');
  await integrationEvidence(box, plainBuilder, activeId, 'receipt', 'done', descendant, 'Another actor cannot close the builder integration attempt.');

  const expiredBuilder = addBuilder(box, 'expired-builder');
  const expiredId = await addAndClaim(box, expiredBuilder, 'Expired integration evidence', 'G2');
  const expiredHead = await submitFile(box, expiredBuilder, expiredId, 'G2', 'web/expired.txt', 'accepted\n', 'prepare expired evidence');
  await acceptAt(box, expiredId, expiredHead);
  const expiredShoutId = await integrationEvidence(box, expiredBuilder, expiredId, 'attempt', 'integrating', expiredHead, 'This attempt is older than one day.');
  const boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const db = new DatabaseSync(boardFile);
  try {
    const old = new Date(Date.now() - DAY - HOUR).toISOString();
    db.prepare('UPDATE shout SET shout_at = ? WHERE shout_id = ?').run(old, expiredShoutId);
  } finally {
    db.close();
  }

  write(box.repo, 'web/shared.txt', 'trunk side\n');
  commit(box.git, box.repo, 'feat(web): trunk shared edit [G1]');

  const reviewBuilder = addBuilder(box, 'review-builder');
  const reviewId = await addAndClaim(box, reviewBuilder, 'Review item', 'G2');
  await submitFile(box, reviewBuilder, reviewId, 'G2', 'web/review.txt', 'review\n', 'submit review item');
  const conflictBeforeResume = await box.inProcess(box.repo, 'show', String(conflictId), '--json');
  assert.equal(conflictBeforeResume.code, 0, conflictBeforeResume.err || conflictBeforeResume.out);
  assert.equal(JSON.parse(conflictBeforeResume.out).item_status, 'verified', 'fixture retains the accepted receipt for resume');

  const open = await box.inProcess(cleanBuilder, 'shout', 'coordinator', 'Need a decision on the next build.', '--kind', 'question', '--decision');
  assert.equal(open.code, 0, open.err || open.out);
  const openId = Number(/#(\d+)/u.exec(open.out)?.[1]);
  const personQuestion = await box.inProcess(box.repo, 'shout', 'person', 'Should the release wait?', '--decision');
  assert.equal(personQuestion.code, 0, personQuestion.err || personQuestion.out);
  const personQuestionId = Number(/#(\d+)/u.exec(personQuestion.out)?.[1]);
  const answeredQuestion = await box.inProcess(box.repo, 'shout', 'person', 'Can the report ship today?', '--decision');
  assert.equal(answeredQuestion.code, 0, answeredQuestion.err || answeredQuestion.out);
  const answeredId = Number(/#(\d+)/u.exec(answeredQuestion.out)?.[1]);
  const answered = await box.inProcess(box.repo, 'answer', String(answeredId), 'Yes, after the review.', '--as', 'person');
  assert.equal(answered.code, 0, answered.err || answered.out);

  const oldAsk = await box.inProcess(box.repo, 'shout', 'person', 'Old answered decision.', '--decision', '--json');
  assert.equal(oldAsk.code, 0, oldAsk.err || oldAsk.out);
  const oldAskId = JSON.parse(oldAsk.out).id;
  const oldAnswer = await box.inProcess(box.repo, 'answer', String(oldAskId), 'Old answer stays in history.', '--as', 'person', '--json');
  assert.equal(oldAnswer.code, 0, oldAnswer.err || oldAnswer.out);
  const oldAnswerId = JSON.parse(oldAnswer.out).id;
  for (let index = 0; index < 4; index += 1) {
    const ask = await box.inProcess(cleanBuilder, 'shout', 'coordinator', `Additional decision ${index}: ${'detail '.repeat(50)}`, '--kind', 'question', '--decision');
    assert.equal(ask.code, 0, ask.err || ask.out);
  }

  const timestampDb = new DatabaseSync(boardFile);
  try {
    const now = Date.now();
    timestampDb.prepare('UPDATE shout SET shout_at = ? WHERE shout_id = ?').run(new Date(now - 2 * HOUR).toISOString(), openId);
    const answerId = timestampDb.prepare('SELECT shout_id FROM shout WHERE shout_answers = ? ORDER BY shout_id LIMIT 1').get(answeredId).shout_id;
    timestampDb.prepare('UPDATE shout SET shout_at = ? WHERE shout_id = ?').run(new Date(now - HOUR).toISOString(), answerId);
    timestampDb.prepare('UPDATE shout SET shout_at = ? WHERE shout_id = ?').run(new Date(now - DAY - HOUR).toISOString(), oldAnswerId);
  } finally {
    timestampDb.close();
  }

  // More than the normal recent-shout window must not hide typed evidence from resume.
  // One shout goes through the CLI; the other 44 copy its row, since a CLI start per shout dominated this case's run time.
  const noise = await box.inProcess(box.repo, 'shout', 'person', `noise 0: #${activeId} integrated at ${descendant}`);
  assert.equal(noise.code, 0, noise.err || noise.out);
  const noiseDb = new DatabaseSync(boardFile);
  try {
    const columns = noiseDb.prepare('PRAGMA table_info(shout)').all().map(column => column.name).filter(name => name !== 'shout_id');
    const template = noiseDb.prepare('SELECT * FROM shout WHERE shout_text LIKE ? ORDER BY shout_id DESC LIMIT 1').get('noise 0:%');
    const insert = noiseDb.prepare(`INSERT INTO shout (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
    for (let index = 1; index < 45; index += 1) {
      insert.run(...columns.map(name => (name === 'shout_text' ? `noise ${index}: #${activeId} integrated at ${descendant}` : template[name])));
    }
  } finally {
    noiseDb.close();
  }
  const currentSpec = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
  writeFileSync(join(box.repo, 'SPEC.md'), currentSpec.replace('The first feature works.', 'The first feature works differently.'));

  const ordinary = await box.inProcess(box.repo, 'resume', '--json');
  assert.equal(ordinary.code, 0, ordinary.err || ordinary.out);
  const indexed = JSON.parse(ordinary.out);
  assert.equal(indexed.openDecisions.length, 5, 'ordinary resume retains current coordinator obligations');
  assert.ok(indexed.staleVerdicts.some(item => item.item_id === conflictId),
    'JSON v1 retains the stale receipt without claiming its verdict is current');
  assert.ok(!indexed.toMerge.some(item => item.item_id === conflictId), 'a stale receipt is never ready to land');
  assert.equal(typeof indexed.newWorktreeLocation, 'string', 'JSON v1 retains the validated checkout guidance');
  assert.ok(indexed.verifiedNotMerged.conflicts.some(entry => entry.item.item_id === conflictId),
    'JSON v1 retains complete integration diagnostics');
  assert.doesNotMatch(indexed.next, /^git merge|^merge #/u, 'ordinary guidance retains guarded landing authority');

  const resumed = await box.inProcess(box.repo, 'resume', '--diagnostics');
  assert.equal(resumed.code, 0, resumed.err);
  assert.ok(resumed.out.length < 4_000, `handoff brief should stay short (${resumed.out.length} characters)`);
  assert.equal((resumed.out.match(/^open decision /gmu) ?? []).length, 3, 'text caps each section while JSON keeps all records');
  assert.doesNotMatch(resumed.out, /Old answer stays in history/u);
  assert.match(resumed.out, new RegExp(`open decision #${openId} from web-1 \\(Test Model\\) \\(2h\\): Need a decision`));
  assert.match(resumed.out, /recent decision .*person answered coordinator \(Test Model\) \(1h ago\): Yes, after the review\./u);
  assert.match(resumed.out, new RegExp(`merges cleanly: #${cleanId} Clean item`));
  assert.match(resumed.out, new RegExp(`conflicts: #${conflictId} Conflict item \\(web/shared\\.txt\\)`));
  assert.match(resumed.out, new RegExp(`claimed for integration: #${activeId} by web-3 \\(Test Model\\) at .*\\(${descendant.slice(0, 12)}\\)`));
  assert.doesNotMatch(resumed.out, new RegExp(`claimed for integration: #(?:${supersededId}|${plainId}|${factId}|${unrelatedId}|${expiredId})\\b`),
    'a later same-actor receipt, plain shout/fact text, non-ancestor SHA, or expired attempt is not an active integration claim');
  assert.match(resumed.out, new RegExp(`waiting on the person: #${personQuestionId} from coordinator`));
  assert.match(resumed.out, /review queue:/u);
  assert.match(resumed.out, new RegExp(`review queue:[\\s\\S]*?to verify: #${reviewId} web \\(`));
  assert.match(resumed.out, /4 stale follow-ups; list them with pullboard resume --diagnostics --json/u,
    'the three stale row follow-ups and expired evidence collapse into one counted line');
  assert.equal((resumed.out.match(/^stale:/gmu) ?? []).length, 0, 'stale details collapse to one line');
  const positions = [
    resumed.out.indexOf(`open decision #${openId}`), resumed.out.indexOf('recent decision '),
    resumed.out.indexOf('verified, not merged — merges cleanly:'),
    resumed.out.indexOf('verified, not merged — conflicts:'),
    resumed.out.indexOf('verified, not merged — claimed for integration:'),
    resumed.out.indexOf('waiting on the person:'), resumed.out.indexOf('review queue:'),
  ];
  assert.ok(positions.every((position) => position >= 0) && positions.every((position, index) => index === 0 || positions[index - 1] < position),
    'the handoff sections stay in the requested order');

  const json = await box.inProcess(box.repo, 'resume', '--diagnostics', '--json');
  assert.equal(json.code, 0, json.err || json.out);
  const document = JSON.parse(json.out);
  assert.equal(document.version, 1);
  assert.equal(document.openDecisions.length, 5);
  assert.equal(document.recentAnswers.length, 1);
  assert.equal(document.openDecisions[0].id, openId);
  assert.equal(document.openDecisions[0].asker, 'web-1');
  assert.equal(document.recentAnswers[0].answeredBy, 'person');
  assert.deepEqual(document.verifiedNotMerged.clean.map((item) => item.item_id).sort((a, b) => a - b),
    [cleanId, supersededId, plainId, factId, unrelatedId, expiredId].sort((a, b) => a - b));
  assert.deepEqual(document.verifiedNotMerged.conflicts[0].files, ['web/shared.txt']);
  assert.equal(document.verifiedNotMerged.conflicts[0].item.item_verdict_state?.code, 'STALE_VERDICT',
    'the stale accepted conflict remains visible as an integration diagnostic');
  assert.ok(!document.toMerge.some(item => item.item_id === conflictId),
    'visible stale conflict diagnostics never become ready-to-land work');
  assert.ok(document.staleVerdicts.some(item => item.item_id === conflictId),
    'the handoff also states that the old acceptance must be re-reviewed');
  assert.match(resumed.out, new RegExp(`conflicts: #${conflictId} Conflict item.*\\[STALE_VERDICT\\]`));
  assert.deepEqual(document.verifiedNotMerged.integrating.map((entry) => entry.item.item_id), [activeId],
    'the >40 later plain shouts do not hide the structured descendant attempt');
  assert.equal(document.verifiedNotMerged.integrating[0].commit, descendant, 'the typed evidence keeps its full descendant SHA');
  assert.equal(document.personQuestions[0].id, personQuestionId);
  assert.equal(document.reviewQueue.items[0].item_id, reviewId);
  assert.equal(document.staleFollowUps.count, 4);
  assert.deepEqual(document.staleFollowUps.items.map((item) => item.id).sort((a, b) => a - b), [cleanId, conflictId, activeId]);
  assert.deepEqual(document.staleFollowUps.integrations.map((entry) => entry.item.item_id), [expiredId]);
  assert.equal(document.staleFollowUps.list, 'pullboard resume --diagnostics --json');

  const agentText = (await box.inProcess(cleanBuilder, 'resume', '--diagnostics')).out;
  assert.match(agentText, /^resume: web-1/u);
  assert.doesNotMatch(agentText, /open decision |recent decision |verified, not merged|waiting on the person|review queue:/u);
  const agentJson = JSON.parse((await box.inProcess(cleanBuilder, 'resume', '--diagnostics', '--json')).out);
  for (const section of ['openDecisions', 'recentAnswers', 'verifiedNotMerged', 'personQuestions', 'reviewQueue', 'staleFollowUps']) {
    assert.equal(Object.hasOwn(agentJson, section), false, `agent resume keeps coordinator-only ${section} fields absent`);
  }
});
