/** The scripted tour run by an agent session keeps the caller's session out of every seat [N10]. */
import assert from 'node:assert/strict';
import {
  runFixtureChildAsync,
} from '../../../tests/fixtures/child.js';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';

import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
const e2e = createE2eHelpers();
after(e2e.cleanup);
const { BIN, sandbox } = e2e;

/** The digest the agent-session ledger stores for one session identifier, as src/person.js computes it. */
function sessionDigest(name, value) {
  return createHash('sha256').update(JSON.stringify([name, value])).digest('hex');
}

test('clause 1: the tour finishes when an agent session runs it [N10]', async () => {
  // A caller in Claude Code or Codex runs the tour; the scripted seats must not inherit the caller's session, so the
  // reject-and-rework still verifies (#952). The caller's own digest must appear on no item the tour moved.
  const runs = [['CLAUDE_CODE_SESSION_ID', 'caller-session-952'], ['CODEX_THREAD_ID', 'caller-thread-952']].map(([name, value]) => {
    const box = sandbox();
    const callerEnv = { ...box.env, TMPDIR: box.dir, CLAUDECODE: '1', [name]: value };
    delete callerEnv.PULLBOARD_MODEL;
    delete callerEnv.NO_COLOR;
    delete callerEnv.FORCE_COLOR;
    return { name, value, shown: runFixtureChildAsync(process.execPath, [BIN, 'tour'], { cwd: box.dir, env: callerEnv }) };
  });
  for (const { name, value, shown } of await Promise.all(runs.map(async run => ({ ...run, shown: await run.shown })))) {
    assert.equal(shown.status, 0, `${name}: ${shown.stdout}${shown.stderr}`);
    assert.match(shown.stdout, /^Nothing shipped until a second agent verified it\.$/mu);
    assert.match(shown.stdout, /verified #1: CRITERION_MET/);
    assert.doesNotMatch(shown.stdout, /SELF_SESSION_VERIFY/);

    const repo = /Look around: cd (\S+) && pullboard log/.exec(shown.stdout)[1];
    const ledger = readFileSync(join(repo, '.git', 'pullboard', 'item-sessions.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const digests = ledger.map((row) => row.digest);
    // The ledger holds the builder's claim and submit; the reviewer's verify passing already proves it is another session.
    assert.ok(digests.length > 0, `${name}: the builder's claim and submit are recorded`);
    assert.equal(digests.includes(sessionDigest(name, value)), false, `${name}: the caller's session is no seat's builder`);
  }
});
