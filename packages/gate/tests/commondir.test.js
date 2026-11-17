/** @pullboard-test-input apps/cli/src/io/current.js apps/cli/src/io/resident/client.js packages/git/src/io/main.js */
/** GitHub #16: Windows paths that differ only by \ versus / resolve to one commonDir [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { relative } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from './fixtures/child.js';
import { laneSeatContext } from '../../seats/index.js';
import { canonicalCommonDir } from '../../git/index.js';
import { repoInfo } from '../../git/index.js';
import { sameCommonDir } from '../../git/index.js';

const root = resolve(import.meta.dirname, '../../..');

test('gate.commondir.c-x-git-c-x: clause 1: C:\\x\\.git and C:/x/.git canonicalise to one commonDir and compare equal [C7]', () => {
  assert.equal(canonicalCommonDir('C:\\x\\.git'), 'C:/x/.git');
  assert.equal(canonicalCommonDir('C:/x/.git'), 'C:/x/.git');
  assert.equal(canonicalCommonDir('c:\\x\\.git\\'), 'C:/x/.git');
  assert.equal(canonicalCommonDir('\\\\host\\share\\r\\.git'), '//host/share/r/.git');
  assert.ok(sameCommonDir('C:\\x\\.git', 'C:/x/.git'));
  assert.ok(!sameCommonDir('C:\\x\\.git', 'C:/y/.git'));
  assert.ok(!sameCommonDir(undefined, undefined));
  assert.equal(canonicalCommonDir('/tmp/a\\b/.git'), '/tmp/a\\b/.git', 'POSIX paths keep a literal backslash');
});

test('gate.commondir.repoinfo-returns-canonical-commondir: clause 1: repoInfo returns the canonical commonDir [C7]', () => {
  const info = repoInfo(root);
  assert.equal(info.commonDir, canonicalCommonDir(info.commonDir));
});

test('gate.commondir.laneseatcontext-reuses-invoking-seat-when: clause 2: laneSeatContext reuses the invoking seat when both commonDir spellings name one repo [C7]', async t => {
  const dir = privateFixtureFiles('pb-wincommon-').root;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  run(dir, 'init', '-q', '-b', 'main');
  run(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x');
  const seatPath = join(dir, 'seat');
  run(dir, 'worktree', 'add', '-q', '-b', 'core/seat', seatPath);
  const main = repoInfo(dir), seat = repoInfo(seatPath);
  assert.ok(sameCommonDir(main.commonDir, seat.commonDir));
  // The invoking context names the same repository with the other slash spelling.
  const flipped = main.commonDir.replace(/\//gu, '\\');
  assert.ok(sameCommonDir(flipped, main.commonDir) || !/^[A-Za-z]:/u.test(main.commonDir));
  const item = { item_status: 'open', item_lane: 'core', item_route: 'light' };
  let opened = 0;
  const store = {
    ROUTES: ['light'], listItems: () => [], agentById: () => ({ agent_id: 'a', agent_lane: 'core', agent_route: 'light', agent_path: seatPath }),
    agentAt: () => ({ agent_id: 'a', agent_path: seatPath }),
  };
  const ctx = { info: { ...main, root: seatPath }, io: {} };
  await laneSeatContext(ctx, 'b', { id: 'a', route: 'light' }, item, [], () => ctx, {
    store, sessionDigest: () => 'd', openWorktree: async () => { opened += 1; },
  }).catch(() => {});
  assert.equal(opened, 0, 'no second seat is opened (no app-2)');
});

/** Source files that may hold a commonDir comparison. */
function sources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'tests' || name === 'test' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (name.endsWith('.js')) out.push(path);
  }
  return out;
}

test('gate.commondir.raw-commondir-comparison-outside-canonical: clause 3: no raw commonDir === or !== comparison outside the canonical helper [C7]', () => {
  const raw = /\w*commonDir\)?\s*[!=]==(?!\s*['"`]|\s*null\b)|[!=]==\s*[\w.?()]*commonDir/iu;
  // resident-client and current-cli compare two paths from one Git answer and must stay import-light.
  const allowed = new Set(['apps/cli/src/io/resident/client.js', 'apps/cli/src/io/current.js', 'packages/git/src/io/main.js']);
  const found = [];
  for (const file of [...sources(join(root, 'packages'))]) {
    const name = relative(root, file);
    if (allowed.has(name)) continue;
    readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      if (raw.test(line) && !/^\s*(\/\/|\*)/u.test(line)) found.push(`${name}:${index + 1}`);
    });
  }
  assert.deepEqual(found, [], 'compare commonDir values with sameCommonDir() from the git front door');
});

test('gate.commondir.next-reuses-existing-seat-when: clause 2: next reuses the existing seat when its checkout names the repository with the other slash spelling, so no second seat opens and the tour passes step 3 [C7]', async t => {
  const dir = privateFixtureFiles('pb-wincommon2-').root;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  run('init', '-q', '-b', 'main');
  run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x');
  const real = repoInfo(dir);
  const item = { item_status: 'open', item_lane: 'core', item_route: 'light', item_id: 1, item_parent_id: null };
  const seat = { agent_id: 'a', agent_lane: 'core', agent_route: 'light', agent_path: real.root };
  const store = { ROUTES: ['light'], listItems: () => [], agentById: () => seat, agentAt: () => seat };
  let opened = 0;
  // The invoking context read C:/x/.git (git rev-parse); the seat's checkout reads C:\x\.git (realpathSync.native).
  const ctx = { info: { ...real, commonDir: 'C:/x/.git' }, io: {} };
  const ports = { store, sessionDigest: () => 'd', openWorktree: async () => { opened += 1; }, repoInfoOf: () => ({ commonDir: 'C:\\x\\.git' }) };
  const result = await laneSeatContext(ctx, {}, { id: 'a', route: 'light' }, item, [seat], () => ctx, ports);
  assert.equal(opened, 0, 'no second seat is opened (no app-2)');
  assert.equal(result.seat.created, false, 'the existing seat is reused, so the tour is not refused NOT_YOURS at step 3');
  assert.equal(result.seat.agent, 'a');
});
