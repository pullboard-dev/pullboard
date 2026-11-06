/** An item whose bar names a coordinator-owned path refuses at add and claim with the split [C7,#3277]. */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { runFixtureChild, runFixtureGit } from './fixture-child.js';
import { fixture as nativeFixture } from './next-take-fixture.js';
import { applyRelayMove, appliedSequence, prepareEngineMove } from '../packages/state/index.js';
import * as store from '../packages/store/index.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const sandboxes = [];
const SPEC = '# Lane check fixture\n\n## G · Goals\n- G1 [approved, must] The feature works. | gate: test\n';

after(() => { for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true }); });

/** A real repo with lanes web (web/) and api (api/), and a joined web seat in its own worktree. */
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-lane-check-')));
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


const BRIEF = 'Change the hook.\nFiles:\n  - web/a.js\n  - .githooks/pre-commit\n';

/** File a web item with the given brief and return the exit code and parsed error. */
function add(box, brief) {
  const result = box.run(box.web, 'add', 'web', 'Coordinator path item', '--route', 'strong', '--specs', 'G1', '--criterion', 'It works', '--brief', brief, '--json');
  return { code: result.code, out: result.out, err: result.err };
}

test('clause 1: add refuses a bar naming a coordinator-owned path with BRIEF_LANE [C7,#3277]', () => {
  const box = fixture();
  const refused = add(box, BRIEF);
  assert.equal(refused.code, 1);
  const error = JSON.parse(refused.out).error;
  assert.equal(error.code, 'BRIEF_LANE');
  assert.match(error.message, /coordinator owns.*\.githooks\/pre-commit/u);
  assert.equal(add(box, 'Change it.\nFiles:\n  - web/a.js\n').code, 0);
});

test('clause 2: the refusal next step files the coordinator piece with --after the lane item [C7,#3277]', () => {
  const box = fixture();
  const error = JSON.parse(add(box, BRIEF).out).error;
  assert.match(error.next, /pullboard add coordinator .*--after /u);
});
