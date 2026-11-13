/** @pullboard-test-input apps/cli/src/io/submit/gate.js */
/** @pullboard-world-pin reads the submit gate source to prove its result move crosses volumes through moveAcross. */
/** The CLI's shadow-batch and trusted-main folders are created under the scratch root, and submit's result move survives another volume [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BOOTSTRAP } from '../../src/io/submit/gate.js';
import { main } from '../../tests/fixtures/native.js';
import * as store from '../../../../packages/store/index.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import {
  cellBoard,
  cellClaim,
  cellItem,
  cellProject,
  cellSeat,
} from '../../../../packages/store/tests/fixtures/cell.js';

const GATE_SOURCE = fileURLToPath(new URL('../../src/io/submit/gate.js', import.meta.url));

/** A repository whose main holds one accepted item and a failing static check that prints where it ran, beside a scratch root. */
function fixture(t) {
  const project = cellProject(t, { config: { staticChecks: 'pwd; exit 1' } });
  const root = project.repo;
  mkdirSync(join(project.dir, 'scratch'));
  const scratch = realpathSync(join(project.dir, 'scratch'));
  const git = (...args) => project.git(root, ...args).trim();
  git('switch', '-q', '-c', 'item-a', 'main');
  mkdirSync(join(root, 'web'), { recursive: true });
  writeFileSync(join(root, 'web/a.txt'), 'a\n');
  git('add', '-A');
  git('-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'feat(web): add a [G1]');
  const head = git('rev-parse', 'HEAD');
  git('switch', '-q', 'main');
  const board = cellBoard(t, project.boardFile, undefined, { gitRoot: root });
  const builder = cellSeat(board, { lane: 'web', path: join(root, 'web') });
  const reviewer = cellSeat(board, { lane: 'review', path: join(root, 'review') });
  const id = cellItem(board, { lane: 'web', title: 'Shadow' }).item_id;
  cellClaim(board, id, builder, { root });
  submitFixture(board, id, { agentId: builder.id, commit: head, tree: git('rev-parse', `${head}^{tree}`) });
  store.verify(board, id, { agentId: reviewer.id, decision: 'ACCEPT', note: 'Fixture accepts.', head, digest: store.getItem(board, id).item_frozen_digest, policy: 'any' });
  return { root, scratch, id, git, base: project.dir, env: project.env };
}

/** Runs shadow-batch with PULLBOARD_SCRATCH set (or cleared) and returns its output. */
async function shadow(f, scratch) {
  const before = process.env.PULLBOARD_SCRATCH;
  const home = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = f.env.PULLBOARD_MACHINE_HOME;
  if (scratch === undefined) delete process.env.PULLBOARD_SCRATCH; else process.env.PULLBOARD_SCRATCH = scratch;
  let stdout = '';
  try {
    await main(['shadow-batch', String(f.id)], { cwd: f.root, stdout: { isTTY: false, write: text => { stdout += text; } }, stderr: { write: () => {} } });
  } finally {
    if (before === undefined) delete process.env.PULLBOARD_SCRATCH; else process.env.PULLBOARD_SCRATCH = before;
    if (home === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = home;
  }
  return stdout;
}

test('with scratch set, the shadow-batch folder is created under it [C7]', async t => {
  const f = fixture(t);
  const out = await shadow(f, f.scratch);
  assert.match(out, new RegExp(`${f.scratch}/pullboard-shadow-batch-`, 'u'));
  assert.equal(f.git('worktree', 'list').split('\n').length, 1, 'the scratch worktree is gone');
});

test('with scratch unset, the shadow-batch folder is an os.tmpdir() folder as before [C7]', async t => {
  const f = fixture(t);
  const out = await shadow(f, undefined);
  assert.match(out, /pullboard-shadow-batch-/u);
  assert.doesNotMatch(out, new RegExp(f.scratch, 'u'));
});

test('with scratch set, the trusted-main folder is created under it [C7]', t => {
  const f = fixture(t);
  const tools = join(f.base, 'tools');
  mkdirSync(join(tools, 'packages/items'), { recursive: true });
  writeFileSync(join(tools, 'packages/items/index.js'), '');
  const entry = 'process.stdout.write(import.meta.url);';
  const encoded = Buffer.from(JSON.stringify({ main: f.git('rev-parse', 'HEAD'), entry, data: {} })).toString('base64');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `const ENCODED = ${JSON.stringify(encoded)};\n${BOOTSTRAP}`], {
    cwd: f.root,
    encoding: 'utf8',
    env: { ...f.env, PULLBOARD_SCRATCH: f.scratch, PULLBOARD_RUNNER_TOOLS: tools },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, new RegExp(`file://${f.scratch}/pullboard-trusted-main-`, 'u'));
});

test("submit's result move goes through moveAcross, so another volume never fails on EXDEV [C7]", () => {
  const source = readFileSync(GATE_SOURCE, 'utf8');
  assert.match(source, /moveAcross\(pending, resultFile\)/u);
  assert.doesNotMatch(source, /renameSync\(pending, resultFile\)/u);
});
