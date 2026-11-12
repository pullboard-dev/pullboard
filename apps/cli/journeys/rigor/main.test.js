/** @pullboard-test-loads packages/store/src/io/board.js packages/state/src/io/engine.js packages/state/src/io/machine.js */
/** Rigor: a repeated failure cause is noticed from structured fields, never from notes [D1,V1]. */
import { apiBoardOpeners } from '../../tests/fixtures/board.js';
import { REJECT_CLAUSE_ENGINE } from '../../../../packages/state/light.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  after,
  test,
} from 'node:test';
import {
  runFixtureChild,
  runFixtureGit,
} from '../../tests/fixtures/child.js';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { fixtureBoard } from '../../tests/fixtures/board.js';
import { AGENT_GRANT_ENGINE } from '../../../../packages/state/light.js';
import {
  applyEngineMove,
  applyRelayMove,
  appliedSequence,
  prepareEngineMove,
} from '../../../../packages/state/index.js';
import { executeMove } from '../../../../packages/api/index.js';
import { main } from '../../tests/fixtures/native.js';
import { refusePersonMove } from '../../../../packages/mcp/index.js';
import {
  CAUSE_ENGINE,
  ENGINE_VERSION,
} from '../../../../packages/state/index.js';
import { rigorReport } from '../../../../packages/store/index.js';
import {
  newRigorNotices,
  undraftedRigor,
} from '../../../../packages/rigor/index.js';
import { runCheckAt } from '../../../../packages/rigor/index.js';
import {
  readRigorSource,
  rigorSource,
  RIGOR_NOTICE_ENGINE,
} from '../../../../packages/store/index.js';
import { loadConfig } from '../../../../packages/config/index.js';
import { loadDoctrine } from '../../../../packages/doctrine/index.js';
import {
  frozenCriterion,
  loadSpec,
} from '../../../../packages/spec/index.js';
import { unpackRelease } from '../../tests/fixtures/release/archive.js';
import { fixtureJoinArgv } from '../../tests/fixtures/testkit.js';

const BIN = resolve(import.meta.dirname, '../../pullboard.js');
const MARKERS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'AI_AGENT', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_CI', 'CODEX_SHELL', 'SSH_CONNECTION', 'SSH_TTY'];
const DIRS = [];
const HOUR = 3_600_000;
const MERGE = 'c'.repeat(40);

after(() => { for (const dir of DIRS) rmSync(dir, { recursive: true, force: true }); });

/** A freshly initialized repo with a private board, Pullboard home and Git identity, run as the person's terminal. */
function freshBoard() {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-rigor-'));
  DIRS.push(dir);
  // The hooks init installs call pullboard by name, so this checkout's CLI is the one on PATH.
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${BIN.replaceAll("'", "'\\''")}' "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') || key.startsWith('PULLBOARD_') || MARKERS.includes(key)) delete env[key];
  Object.assign(env, {
    PATH: `${bin}:${process.env.PATH}`,
    PULLBOARD_HOME: join(dir, 'home'), PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
    PULLBOARD_VIEW_BACKGROUND: '0', // Restore the fixture opt-out after removing inherited board identity.
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Rigor fixture', GIT_AUTHOR_EMAIL: 'rigor@example.invalid',
    GIT_COMMITTER_NAME: 'Rigor fixture', GIT_COMMITTER_EMAIL: 'rigor@example.invalid',
  });
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const git = (...args) => runFixtureGit(args, { cwd: repo, env, encoding: 'utf8' });
  const run = (...args) => runFixtureChild(process.execPath, [BIN, ...args], { cwd: repo, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  const init = run('init', '--model', 'Rigor coordinator');
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const config = join(repo, 'pullboard.json');
  writeFileSync(config, `${JSON.stringify({ ...JSON.parse(readFileSync(config, 'utf8')), gate: 'true' }, null, 2)}\n`);
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: set up rigor fixture');
  const file = join(repo, '.git', 'pullboard', 'board.sqlite');
  return { dir, repo, run, git, file, env };
}

/** Run one command with --json and return its document, failing with its output. */
function json(box, ...args) {
  const result = box.run(...args, '--json');
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout);
}

/** Assert a CLI run refused with one code, naming the rule it proves when it did not. */
function refused(result, code, why) {
  const document = JSON.parse(result.stdout || '{}');
  assert.equal(document.error?.code, code, `${why}: ${result.stdout}${result.stderr}`);
}

/**
 * Build board history straight through the board's own moves on the real SQLite file: a builder
 * and a reviewer in one lane, and helpers to submit, reject and land-reopen an item.
 */
function history(file, { freeze: suppliedFreeze } = {}) {
  const board = openBoard(file);
  const builder = store.register(board, { lane: 'app', path: '/fixture/app-1', model: 'Builder model' });
  const reviewer = store.register(board, { lane: 'app', path: '/fixture/app-2', model: 'Reviewer model' });
  /** Freeze the item's title, as the real freezer digests its criterion. */
  const freeze = suppliedFreeze ?? ((item) => ({ text: item.item_title, digest: `digest:${item.item_title}` }));
  let next = 0;
  /** A fresh 40-character commit id for each submission. */
  const commit = () => (++next).toString(16).padStart(40, '0');
  /** Claim and submit an item at a new commit, returning that commit. */
  const submit = (id, at = null) => {
    store.claim(board, id, { agentId: builder, lane: 'app', leaseMs: 2 * HOUR, freeze });
    const sha = at ?? commit();
    submitFixture(board, id, { agentId: builder, commit: sha, tree: `tree-${sha}` });
    return sha;
  };
  /** Reject the current submission, naming a cause key or none. */
  const reject = (id, cause, note = 'the named test failed at this commit') => store.verify(board, id, {
    agentId: reviewer, decision: 'REJECT', reason: 'TEST_FAILURE', note, ...(cause === undefined ? {} : { cause }),
    ...((board.executionEngineVersion ?? REJECT_CLAUSE_ENGINE) >= REJECT_CLAUSE_ENGINE ? { clause: store.getItem(board, id).item_title } : {}),
    head: store.getItem(board, id).item_commit, digest: store.getItem(board, id).item_frozen_digest, policy: 'any',
  });
  /** Accept, then reopen after a red landing whose failing test the note names in the landing format. */
  const landReopen = (id, test) => {
    store.verify(board, id, { agentId: reviewer, decision: 'ACCEPT', note: 'broke the fix; its test failed; restored it',
      head: store.getItem(board, id).item_commit, digest: store.getItem(board, id).item_frozen_digest, policy: 'any' });
    return store.reopen(board, id, { agentId: 'coordinator', note: `${test.file}: ${test.name}; merge commit ${MERGE}` });
  };
  /** Add one item in the fixture lane. */
  const add = (title) => store.addItem(board, { by: 'coordinator', lane: 'app', title, criterion: title });
  return { board, add, submit, reject, landReopen, close: () => store.closeBoard(board) };
}

/** Two real commits for a proof, including the exact failing source noticed on the board. */
function noticeProof(box) {
  mkdirSync(join(box.repo, 'src'), { recursive: true });
  writeFileSync(join(box.repo, 'src/notice.js'), '// TODO: keep the rule\n');
  box.git('add', 'src/notice.js'); box.git('commit', '-q', '-m', 'chore: record noticed failure');
  const red = box.git('rev-parse', 'HEAD');
  writeFileSync(join(box.repo, 'src/notice.js'), '// The rule holds.\n');
  writeFileSync(join(box.repo, 'fixed.txt'), 'fixed\n');
  box.git('add', 'src/notice.js', 'fixed.txt'); box.git('commit', '-q', '-m', 'chore: fix noticed failure');
  return { red, green: box.git('rev-parse', 'HEAD') };
}

/** Resume reads a real frozen criterion, unlike the small board-only history fixture. */
function noticeHistory(box) {
  const config = loadConfig(box.repo);
  return history(box.file, { freeze: item => frozenCriterion(loadSpec(box.repo, config), item, loadDoctrine(box.repo, config)) });
}

test('engine 43 repeated-cause notices retain their deferred proved-draft workflow [D1,D3,H16]', () => {
  const box = freshBoard();
  const proof = noticeProof(box);
  const historyBox = noticeHistory(box);
  historyBox.board.executionEngineVersion = RIGOR_NOTICE_ENGINE;
  const cause = 'doctrine:C3';
  const ids = ['First', 'Second', 'Third', 'After decline', 'Still quiet'].map(historyBox.add);
  const notices = () => store.allShouts(historyBox.board).filter(shout => shout.shout_from === 'rigor');
  historyBox.submit(ids[0], proof.red); historyBox.reject(ids[0], cause);
  assert.equal(notices().length, 0);
  historyBox.submit(ids[1], proof.red); historyBox.reject(ids[1], cause);
  assert.equal(notices().length, 1, 'the reject crossing the repeat threshold tells the coordinator');
  assert.equal(notices()[0].shout_to, 'coordinator');
  assert.ok(notices()[0].shout_text.includes(cause));
  for (const id of ids.slice(0, 2)) assert.ok(notices()[0].shout_text.includes(`#${id}`));
  assert.ok(notices()[0].shout_text.includes('pullboard rigor draft'));
  assert.ok(notices()[0].shout_text.includes('--red <commit> --green <commit>'));
  historyBox.submit(ids[2], proof.red); historyBox.reject(ids[2], cause);
  assert.equal(notices().length, 1, 'a third failure posts no duplicate');
  assert.equal(json(box, 'resume').rigor.undrafted.find(entry => entry.key === cause).items.length, 3);
  const text = box.run('resume');
  assert.equal(text.status, 0, text.stderr);
  assert.ok(text.stdout.includes(`Rigor needs a proved draft: ${cause}`));
  const draft = json(box, 'rigor', 'draft', cause, 'No TODO markers in source', '--check', 'grep -rn TODO src', '--red', proof.red, '--green', proof.green);
  assert.equal(json(box, 'resume').rigor.undrafted.some(entry => entry.key === cause), false);
  json(box, 'spec', 'decline', `doctrine:${draft.drafts[0].id}`, '--reason', 'This is not the rule we want');
  historyBox.submit(ids[0], proof.green); historyBox.reject(ids[0], cause);
  assert.equal(notices().length, 1, 'a new commit on an old item does not undo the person’s decline');
  assert.equal(json(box, 'resume').rigor.undrafted.some(entry => entry.key === cause), false);
  historyBox.submit(ids[3], proof.red); historyBox.reject(ids[3], cause);
  assert.equal(notices().length, 2, 'a new item repeating after the decline tells the coordinator once');
  historyBox.submit(ids[4], proof.red); historyBox.reject(ids[4], cause);
  assert.equal(notices().length, 2);
  const receipts = store.events(historyBox.board).filter(event => event.event_kind === 'rigor-notice');
  assert.equal(receipts.length, 2);
  assert.ok(receipts.every(event => event.event_by === 'rigor' && JSON.parse(event.event_detail).engine === RIGOR_NOTICE_ENGINE));
  historyBox.close();
});

test('a Rigor draft reaches Needs-you with its proof [D1,D3,S1,P6]', () => {
  const box = freshBoard();
  const proof = noticeProof(box);
  const historyBox = noticeHistory(box);
  const ids = ['Product first', 'Product second'].map(historyBox.add);
  for (const id of ids) { historyBox.submit(id, proof.red); historyBox.reject(id, 'row:G1'); }
  historyBox.close();
  const draft = json(box, 'rigor', 'draft', 'row:G1', 'The fixed file exists', '--check', 'test -f fixed.txt', '--red', proof.red, '--green', proof.green);
  const source = readRigorSource(draft.drafts[0].line.split(' | source: ')[1]);
  assert.equal(source.key, 'row:G1');
  assert.deepEqual(source.evidence.items.map(item => item.id), ids);
  assert.deepEqual([source.proof.red.commit, source.proof.red.exit, source.proof.green.commit, source.proof.green.exit], [proof.red, 1, proof.green, 0]);
  const pending = json(box, 'resume');
  const need = pending.needsYou.find(entry => entry.kind === 'rigor-draft');
  assert.ok(need, 'the proved Rigor row is an individual Needs-you call');
  assert.equal(need.target, `spec:${draft.drafts[0].id}`);
  assert.equal(need.what, 'Approve or Decline');
  assert.equal(need.cause, source.key);
  assert.deepEqual(need.evidence, source.evidence);
  assert.deepEqual(need.proof, source.proof);
  assert.ok(need.text.includes('Rigor draft: The fixed file exists'));
  assert.ok(need.text.includes(proof.red) && need.text.includes(proof.green));
  assert.equal(pending.rigor.undrafted.length, 0);
  assert.equal(pending.needsYou.filter(entry => entry.kind === 'draft').reduce((sum, entry) => sum + entry.count, 0),
    json(box, 'spec').rows.filter(row => row.status === 'draft' && row.id !== draft.drafts[0].id).length, 'the generic draft count does not count the Rigor row twice');
  json(box, 'spec', 'approve', draft.drafts[0].id);
  assert.equal(json(box, 'resume').needsYou.some(entry => entry.kind === 'rigor-draft'), false, 'the person’s pending approval closes the call');
  json(box, 'spec', 'apply');
  const approved = json(box, 'spec').rows.find(row => row.id === draft.drafts[0].id);
  assert.equal(approved.status, 'approved');
  assert.equal(approved.gate, 'test -f fixed.txt');
  assert.equal(json(box, 'resume').rigor.undrafted.length, 0);
});

test('independent Rigor writer respects a lane draft reservation [D1,S1,B26]', () => {
  const box = freshBoard();
  const config = join(box.repo, 'pullboard.json');
  writeFileSync(config, `${JSON.stringify({ ...JSON.parse(readFileSync(config, 'utf8')), lanes: { app: { owns: ['app/'] } } }, null, 2)}\n`);
  box.git('add', 'pullboard.json'); box.git('commit', '-q', '-m', 'chore: add the app lane');
  const proof = noticeProof(box);
  const historyBox = noticeHistory(box);
  for (const id of ['Product first', 'Product second'].map(historyBox.add)) { historyBox.submit(id, proof.red); historyBox.reject(id, 'row:G1'); }
  historyBox.close();
  const lane = join(box.dir, 'lane');
  box.git('worktree', 'add', '-q', lane, '-b', 'app/rows');
  /** Run the real CLI in the lane worktree. */
  const inLane = (...args) => runFixtureChild(process.execPath, [BIN, ...args], { cwd: lane, env: box.env, encoding: 'utf8' });
  const joined = inLane('join', 'app', '--model', 'Lane model');
  assert.equal(joined.status, 0, joined.stdout + joined.stderr);
  /** Draft a spec row from the lane and return its id. */
  const laneDraft = (text) => {
    const drafted = inLane('spec', 'draft', text, '--json');
    assert.equal(drafted.status, 0, drafted.stdout + drafted.stderr);
    return JSON.parse(drafted.stdout).id;
  };
  // Lane first, then Rigor in the main checkout; then the lane again, while Rigor's row is still uncommitted there.
  const laneFirst = laneDraft('A lane row drafted before Rigor');
  const rigor = json(box, 'rigor', 'draft', 'row:G1', 'The fixed file exists', '--check', 'test -f fixed.txt', '--red', proof.red, '--green', proof.green);
  const rigorId = rigor.drafts[0].id;
  const laneAfter = laneDraft('A lane row drafted after Rigor');
  assert.equal(new Set([laneFirst, rigorId, laneAfter]).size, 3, `every writer keeps its own id: ${laneFirst}, ${rigorId}, ${laneAfter}`);
  assert.equal(runFixtureGit(['status', '--porcelain'], { cwd: lane, env: box.env, encoding: 'utf8' }).trim(), '', 'the lane edits no file outside its lane');

  const applied = box.run('spec', 'apply');
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  assert.doesNotMatch(applied.stdout, /holds other text/u);
  const rows = json(box, 'spec').rows;
  const text = (id) => rows.find((row) => row.id === id)?.text ?? '';
  assert.equal(text(laneFirst), 'A lane row drafted before Rigor');
  assert.equal(text(laneAfter), 'A lane row drafted after Rigor');
  assert.match(text(rigorId), /^The fixed file exists Why: rigor row:G1/u);
  assert.ok([laneFirst, rigorId, laneAfter].every((id) => rows.find((row) => row.id === id)?.status === 'draft'), 'all three stay drafts for the person');
  assert.notEqual(inLane('spec', 'approve', laneFirst).status, 0, 'a lane cannot approve its own draft; the person does');
});

test('a lane draft made while a Rigor proof runs still keeps its id [D1,S1,B26]', () => {
  const box = freshBoard();
  const config = join(box.repo, 'pullboard.json');
  writeFileSync(config, `${JSON.stringify({ ...JSON.parse(readFileSync(config, 'utf8')), lanes: { app: { owns: ['app/'] } } }, null, 2)}\n`);
  box.git('add', 'pullboard.json'); box.git('commit', '-q', '-m', 'chore: add the app lane');
  const proof = noticeProof(box);
  const historyBox = noticeHistory(box);
  for (const id of ['Product first', 'Product second'].map(historyBox.add)) { historyBox.submit(id, proof.red); historyBox.reject(id, 'row:G1'); }
  historyBox.close();
  const lane = join(box.dir, 'lane');
  box.git('worktree', 'add', '-q', lane, '-b', 'app/rows');
  const joined = runFixtureChild(process.execPath, [...fixtureJoinArgv(BIN), 'app', '--model', 'Lane model'], { cwd: lane, env: box.env, encoding: 'utf8' });
  assert.equal(joined.status, 0, joined.stdout + joined.stderr);
  // The proof's own check drafts from the lane the first time it runs, so the draft lands mid-proof.
  const result = join(box.dir, 'mid-proof-draft.json');
  const drafter = join(box.dir, 'mid-proof-draft.mjs');
  writeFileSync(drafter, [
    "import { existsSync, writeFileSync } from 'node:fs';",
    "import { spawnSync } from 'node:child_process';",
    `if (!existsSync(${JSON.stringify(result)})) {`,
    `  const drafted = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(BIN)}, 'spec', 'draft', 'A lane row drafted mid-proof', '--json'], { cwd: ${JSON.stringify(lane)}, env: ${JSON.stringify(box.env)}, encoding: 'utf8' });`,
    `  writeFileSync(${JSON.stringify(result)}, JSON.stringify({ status: drafted.status, out: drafted.stdout + drafted.stderr }));`,
    '}',
  ].join('\n'));
  const check = `node ${drafter} && test -f fixed.txt`;
  const rigor = json(box, 'rigor', 'draft', 'row:G1', 'The fixed file exists', '--check', check, '--red', proof.red, '--green', proof.green);
  const midProof = JSON.parse(readFileSync(result, 'utf8'));
  assert.equal(midProof.status, 0, midProof.out);
  const laneId = JSON.parse(midProof.out).id;
  assert.notEqual(rigor.drafts[0].id, laneId, `Rigor's ${rigor.drafts[0].id} skips the lane draft made during its proof`);
  const applied = box.run('spec', 'apply');
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  assert.doesNotMatch(applied.stdout, /holds other text/u);
  assert.equal(json(box, 'spec').rows.find((row) => row.id === laneId)?.text, 'A lane row drafted mid-proof');
});

test('automatic Rigor notices retain old replay and include reopen and never-again [D1,H16]', () => {
  const box = freshBoard();
  const historyBox = history(box.file);
  historyBox.board.executionEngineVersion = RIGOR_NOTICE_ENGINE - 1;
  const old = ['Old first', 'Old second'].map(historyBox.add);
  for (const id of old) { historyBox.submit(id); historyBox.reject(id, 'row:G1'); }
  assert.equal(store.allShouts(historyBox.board).filter(shout => shout.shout_from === 'rigor').length, 0,
    'engine42 replay keeps its old event stream without automatic notices');
  delete historyBox.board.executionEngineVersion;
  const fresh = ['Reopened first', 'Reopened second'].map(historyBox.add);
  for (const id of fresh) {
    historyBox.submit(id);
    store.reopen(historyBox.board, id, { agentId: 'coordinator', note: 'A typed product failure', cause: 'row:G2' });
  }
  assert.equal(store.allShouts(historyBox.board).filter(shout => shout.shout_from === 'rigor').length, 1);
  const one = historyBox.add('One item, two commits');
  historyBox.submit(one); historyBox.reject(one, 'refusal:UNDECLARED_REFUSAL');
  historyBox.submit(one); historyBox.reject(one, 'refusal:UNDECLARED_REFUSAL');
  assert.equal(store.allShouts(historyBox.board).filter(shout => shout.shout_from === 'rigor').length, 2);
  store.appendFact(historyBox.board, one, { agentId: 'coordinator', kind: 'root-cause', text: 'Never again',
    cause: 'doctrine:C4', neverAgain: true, asPerson: true, channel: 'terminal' });
  assert.equal(store.allShouts(historyBox.board).filter(shout => shout.shout_from === 'rigor').length, 3,
    'a person never-again tells the coordinator without waiting for a second item');
  const conflicts = ['Conflict first', 'Conflict second'].map(historyBox.add);
  for (const id of conflicts) { historyBox.submit(id); historyBox.reject(id, 'refusal:MERGE_CONFLICT'); }
  assert.equal(store.allShouts(historyBox.board).filter(shout => shout.shout_from === 'rigor').length, 3);
  historyBox.close();
});

test('unreadable historical decline metadata cannot abort or silence a repeated cause [D1,H16,M1]', () => {
  const box = freshBoard();
  const recorded = history(box.file);
  recorded.board.executionEngineVersion = RIGOR_NOTICE_ENGINE - 1;
  for (const id of ['Historical first', 'Historical second'].map(recorded.add)) {
    recorded.submit(id); recorded.reject(id, 'row:G1');
  }
  const events = store.events(recorded.board);
  const trigger = events.at(-1);
  const cause = rigorReport(events, { person: store.PERSON }).causes[0];
  const proof = { check: 'test -f fixed', red: { commit: 'a'.repeat(40), exit: 1 }, green: { commit: 'b'.repeat(40), exit: 0 } };
  const row = `- G9 [draft, must] A proved rule | source: ${rigorSource(cause, proof)}`;
  const declined = source => [...events, { event_id: trigger.event_id + 1, event_kind: 'row_decision', event_by: store.PERSON,
    item_id: null, event_detail: JSON.stringify({ record: { decision: 'decline', source } }) }];
  const state = { spec: [], practice: [] };
  assert.deepEqual(undraftedRigor(declined(row), state, { person: store.PERSON }), [], 'a valid typed decline still stays quiet');
  for (const source of [undefined, 'ordinary prose', `<!-- pullboard-grammar 999 -->\n${row}`]) {
    const historical = declined(source);
    assert.deepEqual(newRigorNotices(historical, trigger, { person: store.PERSON }).map(entry => entry.key), ['row:G1'],
      'unknown provenance neither refuses the item move nor suppresses the notice');
    assert.deepEqual(undraftedRigor(historical, state, { person: store.PERSON }).map(entry => entry.key), ['row:G1']);
  }
  recorded.close();
});

test('a repeated failure cause is noticed [D1,V1]', () => {
  const box = freshBoard();
  const before = json(box, 'rigor');
  assert.deepEqual(before.causes, [], 'an empty board has no repeated cause');

  const catalog = 'test:apps/cli/journeys/milestone/api.test.js::[A1] every catalog command and subcommand has a real CLI exercise';
  const board = history(box.file);
  const [first, second, third, single, conflictA, conflictB] = ['First', 'Second', 'Third', 'Single', 'Conflict A', 'Conflict B'].map(board.add);
  // A repeat: the same failing test sends back two items.
  board.submit(first); board.reject(first, catalog);
  board.submit(second); board.reject(second, catalog);
  // A repeat on one item at two different commits.
  const firstSha = board.submit(third); board.reject(third, 'refusal:UNDECLARED_REFUSAL');
  const secondSha = board.submit(third); board.reject(third, 'refusal:UNDECLARED_REFUSAL');
  // A single: one failure on one item at one commit never lists.
  board.submit(single); board.reject(single, 'row:G1');
  // No explicit cause or failure receipt: use the coarse coded verdict, never the test named in prose.
  const uncausedItem = board.add('Uncaused');
  board.submit(uncausedItem); board.reject(uncausedItem, undefined, `${catalog.slice('test:'.length).replace('::', ': ')} failed`);
  // Merge conflicts on two items never list, however often they recur.
  board.submit(conflictA); board.landReopen(conflictA, { file: 'src/sample-conflict.js', name: 'conflicts with main 8b8dc50e (0.8.29), merge main and resubmit' });
  board.submit(conflictB); board.landReopen(conflictB, { file: 'src/sample-conflict.js', name: 'conflicts with main 8b8dc50e (0.8.29), merge main and resubmit' });
  board.close();

  const repeated = json(box, 'rigor');
  assert.deepEqual(repeated.causes.map((cause) => cause.key), [catalog, 'refusal:UNDECLARED_REFUSAL'],
    'the two repeats list, the single and the merge conflicts do not');
  const [test, refusal] = repeated.causes;
  assert.deepEqual(test.items.map((item) => item.id), [first, second], 'a repeat lists both its items');
  assert.equal(test.reads, 'both', 'a failing test reads as work or product, so the person picks');
  assert.equal(test.occurrences, 2);
  assert.deepEqual(refusal.items, [{ id: third, commits: [firstSha, secondSha] }], 'one item at two commits is a repeat');
  assert.equal(refusal.reads, 'work', 'a refusal is about how the work is done');
  assert.ok(!repeated.causes.some((cause) => cause.key === 'row:G1'), 'a single failure does not list');
  assert.ok(!repeated.causes.some((cause) => /conflicts with/u.test(cause.key)), 'a merge conflict never lists');
  assert.equal(repeated.uncaused, 0, 'the coded verdict supplies a coarse key without parsing its note as test evidence');
  assert.equal(test.items.length, 2, 'the uncaused reject does not join the catalog cause');

  // A person's never-again lists at once, from one fact and no failure at all.
  const marked = json(box, 'fact', String(single), 'root-cause', 'Every function keeps its JSDoc block', '--cause', 'doctrine:C3', '--never-again', '--as', 'person');
  assert.equal(marked.fact.by, store.PERSON, 'the fact is the person’s');
  assert.equal(marked.fact.neverAgain, true);
  const never = json(box, 'rigor');
  assert.deepEqual(never.causes[0], { key: 'doctrine:C3', reads: 'work', occurrences: 0, neverAgain: true, items: [{ id: single, commits: [] }] },
    'the never-again lists first, at once');
  assert.equal(never.causes.length, 3);

  const text = box.run('rigor');
  assert.equal(text.status, 0, text.stderr);
  const lines = text.stdout.trim().split('\n');
  assert.match(lines[0], /^doctrine:C3 {2}reads as work {2}never again \(the person\) {2}items #\d+$/u);
  assert.equal(lines[1], `${catalog}  reads as both  2 failures  items #${first}, #${second}`);
  assert.equal(lines[2], `refusal:UNDECLARED_REFUSAL  reads as work  2 failures  items #${third} (2 commits)`);
  assert.equal(lines[3], '0 rejects and reopens carry no cause key; name one with --cause <key> (test:<file>::<title>, refusal:<CODE>, row:<id>, doctrine:<id>, sentinel:<name>, conflict:<file>, instruction:<kind>)');
  // The report also ends with its coordinator-instruction line (60b2f87252: draft repeated coordinator instructions).
  assert.equal(lines[4], 'coordinator instructions: none in 7 days; draft threshold 3');
  assert.equal(lines.length, 5, 'the single coarse verdict is not a repeat; the zero-uncaused footer remains explicit');

  const help = box.run('rigor', '--help');
  assert.equal(help.status, 0, help.stderr);
  // One command's help ends at its example with no next line (041dbbaccc, json-output.js helpSubject).
  assert.doesNotMatch(help.stdout, /^next:/mu, 'Rigor help ends at its example');
  const draft = box.run('rigor', 'draft');
  assert.notEqual(draft.status, 0, 'an incomplete drafting command remains refused');
  assert.match(draft.stdout + draft.stderr, /(?:^|\n)next: /u, 'actionable drafting refusals retain their guidance');
});

test('rigor reads old events by their structured fields only, never by their notes [D1,V1]', () => {
  const box = freshBoard();
  const board = history(box.file);
  board.board.executionEngineVersion = RIGOR_NOTICE_ENGINE;
  const [first, second, third, fourth] = ['First', 'Second', 'Third', 'Fourth'].map(board.add);
  const landing = { file: 'apps/cli/journeys/verify/machine.test.js', name: 'the declaration matches the refusals board.js and cli.js raise [M1]' };
  // Reopens after a red landing carry their failing tests as structured fields, with no cause key.
  board.submit(first); board.landReopen(first, landing);
  board.submit(second); board.landReopen(second, landing);
  // Rejects recorded without a cause key: their notes name the same test, and are never parsed.
  const note = `${landing.file}: ${landing.name} failed again`;
  board.submit(third); board.reject(third, undefined, note);
  board.submit(fourth); board.reject(fourth, undefined, note);
  board.close();
  const report = json(box, 'rigor');
  assert.deepEqual(report.causes.map((cause) => [cause.key, cause.items.map((item) => item.id)]),
    [[`test:${landing.file}::${landing.name}`, [first, second]]], 'only the structured landing tests count');
  assert.equal(report.uncaused, 2, 'the two causeless rejects are counted as uncaused');
  const text = box.run('rigor');
  assert.match(text.stdout, /^2 rejects and reopens carry no cause key; name one with --cause <key>/mu);
});

test('a cause key is checked, recorded on reject and reopen, and the person alone marks never-again [D1,V1,H16]', () => {
  const box = freshBoard();
  const board = history(box.file);
  const id = board.add('Checked');
  board.submit(id);
  for (const [bad, named] of [['the catalog test failed', '"the catalog test failed"'], ['cause:G1', '"cause:G1"'], ['', 'an empty key']]) {
    assert.throws(() => board.reject(id, bad), (error) => error.code === 'BAD_CAUSE' && error.message.startsWith(`[BAD_CAUSE] ${named} is not a cause key`)
      && ['test:<file>::<title>', 'refusal:<CODE>', 'row:<id>', 'doctrine:<id>'].every((form) => error.message.includes(form)),
    `${named} is refused by name, with the four forms`);
  }
  assert.equal(store.getItem(board.board, id).item_status, 'submitted', 'a refused reject leaves the item submitted');
  board.reject(id, 'row:G1');
  // A reject reopens the item at once, so the reject is no longer the last event.
  const rejected = store.events(board.board, { itemId: id }).findLast(event => event.event_kind === 'reject');
  assert.equal(JSON.parse(rejected.event_detail).cause, 'row:G1', 'the reject records its cause key');

  // A sealed move that carries a cause needs the cause engine; an older envelope cannot carry it.
  const second = board.add('Sealed');
  board.submit(second);
  const move = prepareEngineMove(board.board, 'verify', [second, { agentId: 'app-2', decision: 'REJECT', reason: 'TEST_FAILURE', note: 'red', cause: 'row:G1', head: store.getItem(board.board, second).item_commit, digest: 'digest:Sealed', policy: 'any' }]);
  assert.equal(CAUSE_ENGINE, 30, 'cause moves keep their stable minimum engine');
  assert.equal(move.engine, ENGINE_VERSION, 'new envelopes declare the current engine independently of the feature minimum');
  for (const older of [19, CAUSE_ENGINE - 1]) {
    assert.throws(() => applyEngineMove(board.board, { ...move, engine: older }, { sequence: 1, at: new Date().toISOString() }),
      (error) => error.code === 'RELAY_MOVE', `an engine-${older} move cannot carry a cause key`);
    assert.equal(store.getItem(board.board, second).item_status, 'submitted', `the engine-${older} refusal changes nothing`);
  }
  board.close();

  // The coordinator's reopen records --cause through the CLI.
  const reopenItem = json(box, 'add', 'coordinator', 'Reopen with a cause', '--criterion', 'Reopen records its cause.', '--check', 'true').item;
  // The private person's acceptance permits this intentionally pre-green fixture check.
  json(box, 'check', 'accept', String(reopenItem.item_id));
  json(box, 'claim', String(reopenItem.item_id));
  // A submit with no change against the claim head is refused (EMPTY_SUBMIT), so the claim gets a commit.
  writeFileSync(join(box.repo, 'reopen-cause.txt'), 'the work\n');
  box.git('add', 'reopen-cause.txt'); box.git('commit', '-q', '-m', 'chore: work for the reopen cause fixture');
  json(box, 'submit', String(reopenItem.item_id), '--wait', '--no-next');
  refused(box.run('reopen', String(reopenItem.item_id), '--note', 'wrong bar', '--cause', 'wrong bar', '--json'), 'BAD_CAUSE', 'a reopen refuses a malformed cause');
  json(box, 'reopen', String(reopenItem.item_id), '--note', 'the bar cites the wrong row', '--cause', 'row:G1');
  const reopened = json(box, 'log', String(reopenItem.item_id)).events.at(-1);
  assert.equal(reopened.event_kind, 'reopen');
  assert.equal(JSON.parse(reopened.event_detail).cause, 'row:G1', 'the reopen records its cause key');

  // Only the person marks never-again; the coordinator alone, or without a cause, is refused.
  refused(box.run('fact', String(id), 'root-cause', 'never again', '--cause', 'row:G1', '--never-again', '--json'), 'RIGOR_PERSON_ONLY', 'the coordinator alone cannot mark never-again');
  const agentShell = runFixtureChild(process.execPath, [BIN, 'fact', String(id), 'root-cause', 'never again', '--cause', 'row:G1', '--never-again', '--as', 'person', '--json'],
    { cwd: box.repo, env: { ...box.env, CLAUDECODE: '1' }, encoding: 'utf8' });
  refused(agentShell, 'B26_PERSON_CHANNEL', 'an agent shell cannot act as the person');
  refused(box.run('fact', String(id), 'root-cause', 'never again', '--never-again', '--as', 'person', '--json'), 'BAD_CAUSE', 'a never-again names its cause');
  const logged = json(box, 'log').events.length;
  const report = json(box, 'rigor');
  assert.deepEqual(report.causes.map((cause) => cause.key), ['row:G1'], 'row:G1 on two items repeats');
  assert.equal(report.causes[0].reads, 'product');
  assert.equal(json(box, 'log').events.length, logged, 'rigor is read-only: it records no move');
});

test('reject, reopen and fact moves without a cause replay unchanged from engines 11 and 12 [D1,H16]', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-rigor-replay-'));
  DIRS.push(directory);
  const fixed = { now: () => new Date('2026-10-16T12:00:00.000Z') };
  /** Freeze with the captured verify policy that released verify replay requires. */
  const freeze = (item) => ({
    text: JSON.stringify({ criterion: item.item_title, policy: { version: 1, commit: 'a'.repeat(40), verify: { policy: 'any', family: 'off' } } }),
    digest: `digest:${item.item_title}`,
  });
  const landed = { file: 'apps/cli/journeys/verify/machine.test.js', name: 'the declaration matches the refusals [M1]' };
  for (const [version, tag] of [[11, 'v0.8.27'], [12, 'v0.8.29']]) {
    const source = join(directory, `client-${version}`);
    mkdirSync(source);
    unpackRelease(tag, source);
    const legacyStore = await import(pathToFileURL(join(source, 'src/board.js')).href);
    const legacyEngine = await import(pathToFileURL(join(source, 'src/engine.js')).href);
    const legacyMachine = await import(pathToFileURL(join(source, 'src/machine.js')).href);
    assert.equal(legacyMachine.ENGINE_VERSION, version, 'the archived executable has the claimed engine');
    const old = legacyStore.openBoard(':memory:', fixed);
    const current = fixtureBoard(t, { clock: fixed });
    t.after(() => legacyStore.closeBoard(old));
    // The current replica's seats predate agent grants (#348), as on the board the released client wrote.
    current.executionEngineVersion = AGENT_GRANT_ENGINE - 1;
    for (const [replica, module] of [[old, legacyStore], [current, store]]) {
      module.register(replica, { lane: 'coordinator', path: '/fixture/main' });
      module.register(replica, { lane: 'app', path: '/fixture/app-1', model: 'Builder model' });
      module.register(replica, { lane: 'app', path: '/fixture/app-2', model: 'Reviewer model' });
    }
    delete current.executionEngineVersion;
    const first = '1'.repeat(40);
    const second = '2'.repeat(40);
    const journal = [
      ['addItem', [{ by: 'coordinator', lane: 'app', title: 'Replayed' }]],
      ['claim', [1, { agentId: 'app-1', lane: 'app', leaseMs: 2 * HOUR, freeze }]],
      ['submit', [1, { agentId: 'app-1', commit: first, tree: 'tree-1' }]],
      ['verify', [1, { agentId: 'app-2', decision: 'REJECT', reason: 'TEST_FAILURE', note: `${landed.file}: ${landed.name}`, head: first, digest: 'digest:Replayed', policy: 'any' }]],
      ['claim', [1, { agentId: 'app-1', lane: 'app', leaseMs: 2 * HOUR, freeze }]],
      ['submit', [1, { agentId: 'app-1', commit: second, tree: 'tree-2' }]],
      ['verify', [1, { agentId: 'app-2', decision: 'ACCEPT', note: 'broke the fix; its test failed; restored it', head: second, digest: 'digest:Replayed', policy: 'any' }]],
      ['reopen', [1, { agentId: 'coordinator', note: `${landed.file}: ${landed.name}; merge commit ${MERGE}` }]],
      ['appendFact', [1, { agentId: 'coordinator', kind: 'root-cause', text: 'the refusal was never declared' }]],
    ];
    journal.forEach(([operation, args], index) => {
      const move = legacyEngine.prepareEngineMove(old, operation, args, { id: `engine-${version}-rigor-${index}` });
      assert.equal(move.engine, version);
      const receipt = { sequence: index + 1, at: `2026-10-16T12:00:0${index}.000Z` };
      const oldOutcome = legacyEngine.applyEngineMove(old, move, receipt);
      assert.equal(oldOutcome.error, undefined, `released engine-${version} ${operation} applies: ${JSON.stringify(oldOutcome)}`);
      assert.deepEqual(applyEngineMove(current, move, receipt), oldOutcome, `engine-${version} ${operation} replays identically`);
    });
    assert.deepEqual(store.events(current), legacyStore.events(old), `engine-${version} reject, reopen and fact events replay with no cause field`);
    assert.ok(store.events(current).every((event) => !Object.hasOwn(JSON.parse(event.event_detail), 'cause')));
    const report = rigorReport(store.events(current), { person: store.PERSON });
    assert.deepEqual(report, { causes: [], uncaused: 1 }, 'the old reject has no key, and one landing failure on one commit is no repeat');
    const caused = prepareEngineMove(current, 'appendFact', [1, { agentId: 'coordinator', kind: 'root-cause', text: 'never again', cause: 'refusal:UNDECLARED', neverAgain: true, asPerson: true, channel: 'terminal' }]);
    assert.throws(() => legacyEngine.applyEngineMove(old, caused, { sequence: journal.length + 1, at: '2026-10-16T12:01:00.000Z' }),
      (error) => error.code === 'ENGINE_VERSION', `the engine-${version} client refuses a cause move before interpreting it`);
  }
});

test('a repeated cause becomes a draft row with its proof [D1,D3,S1,P6]', async () => {
  const box = freshBoard();
  // Two real commits: the bad one has a TODO and no fixed file; the fix removes the TODO and adds it.
  mkdirSync(join(box.repo, 'src'), { recursive: true });
  writeFileSync(join(box.repo, 'src/page.js'), '// TODO: escape the title\nexport const page = 1;\n');
  mkdirSync(join(box.repo, 'test'), { recursive: true });
  writeFileSync(join(box.repo, 'test/page.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { page } from '../src/page.js';\ntest('[G1] the page::title is escaped', () => assert.equal(page, 2));\n");
  box.git('add', 'src/page.js', 'test/page.test.js');
  box.git('commit', '-q', '-m', 'chore: add the page');
  const bad = box.git('rev-parse', 'HEAD');
  writeFileSync(join(box.repo, 'unrelated-note.txt'), 'An unrelated commit still has the same failure.\n');
  box.git('add', 'unrelated-note.txt');
  box.git('commit', '-q', '-m', 'chore: record an unrelated note');
  const unrelatedBad = box.git('rev-parse', 'HEAD');
  writeFileSync(join(box.repo, 'src/page.js'), 'export const page = 2;\n');
  writeFileSync(join(box.repo, 'fixed.txt'), 'fixed\n');
  box.git('add', 'src/page.js', 'fixed.txt');
  box.git('commit', '-q', '-m', 'chore: escape the title');
  const fix = box.git('rev-parse', 'HEAD');
  const testFile = join(box.repo, 'test/page.test.js');
  const testSource = readFileSync(testFile, 'utf8');
  writeFileSync(testFile, testSource.replace("', () =>", "', { skip: true }, () =>"));
  box.git('add', 'test/page.test.js');
  box.git('commit', '-q', '-m', 'chore: record a skipped green test');
  const skippedGreen = box.git('rev-parse', 'HEAD');
  writeFileSync(testFile, testSource);
  box.git('add', 'test/page.test.js');
  box.git('commit', '-q', '-m', 'chore: restore the executed test');

  const board = history(box.file);
  const items = ['Work one', 'Work two', 'Product one', 'Product two', 'Both one', 'Both two', 'Lonely'].map(board.add);
  const [workA, workB, productA, productB, bothA, bothB, lonely] = items;
  const bothKey = 'test:test/page.test.js::[G1] the page::title is escaped';
  for (const [id, cause] of [[workA, 'doctrine:C3'], [workB, 'doctrine:C3'], [productA, 'row:G1'], [productB, 'row:G1'], [bothA, bothKey], [bothB, bothKey], [lonely, 'refusal:LONELY']]) {
    board.submit(id, bad); board.reject(id, cause);
  }
  board.close();
  const specBefore = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
  const doctrineBefore = readFileSync(join(box.repo, 'DOCTRINE.md'), 'utf8');

  // Without proof, or with a proof that is not red then green, nothing is drafted.
  const flags = (check, red, green) => ['--check', check, '--red', red, '--green', green];
  const unrelatedRed = box.run('rigor', 'draft', 'doctrine:C3', 'No TODO markers in shipped source', ...flags('grep -rn TODO src', unrelatedBad, fix), '--json');
  refused(unrelatedRed, 'RIGOR_UNPROVEN', 'a red commit outside the noticed failure receipts cannot prove this cause');
  assert.ok(JSON.parse(unrelatedRed.stdout).error.message.includes(bad), 'the refusal names the actual noticed receipt commit');
  const unrelatedCheck = box.run('rigor', 'draft', bothKey, 'Page titles are escaped', ...flags('! grep -rn TODO src', bad, fix), '--json');
  refused(unrelatedCheck, 'RIGOR_UNPROVEN', 'an unrelated check cannot prove the named failing test');
  assert.ok(JSON.parse(unrelatedCheck.stdout).error.message.includes(bad), 'an unrelated check refusal names the noticed receipt commit');
  refused(box.run('rigor', 'draft', bothKey, 'Page titles are escaped', ...flags('node --test test/page.test.js', bad, skippedGreen), '--json'), 'RIGOR_UNPROVEN', 'a skipped green test is no passing proof');
  refused(box.run('rigor', 'draft', bothKey, 'Page titles are escaped', ...flags("node --test --test-name-pattern 'a different test' test/page.test.js", bad, fix), '--json'), 'RIGOR_UNPROVEN', 'a selector that excludes the noticed test is no proof');
  const unchecked = box.run('rigor', 'draft', 'doctrine:C3', 'No TODO markers in shipped source', '--json');
  refused(unchecked, 'RIGOR_UNPROVEN', 'a draft without a check is unproven');
  assert.match(JSON.parse(unchecked.stdout).error.message, /no --check names the command that proves it/u, 'the refusal names the missing check');
  const ungreen = box.run('rigor', 'draft', 'doctrine:C3', 'No TODO markers in shipped source', '--check', 'grep -rn TODO src', '--red', bad, '--json');
  refused(ungreen, 'RIGOR_UNPROVEN', 'a draft without its green commit is unproven');
  assert.match(JSON.parse(ungreen.stdout).error.message, /no --green names the commit where the check passes/u);
  refused(box.run('rigor', 'draft', 'doctrine:C3', 'No TODO markers in shipped source', ...flags('grep -rn NEVER_PRESENT src', bad, fix), '--json'), 'RIGOR_UNPROVEN', 'a work check that finds no problem at red proves nothing');
  refused(box.run('rigor', 'draft', 'doctrine:C3', 'No TODO markers in shipped source', ...flags('grep -rn TODO src', fix, bad), '--json'), 'RIGOR_UNPROVEN', 'a check green at red and red at green proves nothing');
  refused(box.run('rigor', 'draft', 'row:G1', 'The fixed file exists', ...flags('true', bad, fix), '--json'), 'RIGOR_UNPROVEN', 'a test that never fails proves nothing');
  refused(box.run('rigor', 'draft', 'refusal:LONELY', 'Lonely rule', ...flags('test -f fixed.txt', bad, fix), '--json'), 'RIGOR_UNNOTICED', 'a cause that has not repeated cannot be drafted');
  assert.equal(readFileSync(join(box.repo, 'SPEC.md'), 'utf8'), specBefore, 'a refused draft writes no spec row');
  assert.equal(readFileSync(join(box.repo, 'DOCTRINE.md'), 'utf8'), doctrineBefore, 'a refused draft writes no doctrine row');

  // A work cause becomes a Doctrine row: gate: check, count: 0, its evidence and its proof.
  const work = json(box, 'rigor', 'draft', 'doctrine:C3', 'No TODO markers in shipped source', ...flags('grep -rn TODO src', bad, fix));
  assert.equal(work.reads, 'work');
  assert.deepEqual(work.evidence.items.map((item) => item.id), [workA, workB]);
  assert.deepEqual([work.proof.red.commit, work.proof.red.problems, work.proof.green.commit, work.proof.green.problems], [bad, 1, fix, 0]);
  assert.equal(work.drafts.length, 1);
  const [doctrineRow] = work.drafts;
  assert.equal(doctrineRow.file, 'DOCTRINE.md');
  assert.equal(doctrineRow.line.split(' | source: ')[0], `- ${doctrineRow.id} [draft, must] No TODO markers in shipped source Why: rigor doctrine:C3 failed on #${workA}, #${workB}; red at ${bad}, green at ${fix}. | gate: check grep -rn TODO src | count: 0`);
  assert.ok(readFileSync(join(box.repo, 'DOCTRINE.md'), 'utf8').includes(doctrineRow.line), 'the row is written into DOCTRINE.md');
  assert.equal(readFileSync(join(box.repo, 'SPEC.md'), 'utf8'), specBefore, 'a work cause writes no spec row');

  // A product cause becomes a spec row gated by its failing test.
  const product = json(box, 'rigor', 'draft', 'row:G1', 'The fixed file exists', ...flags('test -f fixed.txt', bad, fix));
  assert.equal(product.reads, 'product');
  assert.deepEqual([product.proof.red.exit, product.proof.green.exit], [1, 0], 'the test fails on the bad commit and passes on the fix');
  assert.equal(product.drafts.length, 1);
  const [specRow] = product.drafts;
  assert.equal(specRow.file, 'SPEC.md');
  assert.equal(specRow.line.split(' | source: ')[0], `- ${specRow.id} [draft, must] The fixed file exists Why: rigor row:G1 failed on #${productA}, #${productB}; red at ${bad}, green at ${fix}. | gate: test -f fixed.txt`);
  assert.equal(readRigorSource(specRow.line.split(' | source: ')[1]).key, 'row:G1');

  // An unclear cause drafts both, and the person picks.
  const both = json(box, 'rigor', 'draft', bothKey, 'Page titles are escaped', ...flags("node --test test/page.test.js", bad, fix));
  assert.equal(both.reads, 'both');
  assert.deepEqual(both.drafts.map((draft) => draft.file), ['DOCTRINE.md', 'SPEC.md']);
  const scanner = both.drafts.find(draft => draft.file === 'DOCTRINE.md').row.gate.slice('check '.length);
  const scanned = runFixtureChild('/bin/sh', ['-c', scanner], { cwd: box.repo, env: box.env, encoding: 'utf8' });
  assert.equal(scanned.status, 0, 'the derived count scanner succeeds on the fixed test');
  assert.equal(scanned.stdout, '', 'a passing test really has zero problem lines in its doctrine scanner');
  writeFileSync(join(box.repo, 'src/page.js'), 'export const page = 1;\n');
  try {
    const redScan = runFixtureChild('/bin/sh', ['-c', scanner], { cwd: box.repo, env: box.env, encoding: 'utf8' });
    assert.equal(redScan.status, 1, 'the derived scanner really executes the failing target instead of inheriting a recursive-test skip');
    assert.equal(redScan.stdout, 'The noticed test failed.\n', 'a failing target produces exactly one doctrine problem line');
  } finally { writeFileSync(join(box.repo, 'src/page.js'), 'export const page = 2;\n'); }
  assert.equal(both.drafts.find(draft => draft.file === 'SPEC.md').row.gate, 'node --test test/page.test.js', 'the product row keeps the actual test command');

  // Drafting is any agent's; approving stays the person's, however an agent tries to reach it (P6).
  const drafted = [doctrineRow.id, specRow.id];
  const agentApprove = runFixtureChild(process.execPath, [BIN, 'spec', 'approve', specRow.id, '--json'], { cwd: box.repo, env: { ...box.env, CLAUDECODE: '1' }, encoding: 'utf8' });
  refused(agentApprove, 'B26_PERSON_CHANNEL', 'an agent shell cannot approve a drafted row');
  const api = await executeMove(box.repo, { verb: 'spec-approve', args: { ids: drafted.join(',') } }, main, true, 'api', undefined, apiBoardOpeners);
  assert.equal(api.body.error?.code, 'B26_PERSON_CHANNEL', 'the standalone API cannot approve a drafted row');
  assert.throws(() => refusePersonMove('spec_approve'), (error) => error.code === 'HUMAN_REQUIRED', 'MCP cannot approve a drafted row');
  const sealedBoard = openBoard(box.file);
  try {
    const forged = prepareEngineMove(sealedBoard, 'recordRowDecisions', [{ agentId: store.PERSON, channel: 'view', decisions: [] }], { id: 'rigor-forged-approval' });
    for (const sender of [{ kind: 'agent', userId: 'fixture', agent: 'coordinator' }, { kind: 'machine', userId: 'fixture', machine: 'fixture-machine' }]) {
      const outcome = applyRelayMove(sealedBoard, { ...forged, id: `${forged.id}-${sender.kind}` }, { sequence: appliedSequence(sealedBoard) + 1, at: new Date().toISOString(), kind: 'move', sender });
      assert.equal(outcome.error?.code, 'RELAY_PERSON_ONLY', `a sealed approval from a ${sender.kind} is refused`);
    }
  } finally { store.closeBoard(sealedBoard); }

  // Nothing is approved or applied: every drafted row is a draft, and the board records no decision.
  const rows = json(box, 'spec').rows.filter((row) => [doctrineRow.id, specRow.id, ...both.drafts.map((draft) => draft.id)].includes(row.id));
  assert.equal(rows.length, 4);
  assert.ok(rows.every((row) => row.status === 'draft'), 'every drafted row is still a draft');
  assert.equal(rows.find((row) => row.id === doctrineRow.id).gate, 'check grep -rn TODO src');
  const check = box.run('spec', 'check');
  assert.equal(check.status, 0, `the drafted rows parse cleanly: ${check.stdout}${check.stderr}`);
  assert.ok(!json(box, 'log').events.some((event) => ['row_decision', 'row_apply'].includes(event.event_kind)), 'the command approved and applied nothing');

  // The person's approval applies through the usual spec apply, with no extra item filed.
  const itemsBefore = json(box, 'list', '--all').items.length;
  json(box, 'spec', 'approve', `doctrine:${doctrineRow.id},${specRow.id}`);
  json(box, 'spec', 'apply');
  const applied = json(box, 'spec').rows.filter((row) => drafted.includes(row.id));
  assert.deepEqual(applied.map((row) => row.status), ['approved', 'approved'], 'the person approved both rows and spec apply applied them');
  assert.equal(json(box, 'list', '--all').items.length, itemsBefore, 'approval files no proof-building item; the draft already carries its proof');
});


test('a timed-out proof drains only its captured process group before removing its worktree [D1,D3,S1]', async () => {
  const { parseProcessCensus } = await import('../../../../packages/kernel/src/logic/census.js');
  const box = freshBoard();
  const helper = join(box.repo, 'hold-proof.mjs');
  let resolveMarker;
  let rejectMarker;
  const marker = new Promise((resolve, reject) => { resolveMarker = resolve; rejectMarker = reject; });
  const ready = createServer(socket => {
    let value = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => { value += chunk; });
    socket.once('end', () => {
      try { resolveMarker(JSON.parse(value)); } catch (error) { rejectMarker(error); }
    });
    socket.once('error', rejectMarker);
  });
  ready.listen(0, '127.0.0.1');
  await once(ready, 'listening');
  const port = ready.address().port;
  const timeoutMs = 1000;
  writeFileSync(helper, `
    import { spawn } from 'node:child_process';
    import { createConnection } from 'node:net';
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    const socket = createConnection({ host: '127.0.0.1', port: ${port} });
    socket.on('error', () => process.exit(33));
    socket.end(JSON.stringify({ pids: [process.pid, child.pid] }));
    setInterval(() => {}, 1000);
  `);
  let runOutcome;
  let failure;
  let watchdog;
  try {
    box.git('add', 'hold-proof.mjs');
    box.git('commit', '-q', '-m', 'test: add bounded proof process fixture');
    const before = box.git('worktree', 'list', '--porcelain').split(/\n\n/u).filter(Boolean).length;
    watchdog = setTimeout(() => rejectMarker(new Error('proof fixture did not send its live process identities')), 5000);
    runOutcome = runCheckAt(box.repo, box.git('rev-parse', 'HEAD'), 'unused', {
      executable: process.execPath, args: ['hold-proof.mjs'],
    }, { timeoutMs, parseProcessCensus }).then(value => ({ value }), error => ({ error }));
    const recorded = await marker;
    assert.equal(recorded.pids?.length, 2, 'the real helper reports itself and its child');
    assert.ok(recorded.pids.every(pid => Number.isInteger(pid) && pid > 0) && recorded.pids[0] !== recorded.pids[1]);
    const pre = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,stat=,comm='], { encoding: 'utf8', timeout: 2000, env: { ...process.env, LC_ALL: 'C' } });
    assert.equal(pre.status, 0, 'the pre-timeout census completed');
    const live = parseProcessCensus(pre.stdout);
    assert.ok(live, 'the pre-timeout census is parseable');
    // One parent census proves both live identities; do not spend a second two-second census inside the one-second proof.
    const rows = recorded.pids.map(pid => live.get(pid));
    assert.ok(rows.every(Boolean), 'both reported processes exist in the actual parent census');
    assert.equal(rows[0].pgid, rows[1].pgid, 'both captured processes belong to one group');
    assert.equal(rows[0].pgid, rows[0].pid, 'the proof owns its detached group');
    for (const [index, identity] of rows.entries()) {
      assert.equal(identity.pid, recorded.pids[index], 'the actual census identifies the reported process');
      assert.equal(identity.state.startsWith('Z'), false, 'each process is live before timeout');
    }
    const outcome = await runOutcome;
    if (outcome.error) throw outcome.error;
    assert.equal(outcome.value.timedOut, true, 'the owned proof reports its configured timeout');
    const post = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,stat=,comm='], { encoding: 'utf8', timeout: 2000, env: { ...process.env, LC_ALL: 'C' } });
    assert.equal(post.status, 0, 'the post-timeout census completed');
    const drained = parseProcessCensus(post.stdout);
    assert.ok(drained, 'the post-timeout census is parseable');
    for (const identity of rows) {
      const current = drained.get(identity.pid);
      assert.ok(!current || current.state.startsWith('Z') || current.pgid !== identity.pgid
        || current.started !== identity.started || current.processSha256 !== identity.processSha256,
      'each captured process is absent, a zombie, or a different process');
    }
    assert.equal(box.git('worktree', 'list', '--porcelain').split(/\n\n/u).filter(Boolean).length, before,
      'the temporary proof worktree was removed after its group drained');
  } catch (error) { failure = error; }
  finally {
    clearTimeout(watchdog);
    const outcome = await runOutcome;
    if (!failure && outcome?.error) failure = outcome.error;
    if (failure && outcome) failure.message += '; bounded proof outcome: ' + JSON.stringify(outcome.error
      ? { refusal: outcome.error.code, message: outcome.error.message }
      : { exit: outcome.value.exit, timedOut: outcome.value.timedOut, stderr: outcome.value.stderr });
    await new Promise(resolve => ready.close(resolve));
  }
  if (failure) throw failure;
});
