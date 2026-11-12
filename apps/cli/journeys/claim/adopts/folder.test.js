/** A claim adopts another live seat's item folder only when it is clean, unused and unclaimed, and never touches any other [B3,C7,#3720]. */
import assert from 'node:assert/strict';
import {
  test,
  after,
} from 'node:test';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  delimiter,
  join,
  resolve,
} from 'node:path';
import {
  createE2eHelpers,
  FIXTURE_MODEL,
} from '../../../tests/fixtures/e2e.js';
import { runFixtureChild } from '../../../tests/fixtures/child.js';
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

test('clause 1: a claim moves a clean idle item folder from a seat that still has a live session and holds no claim, through the real claim [B3,C7]', () => {
  const { box, id, folder } = priorFolder();
  const second = seat(box, 'web-b', 'session-b');
  const claimed = as(box, 'session-b', () => box.run(second.root, 'claim', id));
  assert.equal(claimed.code, 0, `${claimed.out}\n${claimed.err}`);
  const adopted = /item folder: (.+)/u.exec(claimed.out)?.[1];
  assert.ok(adopted && adopted !== folder, claimed.out);
  assert.equal(existsSync(folder), false, 'the idle folder was moved to the claiming seat');
  assert.equal(box.git(adopted, 'branch', '--show-current'), `web/item-${id}`, 'the branch is kept');
  assert.equal(binding(box, adopted).agent, second.id);
});

/**
 * Run `work` on a PATH that has every tool the box's PATH has except lsof, as a runner without it does.
 *
 * @template T
 * @param {any} box
 * @param {() => T} work
 * @returns {T}
 */
function withoutLsof(box, work) {
  const [shims, ...rest] = box.env.PATH.split(delimiter);
  const bin = join(box.dir, 'bin-without-lsof');
  mkdirSync(bin, { recursive: true });
  for (const dir of rest) {
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (name === 'lsof' || existsSync(join(bin, name))) continue;
      try { symlinkSync(join(dir, name), join(bin, name)); } catch { /* a name another directory already supplied */ }
    }
  }
  const previous = box.env.PATH;
  box.env.PATH = [shims, bin].join(delimiter);
  try { return work(); } finally { box.env.PATH = previous; }
}

test('clause 1: with no lsof on the PATH a clean idle item folder is still adopted, since an unknown probe never reads as busy [B3,C7]', () => {
  const { box, id, folder } = priorFolder();
  const second = seat(box, 'web-b', 'session-b');
  const claimed = withoutLsof(box, () => {
    assert.equal(box.tryGit(box.repo, 'version').status, 0, 'git still runs without lsof');
    assert.equal(runFixtureChild('lsof', ['-v'], { env: box.env, encoding: 'utf8' }).error?.code, 'ENOENT', 'lsof is absent from the PATH');
    return as(box, 'session-b', () => box.run(second.root, 'claim', id));
  });
  assert.equal(claimed.code, 0, `${claimed.out}\n${claimed.err}`);
  const adopted = /item folder: (.+)/u.exec(claimed.out)?.[1];
  assert.ok(adopted && adopted !== folder, claimed.out);
  assert.equal(existsSync(folder), false, 'the idle folder was moved to the claiming seat');
});

test('clause 2: a dirty folder of a live seat is never touched and the refusal names that seat [B3,C7]', () => {
  const { box, id, first, folder } = priorFolder();
  writeFileSync(join(folder, 'scratch.txt'), 'unsaved\n');
  const second = seat(box, 'web-b', 'session-b');
  const claimed = as(box, 'session-b', () => box.run(second.root, 'claim', id));
  const all = `${claimed.out}\n${claimed.err}`;
  assert.notEqual(claimed.code, 0, all);
  assert.match(all, new RegExp(`${first.id}'s live session`, 'u'));
  assert.ok(existsSync(join(folder, 'scratch.txt')), 'the dirty folder keeps its file where it was');
});

test('clause 2: a folder with a process inside it is never touched and the refusal names its seat [B3,C7]', async () => {
  const { box, id, first, folder } = priorFolder();
  const holder = spawn(process.execPath, ['-e', "console.log('ready'); setInterval(() => {}, 1000)"], { cwd: folder, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await once(holder.stdout, 'data');
    const second = seat(box, 'web-b', 'session-b');
    const claimed = as(box, 'session-b', () => box.run(second.root, 'claim', id));
    const all = `${claimed.out}\n${claimed.err}`;
    assert.notEqual(claimed.code, 0, all);
    assert.match(all, new RegExp(`${first.id}'s live session`, 'u'));
    assert.ok(existsSync(folder), 'the folder with a process inside stays where it was');
  } finally { holder.kill(); }
});
