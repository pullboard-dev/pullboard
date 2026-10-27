/** @pullboard-test-input source-tree */
/** Verification carries the gate's explicit desktop requirement into real admission [C7,V4]. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createE2eHelpers } from './e2e-helpers.js';
import { checkNeedsGui } from '../src/gui-admission.js';
import { GATE_SLOT_HELD_ENV, GATE_SLOT_POOL_ENV, GATE_SLOT_TOKEN_ENV, BROWSER_SLOT_HELD_ENV } from '../src/resources.js';

/** Require successful native setup rather than interpreting a setup refusal as admission evidence. */
function document(result) {
  assert.equal(result.code, 0, result.out + result.err);
  return JSON.parse(result.out);
}

test('verify admits a GUI check through the GUI slot like the gate [C7,V4]', async (t) => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  for (const gui of [true, false]) {
    const box = helpers.project('true');
    // Only this private machine drops inherited admission; no host setting or pool is modified.
    for (const key of [GATE_SLOT_HELD_ENV, GATE_SLOT_POOL_ENV, GATE_SLOT_TOKEN_ENV, BROWSER_SLOT_HELD_ENV]) delete box.env[key];
    mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    writeFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json'), JSON.stringify({ gateSlots: 1, browserSlots: 1 }));
    mkdirSync(join(box.repo, 'bin'));
    mkdirSync(join(box.repo, 'test'));
    writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
    // A literal fixture runner executes the selected file, without importing the real project's test pool.
    writeFileSync(join(box.repo, 'bin/run-tests.js'), "await import(new URL('../' + process.argv[2], import.meta.url));\n");
    writeFileSync(join(box.repo, 'test/desktop.test.js'), `${gui ? '/** @pullboard-test-gui */\n' : ''}import { test } from 'node:test';\ntest('desktop fixture executes', () => {});\n`);
    box.git(box.repo, 'add', '-A');
    box.git(box.repo, 'commit', '-q', '-m', 'test: explicit desktop admission fixture [G1]');
    box.git(box.web, 'merge', '-q', '--ff-only', 'main');
    const check = 'node bin/run-tests.js test/desktop.test.js';
    document(box.run(box.repo, 'add', 'web', 'Desktop admission', '--criterion', 'the selected check executes', '--check', check, '--specs', 'G1', '--json'));
    document(box.run(box.web, 'claim', '1', '--json'));
    const head = box.git(box.web, 'rev-parse', 'HEAD');
    helpers.historicalCheckSubmission(box, head);
    const reviewer = join(box.dir, 'reviewer');
    box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, head);
    document(box.run(reviewer, 'join', 'api', '--json'));
    assert.equal(await checkNeedsGui(reviewer, check), gui, 'the gate classifier reads the tracked leading annotation');
    const ready = join(box.dir, 'holder-ready');
    const release = join(box.dir, 'holder-release');
    const holderSource = join(box.dir, 'holder.mjs');
    const gate = new URL('../src/gate.js', import.meta.url).href;
    writeFileSync(holderSource, `import { withGateSlot } from ${JSON.stringify(gate)};\nimport { existsSync, writeFileSync } from 'node:fs';\nawait withGateSlot(process.cwd(), async () => { writeFileSync(${JSON.stringify(ready)}, 'ready'); while (!existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 20)); }, { remote: false, agent: 'private-holder', kind: 'check' });\n`);
    const holder = helpers.launch(box, reviewer, process.execPath, [holderSource]);
    let verification;
    let queued;
    try {
      await helpers.waitFor(() => existsSync(ready), 'private gate holder');
      verification = helpers.launch(box, reviewer, process.execPath, [helpers.BIN, 'verify', '1', 'accept', '--note', 'real admission fixture', '--json']);
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
    assert.equal(queued.gui, Number(gui), 'verify preserves the same explicit GUI requirement as the gate');
    assert.equal(document(box.run(box.repo, 'show', '1', '--json')).item_status, 'verified');
  }
});
