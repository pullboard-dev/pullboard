/** Submit from the item folder next names prints no NOT_JOINED warning; a truly unjoined folder still warns once [C7]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

test('clause 1: submit from the item folder prints no NOT_JOINED warning, and an unjoined folder warns once [C7]', async () => {
  const box = helpers.project('true');
  await fileFixtureItem(box, box.repo, { lane: 'web', title: 'Joined folder submit', args: ['--specs', 'G1'], run: box.runLocal });
  const claimed = await box.runLocal(box.web, 'claim', '1', '--no-next');
  assert.equal(claimed.code, 0, claimed.out + claimed.err);
  const folder = /item folder: (\S+)/u.exec(claimed.out + claimed.err)?.[1] ?? `${box.web}-item-1`;
  mkdirSync(join(folder, 'web'), { recursive: true });
  writeFileSync(join(folder, 'web/joined.js'), 'export const joined = true;\n');
  box.git(folder, 'add', 'web/joined.js');
  box.git(folder, 'commit', '-q', '-m', 'feat(web): joined folder fixture [G1]');
  const submitted = await box.runLocal(folder, 'submit', '1', '--no-next');
  assert.doesNotMatch(submitted.out + submitted.err, /NOT_JOINED/u, submitted.out + submitted.err);

  const stranger = join(box.dir, 'stranger');
  box.git(box.repo, 'worktree', 'add', '-q', stranger, '-b', 'web/stranger');
  const refused = await box.runLocal(stranger, 'submit', '1', '--no-next');
  assert.equal((`${refused.out}${refused.err}`.match(/NOT_JOINED/gu) ?? []).length, 1, refused.out + refused.err);
});
