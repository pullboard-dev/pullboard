/** @pullboard-test-input packages/landing/src/io/runner/job.js */
/** With landing.parallelGates on, two gated land groups reach trunk one after the other through the compare-and-swap push, a group that loses the swap retries on the new tip, and each landing records the main it was gated against [C7,#9707]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFixtureGit } from '../../../fixtures/child.js';
import { runFixtureSetupGit } from '../../../fixtures/child.js';
import { privateFixtureFiles } from '../../../fixtures/child.js';
import { fixtureMachineSettings } from '../../../../../../packages/gate/tests/fixtures/testkit.js';
import { parallelGatesEnabled } from '../../../../../../packages/config/index.js';
import { runLandingJob } from '../../../../../../packages/landing/index.js';
import { cellRepo } from '../../../../../../packages/store/tests/fixtures/cell.js';

const TRUNK = 'refs/heads/main';
const IDENT = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test'];

/** A non-bare trunk with main checked out and two gated groups, one item each, whose commits sit on the trunk's current tip; parallelGates is on in a private machine home. */
function twoGroups(t) {
  const { root: dir } = privateFixtureFiles('pullboard-parallel-push-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine');
  mkdirSync(process.env.PULLBOARD_MACHINE_HOME);
  fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, { landing: { parallelGates: true } });
  t.after(() => {
    if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved;
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(parallelGatesEnabled(), true, 'landing.parallelGates is on for this test');
  const trunk = cellRepo(t, { real: true }).root;
  runFixtureGit(['-C', trunk, 'config', 'receive.denyCurrentBranch', 'updateInstead']);
  const expect = runFixtureGit(['-C', trunk, 'rev-parse', 'HEAD']);
  /** One gated group: an item commit pushed to its own ref, and the land job that carries it. */
  const group = (id, file) => {
    const clone = join(dir, `item-${id}`);
    runFixtureGit(['clone', '-q', trunk, clone]);
    writeFileSync(join(clone, file), `${id}\n`);
    runFixtureGit(['-C', clone, 'add', '.']);
    runFixtureSetupGit(['-C', clone, ...IDENT, 'commit', '-q', '-m', `item ${id}`]);
    const commit = runFixtureGit(['-C', clone, 'rev-parse', 'HEAD']);
    runFixtureGit(['-C', clone, 'push', '-q', trunk, `HEAD:refs/heads/item-${id}`]);
    const payload = { shape: 3, remote: trunk, trunk: TRUNK, expect, checkout: true, publish: 'separate',
      items: [{ id, commit, ref: `refs/heads/item-${id}`, header: `feat(landing): item ${id} [C7]`, trailers: `Pullboard-Item: #${id}\nPullboard-Rows: C7` }] };
    return { id, commit, run: checks => runLandingJob(payload, { workdir: join(dir, `runner-${id}`), checks }) };
  };
  const tip = () => runFixtureGit(['-C', trunk, 'rev-parse', 'HEAD']);
  const parentOf = commit => runFixtureGit(['-C', trunk, 'rev-parse', `${commit}^1`]);
  return { trunk, expect, group, tip, parentOf };
}

test('cli.journeys-land-parallel-push.two-gated-groups-update-trunk-in-turn: clause 1: with landing.parallelGates on, two gated groups gated against the same main update trunk one after the other through the compare-and-swap push [C7,#9707]', async t => {
  const { expect, group, tip, parentOf } = twoGroups(t);
  const first = group(61, 'first.txt');
  const second = group(62, 'second.txt');
  const one = await first.run(() => ({ ok: true }));
  assert.equal(one.outcome, 'landed', one.detail ?? '');
  const afterFirst = tip();
  assert.notEqual(afterFirst, expect, 'the first group moved trunk');
  const two = await second.run(() => ({ ok: true }));
  assert.equal(two.outcome, 'landed', two.detail ?? '');
  assert.equal(parentOf(tip()), afterFirst, 'the second group landed on the first group\'s tip, one after the other');
  assert.equal(two.attempts, 1, 'a group that began on the moved trunk needed no retry');
});

test('cli.journeys-land-parallel-push.a-group-that-loses-the-swap-retries: clause 2: a group whose push loses the compare-and-swap to the other group retries on the new tip and lands [C7,#9707]', async t => {
  const { group, tip, parentOf } = twoGroups(t);
  const first = group(63, 'first.txt');
  const second = group(64, 'second.txt');
  let rivalTip = null;
  // The first group lands while the second group's check runs, so the second group's first push is the losing one.
  const checks = async () => {
    if (rivalTip === null) {
      const rival = await first.run(() => ({ ok: true }));
      assert.equal(rival.outcome, 'landed', rival.detail ?? '');
      rivalTip = tip();
    }
    return { ok: true };
  };
  const lost = await second.run(checks);
  assert.equal(lost.outcome, 'landed', lost.detail ?? '');
  assert.equal(lost.attempts, 2, 'the first push lost the swap and the second attempt landed');
  assert.deepEqual(lost.moved, [rivalTip], 'the group saw trunk move to the other group\'s landing');
  assert.equal(lost.base, rivalTip, 'the retry was gated against the new tip');
  assert.equal(parentOf(tip()), rivalTip, 'the retried landing sits on the new tip');
});

test('cli.journeys-land-parallel-push.each-landing-names-the-main-it-was-gated-against: clause 3: each recorded landing names the main commit it was gated against, and the landed merge sits on exactly that commit [C7,#9707]', async t => {
  const { expect, group, tip, parentOf } = twoGroups(t);
  const first = group(65, 'first.txt');
  const second = group(66, 'second.txt');
  const one = await first.run(() => ({ ok: true }));
  assert.equal(one.base, expect, 'the first landing names the main it was gated against');
  assert.equal(parentOf(tip()), one.base, 'its merge sits on that main');
  const afterFirst = tip();
  const two = await second.run(() => ({ ok: true }));
  assert.equal(two.base, afterFirst, 'the second landing names the new main it was gated against, not the one its job was offered on');
  assert.equal(parentOf(tip()), two.base, 'its merge sits on that main');
});
