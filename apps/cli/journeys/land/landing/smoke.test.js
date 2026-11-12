/** Every landing runs the candidate's help, init, add, list, show, claim, next and status on a scratch board before main moves [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  runCommitCliSmoke,
  runLandingCliSmoke,
} from '../../../../../packages/landing/index.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../../tests/fixtures/land/project.js';

const ROOT = resolve(import.meta.dirname, '../../../../..');
const e2e = createE2eHelpers();
after(e2e.cleanup);
const { landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures(e2e);

/** A project CLI that answers every command until an item's file asks it to break, as an import cycle would. */
const BREAKABLE_CLI = [
  "const fs = require('node:fs'); const path = require('node:path');",
  "const file = path.join(__dirname, '../..', 'web', 'land-1.test.js');",
  "if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('BREAK')) throw new Error('import cycle in the command catalog');",
].join('\n') + '\n';

/**
 * Land one accepted item whose merged tree breaks the project's own CLI through the ordinary, non-parallel path, and
 * return main and origin before and after. `separate` takes the local-trunk path instead of the inline batch gate.
 */
async function landBrokenCli({ separate }) {
  const box = landProject();
  const path = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  assert.notEqual(config.landing?.parallel, true, 'the fixture lands through the ordinary, non-parallel path');
  if (separate) writeFileSync(path, JSON.stringify({ ...config, landing: { ...config.landing, publish: 'separate' } }, null, 2));
  mkdirSync(join(box.repo, 'apps', 'cli'), { recursive: true });
  writeFileSync(join(box.repo, 'apps/cli/pullboard.js'), BREAKABLE_CLI);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: ship a project CLI');
  box.git(box.repo, 'push', '-q', 'origin', 'main');
  const entry = itemWorktree(box, 1);
  submitItem(box, entry, '// BREAK PASS\n');
  acceptItem(box, entry);
  const main = box.git(box.repo, 'rev-parse', 'main'), origin = box.git(box.remote, 'rev-parse', 'main');
  const landed = await box.runLocal(box.repo, 'land');
  return { landed, main, origin, mainAfter: box.git(box.repo, 'rev-parse', 'main'), originAfter: box.git(box.remote, 'rev-parse', 'main') };
}

/** A candidate tree whose CLI entry throws on import, committed in a throwaway repository. */
function brokenCandidate(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-smoke-candidate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'apps', 'cli'), { recursive: true });
  writeFileSync(join(dir, 'apps/cli/pullboard.js'), "throw new Error('import cycle in the command catalog');\n");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid',
    GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-q', '-m', 'feat: broken help']]) {
    assert.equal(spawnSync('git', args, { cwd: dir, env }).status, 0);
  }
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, env, encoding: 'utf8' }).stdout.trim();
  return { dir, commit };
}

test('a healthy candidate passes help, init, add, list, show, claim, next and status on a scratch board [C7]', () => {
  const { ran } = runLandingCliSmoke(ROOT);
  for (const command of ['help', 'init', 'add', 'list', 'show', 'claim', 'next', 'status']) assert.ok(ran.includes(command), `${command} ran and exited 0`);
});

test('a candidate whose help throws at import is refused, naming the failing command [C7]', t => {
  const { dir } = brokenCandidate(t);
  assert.throws(() => runLandingCliSmoke(dir), error => error.code === 'LAND_CLI_SMOKE' && /pullboard help/u.test(error.message) && /import cycle/u.test(error.message));
});

test('a hand landing smokes the recorded commit the same way, from a tree it extracts itself [C7]', t => {
  const { dir, commit } = brokenCandidate(t);
  assert.throws(() => runCommitCliSmoke(dir, commit), error => error.code === 'LAND_CLI_SMOKE' && /pullboard help/u.test(error.message));
});

test('a candidate that ships no CLI entry has nothing to smoke [C7]', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-smoke-none-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(runLandingCliSmoke(dir), { ran: [] });
});

test('a non-parallel inline landing whose candidate help throws is refused before main moves, naming the command [C7]', { timeout: 180_000 }, async () => {
  const { landed, main, origin, mainAfter, originAfter } = await landBrokenCli({ separate: false });
  assert.notEqual(landed.code, 0, landed.out);
  assert.match(landed.err, /LAND_CLI_SMOKE/u);
  assert.match(landed.err, /pullboard help/u);
  assert.equal(mainAfter, main, 'main did not move');
  assert.equal(originAfter, origin, 'origin did not move');
});

test('a local-trunk landing whose candidate help throws lands nothing, naming the command [C7]', { timeout: 180_000 }, async () => {
  const { landed, main, origin, mainAfter, originAfter } = await landBrokenCli({ separate: true });
  assert.match(`${landed.out}\n${landed.err}`, /nothing landed: .*pullboard help/u);
  assert.equal(mainAfter, main, 'main did not move');
  assert.equal(originAfter, origin, 'origin did not move');
});
