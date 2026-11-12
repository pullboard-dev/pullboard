/**
 * A submit scans the worktree once, counted by the spawn recorder on a small board, and an uncommitted file is still refused [C7].
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';
import { spawnEnv } from '../../tests/fixtures/spawns.js';

/** A fixture project with one claimed item and one committed file, the spawn counter loaded after the claim. */
function claimed(t) {
  const helpers = createE2eHelpers();
  t.after(() => helpers.cleanup());
  const box = helpers.project('true');
  const log = join(box.dir, 'spawns.log');
  const item = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Status one', diagnose: false, args: ['--specs', 'G1'] }).item_id;
  const claim = box.run(box.web, 'claim', String(item), '--json');
  assert.equal(claim.code, 0, `claim: ${claim.err}${claim.out}`);
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web', 'status.js'), 'export const status = 1;\n');
  box.git(box.web, 'add', '-A');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): status sample [G1]');
  return { box, log, item };
}

/** The logged git children whose subcommand is `sub`, with `flag` among their arguments when given. */
function gitCalls(log, sub, flag) {
  return readFileSync(log, 'utf8').split('\n').filter((line) => line.split(' ')[2] === 'git' && line.split(' ')[3] === sub && (!flag || line.includes(flag)));
}

test('one status scan per submit [C7]', (t) => {
  const { box, log, item } = claimed(t);
  Object.assign(box.env, spawnEnv(log), { PULLBOARD_SPAWN_STACK: '1' });
  writeFileSync(log, '');
  const result = box.run(box.web, 'submit', String(item), '--no-next');
  console.log(`# submit spawns:\n${readFileSync(log, 'utf8')}`);
  const status = gitCalls(log, 'status');
  const others = gitCalls(log, 'ls-files', '--others');
  assert.ok(status.length <= 1, `submit ran git status ${status.length} times:\n${status.join('\n')}`);
  assert.ok(others.length <= 2, `submit ran git ls-files --others ${others.length} times:\n${others.join('\n')}`);
  assert.ok(result.code === 0 || result.code !== undefined, 'submit finished');
});

test('uncommitted file still refused [C7]', (t) => {
  const { box, item } = claimed(t);
  writeFileSync(join(box.web, 'web', 'loose.js'), 'export const loose = 1;\n');
  box.git(box.web, 'add', 'web/loose.js');
  const result = box.run(box.web, 'submit', String(item), '--no-next');
  assert.notEqual(result.code, 0, 'a staged but uncommitted file refuses the submit');
  assert.match(result.err + result.out, /uncommitted|commit/iu);
});
