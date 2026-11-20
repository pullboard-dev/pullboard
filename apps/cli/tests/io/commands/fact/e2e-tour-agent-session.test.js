/** The scripted tour run by an agent session keeps the caller's session out of every seat, apart from the second-tour case so each file stays under 120 s [N10]. */
import assert from 'node:assert/strict';
import {
  runFixtureChildAsync,
} from '../../../fixtures/child.js';
import {
  existsSync,
  readFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import {
  dirname,
  join,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';

import { DatabaseSync } from 'node:sqlite';
import { fixtureMachineSettings } from '../../../fixtures/testkit.js';
import { createE2eHelpers } from '../../../fixtures/e2e.js';
const e2e = createE2eHelpers();
after(e2e.cleanup);
const { BIN, sandbox } = e2e;

/** The digest the agent-session ledger stores for one session identifier, as src/person.js computes it. */
function sessionDigest(name, value) {
  return createHash('sha256').update(JSON.stringify([name, value])).digest('hex');
}

// The offering command touches the wake file just before the board stamps the offer step, so the runner's marker can precede that stamp by a few ms; order is judged with this slack.
const OFFER_RECORD_SLACK_MS = 500;

/** The time of each job's offer and of its claim on the demo board, in offer order. */
function offerToClaim(repo) {
  // @pullboard-board-file journey: a read-only look at the jobs the tour's demo runner claimed.
  const db = new DatabaseSync(join(repo, '.git', 'pullboard', 'board.sqlite'), { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 10000');
    return db.prepare("SELECT o.job_step_at AS offered, c.job_step_at AS claimed FROM job_step o JOIN job_step c ON c.job_step_job = o.job_step_job AND c.job_step_name = 'claimed' AND c.job_step_seq = (SELECT MIN(job_step_seq) FROM job_step WHERE job_step_job = o.job_step_job AND job_step_name = 'claimed') WHERE o.job_step_name = 'offered' ORDER BY o.job_step_at").all().map(row => ({ offered: row.offered, claimed: row.claimed }));
  } finally { db.close(); }
}

test('cli.journeys-fact-e2e-tour.the-tour-finishes-when-an-agent: clause 1: the tour finishes when an agent session runs it [N10]', async t => {
  // A caller in Claude Code or Codex runs the tour; the scripted seats must not inherit the caller's session, so the
  // reject-and-rework still verifies (#952). The caller's own digest must appear on no item the tour moved.
  const runs = [['CLAUDE_CODE_SESSION_ID', 'caller-session-952'], ['CODEX_THREAD_ID', 'caller-thread-952']].map(([name, value]) => {
    const box = sandbox();
    // The Claude Code caller has runners.localWake on and the Codex caller leaves it off, so one tour per switch state proves the demo carries it only when on [C7,#10418].
    const wake = name === 'CLAUDE_CODE_SESSION_ID';
    if (wake) fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { 'runners.localWake': true });
    // One of the two runs keeps git's own hook scripts as processes, the real-process path a person's commit takes [N10,#10408].
    const callerEnv = { ...box.env, TMPDIR: box.dir, CLAUDECODE: '1', [name]: value, ...(name === 'CODEX_THREAD_ID' ? { PULLBOARD_TOUR_REAL_HOOKS: '1' } : {}) };
    delete callerEnv.PULLBOARD_MODEL;
    delete callerEnv.NO_COLOR;
    delete callerEnv.FORCE_COLOR;
    return { name, value, wake, shown: runFixtureChildAsync(process.execPath, [BIN, 'tour'], { cwd: box.dir, env: callerEnv }) };
  });
  for (const { name, value, wake, shown } of await Promise.all(runs.map(async run => ({ ...run, shown: await run.shown })))) {
    t.diagnostic(`${name}: ${/^scripted commits: .*$/mu.exec(shown.stderr)?.[0]}`);
    assert.equal(shown.status, 0, `${name}: ${shown.stdout}${shown.stderr}`);
    assert.match(shown.stdout, /^Nothing shipped until a second agent verified it\.$/mu);
    assert.match(shown.stdout, /verified #1: CRITERION_MET/);
    assert.match(shown.stdout, /\$ git commit -q -m "feat\(app\): greet by name \[G1\]"/u, `${name}: the first scripted commit is shown`);
    assert.match(shown.stdout, /\$ git commit -q -am "fix\(app\): a blank name greets the world \[G1\]"/u, `${name}: the fix commit is shown`);
    assert.doesNotMatch(shown.stdout, /SELF_SESSION_VERIFY/);

    const repo = /Look around: cd (\S+) && pullboard log/.exec(shown.stdout)[1];
    const ledger = readFileSync(join(repo, '.git', 'pullboard', 'item-sessions.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const digests = ledger.map((row) => row.digest);
    // The ledger holds the builder's claim and submit; the reviewer's verify passing already proves it is another session.
    assert.ok(digests.length > 0, `${name}: the builder's claim and submit are recorded`);
    assert.equal(digests.includes(sessionDigest(name, value)), false, `${name}: the caller's session is no seat's builder`);
    const claims = offerToClaim(repo);
    const machine = join(dirname(repo), '.pullboard-machine');
    // Order, not time: a run beside other jobs has a cold first claim, so the proof is offer, then the runner's wake marker, then claim.
    const log = existsSync(join(machine, 'local-runner', 'runner.log')) ? readFileSync(join(machine, 'local-runner', 'runner.log'), 'utf8') : '';
    const woke = log.split('\n').filter(line => /^\S+ runner-woke-on-offer$/u.test(line)).map(line => Date.parse(line.split(' ')[0]));
    if (wake) {
      assert.ok(claims.length > 0, `${name}: the demo runner claimed jobs`);
      assert.ok(woke.some(at => at >= claims[0].offered - OFFER_RECORD_SLACK_MS && at <= claims[0].claimed), `${name}: with runners.localWake on the first claim follows its offer through a runner wake marker, offer then marker then claim: ${JSON.stringify({ first: claims[0], woke, runnerLogTail: log.split('\n').slice(-12) })}`);
    } else assert.deepEqual(woke, [], `${name}: with runners.localWake off the runner records no wake marker`);
    t.diagnostic(`offer-to-claim ms (runners.localWake ${wake ? 'on' : 'off'}, ${name}): ${JSON.stringify(claims.map(({ offered, claimed }) => claimed - offered))}`);
    const settings = join(machine, 'settings.json');
    const demo = existsSync(settings) ? JSON.parse(readFileSync(settings, 'utf8')) : {};
    assert.equal(demo['runners.localWake'], wake ? true : undefined, `${name}: the demo settings carry the caller's runners.localWake only when it is on`);
  }
});
