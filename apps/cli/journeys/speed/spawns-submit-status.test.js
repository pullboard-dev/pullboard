/** One submit runs one git status and at most two untracked scans, and an uncommitted file is still refused [C7]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';
import { spawnEnv } from '../../tests/fixtures/spawns.js';

/** A claimed fixture item with one commit, and the spawn counter loaded in every child. */
async function claimed(t) {
  const helpers = createE2eHelpers();
  t.after(() => helpers.cleanup());
  const box = helpers.project('true');
  const log = join(box.dir, 'spawns.log');
  const id = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Status scan', diagnose: false, args: ['--specs', 'G1'] }).item_id;
  const claim = await box.runLocal(box.web, 'claim', String(id), '--json');
  assert.equal(claim.code, 0, claim.err + claim.out);
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web', 'scan.js'), 'export const scan = 1;\n');
  box.git(box.web, 'add', '-A');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): status scan [G1]');
  Object.assign(box.env, spawnEnv(log), { PULLBOARD_SPAWN_STACK: '1' });
  writeFileSync(log, '');
  return { box, id, log };
}

/** The logged git lines whose subcommand is `name`, with the first argument after it. */
function lines(log, name, rest = '') {
  return readFileSync(log, 'utf8').split('\n').filter(line => new RegExp(`\\sgit ${name}\\b.*${rest}`, 'u').test(line));
}

test('cli.journeys-speed-spawns-submit-status.one-status-scan-per-submit-c7: one status scan per submit [C7]', async t => {
  const { box, id, log } = await claimed(t);
  const submit = box.run(box.web, 'submit', String(id), '--no-next');
  assert.equal(submit.code, 0, submit.err + submit.out);
  const status = lines(log, 'status');
  const untracked = lines(log, 'ls-files', '--others');
  console.log(`# status ${status.length}\n${status.join('\n')}\n# untracked ${untracked.length}\n${untracked.join('\n')}`);
  assert.ok(status.length <= 1, `git status ran ${status.length} times`);
  assert.ok(untracked.length <= 2, `git ls-files --others ran ${untracked.length} times`);
});

test('cli.journeys-speed-spawns-submit-status.uncommitted-file-still-refused-c7: uncommitted file still refused [C7]', async t => {
  const { box, id } = await claimed(t);
  writeFileSync(join(box.web, 'web', 'dirty.js'), 'export const dirty = 1;\n');
  const submit = await box.runLocal(box.web, 'submit', String(id), '--no-next');
  assert.notEqual(submit.code, 0, 'an uncommitted file is refused');
  assert.match(submit.err + submit.out, /uncommitted|untracked|SUBMIT_DIRTY|commit/iu);
});
