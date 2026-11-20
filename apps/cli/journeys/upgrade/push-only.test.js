/**
 * The upgrade journey runs only in the pre-push full gate: an item gate leaves it to the audit through the push-only listing,
 * and the full gate still plans it [R4,C7] (#7788).
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { loadConfig } from '../../../../packages/config/index.js';
import { pushOnlyTests } from '../../../../packages/gate/heavy.js';
import { selectTestTiers } from '../../../../packages/gate/heavy.js';
import { submitGatePlan } from '../../../../packages/gate/heavy.js';
import { writeTestTiers } from '../../../../packages/gate/heavy.js';
import { git } from '../../../../packages/landing/tests/fixtures/plan.js';
import { frozen } from '../../../../packages/gate/tests/io/test/tier/frozen.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureProjectPolicy } from '../../tests/fixtures/testkit.js';
import { pushShardPlan } from '../../src/io/hook/push.js';

const JOURNEY = 'apps/cli/journeys/upgrade/previous-release.test.js';
const e2e = createE2eHelpers();
after(() => e2e.cleanup());

/** An identical journey the listing does not name, the control that an item gate would otherwise run it. */
const CONTROL = 'apps/cli/journeys/upgrade/control.test.js';
const REACHES = "import { size } from '../../../../packages/gate/src/io/size.js';\nvoid size;\n";

test('cli.journeys-upgrade-push-only.the-push-only-listing-names-the: the push-only listing names the upgrade journey [R4,C7]', () => {
  assert.deepEqual(pushOnlyTests(), [JOURNEY]);
});

test('cli.journeys-upgrade-push-only.an-item-gate-that-does-not: an item gate that does not touch the upgrade journey leaves it out, and without the listing it would run [R4,C7]', t => {
  const box = frozen(t);
  // The journey sits in the base, untouched by the change under test, and reaches the changed module.
  box.put(JOURNEY, REACHES);
  box.put(CONTROL, REACHES);
  git(box.root, 'add', '-A');
  writeTestTiers(box.root);
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'journey');
  const base = git(box.root, 'rev-parse', 'HEAD').trim();
  box.put('packages/gate/src/io/size.js', 'export const size = 2;\n');
  git(box.root, 'add', '-A');
  writeTestTiers(box.root);
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'change');
  const commit = git(box.root, 'rev-parse', 'HEAD').trim();
  const chosen = plan => [...plan.units, ...plan.journeys];

  const gated = selectTestTiers(box.root, { base, commit });
  assert.ok(chosen(gated).includes(CONTROL), 'the change reaches an unlisted twin, so its item gate runs it');
  assert.ok(!chosen(gated).includes(JOURNEY), 'the listed journey leaves the item gate');
  assert.deepEqual(gated.auditLeft, [JOURNEY], 'and is named as left to the audit');

  const composed = submitGatePlan(box.root, { gate: 'node --test', affectedTests: 'node --test' }, { base, commit });
  assert.ok(!composed.proofFiles.includes(JOURNEY), 'the submit gate runs none of it');
});

test('cli.journeys-upgrade-push-only.the-pre-push-full-gate-still: the pre-push full gate still plans the upgrade journey into a shard [R4,C7]', t => {
  const box = e2e.project('node --test', undefined, { withWorktree: false });
  const settings = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = box.env.PULLBOARD_MACHINE_HOME;
  t.after(() => { if (settings === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = settings; });
  const source = body => `import { test } from 'node:test';\ntest('holds', () => {});\n${body}`;
  for (const file of [JOURNEY, 'web/other.test.js']) {
    mkdirSync(dirname(join(box.repo, file)), { recursive: true });
    writeFileSync(join(box.repo, file), source(''));
  }
  fixtureProjectPolicy(box.repo, { config: { gate: 'node --test' } });
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test(web): two gate files [G1]');
  return pushShardPlan(box.repo, loadConfig(box.repo)).then(plan => {
    assert.ok(plan, 'the full gate plans shards for this project');
    const planned = plan.shards.flatMap(shard => shard.files.map(file => file.replace(/^\.\//u, '')));
    assert.ok(planned.includes(JOURNEY), 'the upgrade journey is in a push shard');
    assert.ok(planned.includes('web/other.test.js'));
  });
});
