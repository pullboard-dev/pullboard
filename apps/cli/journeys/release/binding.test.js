/** The item folder a claim creates or switches belongs to the claiming seat, so whoami, takeover and the hooks work there [B5,C7,#3817]. */
import assert from 'node:assert/strict';
import {
  test,
  after,
} from 'node:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  createE2eHelpers,
  FIXTURE_MODEL,
} from '../../tests/fixtures/e2e.js';
import {
  fileFixtureItem,
  joinFixtureSeat,
} from '../../tests/fixtures/testkit.js';

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

/** A web project with one joined web seat in its own checkout and two open items. */
async function project() {
  const box = e2e.project();
  const ids = ['First bound folder', 'Second bound folder'].map(title =>
    String(fileFixtureItem(box, box.repo, { lane: 'web', title, check: 'true', args: ['--specs', 'G1'] }).item_id));
  const root = join(box.dir, 'web-seat');
  box.git(box.repo, 'worktree', 'add', '-q', root, '-b', 'web/web-seat');
  const joined = await as(box, 'bind-session', () => joinFixtureSeat(box, root, 'web', { model: FIXTURE_MODEL }));
  assert.equal(joined.code, 0, `${joined.out}\n${joined.err}`);
  return { box, ids, seat: { root, id: JSON.parse(joined.out).agent } };
}

/** Claim `id` from the seat checkout and return the item folder the claim names. */
async function claimFolder(box, seat, id) {
  const claimed = await as(box, 'bind-session', () => box.inProcess(seat.root, 'claim', id));
  assert.equal(claimed.code, 0, `${claimed.out}\n${claimed.err}`);
  const path = /item folder: (.+)/u.exec(claimed.out)?.[1];
  assert.ok(path && existsSync(path), claimed.out);
  return path;
}

/** Whoami inside `path` names the seat, and a real commit there passes the hooks' seat check. */
async function assertBound(box, seat, path, file) {
  const who = await as(box, 'bind-session', () => box.inProcess(path, 'whoami', '--json'));
  assert.equal(who.code, 0, `${who.out}\n${who.err}`);
  assert.equal(JSON.parse(who.out).id, seat.id, 'whoami in the item folder names the claiming seat');
  const committed = await as(box, 'bind-session', () => e2e.commitFile(box, path, file, 'bound work\n', 'feat(web): work in the bound folder [G1]'));
  assert.equal(committed.status, 0, `${committed.stdout}\n${committed.stderr}`);
}

test('clause 1: after claim creates an item folder, whoami there names the claiming seat and a commit passes the seat check [B5,C7]', async () => {
  const { box, ids, seat } = await project();
  const path = await claimFolder(box, seat, ids[0]);
  await assertBound(box, seat, path, 'web/first.txt');
});

test('clause 2: a folder switched to a new item by claim stays bound to the same seat [B5,C7]', async () => {
  const { box, ids, seat } = await project();
  const first = await claimFolder(box, seat, ids[0]);
  const released = await as(box, 'bind-session', () => box.inProcess(seat.root, 'release', ids[0], '--reason', 'BLOCKED', '--note', 'fixture switch'));
  assert.equal(released.code, 0, `${released.out}\n${released.err}`);
  const second = await claimFolder(box, seat, ids[1]);
  assert.notEqual(second, first);
  assert.equal(existsSync(first), false, 'the idle folder was switched to the new item, not copied');
  assert.equal(box.git(second, 'branch', '--show-current'), `web/item-${ids[1]}`);
  await assertBound(box, seat, second, 'web/second.txt');
});
