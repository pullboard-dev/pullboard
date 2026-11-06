/** An item whose bar names a coordinator-owned path is refused with CROSS_OWNERSHIP and the split as next step [C7,#2650]. */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { runFixtureChild, runFixtureGit } from './fixture-child.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const sandboxes = [];
const SPEC = '# Lane check fixture\n\n## G · Goals\n- G1 [approved, must] The feature works. | gate: test\n';

after(() => { for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true }); });

/** A real repo with lanes web (web/) and api (api/), and a joined web seat in its own worktree. */
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-cross-owner-')));
  sandboxes.push(dir);
  const shims = join(dir, 'bin');
  mkdirSync(shims);
  writeFileSync(join(shims, 'pullboard'), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`, { mode: 0o755 });
  chmodSync(join(shims, 'pullboard'), 0o755);
  const env = { ...process.env, PATH: `${shims}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.com', GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.com',
    PULLBOARD_HOME: join(dir, 'home'), PULLBOARD_MACHINE_HOME: join(dir, 'machine-home') };
  for (const name of Object.keys(env)) if (name.startsWith('GIT_') && !/^GIT_(?:CONFIG|AUTHOR|COMMITTER)/u.test(name)) delete env[name];
  delete env.PULLBOARD_RELAY_TOKEN;
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env });
  const run = (cwd, ...args) => {
    const result = runFixtureChild(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
    return { code: result.status, out: result.stdout ?? '', err: result.failure ?? result.stderr ?? '' };
  };
  git(repo, 'init', '-q', '-b', 'main');
  assert.equal(run(repo, 'init').code, 0);
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'true', spec: 'SPEC.md', verify: 'any', lease: '2h',
    lanes: { web: { owns: ['web/'], specs: ['G1'] }, api: { owns: ['api/'], specs: ['G1'] } } }, null, 2));
  writeFileSync(join(repo, 'SPEC.md'), SPEC);
  mkdirSync(join(repo, 'web'));
  writeFileSync(join(repo, 'web', 'shared.txt'), 'base\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'chore: create fixture');
  const created = run(repo, 'worktree', 'web', '--route', 'strong', '--model', 'fixture-model', '--json');
  assert.equal(created.code, 0, created.err + created.out);
  return { repo, web: JSON.parse(created.out).path, run };
}


/** File an item from a directory with the given criterion and brief and return the exit code and parsed result. */
function add(box, cwd, lane, criterion, brief) {
  const result = box.run(cwd, 'add', lane, 'Cross item', '--route', 'strong', '--specs', 'G1', '--criterion', criterion, '--brief', brief, '--json');
  return { code: result.code, doc: result.code === 0 ? JSON.parse(result.out) : JSON.parse(result.out).error };
}

test('clause 1: a bar naming a coordinator-owned path is refused with the split as next step [C7,#2650]', () => {
  const box = fixture();
  const refused = add(box, box.web, 'web', 'The hook .githooks/pre-commit refuses it [test].', 'Files:\n- web/a.js\nTest:\n- web/a.test.js');
  assert.notEqual(refused.code, 0);
  assert.equal(refused.doc.code, 'CROSS_OWNERSHIP');
  assert.match(refused.doc.message, /\.githooks\/pre-commit/u);
  assert.match(refused.doc.next ?? refused.doc.nextStep ?? JSON.stringify(refused.doc), /add coordinator .* --after <lane item id>/u);
  const inBrief = add(box, box.web, 'web', 'It works [test].', 'Files:\n- web/a.js\n- pullboard.json\nTest:\n- web/a.test.js');
  assert.equal(inBrief.doc.code, 'CROSS_OWNERSHIP');
  const clean = add(box, box.web, 'web', 'It works [test].', 'Files:\n- web/a.js\nTest:\n- web/a.test.js');
  assert.equal(clean.code, 0, JSON.stringify(clean.doc));
});
