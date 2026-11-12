/** next leaves out an item whose folder another live session holds and hands the next eligible item; claim still refuses it (#3688) [B3,C7]. */
import assert from 'node:assert/strict';
import {
  test,
  after,
} from 'node:test';
import {
  existsSync,
  readFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import {
  createE2eHelpers,
  FIXTURE_MODEL,
} from '../../../../tests/fixtures/e2e.js';
import {
  fileFixtureItem,
  joinFixtureSeat,
} from '../../../../tests/fixtures/testkit.js';
import { runFixtureChildAsync } from '../../../../tests/fixtures/child.js';
import { waitForCondition } from '../../../../tests/fixtures/runner/holders.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/**
 * Run `work` as one agent session: the CLI and the Git hooks it starts all see that session, as a real agent shell does.
 *
 * @template T
 * @param {any} box
 * @param {string} session the session id
 * @param {() => T} work
 * @returns {T}
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
  const joined = await as(box, session, async () => joinFixtureSeat(box, root, 'web', { model: FIXTURE_MODEL }));
  assert.equal(joined.code, 0, `${joined.out}\n${joined.err}`);
  return { root, id: JSON.parse(joined.out).agent };
}

/** The local session binding of a checkout, read from its own Git directory. */
function binding(box, root) {
  return JSON.parse(readFileSync(join(resolve(root, box.git(root, 'rev-parse', '--git-dir')), 'pullboard-checkout-session.json'), 'utf8'));
}

/**
 * Item A first in the queue, whose folder seat A's still-live session holds after it committed there and released A;
 * item B filed after it. Seat B joins from its own session.
 */
async function liveFolderBoard() {
  const box = e2e.project();
  const first = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Folder held live', check: 'true', args: ['--specs', 'G1'] });
  const second = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Next eligible', check: 'true', args: ['--specs', 'G1'] });
  const a = String(first.item_id), b = String(second.item_id);
  const holder = await seat(box, 'web-a', 'session-a');
  const folder = await as(box, 'session-a', async () => {
    const claimed = (await box.runLocal(holder.root, 'claim', a));
    assert.equal(claimed.code, 0, `${claimed.out}\n${claimed.err}`);
    const path = /item folder: (.+)/u.exec(claimed.out)?.[1];
    assert.ok(path, claimed.out);
    const committed = e2e.commitFile(box, path, 'web/kept.txt', 'kept work\n', 'feat(web): kept prior work [G1]');
    assert.equal(committed.status, 0, committed.stderr);
    const released = (await box.runLocal(holder.root, 'release', a, '--reason', 'OTHER', '--note', 'fixture'));
    assert.equal(released.code, 0, `${released.out}\n${released.err}`);
    return path;
  });
  const claimer = await seat(box, 'web-b', 'session-b');
  return { box, a, b, holder, claimer, folder, before: binding(box, folder) };
}

/** Keep a real process in the clean folder while the live session uses it. */
async function keepFolderInUse(t, box, folder) {
  const marker = join(box.dir, 'folder-process-ready');
  // Process-level case, kept: a live OS process must hold the folder open for the other session to see.
  const child = runFixtureChildAsync(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ready'); setInterval(() => {}, 1000);`], { cwd: folder, env: box.env });
  t.after(async () => { child.child.kill('SIGTERM'); await child; });
  await waitForCondition(() => existsSync(marker), 'the folder process starts', { signal: AbortSignal.timeout(10_000) }); // Budget: runaway ceiling for the owned process to start.
}

test('clause 1: with item A first and its folder held by another live session, plain pullboard next hands item B through the real next path instead of refusing ITEM_FOLDER_SESSION_LIVE [B3,C7]', async t => {
  const { box, a, b, claimer, folder, before } = await liveFolderBoard();
  await keepFolderInUse(t, box, folder);
  const next = await as(box, 'session-b', async () => (await box.runLocal(claimer.root, 'next')));
  const all = `${next.out}\n${next.err}`;
  assert.equal(next.code, 0, all);
  assert.doesNotMatch(all, /ITEM_FOLDER_SESSION_LIVE/u);
  assert.match(next.out, new RegExp(`claimed #${b}:`, 'u'), all);
  assert.match(next.out, new RegExp(`item folder: ${join(box.dir, `web-b-item-${b}`).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'), 'B is built in a fresh item folder of seat B');
  const shownA = (await box.runLocal(box.repo, 'show', a));
  assert.match(shownA.out, new RegExp(`^#${a}\\s+open\\b`, 'mu'), `A stays open, never claimed by seat B: ${shownA.out}`);
  assert.ok(existsSync(folder), 'the live session keeps its folder');
  assert.deepEqual(binding(box, folder), before, 'the live session still owns the folder binding');
});

test('clause 2: pullboard claim A on that seat still refuses ITEM_FOLDER_SESSION_LIVE naming the live session [B3,C7]', async t => {
  const { box, a, holder, claimer, folder, before } = await liveFolderBoard();
  await keepFolderInUse(t, box, folder);
  const claimed = await as(box, 'session-b', async () => (await box.runLocal(claimer.root, 'claim', a)));
  const all = `${claimed.out}\n${claimed.err}`;
  assert.notEqual(claimed.code, 0, all);
  assert.match(all, /ITEM_FOLDER_SESSION_LIVE/u);
  assert.match(all, new RegExp(`${holder.id}'s live session`, 'u'), 'the refusal names the live session');
  assert.deepEqual(binding(box, folder), before, 'nothing was adopted');
});
