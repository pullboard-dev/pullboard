/** @pullboard-test-input source-tree */
/** Verification carries the gate's explicit desktop requirement into real admission [C7,V4]. */
import { executionServicesSource } from '../../tests/fixtures/gate/execution.js';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { checkNeedsGui } from '../../../../packages/gate/index.js';
import {
  GATE_SLOT_HELD_ENV,
  GATE_SLOT_POOL_ENV,
  GATE_SLOT_TOKEN_ENV,
  BROWSER_SLOT_HELD_ENV,
} from '../../../../packages/resources/index.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';

/** Require successful native setup rather than interpreting a setup refusal as admission evidence. */
function document(result) {
  assert.equal(result.code, 0, result.out + result.err);
  return JSON.parse(result.out);
}

test('verify admits a GUI check through the GUI slot like the gate [C7,V4]', async (t) => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  for (const { liveGui, companion, expectedGui } of [
    { liveGui: true, companion: false, expectedGui: true },
    { liveGui: false, companion: false, expectedGui: false },
    { liveGui: false, companion: true, expectedGui: true },
  ]) {
    const box = helpers.project('true');
    // Only this private machine drops inherited admission; no host setting or pool is modified.
    for (const key of [GATE_SLOT_HELD_ENV, GATE_SLOT_POOL_ENV, GATE_SLOT_TOKEN_ENV, BROWSER_SLOT_HELD_ENV]) delete box.env[key];
    mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    writeFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json'), JSON.stringify({ gateSlots: 1, browserSlots: 1 }));
    // The explicit-file classifier only reads checks run through apps/cli/src/io/run/tests.js, so the web lane owns the runner and the test dir here.
    const configPath = join(box.repo, 'pullboard.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.lanes.web.owns = [...config.lanes.web.owns, 'apps/cli/src/io/run/', 'test/'];
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    mkdirSync(join(box.repo, 'apps/cli/src/io/run'), { recursive: true });
    mkdirSync(join(box.repo, 'test'));
    writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
    // A literal fixture runner executes the selected file, without importing the real project's test pool.
    writeFileSync(join(box.repo, 'apps/cli/src/io/run/tests.js'), "await import(new URL('../../../../../' + process.argv[2], import.meta.url));\n");
    writeFileSync(join(box.repo, 'test/desktop.test.js'), `${liveGui ? '/** @pullboard-test-gui */\n' : ''}import { test } from 'node:test';\ntest('desktop fixture executes', () => {});\n`);
    box.git(box.repo, 'add', '-A');
    box.git(box.repo, 'commit', '-q', '-m', 'test: explicit desktop admission fixture [G1]');
    box.git(box.web, 'merge', '-q', '--ff-only', 'main');
    const check = 'node apps/cli/src/io/run/tests.js test/desktop.test.js';
    document(fixtureAdd(box.run, box.repo, 'web', 'Desktop admission', '--criterion', 'the selected check executes', '--check', check, '--specs', 'G1', '--json'));
    document(box.run(box.web, 'claim', '1', '--json'));
    const head = box.git(box.web, 'rev-parse', 'HEAD');
    helpers.historicalCheckSubmission(box, head);
    const reviewer = join(box.dir, 'reviewer');
    box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, head);
    document(fixtureJoin(box.run, reviewer, 'api', '--json'));
    assert.equal(await checkNeedsGui(reviewer, check), liveGui, 'the live classifier reads only the original tracked annotation');
    if (companion) {
      const coordinator = document(box.run(box.repo, 'whoami', '--json'));
      assert.equal(coordinator.id, 'coordinator', 'the native source author owns coordinator-only test paths');
      const patch = [
        'diff --git a/test/desktop.test.js b/test/desktop.test.js',
        '--- a/test/desktop.test.js',
        '+++ b/test/desktop.test.js',
        '@@ -1,2 +1,3 @@',
        '+/** @pullboard-test-gui */',
        " import { test } from 'node:test';",
        " test('desktop fixture executes', () => {});",
        '',
      ].join('\n');
      const patchFile = join(box.dir, 'desktop-marker.patch');
      writeFileSync(patchFile, patch);
      document(box.run(box.repo, 'patch', 'attach', '1', patchFile, '--key', 'desktop-marker',
        '--author', coordinator.id, '--source', head, '--json'));
      assert.equal(await checkNeedsGui(reviewer, check), false, 'attachment never mutates the unmarked live reviewer source');
    }
    const liveHead = box.git(reviewer, 'rev-parse', 'HEAD');
    const liveStatus = box.git(reviewer, 'status', '--porcelain=v1');
    const indexPath = box.git(reviewer, 'rev-parse', '--git-path', 'index');
    const liveIndex = readFileSync(indexPath.startsWith('/') ? indexPath : join(reviewer, indexPath));
    let verifier = reviewer;
    if (companion) {
      verifier = join(box.dir, 'composed-reviewer');
      box.git(box.repo, 'worktree', 'add', '-q', '--detach', verifier, head);
      document(fixtureJoin(box.run, verifier, 'api', '--json'));
      document(box.run(verifier, 'next', '--verify', '1', '--json'));
      assert.equal(await checkNeedsGui(verifier, check), true, 'the reserved reviewer sees the composed GUI marker');
    }
    const ready = join(box.dir, 'holder-ready');
    const release = join(box.dir, 'holder-release');
    const holderSource = join(box.dir, 'holder.mjs');
    const gate = new URL('../../../../packages/gate/index.js', import.meta.url).href;
    writeFileSync(holderSource, `import { withGateSlot } from ${JSON.stringify(gate)};
${executionServicesSource(gate)}\nimport { existsSync, writeFileSync } from 'node:fs';\nawait withGateSlot(process.cwd(), async () => { writeFileSync(${JSON.stringify(ready)}, 'ready'); while (!existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 20)); }, { executionServices, remote: false, agent: 'private-holder', kind: 'check' });\n`);
    const holder = helpers.launch(box, reviewer, process.execPath, [holderSource]);
    let verification;
    let queued;
    try {
      await helpers.waitFor(() => existsSync(ready), 'private gate holder');
      verification = helpers.launch(box, verifier, process.execPath, [helpers.BIN, 'verify', '1', 'accept', '--note', 'real admission fixture', '--json']);
      const db = new DatabaseSync(join(box.env.PULLBOARD_MACHINE_HOME, 'resources.sqlite'), { readOnly: true });
      // This observer must wait for a real in-flight writer, without changing admission or its deadline.
      db.exec('PRAGMA busy_timeout = 500');
      let busyReads = 0;
      try {
        queued = await helpers.waitFor(() => {
          try { return db.prepare("SELECT gui, browser FROM waiter WHERE kind = 'review' AND item = '1'").get(); }
          catch (error) {
            if (error.code !== 'ERR_SQLITE_ERROR' || !/database is (?:locked|busy)/u.test(error.message)) throw error;
            busyReads += 1;
            return null;
          }
        }, 'the actual verification admission request');
      } finally { db.close(); }
      if (busyReads) t.diagnostic(`verification observer retried ${busyReads} busy reads before seeing the actual waiter`);
    } finally {
      writeFileSync(release, 'release');
      assert.equal((await holder.closed).code, 0, holder.stderrText);
      if (verification) assert.equal((await verification.closed).code, 0, verification.stdoutText + verification.stderrText);
    }
    assert.equal(queued.browser, 1, 'both verification requests preserve the default browser-slot requirement');
    assert.equal(queued.gui, Number(expectedGui), 'actual admission uses the exact checked source GUI requirement');
    const accepted = document(box.run(box.repo, 'show', '1', '--json'));
    assert.equal(accepted.item_status, 'verified', 'the actual native frozen check completed successfully');
    assert.equal(box.git(reviewer, 'rev-parse', 'HEAD'), liveHead);
    assert.equal(box.git(reviewer, 'status', '--porcelain=v1'), liveStatus);
    assert.deepEqual(readFileSync(indexPath.startsWith('/') ? indexPath : join(reviewer, indexPath)), liveIndex);
    if (companion) {
      const reviewed = accepted.verdicts.at(-1).review.head;
      assert.notEqual(reviewed, head, 'the checked composition is immutable and distinct from submitted source');
      assert.match(box.git(box.repo, 'show', `${reviewed}:test/desktop.test.js`), /^\/\*\* @pullboard-test-gui \*\//u);
      assert.doesNotMatch(readFileSync(join(reviewer, 'test/desktop.test.js'), 'utf8'), /@pullboard-test-gui/u);
    }
  }
});
