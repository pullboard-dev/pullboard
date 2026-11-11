/** The generated tier table accepts a seat's own-lane rows and refuses any other lane's [L3,C7]. */
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { outOfLane } from '../../../../packages/seats/index.js';
import {
  TIER_TABLE,
  tierRowChange,
} from '../../../../packages/commits/light.js';

const config = { shared: [], lanes: { core: { owns: ['test/'] }, view: { owns: ['test/cockpit/'] } } };
const row = file => ({ file, tier: 'T3', packages: ['.'] });
const blob = rows => ({ mode: '100644', bytes: Buffer.from(JSON.stringify({ version: 1, files: rows })) });

/** Judge one change to the table as the given lane's seat. */
function judge(lane, before, after) {
  return tierRowChange(TIER_TABLE, { before: () => blob(before), after: () => blob(after),
    ownsFile: file => !outOfLane(config, lane, [file]).length });
}

test('clause 1: a seat commits a tier table change whose rows all name its own lane, and a foreign row is refused [L3,C7]', () => {
  const base = [row('test/a.test.js'), row('test/cockpit/b.test.js')];
  assert.equal(judge('view', base, [...base, row('test/cockpit/c.test.js')]).allowed, true);
  assert.equal(judge('view', base, [...base, row('test/cockpit/c.test.js'), row('test/d.test.js')]).allowed, false);
  assert.equal(judge('view', base, [row('test/a.test.js'), row('test/cockpit/b.test.js')].map(r => ({ ...r, tier: 'T1' }))).allowed, false);
  assert.equal(tierRowChange('packages/other.json', { before: () => null, after: () => null, ownsFile: () => true }).allowed, false);
});

test('clause 2: a view seat adds test/cockpit/new.test.js with its row but may not edit a core test row [L3,C7]', () => {
  const base = [row('test/a.test.js')];
  assert.equal(judge('view', base, [...base, row('test/cockpit/new.test.js')]).allowed, true);
  const edited = [{ ...row('test/a.test.js'), tier: 'T1' }];
  const refused = judge('view', base, edited);
  assert.equal(refused.allowed, false);
  assert.match(refused.problem, /test\/a\.test\.js/);
  assert.equal(judge('core', base, edited).allowed, true);
});

const BIN = join(import.meta.dirname, '../../pullboard.js');

/** A private board whose view seat owns test/cockpit/ and whose tier table lists one core test. */
function hookFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-tier-row-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const shims = join(dir, 'bin'), root = join(dir, 'main'), lane = join(dir, 'lane');
  mkdirSync(shims); mkdirSync(root);
  writeFileSync(join(shims, 'pullboard'), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`);
  chmodSync(join(shims, 'pullboard'), 0o755);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  Object.assign(env, { PATH: `${shims}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Tier Fixture', GIT_AUTHOR_EMAIL: 'tier@example.invalid',
    GIT_COMMITTER_NAME: 'Tier Fixture', GIT_COMMITTER_EMAIL: 'tier@example.invalid',
    HOME: join(dir, 'home'), PULLBOARD_HOME: join(dir, 'board-home'), PULLBOARD_MACHINE_HOME: join(dir, 'machine-home') });
  const git = (cwd, ...args) => runFixtureChild('git', args, { cwd, env, encoding: 'utf8' });
  const cli = (cwd, ...args) => runFixtureChild(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
  assert.equal(git(root, 'init', '-q', '-b', 'main').status, 0);
  assert.equal(cli(root, 'init').status, 0);
  const config = { spec: 'SPEC.md', practice: 'PRACTICE.md', gate: '', lease: '2h', verify: { policy: 'any' },
    lanes: { core: { owns: ['test/', 'packages/'], specs: ['L3'] }, view: { owns: ['test/cockpit/'], specs: ['L3'] } }, shared: [] };
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify(config, null, 2));
  writeFileSync(join(root, 'SPEC.md'), '# Fixture\n\n## L · Limits\n- L3 [approved, must] Lanes own their paths. | gate: any\n');
  mkdirSync(join(root, 'test/cockpit'), { recursive: true }); mkdirSync(join(root, 'packages', 'gate', 'data', 'tests'), { recursive: true });
  writeFileSync(join(root, 'test/a.test.js'), '// a\n');
  writeFileSync(join(root, 'packages', 'gate', 'data', 'tests', 'tiers.json'), JSON.stringify({ version: 1, files: [row('test/a.test.js')] }, null, 2) + '\n');
  assert.equal(git(root, 'add', '-A').status, 0);
  assert.equal(git(root, 'commit', '-q', '-m', 'chore: seed private fixture [L3]').status, 0);
  assert.equal(git(root, 'worktree', 'add', '-q', '-b', 'view/fixture', lane).status, 0);
  const joined = cli(lane, 'join', 'view', '--model', 'gpt-6-luna');
  assert.equal(joined.status, 0, joined.stderr + joined.stdout);
  return { lane, git };
}

test('clause 1: the installed pre-commit hook lets a seat commit its own-lane tier row and refuses a foreign row [L3,C7]', t => {
  const box = hookFixture(t);
  const table = join(box.lane, 'packages', 'gate', 'data', 'tests', 'tiers.json');
  mkdirSync(join(box.lane, 'test/cockpit'), { recursive: true });
  writeFileSync(table, JSON.stringify({ version: 1, files: [row('test/a.test.js'), row('test/cockpit/n.test.js')] }, null, 2) + '\n');
  writeFileSync(join(box.lane, 'test/cockpit/n.test.js'), '// n\n');
  assert.equal(box.git(box.lane, 'add', '-A').status, 0);
  const allowed = box.git(box.lane, 'commit', '-m', 'test: add n [L3]');
  assert.equal(allowed.status, 0, allowed.stderr + allowed.stdout);
  writeFileSync(table, JSON.stringify({ version: 1, files: [row('test/a.test.js'), row('test/cockpit/n.test.js'), row('test/d.test.js')] }, null, 2) + '\n');
  assert.equal(box.git(box.lane, 'add', '-A').status, 0);
  const refused = box.git(box.lane, 'commit', '-m', 'test: add d row [L3]');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout + refused.stderr, /outside the view lane.*test\/d\.test\.js/su);
});

test('clause 2: the hook commits a view seat test/cockpit/new.test.js with its row and refuses an edit of a core test row [L3,C7]', t => {
  const box = hookFixture(t);
  const table = join(box.lane, 'packages', 'gate', 'data', 'tests', 'tiers.json');
  mkdirSync(join(box.lane, 'test/cockpit'), { recursive: true });
  writeFileSync(join(box.lane, 'test/cockpit/new.test.js'), '// new\n');
  writeFileSync(table, JSON.stringify({ version: 1, files: [row('test/a.test.js'), row('test/cockpit/new.test.js')] }, null, 2) + '\n');
  assert.equal(box.git(box.lane, 'add', '-A').status, 0);
  const allowed = box.git(box.lane, 'commit', '-m', 'test: add new cockpit test [L3]');
  assert.equal(allowed.status, 0, allowed.stderr + allowed.stdout);
  writeFileSync(table, JSON.stringify({ version: 1, files: [{ ...row('test/a.test.js'), tier: 'T1' }, row('test/cockpit/new.test.js')] }, null, 2) + '\n');
  assert.equal(box.git(box.lane, 'add', '-A').status, 0);
  const refused = box.git(box.lane, 'commit', '-m', 'test: edit core row [L3]');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout + refused.stderr, /test\/a\.test\.js/u);
});
