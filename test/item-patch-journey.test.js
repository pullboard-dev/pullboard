/** File-backed native board journey: exact companion bytes are checked and landed [V1,V4,H16,B3]. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { submitFixture } from './board-submit-fixture.js';
import { createE2eHelpers } from './e2e-helpers.js';

/** Require actual successful native CLI execution before inspecting its document. */
function document(result) {
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  return JSON.parse(result.out);
}

/** Invoke a native command under an explicit independent fixture session. */
function asSession(box, session, cwd, ...args) {
  const previous = box.env.CODEX_THREAD_ID;
  box.env.CODEX_THREAD_ID = session;
  try { return box.run(cwd, ...args, '--json'); }
  finally {
    if (previous === undefined) delete box.env.CODEX_THREAD_ID;
    else box.env.CODEX_THREAD_ID = previous;
  }
}

/** Join an independent real detached worktree without changing the candidate checkout. */
function seat(box, name, lane, commit) {
  const path = join(box.dir, name);
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', path, commit);
  const joined = document(asSession(box, name, path, 'join', lane));
  return { path, id: joined.agent, session: name };
}

/** Observe the live source and index; private verification must leave both byte-identical. */
function liveSource(box, root) {
  const index = box.git(root, 'rev-parse', '--git-path', 'index');
  return { head: box.git(root, 'rev-parse', 'HEAD'), status: box.git(root, 'status', '--porcelain=v1'),
    index: readFileSync(index.startsWith('/') ? index : join(root, index)),
    companion: existsSync(join(root, 'api/companion.txt')) };
}

test('a native companion patch is independently checked and lands the exact accepted composition [V1,V4,H16,B3]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const remote = join(box.dir, 'origin.git');
  box.git(box.dir, 'init', '-q', '--bare', remote);
  box.git(box.repo, 'remote', 'add', 'origin', remote);
  box.git(box.repo, 'push', '-q', '-u', 'origin', 'main');
  box.git(box.repo, 'config', 'user.name', 'Patch journey fixture');
  box.git(box.repo, 'config', 'user.email', 'patch-journey@example.invalid');
  // @pullboard-board-file journey: production CLI verification and landing share this durable board
  const board = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => store.closeBoard(board));
  const observations = join(box.dir, 'frozen-observations.jsonl');
  const joinMarker = join(box.dir, 'main-arrived-once');
  const script = join(box.dir, 'companion-check.cjs');
  writeFileSync(script, [
    "const fs = require('node:fs');",
    "const cp = require('node:child_process');",
    "const file = 'api/companion.txt';",
    "const bytes = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;",
    "const mainFile = 'docs/arrived.txt';",
    "const mainBytes = fs.existsSync(mainFile) ? fs.readFileSync(mainFile, 'utf8') : null;",
    "const head = cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();",
    `fs.appendFileSync(${JSON.stringify(observations)}, JSON.stringify({head,bytes,mainArrived:mainBytes !== null,mainBytes})+'\\n');`,
    "console.log('TAP version 13\\n1..1\\n# Subtest: companion exact bytes and new main input');",
    "const pass = bytes === 'required companion\\n';",
    "console.log((pass ? 'ok' : 'not ok') + ' 1 - companion exact bytes and new main input');",
    `if (pass && !fs.existsSync(${JSON.stringify(joinMarker)})) {`,
    `  fs.mkdirSync(${JSON.stringify(box.repo)} + '/docs', { recursive: true });`,
    `  fs.writeFileSync(${JSON.stringify(box.repo)} + '/docs/arrived.txt', 'main arrived\\n');`,
    `  cp.execFileSync('git', ['-C', ${JSON.stringify(box.repo)}, 'add', 'docs/arrived.txt']);`,
    `  cp.execFileSync('git', ['-C', ${JSON.stringify(box.repo)}, 'commit', '-q', '-m', 'test: move main during patched review [G1]']);`,
    `  cp.execFileSync('git', ['-C', ${JSON.stringify(box.repo)}, 'push', '-q', 'origin', 'main']);`,
    `  fs.writeFileSync(${JSON.stringify(joinMarker)}, 'moved\\n');`,
    "}",
    "process.exitCode = pass ? 0 : 1;",
  ].join('\n'));
  const added = document(box.run(box.repo, 'add', 'web', 'A feature requiring a native companion',
    '--criterion', 'The companion contains exactly the required bytes.', '--specs', 'G1',
    '--check', `node ${JSON.stringify(script)}`, '--json'));
  const id = added.item.item_id;
  const builder = document(asSession(box, 'patch-journey-builder', box.web, 'whoami')).id;
  document(asSession(box, 'patch-journey-builder', box.web, 'claim', String(id)));
  const previousSession = box.env.CODEX_THREAD_ID;
  box.env.CODEX_THREAD_ID = 'patch-journey-builder';
  let committed;
  try { committed = helpers.commitFile(box, box.web, 'web/feature.txt', 'feature\n', 'feat(web): add companion-dependent feature [G1]'); }
  finally { if (previousSession === undefined) delete box.env.CODEX_THREAD_ID; else box.env.CODEX_THREAD_ID = previousSession; }
  assert.equal(committed.status, 0, committed.stderr);
  const submitted = box.git(box.web, 'rev-parse', 'HEAD');
  // State-only setup: this deliberately does not claim the missing companion passed a Submit gate.
  submitFixture(board, id, { agentId: builder, commit: submitted, tree: box.git(box.web, 'rev-parse', 'HEAD^{tree}') });
  const author = seat(box, 'patch-journey-author', 'api', submitted);
  const reviewer = seat(box, 'patch-journey-reviewer', 'api', submitted);
  const before = liveSource(box, reviewer.path);
  const red = asSession(box, reviewer.session, reviewer.path, 'verify', String(id), 'accept', '--note', 'The real frozen check must refuse missing bytes.');
  assert.equal(red.code, 1, red.err || red.out);
  assert.equal(JSON.parse(red.out).error.code, 'CHECK_RED');
  assert.equal(store.getItem(board, id).item_status, 'submitted');
  assert.deepEqual(liveSource(box, reviewer.path), before);
  mkdirSync(join(author.path, 'api'), { recursive: true });
  writeFileSync(join(author.path, 'api/companion.txt'), 'required companion\n');
  box.git(author.path, 'add', 'api/companion.txt');
  const patch = box.git(author.path, 'diff', '--cached', '--binary') + '\n';
  const patchFile = join(box.dir, 'companion.patch');
  writeFileSync(patchFile, patch);
  document(box.run(box.repo, 'patch', 'attach', String(id), patchFile, '--key', 'companion-v1', '--author', author.id, '--source', submitted, '--json'));
  const authorRefused = asSession(box, author.session, author.path, 'next', '--verify', String(id));
  assert.equal(authorRefused.code, 1, authorRefused.err || authorRefused.out);
  assert.match(JSON.parse(authorRefused.out).error.code, /^SELF_(?:SESSION_)?VERIFY$/);
  document(asSession(box, reviewer.session, reviewer.path, 'verify', String(id), 'accept', '--note', 'Observed exact companion bytes through the real frozen check.'));
  const accepted = store.getItem(board, id);
  const reviewed = store.verdictsFor(board, id).at(-1).review.head;
  assert.equal(accepted.item_status, 'verified');
  assert.notEqual(reviewed, submitted);
  assert.equal(box.git(box.repo, 'show', `${reviewed}:api/companion.txt`), 'required companion');
  assert.deepEqual(liveSource(box, reviewer.path), before, 'verification never modifies live HEAD, index, or checkout');
  const runs = readFileSync(observations, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(runs.some(run => run.head === submitted && run.bytes === null), 'unpatched frozen execution actually failed');
  assert.ok(runs.some(run => run.head === reviewed && run.bytes === 'required companion\n'), 'accepted source actually ran with exact bytes');
  const patchedRuns = runs.filter(run => run.bytes === 'required companion\n');
  assert.equal(patchedRuns.length, 2, 'a real main advance during the first patched check causes exactly one retry');
  assert.notEqual(patchedRuns[0].head, patchedRuns[1].head, 'the retry checks a distinct composed source');
  assert.equal(patchedRuns[0].mainArrived, false);
  assert.equal(patchedRuns[1].mainArrived, true);
  assert.equal(patchedRuns[1].mainBytes, 'main arrived\n');
  assert.equal(reviewed, patchedRuns[1].head, 'the accepted verdict binds to the second patched check');
  assert.equal(box.git(box.repo, 'rev-list', '--count', `${submitted}..main`), '1', 'the fixture advances main exactly once');
  assert.equal(box.git(box.repo, 'show', `${reviewed}:docs/arrived.txt`), 'main arrived', 'the accepted composition includes the exact new main bytes');
  document(box.run(box.repo, 'patch', 'remove', String(id), 'companion-v1', '--json'));
  assert.equal(store.getItem(board, id).item_status, 'submitted', 'a changed active set invalidates acceptance');
  assert.equal(store.getItem(board, id).item_verified_by, null);
  document(box.run(box.repo, 'patch', 'attach', String(id), patchFile, '--key', 'companion-v2', '--author', author.id, '--source', submitted, '--json'));
  document(asSession(box, reviewer.session, reviewer.path, 'verify', String(id), 'accept', '--note', 'Rechecked the newly bound patch set.'));
  const finalReviewed = store.verdictsFor(board, id).at(-1).review.head;
  const landed = document(box.run(box.repo, 'land', '--json'));
  assert.deepEqual(landed.landed, [id]);
  assert.equal(box.git(box.repo, 'merge-base', '--is-ancestor', finalReviewed, 'main'), '');
  assert.equal(readFileSync(join(box.repo, 'api/companion.txt'), 'utf8'), 'required companion\n');
  assert.equal(box.git(box.repo, 'show', `${finalReviewed}:api/companion.txt`), 'required companion', 'landing retains reviewed bytes without reapplying');
});
