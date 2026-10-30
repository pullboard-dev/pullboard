/** Real queued submissions retain immutable source and native gate authority [V4,H16,E18]. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { openBoard } from '../src/native-board.js';
import { getItem } from '../src/board-query.js';
import { submitHandoff } from '../src/submit-handoff-read.js';
import { completeSubmitHandoff } from '../src/submit-handoff-state.js';

/** Require authentic command success before interpreting any native result. */
function document(result) {
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  return JSON.parse(result.out);
}

/** Read the real SQLite state without writing or inventing a proof receipt. */
function state(box, id) {
  const board = openBoard(box.boardFile);
  try { return { item: getItem(board, id), job: submitHandoff(board, id) }; }
  finally { board.db.close(); }
}

/** Quote a private fixture path for the actual configured shell command. */
function word(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

/** Build a native project whose frozen check waits for a real release file, not a timing margin. */
function fixture(t, { enabled = true, result = 'green', companion = false } = {}) {
  const helpers = createE2eHelpers();
  const box = helpers.project('true');
  const armed = join(box.dir, 'armed');
  const release = join(box.dir, 'release');
  const started = join(box.dir, 'started.jsonl');
  const script = join(box.dir, 'gate.cjs');
  writeFileSync(script, [
    "const fs = require('node:fs'); const cp = require('node:child_process');",
    "const value = fs.existsSync('web/snapshot.txt') ? fs.readFileSync('web/snapshot.txt', 'utf8').trim() : 'base';",
    `if (fs.existsSync(${JSON.stringify(armed)}) && value !== 'base') {`,
    ` fs.appendFileSync(${JSON.stringify(started)}, JSON.stringify({value, head:cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()})+'\\n');`,
    ...(companion ? [" if (fs.readFileSync('api/companion.txt','utf8') !== 'required\\n') throw Error('required companion missing');"] : []),
    ' const deadline = Date.now() + 120000;',
    ` while (!fs.existsSync(${JSON.stringify(release)})) { if (Date.now() > deadline) throw Error('fixture release never arrived'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20); }`,
    " if (value === 'red') process.exitCode = 1;",
    '}',
  ].join('\n'));
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, submit: { handoff: enabled } }, null, 2) + '\n');
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure native submit handoff [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  box.boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const check = `${word(process.execPath)} ${word(script)}`;
  const id = document(box.run(box.repo, 'add', 'web', 'Captured submit source', '--specs', 'G1',
    '--criterion', 'The captured candidate passes its real gate.', '--check', check, '--wait', '--json')).item.item_id;
  const second = document(box.run(box.repo, 'add', 'web', 'Independent second build', '--specs', 'G1',
    '--criterion', 'The second build remains separate.', '--check', 'true', '--wait', '--json')).item.item_id;
  document(box.run(box.web, 'claim', String(id), '--json'));
  assert.equal(helpers.commitFile(box, box.web, 'web/snapshot.txt', result + '\n', 'feat(web): captured candidate [G1]').status, 0);
  const commit = box.git(box.web, 'rev-parse', 'HEAD');
  writeFileSync(armed, 'armed\n');
  t.after(async () => {
    writeFileSync(release, 'release\n');
    const job = state(box, id).job;
    if (job) await helpers.waitFor(() => {
      const current = state(box, id).job;
      return current && !['queued', 'running'].includes(current.state)
        && !existsSync(join(box.repo, '.git', 'pullboard', 'submit-handoffs', current.id, 'source'));
    }, 'queued worker completion and normal temporary worktree removal', 120000);
    helpers.cleanup();
  });
  return { ...box, helpers, id, second, commit, release, started };
}

test('queued submit returns before its gate and remains bound when the builder commits and claims again [V4,H16,E18]', async t => {
  const box = fixture(t, { companion: true });
  const author = join(box.dir, 'companion-author');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', author, box.commit);
  const authorId = document(box.run(author, 'join', 'api', '--json')).agent;
  mkdirSync(join(author, 'api'), { recursive: true });
  writeFileSync(join(author, 'api', 'companion.txt'), 'required\n');
  box.git(author, 'add', 'api/companion.txt');
  const patch = join(box.dir, 'companion.diff');
  writeFileSync(patch, box.git(author, 'diff', '--cached', '--binary') + '\n');
  document(box.run(box.repo, 'patch', 'attach', String(box.id), patch, '--key', 'required-companion', '--author', authorId, '--source', box.commit, '--json'));
  const queued = document(box.run(box.web, 'submit', String(box.id), '--no-next', '--json'));
  assert.equal(queued.queued, true);
  assert.equal(queued.commit, box.commit);
  assert.match(queued.companionDigest, /^[a-f0-9]{64}$/u);
  assert.equal(document(box.run(box.web, 'submit', String(box.id), '--no-next', '--json')).commit, queued.commit);
  assert.equal(existsSync(box.release), false, 'submit acknowledged while the gate was still blocked');
  await box.helpers.waitFor(() => existsSync(box.started), 'actual captured gate execution', 120000);
  assert.equal(state(box, box.id).item.item_status, 'claimed', 'unproved work is never reviewable');
  assert.equal(helpersCommit(box, 'web/later.txt', 'later\n').status, 0);
  document(box.run(box.web, 'claim', String(box.second), '--json'));
  const duplicate = state(box, box.id).job;
  assert.equal(duplicate.commit, box.commit);
  writeFileSync(box.release, 'release\n');
  await box.helpers.waitFor(() => state(box, box.id).job?.state === 'green', 'native proved submission', 120000);
  const completed = state(box, box.id);
  assert.equal(completed.item.item_status, 'submitted');
  assert.equal(completed.item.item_commit, box.commit);
  assert.equal(state(box, box.second).item.item_owner, completed.job.agentId);
  assert.deepEqual(readFileSync(box.started, 'utf8').trim().split('\n').map(JSON.parse), [{ value: 'green', head: completed.job.executionCommit }]);
  assert.notEqual(completed.job.executionCommit, box.commit, 'the native companion composition was actually executed');
  const reviewer = join(box.dir, 'reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, 'main');
  document(box.run(reviewer, 'join', 'api', '--json'));
  assert.equal(document(box.run(reviewer, 'next', '--verify', String(box.id), '--json')).item.item_id, box.id);
});

/** Make a real later builder commit without replacing the queued source. */
function helpersCommit(box, path, body) {
  return box.helpers.commitFile(box, box.web, path, body, 'feat(web): independent later work [G1]');
}

test('a queued red retains the exact canonical refusal and builder first refusal while another claim stays owned [V4,H16]', async t => {
  const box = fixture(t, { result: 'red' });
  document(box.run(box.web, 'submit', String(box.id), '--no-next', '--json'));
  await box.helpers.waitFor(() => existsSync(box.started), 'actual red candidate execution', 120000);
  document(box.run(box.web, 'claim', String(box.second), '--json'));
  writeFileSync(box.release, 'release\n');
  await box.helpers.waitFor(() => state(box, box.id).job?.state === 'red', 'canonical gate refusal', 120000);
  const completed = state(box, box.id);
  assert.equal(completed.item.item_status, 'open');
  assert.equal(completed.job.error.code, 'GATE_RED');
  const retained = JSON.parse(readFileSync(join(box.repo, '.git', 'pullboard', 'submit-handoffs', completed.job.id, 'refusal.json'), 'utf8'));
  assert.deepEqual(completed.job.error, retained.error);
  assert.equal(state(box, box.second).item.item_owner, completed.job.agentId);
  const shown = document(box.run(box.web, 'show', String(box.id), '--json'));
  assert.deepEqual(shown.queuedSubmit.error, retained.error);
});

test('setting off retains foreground submit until the real gate finishes [V4]', async t => {
  const box = fixture(t, { enabled: false });
  const child = box.helpers.launch(box, box.web, process.execPath, [box.helpers.BIN, 'submit', String(box.id), '--no-next', '--json']);
  let closed = false;
  child.closed.then(() => { closed = true; });
  await box.helpers.waitFor(() => existsSync(box.started), 'foreground gate execution', 120000);
  assert.equal(closed, false);
  assert.equal(state(box, box.id).job, null);
  writeFileSync(box.release, 'release\n');
  const exit = await child.closed;
  assert.equal(exit.code, 0, child.stderrText);
  assert.equal(JSON.parse(child.stdoutText).gate.green, true);
});

test('a handoff result cannot invent a green submission or complete another sender job [V4,E18]', async t => {
  const box = fixture(t);
  document(box.run(box.web, 'submit', String(box.id), '--no-next', '--json'));
  const board = openBoard(box.boardFile);
  try {
    const job = submitHandoff(board, box.id);
    assert.throws(() => completeSubmitHandoff(board, box.id, { agentId: 'foreign-seat', job: job.id, result: { code: 0, commit: box.commit } }), { code: 'SUBMIT_HANDOFF_CHANGED' });
    assert.throws(() => completeSubmitHandoff(board, box.id, { agentId: job.agentId, job: job.id, result: { code: 0, commit: box.commit } }), { code: 'SUBMIT_HANDOFF_RESULT' });
    assert.equal(getItem(board, box.id).item_status, 'claimed');
  } finally { board.db.close(); }
});
