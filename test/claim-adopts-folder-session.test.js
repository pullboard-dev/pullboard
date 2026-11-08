/** A claim that adopts an item folder from an ended session also takes its checkout binding, so the claimer can commit there [B3,C7]. */
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createE2eHelpers, FIXTURE_MODEL } from './e2e-helpers.js';
import { fileFixtureItem, joinFixtureSeat } from './testkit-fixture.js';

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

/**
 * Seat A claims an item from session-a, commits in its item folder through the real commit hook (which binds the folder
 * to session-a) and releases the item, leaving the folder with its unlanded commit.
 *
 * @returns {{ box: any, id: string, first: { root: string, id: string }, folder: string }}
 */
function priorFolder() {
  const box = e2e.project();
  const item = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Adopted folder', check: 'true', args: ['--specs', 'G1'] });
  const id = String(item.item_id);
  const first = seat(box, 'web-a', 'session-a');
  const folder = as(box, 'session-a', () => {
    const claimed = box.run(first.root, 'claim', id);
    assert.equal(claimed.code, 0, `${claimed.out}\n${claimed.err}`);
    const path = /item folder: (.+)/u.exec(claimed.out)?.[1];
    assert.ok(path, claimed.out);
    const committed = e2e.commitFile(box, path, 'web/kept.txt', 'kept work\n', 'feat(web): kept prior work [G1]');
    assert.equal(committed.status, 0, committed.stderr);
    const released = box.run(first.root, 'release', id, '--reason', 'BLOCKED', '--note', 'fixture');
    assert.equal(released.code, 0, `${released.out}\n${released.err}`);
    return path;
  });
  assert.ok(existsSync(folder), 'the released folder keeps its unlanded commit');
  assert.deepEqual([binding(box, folder).agent], [first.id], 'the real commit hook bound the folder to seat A');
  return { box, id, first, folder };
}

/** End session-a: a new session takes seat A's checkout over, as a restarted agent does. */
function endFirstSession(box, first) {
  const taken = as(box, 'session-a2', () => box.run(first.root, 'takeover'));
  assert.equal(taken.code, 0, `${taken.out}\n${taken.err}`);
}

test('clause 1: a seat claiming an item whose folder an ended session left adopts it through the real claim path and commits in it through the real commit hook with no takeover [B3,C7]', () => {
  const { box, id, first, folder } = priorFolder();
  endFirstSession(box, first);
  const second = seat(box, 'web-b', 'session-b');
  as(box, 'session-b', () => {
    const claimed = box.run(second.root, 'claim', id);
    assert.equal(claimed.code, 0, `${claimed.out}\n${claimed.err}`);
    const adopted = /item folder: (.+)/u.exec(claimed.out)?.[1];
    assert.ok(adopted && adopted !== folder, claimed.out);
    assert.equal(existsSync(folder), false, 'the folder was moved to the claiming seat');
    assert.equal(binding(box, adopted).agent, second.id, 'the adopted folder now belongs to the claiming seat');
    const committed = e2e.commitFile(box, adopted, 'web/next.txt', 'next work\n', 'feat(web): continue adopted work [G1]');
    assert.equal(committed.status, 0, `the real commit hook accepts the claimer's commit: ${committed.stderr}`);
    assert.doesNotMatch(committed.stderr ?? '', /NOT_YOUR_CHECKOUT/u);
    assert.equal(box.git(adopted, 'log', '-1', '--format=%s'), 'feat(web): continue adopted work [G1]');
  });
});

test('clause 1: the same seat in a new session reclaims its own item folder bound to its ended session and commits there through the real hook [B3,C7]', () => {
  const { box, id, first, folder } = priorFolder();
  endFirstSession(box, first);
  as(box, 'session-a2', () => {
    const claimed = box.run(first.root, 'claim', id);
    assert.equal(claimed.code, 0, `${claimed.out}\n${claimed.err}`);
    assert.equal(/item folder: (.+)/u.exec(claimed.out)?.[1], folder, claimed.out);
    const committed = e2e.commitFile(box, folder, 'web/next.txt', 'next work\n', 'feat(web): continue in a new session [G1]');
    assert.equal(committed.status, 0, `the real commit hook accepts the new session's commit: ${committed.stderr}`);
  });
});

test('clause 2: a folder whose previous session is still live is never adopted, and the claim refusal names that session [B3,C7]', () => {
  const { box, id, first, folder } = priorFolder();
  // A clean idle folder is adopted since #3720; unsaved work keeps the live session's folder retained.
  writeFileSync(join(folder, 'scratch.txt'), 'unsaved\n');
  const before = binding(box, folder);
  const second = seat(box, 'web-b', 'session-b');
  const claimed = as(box, 'session-b', () => box.run(second.root, 'claim', id));
  const all = `${claimed.out}\n${claimed.err}`;
  assert.notEqual(claimed.code, 0, all);
  assert.match(all, /ITEM_FOLDER_SESSION_LIVE/u);
  assert.match(all, new RegExp(`${first.id}'s live session`, 'u'), 'the refusal names the live session');
  assert.ok(existsSync(folder), 'the live session keeps its folder where it was');
  assert.equal(existsSync(join(box.dir, `web-b-item-${id}`)), false, 'nothing was adopted');
  assert.deepEqual(binding(box, folder), before, 'the live session still owns the folder binding');
});
