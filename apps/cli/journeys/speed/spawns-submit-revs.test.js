/** One submit resolves its revisions once and reads the first-parent log once [C7]. */
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

/** The logged git lines whose subcommand is `name`, with the pattern `rest` after it. */
function lines(log, name, rest = '') {
  return readFileSync(log, 'utf8').split('\n').filter(line => new RegExp(`\\sgit ${name}\\b.*${rest}`, 'u').test(line));
}

test('cli.journeys-speed-spawns-submit-revs.submit-resolves-revisions-once-c7: submit resolves revisions once [C7]', async t => {
  const helpers = createE2eHelpers();
  t.after(() => helpers.cleanup());
  const box = helpers.project('true');
  const log = join(box.dir, 'spawns.log');
  const id = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Revisions once', diagnose: false, args: ['--specs', 'G1'] }).item_id;
  const claim = await box.runLocal(box.web, 'claim', String(id), '--json');
  assert.equal(claim.code, 0, claim.err + claim.out);
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web', 'revs.js'), 'export const revs = 1;\n');
  box.git(box.web, 'add', '-A');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): revisions once [G1]');
  Object.assign(box.env, spawnEnv(log), { PULLBOARD_SPAWN_STACK: '1' });
  writeFileSync(log, '');
  const submit = box.run(box.web, 'submit', String(id), '--no-next');
  assert.equal(submit.code, 0, submit.err + submit.out);
  const parents = lines(log, 'rev-parse', 'HEAD\\^');
  const firstParent = lines(log, 'log', '--first-parent');
  const trunk = lines(log, 'config', 'pullboard\\.trunk');
  console.log(`# rev-parse HEAD^ ${parents.length}\n${parents.join('\n')}\n# log first-parent ${firstParent.length}\n${firstParent.join('\n')}\n# config trunk ${trunk.length}\n${trunk.join('\n')}`);
  assert.ok(parents.length <= 1, `git rev-parse HEAD^ ran ${parents.length} times`);
  assert.ok(firstParent.length <= 1, `git log --first-parent ran ${firstParent.length} times`);
  assert.ok(trunk.length <= 1, `git config pullboard.trunk ran ${trunk.length} times`);
});
