/** @pullboard-test-input source-tree */
/** GitHub #16: Windows paths that differ only by \ versus / resolve to one commonDir [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { laneSeatContext } from '../packages/seats/index.js';
import { canonicalCommonDir, repoInfo, sameCommonDir } from '../packages/git/index.js';

const root = resolve(import.meta.dirname, '..');

test('clause 1: C:\\x\\.git and C:/x/.git canonicalise to one commonDir and compare equal', () => {
  assert.equal(canonicalCommonDir('C:\\x\\.git'), 'C:/x/.git');
  assert.equal(canonicalCommonDir('C:/x/.git'), 'C:/x/.git');
  assert.equal(canonicalCommonDir('c:\\x\\.git\\'), 'C:/x/.git');
  assert.equal(canonicalCommonDir('\\\\host\\share\\r\\.git'), '//host/share/r/.git');
  assert.ok(sameCommonDir('C:\\x\\.git', 'C:/x/.git'));
  assert.ok(!sameCommonDir('C:\\x\\.git', 'C:/y/.git'));
  assert.ok(!sameCommonDir(undefined, undefined));
  assert.equal(canonicalCommonDir('/tmp/a\\b/.git'), '/tmp/a\\b/.git', 'POSIX paths keep a literal backslash');
});

test('clause 1: repoInfo returns the canonical commonDir', () => {
  const info = repoInfo(root);
  assert.equal(info.commonDir, canonicalCommonDir(info.commonDir));
});

test('clause 2: laneSeatContext reuses the invoking seat when both commonDir spellings name one repo', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pb-wincommon-')));
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

test('clause 3: no raw commonDir === or !== comparison outside the canonical helper', () => {
  const raw = /\w*commonDir\)?\s*[!=]==(?!\s*['"`]|\s*null\b)|[!=]==\s*[\w.?()]*commonDir/iu;
  // resident-client and current-cli compare two paths from one Git answer and must stay import-light.
  const allowed = new Set(['bin/resident-client.js', 'bin/current-cli.js', 'packages/git/src/shell/git.js']);
  const found = [];
  for (const file of [...sources(join(root, 'bin')), ...sources(join(root, 'packages')), ...sources(join(root, 'src'))]) {
    const name = relative(root, file);
    if (allowed.has(name)) continue;
    readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      if (raw.test(line) && !/^\s*(\/\/|\*)/u.test(line)) found.push(`${name}:${index + 1}`);
    });
  }
  assert.deepEqual(found, [], 'compare commonDir values with sameCommonDir() from the git front door');
});
