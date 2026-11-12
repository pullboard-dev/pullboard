/** An earlier holder may be excluded from reviewing the item it released [V1,B3]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { FIXTURE_MODEL } from '../../tests/fixtures/e2e.js';

for (const on of [false, true]) test(`review.excludeEarlierHolders ${on ? 'on refuses' : 'off allows'} a seat that claimed then released the item to reserve its review [V1,B3]`, async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const ok = result => { assert.equal(result.code, 0, result.err || result.out); return JSON.parse(result.out); };
  const early = join(box.dir, 'early-seat');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', early, 'main');
  ok(await box.inProcess(early, 'join', 'web', '--model', FIXTURE_MODEL, '--route', 'strong', '--json'));
  ok(await fixtureAdd(box.inProcess, box.repo, 'web', 'Held before', '--criterion', 'the feature builds', '--specs', 'G1', '--check', 'true', '--json'));
  ok(await box.inProcess(early, 'claim', '1', '--json'));
  ok(await box.inProcess(early, 'release', '1', '--reason', 'OTHER', '--note', 'dropped before building', '--json'));
  ok(await box.inProcess(box.web, 'claim', '1', '--json'));
  assert.equal(helpers.commitFile(box, box.web, 'web/feature.js', 'built\n', 'feat(web): build feature [G1]').status, 0);
  ok(await box.inProcess(box.web, 'submit', '1', '--json'));
  if (on) {
    const file = join(early, 'pullboard.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), review: { excludeEarlierHolders: true } }, null, 2) + '\n');
    box.git(early, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qam', 'chore: exclude earlier holders from review');
  }
  const reserve = await box.inProcess(early, 'next', '--verify', '1', '--json');
  if (on) {
    assert.equal(reserve.code, 1, reserve.out + reserve.err);
    assert.equal(JSON.parse(reserve.out).error.code, 'REVIEW_EARLIER_HOLDER');
    assert.match(JSON.parse(reserve.out).error.message, /review\.excludeEarlierHolders/u);
  } else assert.equal(reserve.code, 0, `off: only the builder is excluded\n${reserve.out}${reserve.err}`);
});

