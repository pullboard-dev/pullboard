/** A lane seat sets --check over test files its own lane owns; another lane's files are refused naming the owner [C7,#2908]. */
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import {
  runFixtureChild,
  runFixtureGit,
} from '../../tests/fixtures/child.js';
import { fixture as nativeFixture } from '../../tests/fixtures/next/take.js';
import {
  applyRelayMove,
  appliedSequence,
  prepareEngineMove,
} from '../../../../packages/state/index.js';
import * as store from '../../../../packages/store/index.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

const BIN = resolve(import.meta.dirname, '../../pullboard.js');
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
    lanes: { web: { owns: ['web/', 'packages/gate/src/io/run/tests.js'], specs: ['G1'] }, api: { owns: ['api/'], specs: ['G1'] } } }, null, 2));
  writeFileSync(join(repo, 'SPEC.md'), SPEC);
  mkdirSync(join(repo, 'web'));
  writeFileSync(join(repo, 'web', 'shared.txt'), 'base\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'chore: create fixture');
  const created = run(repo, 'worktree', 'web', '--route', 'strong', '--model', 'fixture-model', '--json');
  assert.equal(created.code, 0, created.err + created.out);
  return { repo, web: JSON.parse(created.out).path, run };
}

/** File an item from a directory and return the exit code and parsed error. */
function add(box, cwd, lane, check) {
  const result = fixtureAdd(box.run, cwd, lane, 'Lane check item', '--route', 'strong', '--specs', 'G1', '--criterion', 'It works', '--check', check, '--json');
  return { code: result.code, doc: result.code === 0 ? JSON.parse(result.out) : JSON.parse(result.out).error };
}

test('clause 1: a web seat files an item whose check names test files its lane owns [C7,#2908]', () => {
  const box = fixture();
  const filed = add(box, box.web, 'web', 'node --test web/a.test.js');
  assert.equal(filed.code, 0, JSON.stringify(filed.doc));
  const shown = JSON.parse(box.run(box.repo, 'show', String(filed.doc.item.item_id), '--json').out);
  assert.equal(shown.item_check, 'node --test web/a.test.js');
  const second = add(box, box.web, 'web', 'node packages/gate/src/io/run/tests.js web/b.test.js && node packages/gate/src/io/run/tests.js web/c.test.js');
  assert.equal(second.code, 0, JSON.stringify(second.doc));
});

test('clause 2: a check naming another lane\'s file is refused, naming the owner [C7,#2908]', () => {
  const box = fixture();
  const refused = add(box, box.web, 'web', 'node --test web/a.test.js api/b.test.js');
  assert.notEqual(refused.code, 0);
  assert.equal(refused.doc.code, 'LANE_CHECK_FOREIGN');
  assert.match(refused.doc.message, /api\/b\.test\.js belongs to lane api/u);
  const arbitrary = add(box, box.web, 'web', 'rm -rf web/');
  assert.equal(arbitrary.doc.code, 'COORDINATOR_CHECK', 'a check that is not a test-file command stays the coordinator\'s');
});

test('clause 2: the authenticated ordered add refuses a foreign lane check at the canonical write [C7,#2908]', async t => {
  const box = await nativeFixture(t, { files: {
    'web/own.test.js': "import { test } from 'node:test'; test('own [G1]', () => {});\n",
    'docs/foreign.test.js': "import { test } from 'node:test'; test('foreign [G1]', () => {});\n",
  } });
  const request = { by: box.seats.actor.id, lane: 'web', title: 'Foreign check boundary', criterion: 'The authoritative write refuses foreign ownership [test].',
    specIds: ['G1'], route: 'strong', brief: 'Files: web/feature.js\nTest: the authoritative write refuses foreign check ownership.',
    check: 'node --test docs/foreign.test.js' };
  const move = prepareEngineMove(box.board, 'addItem', [request], { actor: box.seats.actor.id });
  const result = applyRelayMove(box.board, move, { sequence: appliedSequence(box.board) + 1,
    at: box.clock.now().toISOString(), kind: 'move', sender: { kind: 'agent', agent: box.seats.actor.id, userId: 'fixture-user' } });
  assert.equal(result.error?.code, 'LANE_CHECK_FOREIGN');
  assert.match(result.error?.message ?? '', /docs\/foreign\.test\.js belongs to lane docs/u);
});

test('clause 2: the authenticated ordered edit refuses a foreign lane check at the canonical write [C7,#2908]', async t => {
  const box = await nativeFixture(t, { files: {
    'web/own.test.js': "import { test } from 'node:test'; test('own [G1]', () => {});\n",
    'docs/foreign.test.js': "import { test } from 'node:test'; test('foreign [G1]', () => {});\n",
  } });
  const id = store.addItem(box.board, { by: box.seats.actor.id, lane: 'web', title: 'Owned check', criterion: 'The check runs its own lane test [test].',
    specIds: ['G1'], route: 'strong', brief: 'Files: web/feature.js\nTest: the check runs its own lane test.', check: 'node --test web/own.test.js' });
  const move = prepareEngineMove(box.board, 'editItem', [id, { agentId: box.seats.actor.id, check: 'node --test docs/foreign.test.js' }],
    { actor: box.seats.actor.id });
  const result = applyRelayMove(box.board, move, { sequence: appliedSequence(box.board) + 1,
    at: box.clock.now().toISOString(), kind: 'move', sender: { kind: 'agent', agent: box.seats.actor.id, userId: 'fixture-user' } });
  assert.equal(result.error?.code, 'LANE_CHECK_FOREIGN');
  assert.match(result.error?.message ?? '', /docs\/foreign\.test\.js belongs to lane docs/u);
});
