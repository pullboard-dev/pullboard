/** After an upgrade, doctor and status give one repair step, and following it leaves doctor clean [R4,A5] (#7761). */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { after } from 'node:test';
import { test } from 'node:test';
import { codeIsFromMain } from '../../../../packages/git/index.js';
import { SCHEMA_VERSION } from '../../../../packages/store/index.js';
import { storeTriggers } from '../../../../packages/state/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { join } from 'node:path';

const e2e = createE2eHelpers();
after(() => e2e.cleanup());

/** A committed private project whose board the production CLI opens in-process, as a released CLI does. */
function project() {
  const box = e2e.project('true', undefined, { withWorktree: false });
  return { command: (...args) => runCliInProcess(args, { cwd: box.repo, env: box.env }), file: join(box.repo, '.git', 'pullboard', 'board.sqlite') };
}

/** Change one guard's SQL the way an older release wrote it, or set the schema stamp back one version. */
function age(file, what) {
  const db = new DatabaseSync(file);
  try {
    if (what === 'schema') db.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`);
    else {
      const { name, sql } = storeTriggers().find((trigger) => trigger.name === 'machine_item_move');
      db.exec(`DROP TRIGGER "${name}"; ${sql.replace('the board changes only through pullboard commands', 'the board changes only through pullboard')}`);
    }
  } finally { db.close(); }
}

/** Every `repair:` step a doctor run printed. */
const repairs = (stdout) => [...stdout.matchAll(/; repair: (.*)$/gmu)].map((match) => match[1]);

for (const what of ['trigger', 'schema']) {
  test(`doctor names a ${what} repair that status agrees with, and that works [R4,A5]`, async () => {
    const box = project();
    assert.equal((await box.command('status')).status, 0);
    age(box.file, what);
    const found = await box.command('doctor');
    assert.equal(found.status, 1, 'the aged board is reported');
    const [step] = repairs(found.stdout);
    assert.ok(step, found.stdout);
    const status = await box.command('status');
    if (status.status === 0) {
      assert.match(step, /^run pullboard status/u, 'status is the step doctor names when status can repair');
      // Only the main checkout's code repairs a board; a runner runs this source from a linked worktree.
      if (codeIsFromMain()) assert.equal((await box.command('doctor')).status, 0, 'doctor is clean once the named repair ran');
    } else {
      // Code outside the main checkout cannot upgrade a board; status and doctor both send the person to main's pullboard.
      const said = status.stderr + status.stdout;
      assert.match(said, /BOARD_SCHEMA_BEHIND|UNMERGED_SCHEMA/u);
      assert.match(said, /merge this code into the main checkout first/u);
      assert.match(step, /^merge this code into the main checkout first/u, `doctor says the same: ${step}`);
    }
  });
}
