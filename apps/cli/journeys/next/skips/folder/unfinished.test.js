/** next and claim name an item folder left mid-merge instead of crashing; health lists every such folder (#3763) [B3,C7]. */
import assert from 'node:assert/strict';
import {
  test,
  after,
} from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  createE2eHelpers,
  FIXTURE_MODEL,
} from '../../../../tests/fixtures/e2e.js';
import {
  fileFixtureItem,
  joinFixtureSeat,
} from '../../../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** Run `work` as one agent session, as a real agent shell does: the CLI and the Git hooks it starts see that session. */
function as(box, session, work) {
  const previous = { CLAUDECODE: box.env.CLAUDECODE, CLAUDE_CODE_SESSION_ID: box.env.CLAUDE_CODE_SESSION_ID };
  box.env.CLAUDECODE = '1';
  box.env.CLAUDE_CODE_SESSION_ID = session;
  try { return work(); }
  finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete box.env[name];
      else box.env[name] = value;
    }
  }
}

/** A commit of `text` at `file` on top of main, written with Git plumbing so no checkout switches branch or runs a hook. */
function commitOnMain(box, cwd, file, text) {
  const index = join(box.dir, 'theirs-index');
  const env = { ...process.env, GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.com' };
  const run = (args, input) => execFileSync('git', args, { cwd, env, input, encoding: 'utf8' }).trim();
  run(['read-tree', 'main']);
  const blob = run(['hash-object', '-w', '--stdin'], text);
  run(['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`]);
  return run(['commit-tree', run(['write-tree']), '-p', 'main', '-m', 'their side']);
}

/** Make a web seat checkout and join it from `session`. */
function seat(box, name, session) {
  const root = join(box.dir, name);
  box.git(box.repo, 'worktree', 'add', '-q', root, '-b', `web/${name}`);
  const joined = as(box, session, () => joinFixtureSeat(box, root, 'web', { model: FIXTURE_MODEL }));
  assert.equal(joined.code, 0, `${joined.out}\n${joined.err}`);
  return { root, id: JSON.parse(joined.out).agent };
}

/**
 * Item A first in the queue, whose item folder seat A left in the middle of a conflicted merge after releasing A;
 * item B filed after it. Seat B is another seat of the lane.
 */
function unfinishedBoard() {
  const box = e2e.project();
  const first = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Folder mid-merge', check: 'true', args: ['--specs', 'G1'] });
  const second = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Next free item', check: 'true', args: ['--specs', 'G1'] });
  const a = String(first.item_id), b = String(second.item_id);
  const holder = seat(box, 'web-a', 'session-a');
  const folder = as(box, 'session-a', () => {
  const claimed = box.run(holder.root, 'claim', a);
  assert.equal(claimed.code, 0, `${claimed.out}\n${claimed.err}`);
  const path = /item folder: (.+)/u.exec(claimed.out)?.[1];
  assert.ok(path, claimed.out);
  const theirs = commitOnMain(box, path, 'web/conflict.txt', 'theirs\n');
  assert.equal(e2e.commitFile(box, path, 'web/conflict.txt', 'ours\n', 'feat(web): our side [G1]').status, 0);
  assert.notEqual(box.tryGit(path, 'merge', '--no-edit', theirs).status, 0, 'the merge stops on a conflict');
  assert.notEqual(box.git(path, 'ls-files', '--unmerged'), '', 'the index has unmerged entries');
  const released = box.run(holder.root, 'release', a, '--reason', 'OTHER', '--note', 'fixture');
  assert.equal(released.code, 0, `${released.out}\n${released.err}`);
  return path;
  });
  // A new session takes over the holder's seat, so the session that bound the folder has ended and does not hold it.
  const taken = as(box, 'session-c', () => box.run(holder.root, 'takeover'));
  assert.equal(taken.code, 0, `${taken.out}\n${taken.err}`);
  return { box, a, b, holder, claimer: seat(box, 'web-b', 'session-b'), folder, status: box.git(folder, 'status', '--porcelain') };
}

test('clause 1: next for another seat names ITEM_FOLDER_UNFINISHED for the mid-merge item, leaves its folder untouched and offers the free item [B3,C7]', () => {
  const { box, a, b, claimer, folder, status } = unfinishedBoard();
  const next = as(box, 'session-b', () => box.run(claimer.root, 'next'));
  const all = `${next.out}\n${next.err}`;
  assert.equal(next.code, 0, all);
  assert.match(next.out, new RegExp(`skipped #${a}: \\[ITEM_FOLDER_UNFINISHED\\] item folder .*web-a-item-${a} for #${a} holds an unfinished merge`, 'u'), all);
  assert.match(next.out, new RegExp(`claimed #${b}:`, 'u'), all);
  assert.match(box.run(box.repo, 'show', a).out, new RegExp(`^#${a}\\s+open\\b`, 'mu'), 'A stays open');
  assert.ok(existsSync(join(folder, '.git')), 'the folder stays');
  assert.equal(box.git(folder, 'status', '--porcelain'), status, 'the folder is untouched');
  assert.ok(box.git(folder, 'rev-parse', '--verify', 'MERGE_HEAD'), 'the merge is still in progress');
});

test('clause 1: pullboard claim of the mid-merge item refuses with the named code, the folder path, the operation and the item [B3,C7]', () => {
  const { box, a, claimer, folder, status } = unfinishedBoard();
  const claimed = as(box, 'session-b', () => box.run(claimer.root, 'claim', a));
  const all = `${claimed.out}\n${claimed.err}`;
  assert.notEqual(claimed.code, 0, all);
  assert.doesNotMatch(all, /maintenance cannot archive/u);
  assert.match(all, /ITEM_FOLDER_UNFINISHED/u);
  assert.ok(all.includes(folder), 'names the folder');
  assert.match(all, new RegExp(`#${a} holds an unfinished merge`, 'u'));
  assert.equal(box.git(folder, 'status', '--porcelain'), status, 'the folder is untouched');
});

test('clause 2: pullboard health lists the folder with its unfinished operation, seat and item [B3,C7]', () => {
  const { box, a, holder, folder } = unfinishedBoard();
  const health = box.run(box.repo, 'health');
  const line = `${health.out}\n${health.err}`.split('\n').find(row => row.includes('unfinished merge'));
  assert.ok(line, `${health.out}\n${health.err}`);
  assert.ok(line.includes(folder), line);
  assert.ok(line.includes(holder.id), line);
  assert.ok(line.includes(`#${a}`), line);
});
