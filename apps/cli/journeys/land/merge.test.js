/** @pullboard-test-input source-tree */
/** Real Git conflict inspection and landing share conservative mechanical resolutions [B3,R3,C7]. */
import { execPath as nodeExecutable } from 'node:process';
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  join,
} from 'node:path';
import {
  hostname,
  tmpdir,
} from 'node:os';
import {
  privateFixtureFiles,
  runFixtureChild,
  runFixtureGit,
} from '../../tests/fixtures/child.js';
import { cleanGitEnvironment } from '../../../../packages/git/index.js';
import { conflictFiles } from '../../../../packages/health/index.js';
import {
  recordedTrunkMerge,
  trunkMerge,
} from '../../../../packages/merge/index.js';
import { resolveMechanicalMerge } from '../../../../packages/merge/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { json } from '../../tests/fixtures/land/board.js';
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import {
  appliedSequence,
  prepareEngineMove,
} from '../../../../packages/state/index.js';
import {
  requireComputedConflict,
  requireComputedConflictObjects,
} from '../../../../packages/landing/index.js';
import { withRecordedConflictContext } from '../../../../packages/state/index.js';
import { reopen as reopenMove } from '../../../../packages/moves/index.js';
import { MECHANICAL_MERGE_ENGINE } from '../../../../packages/state/light.js';
import { AGENT_GRANT_ENGINE } from '../../../../packages/state/light.js';

console.log('# MECHANICAL_RUNTIME ' + JSON.stringify({ node: process.version, execPath: process.execPath,
  platform: process.platform, arch: process.arch, host: hostname(), binarySha256: createHash('sha256').update(readFileSync(nodeExecutable)).digest('hex') }));

const directories = [];
after(() => directories.forEach(root => rmSync(root, { recursive: true, force: true })));
const e2e = createE2eHelpers();
after(e2e.cleanup);

/** Build divergent real commits without inherited Git identity or repository selectors. */
function fixture(path, base, left, right, extra = {}) {
  const inputs = privateFixtureFiles('pullboard-mechanical-');
  const root = inputs.root;
  directories.push(root);
  const env = { ...cleanGitEnvironment(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Mechanical fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Mechanical fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  /** Execute only fixture-owned Git commands. */
  const git = (...args) => runFixtureGit(args, { cwd: root, env });
  /** Write a real source file and its parent directories. */
  function write(file, source) {
    inputs.write(file, source);
  }
  /** Commit the exact selected fixture version. */
  function commit(source, message) {
    write(path, source);
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  }
  git('init', '-q', '-b', 'main');
  for (const [file, source] of Object.entries(extra)) write(file, source);
  const ancestor = commit(base, 'chore: fixture base');
  git('checkout', '-q', '-b', 'candidate');
  const head = commit(right, 'feat: candidate');
  git('checkout', '-q', 'main');
  const trunk = commit(left, 'feat: trunk');
  return { root, env, git, write, read: inputs.read, path, ancestor, head, trunk };
}

/** Pin the actual checkout/index before all read-only conflict entry points. */
function inspect(box, expected) {
  const status = box.git('status', '--porcelain=v1', '-z');
  const index = readFileSync(join(box.root, '.git', 'index'));
  assert.deepEqual(conflictFiles(box.root, box.trunk, box.head), expected);
  assert.deepEqual(trunkMerge(box.root, box.head).files, expected.length ? expected : null);
  assert.deepEqual(recordedTrunkMerge(join(box.root, '.git'), box.head, box.trunk), expected.length ? expected : null);
  assert.equal(box.git('status', '--porcelain=v1', '-z'), status);
  assert.deepEqual(readFileSync(join(box.root, '.git', 'index')), index);
  assert.equal(box.git('rev-parse', 'HEAD'), box.trunk);
}

/** Resolve through the actual landing resolver and finish a real Git merge. */
function land(box, expected) {
  const merge = runFixtureChild('git', ['merge', '--no-ff', '--no-commit', box.head],
    { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.equal(merge.status, 1, `${merge.stdout}\n${merge.stderr}`);
  assert.ok(resolveMechanicalMerge(box.root, [box.path]));
  assert.equal(box.read(box.path).toString('utf8'), expected);
  box.git('add', '--', box.path);
  box.git('commit', '-q', '-m', 'chore: land mechanical merge');
  assert.equal(box.git('show', `HEAD:${box.path}`), expected.trimEnd());
  assert.equal(box.git('merge-base', '--is-ancestor', box.head, 'HEAD'), '');
}

test('JSON snapshots keep independent keys, removals, null and raised counters through inspection and landing [B3,R3,C7]', () => {
  const box = fixture('apps/cli/tests/fixtures/move/registry/baseline.json',
    '{"keep":1,"remove":true,"counter":2,"list":["base"],"nullable":null}\n',
    '{"keep":1,"counter":3,"list":["base","left"],"nullable":null,"left":true}\n',
    '{"keep":1,"remove":true,"counter":4,"list":["base","right"],"nullable":null,"right":true}\n');
  inspect(box, []);
  const expected = { keep: 1, counter: 4, list: ['base', 'left', 'right'], nullable: null, left: true, right: true };
  land(box, JSON.stringify(expected) + '\n');
});

test('add-only Markdown retains both contributors without reopening [B3,R3,C7]', () => {
  const box = fixture('docs/api.md', '# API\n\nEnd.\n', '# API\n\nLeft.\nEnd.\n', '# API\n\nRight.\nEnd.\n');
  inspect(box, []);
  land(box, '# API\n\nLeft.\nRight.\nEnd.\n');
});

test('a valid JavaScript union is checked without executing its top-level body [B3,R3,C7]', () => {
  const box = fixture('src/cli.js', 'export {};\n', "throw new Error('inspection must not execute this');\nexport {};\n",
    'export const added = true;\nexport {};\n');
  inspect(box, []);
  land(box, "throw new Error('inspection must not execute this');\nexport const added = true;\nexport {};\n");
});

test('generated lifecycle is classified without executing item code and regenerated only by landing [B3,R3,C7]', () => {
  const box = fixture('docs/lifecycle.md', 'old\n', 'left\n', 'right\n', {
    'package.json': '{"type":"module"}\n',
    'apps/cli/pullboard.js': "import {writeFileSync} from 'node:fs'; writeFileSync('executed', 'yes'); console.log('regenerated');\n",
  });
  inspect(box, []);
  assert.equal(box.git('status', '--porcelain'), '', 'inspection never runs the candidate generator');
  land(box, 'regenerated\n');
  assert.equal(readFileSync(join(box.root, 'executed'), 'utf8'), 'yes');
});

for (const [name, path, base, left, right] of [
  ['same-line edits', 'docs/api.md', 'Original.\n', 'Left edit.\n', 'Right edit.\n'],
  ['conflicting JSON scalars', 'snapshot.json', '{"value":"base"}\n', '{"value":"left"}\n', '{"value":"right"}\n'],
  ['a decreased counter', 'snapshot.json', '{"value":2}\n', '{"value":1}\n', '{"value":3}\n'],
  ['delete versus edit', 'snapshot.json', '{"value":null}\n', '{}\n', '{"value":1}\n'],
  ['JSON numbers that cannot round-trip', 'snapshot.json', '{"value":1}\n', '{"value":1e400}\n', '{"value":2e400}\n'],
  ['an invalid JavaScript union', 'src/cli.js', 'export {};\n', 'const value = 1;\nexport {};\n', 'const value = 2;\nexport {};\n'],
  ['keyed additions with invalid JavaScript context', 'src/api-moves.js',
    'export = ;\nconst MOVES = {\n  base: { item: true },\n};\n',
    'export = ;\nconst MOVES = {\n  left: { item: true },\n  base: { item: true },\n};\n',
    'export = ;\nconst MOVES = {\n  right: { item: true },\n  base: { item: true },\n};\n'],
]) {
  test(`${name} remains a real conflict [B3,R3,C7]`, () => {
    const box = fixture(path, base, left, right);
    inspect(box, [path]);
    assert.equal(runFixtureChild('git', ['merge', '--no-commit', box.head],
      { cwd: box.root, env: box.env, encoding: 'utf8' }).status, 1);
    const before = box.read(path);
    assert.equal(resolveMechanicalMerge(box.root, [path]), null);
    assert.deepEqual(box.read(path), before, 'a refused resolution leaves the merge for normal conflict handling');
  });
}

/** Configure an ordinary private board and actual publication remote for public landing controls. */
function boardFixture() {
  const box = e2e.project('true');
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  config.lanes.web.owns.push('docs/', 'test/');
  // The board's model table determines fixture seat routes since b95e1aa538.
  config.modelTiers = [{ contains: box.env.PULLBOARD_MODEL, route: 'strong' }];
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config, null, 2));
  mkdirSync(join(box.repo, 'docs'), { recursive: true });
  mkdirSync(join(box.repo, 'test'), { recursive: true });
  writeFileSync(join(box.repo, 'docs/api.md'), '# API\n\nEnd.\n');
  writeFileSync(join(box.repo, 'test/snapshot.json'), '{"base":true}\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure mechanical landing fixture');
  const remote = join(box.dir, 'origin.git');
  box.git(box.dir, 'init', '-q', '--bare', remote);
  box.git(box.repo, 'remote', 'add', 'origin', remote);
  box.git(box.repo, 'push', '-q', '-u', 'origin', 'main');
  return { ...box, remote };
}

/** Obtain a genuine independently verified submission with ordinary fixture authority and immutable Git bytes. */
function accepted(box, number, files, { verify = true } = {}) {
  const builder = join(box.dir, `builder-${number}`);
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', builder, 'main');
  json(box, builder, 'join', 'web');
  const id = json(box, box.repo, 'add', 'web', `Mechanical contribution ${number}`, '--specs', 'G1',
    '--criterion', 'retain the actual contributed file contents', '--check', 'true').item.item_id;
  json(box, builder, 'claim', String(id));
  for (const [path, source] of Object.entries(files)) writeFileSync(join(builder, path), source);
  box.git(builder, 'add', '-A');
  const commit = e2e.commitFile(box, builder, Object.keys(files)[0], Object.values(files)[0], `feat(web): contribution ${number} [G1]`);
  assert.equal(commit.status, 0, commit.stderr);
  const head = box.git(builder, 'rev-parse', 'HEAD');
  json(box, builder, 'submit', String(id));
  if (!verify) return id;
  box.git(box.repo, 'checkout', '-q', '--detach', head);
  try { json(box, box.repo, 'verify', String(id), 'accept', '--as', 'coordinator', '--note', 'checked the private fixture contribution'); }
  finally { box.git(box.repo, 'checkout', '-q', 'main'); }
  return id;
}

test('public land retains JSON and Markdown additions, while a same-line edit really reopens [B3,R3,C7]', () => {
  const box = boardFixture();
  const left = accepted(box, 1, { 'test/snapshot.json': '{"base":true,"left":true}\n', 'docs/api.md': '# API\n\nLeft.\nEnd.\n' });
  const right = accepted(box, 2, { 'test/snapshot.json': '{"base":true,"right":true}\n', 'docs/api.md': '# API\n\nRight.\nEnd.\n' });
  const landed = json(box, box.repo, 'land', '--max', '2');
  assert.deepEqual(landed.landed, [left, right]);
  assert.deepEqual(landed.conflicts, []);
  assert.deepEqual(JSON.parse(box.git(box.repo, 'show', 'main:test/snapshot.json')), { base: true, left: true, right: true });
  assert.match(box.git(box.repo, 'show', 'main:docs/api.md'), /Left\.\nRight\./u);
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), box.git(box.repo, 'rev-parse', 'main'));
  const competing = accepted(box, 3, { 'docs/api.md': '# Edited by first item\n\nLeft.\nRight.\nEnd.\n' });
  const conflict = accepted(box, 4, { 'docs/api.md': '# Edited by second item\n\nLeft.\nRight.\nEnd.\n' });
  const returned = json(box, box.repo, 'land', '--max', '2');
  assert.deepEqual(returned.landed, [competing], 'both accepts are fresh against the batch base; their actual composition exposes the conflict');
  assert.deepEqual(returned.conflicts.map(entry => entry.id), [conflict]);
  const item = json(box, box.repo, 'show', String(conflict));
  assert.equal(item.item_status, 'open', 'a real conflicting accepted submission returns to its builder');
});

test('version-one conflict replay keeps its original Git meaning while fresh mechanical returns require their engine [H16,V4]', t => {
  const box = boardFixture();
  const id = accepted(box, 1, { 'test/snapshot.json': '{"base":true,"left":true}\n' }, { verify: false });
  writeFileSync(join(box.repo, 'test/snapshot.json'), '{"base":true,"right":true}\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: independent snapshot addition');
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => store.closeBoard(board));
  const item = store.getItem(board, id);
  const fields = { version: 1, id: randomUUID(), board: board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='board_id'").get().meta_value,
    item: id, actor: 'coordinator', head: item.item_commit, trunk: box.git(box.repo, 'rev-parse', 'HEAD'),
    files: ['test/snapshot.json'], at: board.clock.now().toISOString(),
    submission: board.db.prepare("SELECT event_id FROM event WHERE item_id=? AND event_kind='submit' ORDER BY event_id DESC LIMIT 1").get(id).event_id };
  /** Self-hashes bind bytes; the real recorded Git objects independently establish their meaning. */
  const receipt = value => ({ ...value, digest: createHash('sha256').update(JSON.stringify(value)).digest('hex') });
  const historical = receipt(fields), mechanical = receipt({ ...fields, version: 2 });
  assert.deepEqual(requireComputedConflictObjects(board, historical), fields.files);
  assert.equal(requireComputedConflictObjects(board, mechanical), null, 'version participates in the immutable-object cache key');
  assert.throws(() => requireComputedConflict(board, mechanical), error => error.code === 'COORDINATOR_ONLY',
    'a version-two self-hash cannot turn a mechanically clean snapshot into a conflict');
  assert.throws(() => prepareEngineMove(board, 'reopen', [id, { agentId: 'coordinator', automaticConflict: true }]),
    error => error.code === 'NOT_CONFLICTING', 'fresh selection cannot return this additive conflict');
  assert.throws(() => store.reopen(board, id, { agentId: 'coordinator', computedConflict: historical }),
    error => error.code === 'COORDINATOR_ONLY', 'historical semantics are not a fresh-authoring escape');
  assert.equal(reopenMove.minimumEngine([id, { computedConflict: historical }]), AGENT_GRANT_ENGINE);
  assert.equal(reopenMove.minimumEngine([id, { computedConflict: mechanical }]), MECHANICAL_MERGE_ENGINE);
  const options = { agentId: 'coordinator', computedConflict: historical };
  const move = { operation: 'reopen', args: [id, options], engine: AGENT_GRANT_ENGINE };
  withRecordedConflictContext(board, move, { sequence: appliedSequence(board) + 1, at: fields.at }, () => store.reopen(board, id, options));
  assert.equal(store.getItem(board, id).item_status, 'open', 'a validated historical replay retains its recorded outcome');
  assert.deepEqual(JSON.parse(store.events(board, { itemId: id }).at(-1).event_detail).computedConflict, historical);
});

test('a failing lifecycle generator blocks landing without reopening accepted work [B3,R3,C7]', () => {
  const box = boardFixture();
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  config.lanes.web.owns.push('apps/');
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config, null, 2));
  // Landing runs docs/tools/update-docs.js only where the generated-docs boundary exists.
  mkdirSync(join(box.repo, 'apps/cli/src/io/generated'), { recursive: true });
  mkdirSync(join(box.repo, 'docs/tools'), { recursive: true });
  writeFileSync(join(box.repo, 'apps/cli/src/io/generated/docs.js'), '// generated-docs boundary\n');
  writeFileSync(join(box.repo, 'docs/tools/update-docs.js'), 'process.exit(7);\n');
  writeFileSync(join(box.repo, 'docs/lifecycle.md'), 'base\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure failing private generator');
  const left = accepted(box, 1, { 'docs/lifecycle.md': 'left\n' });
  const right = accepted(box, 2, { 'docs/lifecycle.md': 'right\n' });
  const before = box.git(box.repo, 'rev-parse', 'main');
  const result = box.run(box.repo, 'land', '--max', '2', '--json');
  assert.equal(result.code, 1, `${result.out}\n${result.err}`);
  const error = JSON.parse(result.out).error;
  assert.equal(error.code, 'LAND_MERGE');
  // The generator refusal names the generator command; it is the one landing step that runs it (packages/landing/src/io/docs.js).
  assert.match(error.message, /node docs\/tools\/update-docs\.js failed in the merged tree/u);
  for (const id of [left, right]) assert.equal(json(box, box.repo, 'show', String(id)).item_status, 'verified');
  assert.equal(box.git(box.repo, 'rev-parse', 'main'), before, 'generator failure publishes nothing');
});
