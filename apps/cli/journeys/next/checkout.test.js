/** next never sends item work into a seat checkout, and the pre-commit hook refuses item work committed there (#3691) [B3,C7]. */
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
} from '../../tests/fixtures/e2e.js';
import {
  fileFixtureItem,
  joinFixtureSeat,
} from '../../tests/fixtures/testkit.js';
import { runFixtureChildAsync } from '../../tests/fixtures/child.js';
import { waitForCondition } from '../../tests/fixtures/runner/holders.js';

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

/** The same session swap as `as`, held across an awaited in-process call. */
async function asAsync(box, session, work) {
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
function seat(box, name, session) {
  const root = join(box.dir, name);
  box.git(box.repo, 'worktree', 'add', '-q', root, '-b', `web/${name}`);
  const joined = as(box, session, () => joinFixtureSeat(box, root, 'web', { model: FIXTURE_MODEL }));
  assert.equal(joined.code, 0, `${joined.out}\n${joined.err}`);
  return { root, id: JSON.parse(joined.out).agent };
}

/** The local session binding of a checkout, read from its own Git directory. */
function binding(box, root) {
  return JSON.parse(readFileSync(join(resolve(root, box.git(root, 'rev-parse', '--git-dir')), 'pullboard-checkout-session.json'), 'utf8'));
}

/** Escape a path for a regular expression. */
function literal(text) { return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'); }

/**
 * Item A, whose folder seat A's still-live session holds after it committed there and released A, and item B filed
 * after it. Seat B joins from its own session.
 */
async function liveFolderBoard() {
  const box = e2e.project();
  const first = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Folder held live', check: 'true', args: ['--specs', 'G1'] });
  const second = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Next eligible', check: 'true', args: ['--specs', 'G1'] });
  const a = String(first.item_id), b = String(second.item_id);
  const holder = seat(box, 'web-a', 'session-a');
  const folder = await asAsync(box, 'session-a', async () => {
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
  const claimer = seat(box, 'web-b', 'session-b');
  return { box, a, b, holder, claimer, folder, before: binding(box, folder) };
}

test('clause 1: a seat holding an item whose folder another live session holds is handed a different item in its own item folder by plain pullboard next, never its seat checkout, through the real next path [B3,C7]', async t => {
  const { box, a, b, claimer, folder, before } = await liveFolderBoard();
  const marker = join(box.dir, 'folder-process-ready');
  const child = runFixtureChildAsync(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ready'); setInterval(() => {}, 1000);`], { cwd: folder, env: box.env });
  t.after(async () => { child.child.kill('SIGTERM'); await child; });
  await waitForCondition(() => existsSync(marker), 'the live folder process starts', { signal: AbortSignal.timeout(10_000) }); // Budget: runaway ceiling for the owned process to start.
  await asAsync(box, 'session-b', async () => {
    const claimed = (await box.runLocal(claimer.root, 'claim', a));
    assert.match(`${claimed.out}\n${claimed.err}`, /ITEM_FOLDER_SESSION_LIVE/u);
    assert.match((await box.runLocal(claimer.root, 'show', a)).out, new RegExp(`^#${a}\\s+claimed ${claimer.id}\\b`, 'mu'), 'the refused claim left seat B holding A, as builders found it');
    const shown = (await box.runLocal(claimer.root, 'show', a)).out;
    assert.doesNotMatch(shown, /continue building in this checkout/u, 'show names the item folder, not the seat checkout');
    assert.match(shown, new RegExp(`build and commit in its item folder ${literal(join(box.dir, `web-b-item-${a}`))}`, 'u'), shown);
    const next = (await box.runLocal(claimer.root, 'next'));
    const all = `${next.out}\n${next.err}`;
    assert.equal(next.code, 0, all);
    assert.match(next.out, new RegExp(`claimed #${b}:`, 'u'), all);
    assert.match(next.out, new RegExp(`next: build and commit in ${literal(join(box.dir, `web-b-item-${b}`))},`, 'u'), all);
    assert.doesNotMatch(next.out, new RegExp(`build and commit in ${literal(claimer.root)},`, 'u'), 'next never names the seat checkout');
    assert.match((await box.runLocal(box.repo, 'show', a)).out, new RegExp(`^#${a}\\s+open\\b`, 'mu'), 'seat B handed A back');
  });
  assert.ok(existsSync(folder), 'the live session keeps its folder');
  assert.deepEqual(binding(box, folder), before, 'the live session still owns the folder binding');
});

test('clause 2: a commit of item work on an item branch in a seat checkout is refused by the real pre-commit hook naming the item folder to use [B3,C7]', () => {
  const box = e2e.project();
  const item = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Item work', check: 'true', args: ['--specs', 'G1'] });
  const id = String(item.item_id);
  const claimer = seat(box, 'web-b', 'session-b');
  as(box, 'session-b', () => {
    box.git(claimer.root, 'switch', '-q', '-c', `web/item-${id}`);
    const committed = e2e.commitFile(box, claimer.root, 'web/item.txt', 'item work\n', 'feat(web): item work in the seat [G1]');
    assert.notEqual(committed.status, 0, 'the pre-commit hook refuses the commit');
    assert.match(committed.stderr, /ITEM_WORK_IN_SEAT/u, committed.stderr);
    assert.match(committed.stderr, new RegExp(literal(join(box.dir, `web-b-item-${id}`)), 'u'), 'the refusal names the item folder to use');
    box.git(claimer.root, 'switch', '-q', '-c', 'web/seat-work');
    const seatWork = e2e.commitFile(box, claimer.root, 'web/seat.txt', 'seat work\n', 'feat(web): seat branch work [G1]');
    assert.doesNotMatch(seatWork.stderr ?? '', /ITEM_WORK_IN_SEAT/u, 'a seat branch is not item work');
  });
});
