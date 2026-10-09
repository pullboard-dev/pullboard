/** Project metadata and registry lifecycle (N33, N35, N36). */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { serveView } from '../src/serve.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');

/** An isolated registry and real Git repos; every CLI child inherits the private home. */
function fleet(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-cross-repo-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const bin = join(dir, '.bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, PULLBOARD_HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.com', GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.com' };
  const prior = process.env.PULLBOARD_HOME;
  process.env.PULLBOARD_HOME = home;
  t.after(() => { if (prior === undefined) delete process.env.PULLBOARD_HOME; else process.env.PULLBOARD_HOME = prior; });
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim();
  const run = (cwd, ...args) => spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
  const ok = (cwd, ...args) => { const out = run(cwd, ...args); assert.equal(out.status, 0, `${out.stdout}${out.stderr}`); return out.stdout; };
  const repo = (folder, name, project = 'Demo group') => {
    const root = join(dir, folder);
    mkdirSync(root);
    git(root, 'init', '-q', '-b', 'main');
    writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ name, project, gate: 'true', lanes: { app: { owns: ['src/'] }, review: { owns: [] } } }));
    ok(root, 'init');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'chore: private setup');
    return root;
  };
  return { dir, home, env, git, run, ok, repo };
}

test('the API prunes a project whose folder is gone and keeps one unreadable-board warning [N33, N35, N36]', async (t) => {
  const f = fleet(t);
  const local = f.repo('local', 'Local label');
  const gone = f.repo('gone', 'Gone label');
  const unreadable = f.repo('unreadable', 'Unreadable label');
  const view = await serveView({ port: 0 });
  try {
    const link = new URL(view.url);
    /** Read the public listing without pruning unavailable registered roots. */
    const boards = async () => {
      const response = await fetch(`${link.origin}/api/v1/boards`, { headers: { 'x-pullboard-key': link.searchParams.get('k') } });
      assert.equal(response.status, 200);
      const document = await response.json();
      assert.equal(document.version, 1);
      assert.ok(Array.isArray(document.boards));
      assert.ok(Array.isArray(document.warnings));
      return document;
    };
    let data = await boards();
    assert.deepEqual(data.boards.map(({ name, project }) => ({ name, project })), [
      { name: 'Local label', project: 'Demo group' },
      { name: 'Gone label', project: 'Demo group' },
      { name: 'Unreadable label', project: 'Demo group' },
    ]);
    assert.deepEqual(data.warnings, []);
    const registered = new Map(data.boards.map(({ root, id, added }) => [root, { id, added }]));
    const config = JSON.parse(readFileSync(join(local, 'pullboard.json'), 'utf8'));
    writeFileSync(join(local, 'pullboard.json'), JSON.stringify({ ...config, name: 'New label', project: 'New group' }));
    rmSync(gone, { recursive: true, force: true });
    rmSync(join(unreadable, '.git'), { recursive: true, force: true });
    data = await boards();
    assert.deepEqual(data.boards.map(({ name, project }) => ({ name, project })), [{ name: 'New label', project: 'New group' }]);
    assert.deepEqual(data.boards.map(({ root, id, added }) => ({ root, id, added })), [{ root: local, ...registered.get(local) }]);
    assert.deepEqual(data.warnings.map(({ root, name, project, added }) => ({ root, name, project, added })), [{ root: unreadable, name: 'Unreadable label', project: 'Demo group', added: registered.get(unreadable).added }]);
    assert.equal(data.warnings.length, 1, 'only the existing folder with an unreadable board remains as a warning');
    assert.equal(data.warnings[0].error.version, 1);
    assert.equal(data.warnings[0].error.error.code, 'BOARD_UNAVAILABLE');
    assert.match(data.warnings[0].error.error.next, /pullboard forget/);
    const registry = join(f.home, 'projects.json');
    const afterPruning = readFileSync(registry, 'utf8');
    const registeredAfterPruning = JSON.parse(afterPruning).projects.map(({ root }) => root);
    assert.deepEqual(registeredAfterPruning, [local, unreadable], 'the missing root is removed while the unreadable directory stays registered');
    const repeated = await boards();
    assert.deepEqual(repeated, data, 'the second API listing returns the same board and warning');
    assert.equal(readFileSync(registry, 'utf8'), afterPruning, 'the second listing makes no further registry change');
    f.ok(local, 'forget', '.');
    data = await boards();
    assert.deepEqual(data.boards, []);
    assert.deepEqual(data.warnings.map(({ root }) => root), [unreadable], 'forget removes only the selected registered repo');
    f.ok(local, 'forget', unreadable);
    data = await boards();
    assert.deepEqual(data.boards, []);
    assert.deepEqual(data.warnings, []);
  } finally { await view.close(); }
});

test('config refusals name bad project/display values and an unknown forget path [N33, N35, N36]', (t) => {
  const f = fleet(t);
  const root = f.repo('local', 'Local label');
  const file = join(root, 'pullboard.json');
  const valid = JSON.parse(readFileSync(file, 'utf8'));
  for (const [field, value] of [['project', false], ['project', ''], ['project', ' padded '], ['name', 42], ['name', 'bad#label'], ['name', 'bad,label'], ['name', 'bad\nlabel']]) {
    writeFileSync(file, JSON.stringify({ ...valid, [field]: value }));
    const result = f.run(root, 'spec', 'check');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /BAD_CONFIG/);
    assert.ok(result.stderr.includes(`"${field}"`), result.stderr);
  }
  writeFileSync(file, JSON.stringify(valid));
  assert.match(f.run(root, 'forget', join(f.dir, 'unknown')).stderr, /NO_REPO/);
  assert.equal(f.run(root, 'forget').status, 1);
});
