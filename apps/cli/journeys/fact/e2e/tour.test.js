/**
 * The scripted tour on real repos, apart from the other end-to-end journeys so the tour never waits behind them
 * and the file timeout never lands on it [N10].
 */
import assert from 'node:assert/strict';
import {
  runFixtureChildAsync,
} from '../../../tests/fixtures/child.js';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import {
  dirname,
  join,
} from 'node:path';
import {
  after,
  describe,
  test,
} from 'node:test';

import { DatabaseSync } from 'node:sqlite';
import { fixtureMachineSettings } from '../../../tests/fixtures/testkit.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
const e2e = createE2eHelpers();
after(e2e.cleanup);
const { BIN, sandbox } = e2e;

/** The digest the agent-session ledger stores for one session identifier, as src/person.js computes it. */
function sessionDigest(name, value) {
  return createHash('sha256').update(JSON.stringify([name, value])).digest('hex');
}

/** Milliseconds from each job's offer to its claim on the demo board, in offer order. */
function offerToClaimMs(repo) {
  // @pullboard-board-file journey: a read-only look at the jobs the tour's demo runner claimed.
  const db = new DatabaseSync(join(repo, '.git', 'pullboard', 'board.sqlite'), { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 10000');
    return db.prepare("SELECT o.job_step_at AS offered, c.job_step_at AS claimed FROM job_step o JOIN job_step c ON c.job_step_job = o.job_step_job AND c.job_step_name = 'claimed' AND c.job_step_seq = (SELECT MIN(job_step_seq) FROM job_step WHERE job_step_job = o.job_step_job AND job_step_name = 'claimed') WHERE o.job_step_name = 'offered' ORDER BY o.job_step_at").all().map(row => row.claimed - row.offered);
  } finally { db.close(); }
}

/** The two cases own separate sandboxes and homes, so they overlap their tours (about 60 s each) instead of adding them [C7,N10]. */
describe('the scripted tour overlaps its cases [N10]', { concurrency: true }, () => {
test('cli.journeys-fact-e2e-tour.a-second-tour-replaces-the-first: a second tour replaces the first demo and links nothing to the relay [N10]', { timeout: 300_000 }, async () => {
  // The machine's own list and relay state hold their own home, so a tour run here can only touch that home (#951).
  const box = sandbox();
  const home = join(box.dir, 'private-home');
  mkdirSync(home);
  const real = join(box.dir, 'real-project');
  mkdirSync(real);
  box.git(real, 'init', '-q', '-b', 'main');
  writeFileSync(join(home, 'projects.json'), JSON.stringify({ projects: [{ root: real, name: 'real-project', project: '', added: '2026-01-01T00:00:00.000Z' }] }));
  mkdirSync(join(home, 'relay-machine'), { mode: 0o700 });
  writeFileSync(join(home, 'relay-machine', 'state.json'), JSON.stringify({ v: 2, autoLink: true, owner: null, machine: 'machine-951', devices: [], excluded: [], pending: null, revocations: [], approvals: [] }), { mode: 0o600 });
  const tourEnv = { ...box.env, TMPDIR: box.dir, PULLBOARD_HOME: home };
  delete tourEnv.NO_COLOR;
  delete tourEnv.FORCE_COLOR;
  delete tourEnv.PULLBOARD_MODEL;
  const repos = [];
  for (let run = 1; run <= 2; run += 1) {
    const shown = await runFixtureChildAsync(process.execPath, [BIN, 'tour'], { cwd: box.dir, env: tourEnv, encoding: 'utf8' });
    assert.equal(shown.status, 0, `run ${run}: ${shown.stdout}${shown.stderr}`);
    repos.push(/Look around: cd (\S+) && pullboard log/u.exec(shown.stdout)[1]);
  }
  const registry = JSON.parse(readFileSync(join(home, 'projects.json'), 'utf8')).projects;
  assert.deepEqual(registry.map((entry) => entry.root), [real, repos[1]], 'the list holds the real project and the demo of the second run, and no other');
  const state = JSON.parse(readFileSync(join(home, 'relay-machine', 'state.json'), 'utf8'));
  assert.deepEqual(state.approvals, [], 'no relay link request or approval was made for either demo');
});

test('cli.journeys-fact-e2e-tour.the-tour-finishes-when-an-agent: clause 1: the tour finishes when an agent session runs it [N10]', async t => {
  // A caller in Claude Code or Codex runs the tour; the scripted seats must not inherit the caller's session, so the
  // reject-and-rework still verifies (#952). The caller's own digest must appear on no item the tour moved.
  const runs = [['CLAUDE_CODE_SESSION_ID', 'caller-session-952'], ['CODEX_THREAD_ID', 'caller-thread-952']].map(([name, value]) => {
    const box = sandbox();
    // The Claude Code caller has runners.localWake on and the Codex caller leaves it off, so one tour per switch state proves the demo carries it only when on [C7,#10418].
    const wake = name === 'CLAUDE_CODE_SESSION_ID';
    if (wake) fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { 'runners.localWake': true });
    const callerEnv = { ...box.env, TMPDIR: box.dir, CLAUDECODE: '1', [name]: value };
    delete callerEnv.PULLBOARD_MODEL;
    delete callerEnv.NO_COLOR;
    delete callerEnv.FORCE_COLOR;
    return { name, value, wake, shown: runFixtureChildAsync(process.execPath, [BIN, 'tour'], { cwd: box.dir, env: callerEnv }) };
  });
  for (const { name, value, wake, shown } of await Promise.all(runs.map(async run => ({ ...run, shown: await run.shown })))) {
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
    t.diagnostic(`offer-to-claim ms (runners.localWake ${wake ? 'on' : 'off'}, ${name}): ${JSON.stringify(offerToClaimMs(repo))}`);
    const settings = join(dirname(repo), '.pullboard-machine', 'settings.json');
    const demo = existsSync(settings) ? JSON.parse(readFileSync(settings, 'utf8')) : {};
    assert.equal(demo['runners.localWake'], wake ? true : undefined, `${name}: the demo settings carry the caller's runners.localWake only when it is on`);
  }
});
});
