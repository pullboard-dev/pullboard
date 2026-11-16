/** A submission proof survives a main move that touches none of its files, and names every file when one does [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { selectAffectedTests } from '../../../index.js';
import { explicitCheckFiles } from '../../../index.js';
import { composeAfterProof } from '../../../../items/index.js';
import { trunkMoveFact } from '../../../../items/index.js';
import { judgeTrunkMove } from '../../../../verify/index.js';
import { runFixtureGit } from '../../fixtures/child.js';

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
for (const key of Object.keys(ENV)) if (key.startsWith('GIT_') && !/^(?:GIT_CONFIG_|GIT_AUTHOR_|GIT_COMMITTER_)/u.test(key)) delete ENV[key];
const SERVICES = { selectAffectedTests, explicitCheckFiles, judgeTrunkMove };
// Submit's own merge commits with the seat's Git identity; this private process supplies a fixture one.
Object.assign(process.env, { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' });

/**
 * A real repository: main with checked, imported and unrelated files; the item's worktree branch changes web/feature.js
 * and its frozen check runs test/feature.test.js, which imports web/feature.js and web/shared.js.
 */
function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-main-moved-unrelated-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = join(root, 'main'), work = join(root, 'work');
  mkdirSync(main);
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env: ENV });
  const write = (dir, path, text) => { mkdirSync(join(dir, path, '..'), { recursive: true }); writeFileSync(join(dir, path), text); };
  write(main, 'package.json', JSON.stringify({ private: true, type: 'module' }));
  write(main, 'apps/cli/src/io/run/tests.js', '// The fixture names the test runner path an explicit check runs.\n');
  write(main, 'web/feature.js', "import { shared } from './shared.js';\nexport const feature = shared + 'base';\n");
  write(main, 'web/shared.js', "export const shared = 'shared-';\n");
  write(main, 'web/other.js', "export const other = 'base';\n");
  write(main, 'test/feature.test.js', "import { test } from 'node:test';\nimport { feature } from '../web/feature.js';\ntest('feature', () => feature);\n");
  write(main, 'test/other.test.js', "import { test } from 'node:test';\nimport { other } from '../web/other.js';\ntest('other', () => other);\n");
  write(main, 'docs/notes.md', 'notes\n');
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'chore: fixture base');
  const claimHead = git(main, 'rev-parse', 'HEAD');
  git(main, 'worktree', 'add', '-q', '-b', 'web/1', work, claimHead);
  write(work, 'web/feature.js', "import { shared } from './shared.js';\nexport const feature = shared + 'item';\n");
  git(work, 'commit', '-q', '-am', 'feat(web): the item change');
  const proofCommit = git(work, 'rev-parse', 'HEAD');
  /** Land a commit on main, as the merge train does while a proof runs. */
  const land = (files, message = 'feat: a landing during the proof') => {
    for (const [path, text] of Object.entries(files)) write(main, path, text);
    git(main, 'add', '-A');
    git(main, 'commit', '-q', '-m', message);
    return git(main, 'rev-parse', 'HEAD');
  };
  const proof = (extra = {}) => ({ id: 1816, proofCommit, proved: claimHead, item: { item_claim_head: claimHead },
    check: `${process.execPath} apps/cli/src/io/run/tests.js test/feature.test.js`, readTrunk: () => ({ commit: git(main, 'rev-parse', 'main') }), ...extra });
  return { main, work, git, land, proof, claimHead, proofCommit };
}

test('a main move touching only unrelated files keeps the proof: submit merges the new main and records the evidence [C7]', async t => {
  const p = project(t);
  const landed = p.land({ 'docs/notes.md': 'moved main notes\n', 'docs/extra.md': 'a new unrelated page\n' });
  const composed = await composeAfterProof(p.work, p.proof(), SERVICES);
  assert.notEqual(composed.commit, p.proofCommit, 'the submitted commit is the merge, not a rerun');
  assert.equal(p.git(p.work, 'rev-parse', 'HEAD'), composed.commit);
  assert.equal(p.git(p.work, 'rev-parse', `${composed.commit}^1`), p.proofCommit, 'the merge keeps the proved commit as its first parent');
  assert.equal(p.git(p.work, 'rev-parse', `${composed.commit}^2`), landed, 'and the new main as its second');
  assert.deepEqual(p.git(p.work, 'diff', '--name-only', p.proofCommit, composed.commit).split('\n').sort(), ['docs/extra.md', 'docs/notes.md'], 'the merge adds only the unrelated main files');
  assert.deepEqual(composed.evidence, { proofCommit: p.proofCommit, merge: composed.commit, from: p.claimHead, to: landed, moved: [landed] });
  const fact = trunkMoveFact(composed.evidence);
  for (const sha of [p.claimHead, landed, p.proofCommit, composed.commit]) assert.ok(fact.includes(sha.slice(0, 12)), `the one recorded fact names ${sha.slice(0, 12)}`);
  assert.match(fact, /stands without a rerun/u);
});

test('a main move touching a checked file refuses and names it [C7]', async t => {
  const p = project(t);
  p.land({ 'test/feature.test.js': "import { test } from 'node:test';\nimport { feature } from '../web/feature.js';\ntest('feature changed on main', () => feature);\n" });
  const head = p.git(p.work, 'rev-parse', 'HEAD');
  await assert.rejects(composeAfterProof(p.work, p.proof(), SERVICES),
    error => error.code === 'MAIN_NOT_COMPOSED' && /test\/feature\.test\.js/u.test(error.message), 'the frozen check file is named');
  assert.equal(p.git(p.work, 'rev-parse', 'HEAD'), head, 'a refused move merges nothing');
});

test('every overlapping file is named: an item file, a file a checked test imports, beside an unrelated one [C7]', async t => {
  const p = project(t);
  p.land({ 'web/feature.js': "import { shared } from './shared.js';\nexport const feature = shared + 'main';\n", 'web/shared.js': "export const shared = 'changed-';\n", 'web/other.js': "export const other = 'moved';\n" });
  await assert.rejects(composeAfterProof(p.work, p.proof(), SERVICES), error => {
    assert.equal(error.code, 'MAIN_NOT_COMPOSED');
    assert.match(error.message, /web\/feature\.js, a file this item changed/u);
    assert.match(error.message, /web\/shared\.js, which test\/feature\.test\.js reads/u);
    assert.doesNotMatch(error.message, /web\/other\.js/u, 'a file only an unrelated test reads is not an overlap');
    return true;
  });
});

test('a checked dependency changed and reverted by main still refuses the proof [C7]', async t => {
  const p = project(t);
  p.land({ 'web/shared.js': "export const shared = 'changed-';\n" }, 'feat: change a checked dependency');
  p.land({ 'web/shared.js': "export const shared = 'shared-';\n" }, 'fix: restore the checked dependency');
  const head = p.git(p.work, 'rev-parse', 'HEAD');
  await assert.rejects(composeAfterProof(p.work, p.proof(), SERVICES),
    error => error.code === 'MAIN_NOT_COMPOSED' && /web\/shared\.js/u.test(error.message),
    'each main commit counts even when their endpoint diff cancels out');
  assert.equal(p.git(p.work, 'rev-parse', 'HEAD'), head, 'the refused range is not merged');
});

test('an unrelated source file read only by an unselected test keeps the proof [C7]', async t => {
  const p = project(t);
  p.land({ 'web/other.js': "export const other = 'moved';\n" });
  const composed = await composeAfterProof(p.work, p.proof(), SERVICES);
  assert.ok(composed.evidence, 'test/other.test.js is not this item\'s check or affected test, so web/other.js is unrelated');
});

test('a check that is not an explicit test selection cannot be bounded and refuses [C7]', async t => {
  const p = project(t);
  p.land({ 'docs/notes.md': 'moved\n' });
  await assert.rejects(composeAfterProof(p.work, p.proof({ check: 'npm test' }), SERVICES),
    error => error.code === 'MAIN_NOT_COMPOSED' && /cannot be bounded/u.test(error.message));
});

test('main moving again during the merge is judged again, and an overlapping second move refuses [C7]', async t => {
  const p = project(t);
  const first = p.land({ 'docs/notes.md': 'first\n' });
  let reads = 0;
  // The second read lands another unrelated commit, as if the train landed again during the merge.
  const readTrunk = () => {
    reads += 1;
    if (reads === 2) p.land({ 'docs/second.md': 'second\n' }, 'feat: a second landing');
    return { commit: p.git(p.main, 'rev-parse', 'main') };
  };
  const composed = await composeAfterProof(p.work, p.proof({ readTrunk }), SERVICES);
  const second = p.git(p.main, 'rev-parse', 'main');
  assert.equal(composed.evidence.to, second);
  assert.deepEqual(composed.evidence.moved, [first, second], 'both landings are recorded');
  const q = project(t);
  q.land({ 'docs/notes.md': 'first\n' });
  let calls = 0;
  const overlapping = () => {
    calls += 1;
    if (calls === 2) q.land({ 'web/shared.js': "export const shared = 'late-';\n" }, 'feat: a late overlapping landing');
    return { commit: q.git(q.main, 'rev-parse', 'main') };
  };
  await assert.rejects(composeAfterProof(q.work, q.proof({ readTrunk: overlapping }), SERVICES),
    error => error.code === 'MAIN_NOT_COMPOSED' && /web\/shared\.js/u.test(error.message), 'the late overlap is still caught and named');
});

test('a main that does not descend from the proved main refuses, and an unmoved main submits the proof commit [C7]', async t => {
  const p = project(t);
  assert.deepEqual(await composeAfterProof(p.work, p.proof(), SERVICES), { commit: p.proofCommit, evidence: null }, 'no move, no merge');
  p.git(p.main, 'checkout', '-q', '--orphan', 'rewritten');
  p.git(p.main, 'commit', '-q', '-m', 'chore: rewritten history');
  const rewritten = p.git(p.main, 'rev-parse', 'HEAD');
  await assert.rejects(composeAfterProof(p.work, p.proof({ readTrunk: () => ({ commit: rewritten }) }), SERVICES),
    error => error.code === 'MAIN_NOT_COMPOSED' && /does not contain the proved main/u.test(error.message));
});
