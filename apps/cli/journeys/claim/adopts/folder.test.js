/** A claim adopts another live seat's item folder only when it is clean, unused and unclaimed, and never touches any other [B3,C7,#3720]. */
import assert from 'node:assert/strict';
import {
  test,
  after,
} from 'node:test';
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  join,
  resolve,
} from 'node:path';
import {
  createE2eHelpers,
  FIXTURE_MODEL,
} from '../../../tests/fixtures/e2e.js';
import {
  fileFixtureItem,
  joinFixtureSeat,
} from '../../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/**
 * Run `work` as one agent session: the CLI and the Git hooks it starts all see that session, as a real agent shell does.
 * The coordinator's commands run outside any session, matching how the fixture bound the main checkout.
 *
 * @template T
 * @param {any} box
 * @param {string} session the session id
 * @param {() => T} work
 * @returns {Promise<T>}
 */
async function as(box, session, work) {
  const previous = { CLAUDECODE: box.env.CLAUDECODE, CLAUDE_CODE_SESSION_ID: box.env.CLAUDE_CODE_SESSION_ID };
  box.env.CLAUDECODE = '1';
  box.env.CLAUDE_CODE_SESSION_ID = session;
  try { return await work(); }
  finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete box.env[name];
      else box.env[name] = value;
    }
  }
}

/**
 * Make a web seat checkout and join it from `session`.
 *
 * @param {any} box
 * @param {string} name the folder name
 * @param {string} session
 * @returns {{ root: string, id: string }}
 */
async function seat(box, name, session) {
  const root = join(box.dir, name);
  box.git(box.repo, 'worktree', 'add', '-q', root, '-b', `web/${name}`);
  const joined = await as(box, session, () => joinFixtureSeat(box, root, 'web', { model: FIXTURE_MODEL, run: box.runLocal }));
  assert.equal(joined.code, 0, `${joined.out}\n${joined.err}`);
  return { root, id: JSON.parse(joined.out).agent };
}

/** The local session binding of a checkout, read from its own Git directory. */
function binding(box, root) {
  return JSON.parse(readFileSync(join(resolve(root, box.git(root, 'rev-parse', '--git-dir')), 'pullboard-checkout-session.json'), 'utf8'));
}

/**
 * Seat A claims an item from session-a, commits in its item folder through the real commit hook (which binds the folder
 * to session-a) and releases the item, leaving the folder with its unlanded commit.
 *
 * @returns {{ box: any, id: string, first: { root: string, id: string }, folder: string }}
 */
async function priorFolder() {
  const box = e2e.project();
  const item = await fileFixtureItem(box, box.repo, { lane: 'web', title: 'Adopted folder', check: 'true', args: ['--specs', 'G1'], run: box.runLocal });
  const id = String(item.item_id);
  const first = await seat(box, 'web-a', 'session-a');
  const folder = await as(box, 'session-a', async () => {
    const claimed = await box.runLocal(first.root, 'claim', id);
    assert.equal(claimed.code, 0, `${claimed.out}\n${claimed.err}`);
    const path = /item folder: (.+)/u.exec(claimed.out)?.[1];
    assert.ok(path, claimed.out);
    const committed = e2e.commitFile(box, path, 'web/kept.txt', 'kept work\n', 'feat(web): kept prior work [G1]');
    assert.equal(committed.status, 0, committed.stderr);
    const released = await box.runLocal(first.root, 'release', id, '--reason', 'BLOCKED', '--note', 'fixture');
    assert.equal(released.code, 0, `${released.out}\n${released.err}`);
    return path;
  });
  assert.ok(existsSync(folder), 'the released folder keeps its unlanded commit');
  assert.deepEqual([binding(box, folder).agent], [first.id], 'the real commit hook bound the folder to seat A');
  return { box, id, first, folder };
}

test('clause 1: a claim moves a clean idle item folder from a seat that still has a live session and holds no claim, through the real claim [B3,C7]', async () => {
  const { box, id, folder } = await priorFolder();
  const second = await seat(box, 'web-b', 'session-b');
  const claimed = await as(box, 'session-b', () => box.runLocal(second.root, 'claim', id));
  if (claimed.code !== 0) { const { spawnSync } = await import('node:child_process'); const l = spawnSync('lsof', ['-w', '-d', 'cwd', '-Fpcn']); const lines = String(l.stdout ?? '').split('\n'); const hits = lines.map((x, i) => /web-a-item/.test(x) ? lines.slice(Math.max(0, i - 2), i + 1).join('|') : '').filter(Boolean); assert.fail(`DBG err=${l.error?.code} st=${l.status} n=${lines.length} git=[${box.git(folder, 'status', '--porcelain', '--untracked-files=all').toString().trim().slice(0, 60)}] hits=${hits.join(';').slice(0, 150)}`); }
  assert.equal(claimed.code, 0, `${claimed.out}\n${claimed.err}`);
  const adopted = /item folder: (.+)/u.exec(claimed.out)?.[1];
  assert.ok(adopted && adopted !== folder, claimed.out);
  assert.equal(existsSync(folder), false, 'the idle folder was moved to the claiming seat');
  assert.equal(box.git(adopted, 'branch', '--show-current'), `web/item-${id}`, 'the branch is kept');
  assert.equal(binding(box, adopted).agent, second.id);
});

test('clause 2: a dirty folder of a live seat is never touched and the refusal names that seat [B3,C7]', async () => {
  const { box, id, first, folder } = await priorFolder();
  writeFileSync(join(folder, 'scratch.txt'), 'unsaved\n');
  const second = await seat(box, 'web-b', 'session-b');
  const claimed = await as(box, 'session-b', () => box.runLocal(second.root, 'claim', id));
  const all = `${claimed.out}\n${claimed.err}`;
  assert.notEqual(claimed.code, 0, all);
  assert.match(all, new RegExp(`${first.id}'s live session`, 'u'));
  assert.ok(existsSync(join(folder, 'scratch.txt')), 'the dirty folder keeps its file where it was');
});

test('clause 2: a folder with a process inside it is never touched and the refusal names its seat [B3,C7]', async () => {
  const { box, id, first, folder } = await priorFolder();
  // Process-level case: a real child process must sit inside the folder; `sleep` is not a CLI or node launch.
  const holder = spawn('/bin/sh', ['-c', 'echo ready; exec sleep 300'], { cwd: folder, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await once(holder.stdout, 'data');
    const second = await seat(box, 'web-b', 'session-b');
    const claimed = await as(box, 'session-b', () => box.runLocal(second.root, 'claim', id));
    const all = `${claimed.out}\n${claimed.err}`;
    assert.notEqual(claimed.code, 0, all);
    assert.match(all, new RegExp(`${first.id}'s live session`, 'u'));
    assert.ok(existsSync(folder), 'the folder with a process inside stays where it was');
  } finally { holder.kill(); }
});
