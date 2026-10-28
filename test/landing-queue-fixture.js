import { landingPorts } from './landing-ports-fixture.js';
import { checkAtCommit } from '../src/runner-private-check.js';
import { fileURLToPath } from 'node:url';
const candidateWorkerFile = fileURLToPath(new URL('../bin/landing-candidate.js', import.meta.url));
/** Public, real-Git landing contention fixture; no private drill data is used [B3,R3,Q1,Q2,E8]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { mainAuditKey } from '../src/main-audit-state.js';
import { readAuditJob } from './main-audit-project.js';
import {
  readGateReceipt,
  receiptStore,
} from '../src/gate-run-receipt.js';
import * as store from '../src/board.js';
import { invalidateGitFacts } from '../src/git.js';
import { runLandingBatch } from '../src/land.js';
import { assertLandingLease } from '../src/landing-lease.js';

/** Run an ordinary fixture command and retain its full refusal on failure. */
function run(box, root, ...args) {
  const result = box.run(root, ...args);
  assert.equal(result.code, 0, `${args.join(' ')}: ${result.err}\n${result.out}`);
  return result.out;
}

/** Read the real board, always closing its SQLite handle. */
function readBoard(box, action) {
  const board = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try { return action(board); }
  finally { store.closeBoard(board); }
}

/** An exited zombie cannot execute a gate; observe only the fixture's recorded PID. */
function running(pid) {
  try { process.kill(pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  const state = spawnSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  if (state.status === 1 && !state.stdout?.trim()) return false; // It exited between kill(0) and ps.
  assert.equal(state.status, 0, 'the fixture can observe its own process state');
  // Unknown or transient kernel states remain running until a later observation proves exit.
  return !state.stdout.trim().startsWith('Z');
}

/** Retain actual states for only this fixture's known PIDs when a custody assertion fails. */
function processObservation(pids) {
  const result = spawnSync('/bin/ps', ['-o', 'pid=,ppid=,pgid=,stat=', '-p', pids.join(',')], { encoding: 'utf8' });
  return { status: result.status, states: result.stdout?.trim() ?? '', error: result.error?.code ?? null };
}

/** Build two independent items and accept the higher id first through actual CLI checks. */
function acceptedPair(helpers, box, staleAfterFirst, policyAfterFirst) {
  const entries = [1, 2].map(number => {
    const root = join(box.dir, `queue-build-${number}`);
    box.git(box.repo, 'worktree', 'add', '-q', '-b', `web/queue-${number}`, root, 'main');
    run(box, root, 'join', 'web');
    const file = `web/queue-${number}.txt`;
    const added = JSON.parse(run(box, box.repo, 'add', 'web', `Queue item ${number}`, '--specs', 'G1',
      '--criterion', `queue item ${number} works`, '--check', `grep -qx works ${file}`, '--json'));
    const id = added.item.item_id;
    run(box, root, 'claim', String(id));
    if (number === 2 && staleAfterFirst) {
      // The first-to-land item changes the lower id's checked path on an independent branch.
      mkdirSync(join(root, 'web'), { recursive: true });
      writeFileSync(join(root, 'web', 'queue-1.txt'), 'works changed\n');
    }
    if (number === 2 && policyAfterFirst) {
      const configPath = join(root, 'pullboard.json');
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      writeFileSync(configPath, JSON.stringify({ ...config, gate: config.gate + ' --new-policy', flakes: { quarantine: true } }, null, 2));
    }
    const commit = helpers.commitFile(box, root, file, 'works\n', 'feat(web): build queue fixture [G1]');
    assert.equal(commit.status, 0, commit.stderr);
    run(box, root, 'submit', String(id));
    return { id, head: box.git(root, 'rev-parse', 'HEAD') };
  });
  for (const entry of [...entries].reverse()) {
    const review = join(box.dir, `queue-review-${entry.id}`);
    box.git(box.repo, 'worktree', 'add', '-q', '--detach', review, entry.head);
    run(box, review, 'join', 'api');
    run(box, review, 'next', '--verify', String(entry.id));
    run(box, review, 'verify', String(entry.id), 'accept', '--note', 'The exact item check passes in this independent private fixture seat.');
  }
  return entries;
}

/** Use a real public lease and board for bounded internal boundary controls, never a fabricated grant. */
async function withFixtureLease(box, branch, action) {
  const board = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  const request = { agentId: 'coordinator', action: 'request', branch, token: randomUUID(), pid: process.pid };
  let fence;
  try {
    const grant = store.landingLeaseMove(board, request);
    assert.equal(grant.acquired, true, 'the private fixture has no remaining lander');
    fence = { ...request, generation: grant.generation };
    invalidateGitFacts();
    const check = () => assertLandingLease(board, fence);
    return await action({ root: box.repo, board, fence, owner: 'private-boundary-control', say() {},
      write: async (operation, args) => store[operation](board, ...args), checkLease: async () => { check(); invalidateGitFacts(); }, checkLeaseNow: check });
  } finally {
    if (fence) store.landingLeaseMove(board, { ...fence, action: 'release' });
    store.closeBoard(board);
  }
}

/** A lease for one branch cannot follow a same-commit branch switch or adopt another branch's batch. */
async function interruptedBranchControls(box) {
  const before = box.git(box.repo, 'rev-parse', 'HEAD');
  try {
    await withFixtureLease(box, 'refs/heads/main', async options => {
      box.git(box.repo, 'switch', '-q', '-c', 'alternate-trunk');
      invalidateGitFacts();
      assert.equal(box.git(box.repo, 'rev-parse', 'HEAD'), before, 'only the actual branch identity changes');
      await assert.rejects(runLandingBatch({ landingPorts, checkAtCommit, candidateWorkerFile, ...options, adopt: true }), error => error.code === 'LAND_LEASE_LOST');
    });
    await withFixtureLease(box, 'refs/heads/alternate-trunk', async options => {
      await assert.rejects(runLandingBatch({ landingPorts, checkAtCommit, candidateWorkerFile, ...options, adopt: true }), error => error.code === 'LAND_LEASE_LOST');
      assert.equal(store.landingBatches(options.board).length, 1, 'a branch mismatch creates no replacement batch');
    });
  } finally { box.git(box.repo, 'switch', '-q', 'main'); invalidateGitFacts(); }
  assert.equal(box.git(box.repo, 'rev-parse', 'main'), before);
}

/** Resolve absent config from the repaired accepted tip; explicit direct-call config remains supported. */
async function repairedPolicyControls(box, batch) {
  box.git(box.repo, 'reset', '--hard', batch.base); // Only this private fixture simulates receipts preceding local Git repair.
  try {
    box.git(box.repo, 'switch', '-q', '-c', 'alternate-repair');
    await withFixtureLease(box, 'refs/heads/alternate-repair', async options => {
      await assert.rejects(runLandingBatch({ landingPorts, checkAtCommit, candidateWorkerFile, ...options }), error => error.code === 'LAND_LEASE_LOST');
      assert.equal(box.git(box.repo, 'rev-parse', 'HEAD'), batch.base, 'a foreign-branch recorded repair never moves Git before refusing');
    });
  } finally { box.git(box.repo, 'switch', '-q', 'main'); invalidateGitFacts(); }
  await withFixtureLease(box, 'refs/heads/main', async options => {
    const count = store.landingBatches(options.board).length;
    const result = await runLandingBatch({ landingPorts, checkAtCommit, candidateWorkerFile, ...options });
    assert.equal(result.batch, null, 'all items were already durably landed');
    assert.equal(box.git(box.repo, 'rev-parse', 'main'), batch.tip, 'the recorded landing repairs local Git');
    assert.equal(options.board.quarantineEnabled(), true, 'policy comes from the repaired accepted tip, not its old base');
    assert.equal(store.landingBatches(options.board).length, count, 'repair does not invent another batch');
  });
  const explicit = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  const board = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    await runLandingBatch({ landingPorts, checkAtCommit, candidateWorkerFile, root: box.repo, board, config: { ...explicit, flakes: { quarantine: false } }, dryRun: true });
    assert.equal(board.quarantineEnabled(), false, 'explicit config and no-fence dry-run callers retain their behavior');
  } finally { store.closeBoard(board); }
}

/** Count every foreground invocation; exclude only an independently source-bound audit of these batches. */
function landingPolicyCalls(box, batches, records) {
  const roots = new Set(batches.map(batch => batch.root));
  const directory = join(box.repo, '.git', 'pullboard', 'main-audits');
  const board = readBoard(box, store.boardId);
  const calls = [];
  const audits = new Set();
  for (const record of records) {
    if (roots.has(record.cwd)) { calls.push(record.args); continue; }
    assert.equal(dirname(record.cwd), directory, 'an unknown gate root cannot disappear from the policy count');
    assert.match(basename(record.cwd), /^source-[a-f0-9]{64}$/u);
    const key = basename(record.cwd).slice('source-'.length);
    assert.equal(audits.has(key), false, 'a duplicate audit invocation cannot disappear from the policy count');
    audits.add(key);
    const job = readAuditJob(directory, key);
    const batch = batches.find(candidate => candidate.id === job.batchId);
    assert.ok(batch, 'only an audit of this exact native landed batch is independent of its foreground run');
    assert.equal(job.board, board);
    assert.equal(job.tip, batch.tip);
    assert.equal(job.tree, box.git(box.repo, 'rev-parse', batch.tip + '^{tree}'));
    assert.equal(mainAuditKey(job), key);
    assert.equal(job.version, 1);
    assert.ok(['running', 'measured', 'complete'].includes(job.state), 'the native worker recorded this audit before its gate ran');
    if (job.state === 'running') {
      assert.equal(job.source, record.cwd);
      assert.ok(Number.isSafeInteger(job.controller) && job.controller > 0);
    } else {
      const receipt = readGateReceipt(receiptStore(box.repo), job.receiptId);
      assert.ok(receipt, 'a measured audit retains its actual native receipt');
      assert.equal(receipt.head, job.tip);
      assert.equal(receipt.tree, job.tree);
      assert.equal(receipt.kind, 'land');
      if (receipt.collection) assert.equal(receipt.collection.batchId, job.batchId);
    }
    assert.deepEqual(record.args, ['--new-policy'], 'an observed background audit also uses the accepted new policy');
  }
  return calls;
}

/** Prove named waiting, exclusion and verdict order with two real overlapping land commands. */
export async function landingQueueCase(t, helpers, { staleAfterFirst = false, killParent = false, killGuardian = false, suspendParent = false, policyAfterFirst = false } = {}) {
  const sandbox = helpers.sandbox();
  const arm = join(sandbox.dir, 'landing-armed');
  const entered = join(sandbox.dir, 'landing-entered');
  const release = join(sandbox.dir, 'landing-release');
  const gatePid = join(sandbox.dir, 'landing-gate-pid');
  const gateFile = join(sandbox.dir, 'landing-queue-gate.cjs');
  const policyCalls = join(sandbox.dir, 'landing-policy-calls.jsonl');
  const policyOrigins = join(sandbox.dir, 'landing-policy-origins.jsonl');
  writeFileSync(gateFile, [
    "const fs = require('node:fs'); const assert = require('node:assert/strict');",
    `const [arm,entered,release,gatePid] = ${JSON.stringify([arm, entered, release, gatePid])};`,
    `fs.appendFileSync(${JSON.stringify(policyOrigins)}, JSON.stringify({ pid: process.pid, ppid: process.ppid, cwd: process.cwd(), args: process.argv.slice(2), node: process.version }) + '\\n');`,
    `fs.appendFileSync(${JSON.stringify(policyCalls)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');`,
    ...(suspendParent ? ["if (fs.existsSync(gatePid)) { const old = Number(fs.readFileSync(gatePid,'utf8')); try { process.kill(old,0); throw new Error('the previous landing gate is still running when the successor gate starts'); } catch(error) { if (error.code !== 'ESRCH') throw error; } }"] : []),
    // Budget: the suspended-parent control holds beyond the real 30s lease; 65s is a runaway ceiling, not a speed target.
    `if (fs.existsSync(arm)) { fs.writeFileSync(gatePid, String(process.pid)); fs.writeFileSync(entered, process.cwd()); const end = Date.now() + ${suspendParent ? 65000 : 20000}; while (!fs.existsSync(release) && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20); assert.ok(fs.existsSync(release), 'owning test releases the gate'); }`,
    "const files = fs.existsSync('web') ? fs.readdirSync('web').filter(file => /^queue-\\d+\\.txt$/.test(file)) : [];",
    "for (const file of files) assert.match(fs.readFileSync('web/' + file,'utf8'), /^works/);",
    "console.log('TAP version 13\\nok 1 - landed queue files keep their behavior\\n1..1\\n# tests 1\\n# pass 1\\n# fail 0');",
  ].join('\n'));
  const box = helpers.project(`node ${JSON.stringify(gateFile)}`, sandbox);
  if (policyAfterFirst) {
    const file = join(box.repo, 'pullboard.json');
    const config = JSON.parse(readFileSync(file, 'utf8'));
    config.lanes.web.owns.push('pullboard.json');
    writeFileSync(file, JSON.stringify(config, null, 2));
    box.git(box.repo, 'add', 'pullboard.json');
    box.git(box.repo, 'commit', '-q', '-m', 'chore: assign fixture policy ownership');
  }
  const remote = join(box.dir, 'queue-origin.git');
  box.git(box.dir, 'init', '-q', '--bare', remote);
  box.git(box.repo, 'remote', 'add', 'origin', remote);
  box.git(box.repo, 'push', '-q', '-u', 'origin', 'main');
  const entries = acceptedPair(helpers, box, staleAfterFirst, policyAfterFirst);
  writeFileSync(policyCalls, '');
  const base = box.git(box.repo, 'rev-parse', 'main');
  const children = [];
  t.after(async () => {
    writeFileSync(release, 'released');
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGCONT'); child.kill('SIGTERM'); }
      await child.closed;
    }
  });
  writeFileSync(arm, 'armed');
  box.env.CODEX_THREAD_ID = 'private-landing-queue-session';
  const first = helpers.launch(box, box.repo, process.execPath, [helpers.BIN, 'land', '--max', '1']);
  children.push(first);
  await helpers.waitFor(() => existsSync(entered) || first.exitCode !== null, 'first landing reaches its real gate');
  assert.ok(existsSync(entered), first.failure ?? first.stderrText);
  const firstBatch = readBoard(box, board => store.landingBatches(board).at(-1));
  assert.equal(firstBatch.state, 'gating');
  assert.deepEqual(firstBatch.items.map(entry => entry.id), [entries[1].id], 'verdict order precedes numeric item order');
  if (suspendParent) rmSync(arm); // Only later gates become unblocked; the current one still requires its unreleased marker.
  const second = helpers.launch(box, box.repo, process.execPath, [helpers.BIN, 'land', ...(suspendParent ? ['--adopt'] : ['--max', '1'])]);
  children.push(second);
  await helpers.waitFor(() => /landing waiting: .*held by .*; queued/u.test(second.stdoutText) || second.exitCode !== null,
    'second landing names its holder and queues');
  assert.match(second.stdoutText, /landing waiting: .*held by .*; queued/u, `${second.stdoutText}\n${second.stderrText}`);
  const holder = readBoard(box, board => store.landingLeaseState(board).holder);
  assert.equal(holder.pid, first.pid);
  assert.ok(second.stdoutText.includes(holder.label), 'the queue names the actual durable holder');
  assert.equal(second.exitCode, null, 'the second command stays queued instead of refusing');
  assert.equal(readBoard(box, board => store.landingBatches(board).length), 1, 'the waiter creates no concurrent batch');
  assert.equal(box.git(box.repo, 'rev-parse', 'main'), base, 'neither unfinished gate advances main');
  await helpers.waitFor(() => Date.parse(readBoard(box, board => store.landingLeaseState(board).holder?.until)) > Date.parse(holder.until),
    'the independent parent renews while the worker is blocked inside its real synchronous gate');
  assert.equal(readBoard(box, board => store.landingBatches(board).at(-1).state), 'gating');
  if (killParent || killGuardian || suspendParent) {
    const blockedGatePid = Number(readFileSync(gatePid, 'utf8'));
    assert.ok(Number.isSafeInteger(holder.guardianPid));
    if (killParent) {
      first.kill('SIGKILL'); // Only the CLI dies; its separately grouped guardian owns the blocked gate.
      assert.equal((await first.closed).signal, 'SIGKILL');
    } else if (killGuardian) {
      process.kill(holder.guardianPid, 'SIGKILL'); // This exact PID came from this private command's bound guardian.
    } else first.kill('SIGSTOP'); // Keep IPC connected while the authority owner cannot renew or run its own watchdog.
    try {
      await helpers.waitFor(() => !running(holder.guardianPid) && !running(blockedGatePid), 'the guardian and blocked gate stop without releasing their marker',
        suspendParent ? 45_000 : 8_000); // Budget: actual 30s lease expiry plus owned-process drain; not a speed threshold.
    } catch (error) {
      const batch = readBoard(box, board => store.landingBatches(board).at(-1));
      error.message += '; custody observation: ' + JSON.stringify({ processes: processObservation([first.pid, holder.guardianPid, blockedGatePid, second.pid]),
        firstExit: first.exitCode, secondExit: second.exitCode, batchState: batch.state, revision: batch.revision, releaseExists: existsSync(release) });
      throw error;
    }
    if (suspendParent) {
      const successor = await second.closed;
      assert.equal(successor.code, 0, successor.failure ?? 'the queued adopter lands only after the previous gate is dead');
      assert.equal(existsSync(release), false, 'no test release made the old gate look drained');
      assert.equal(readBoard(box, board => store.landingBatches(board).at(-1).state), 'landed');
      first.kill('SIGCONT');
      assert.equal((await first.closed).code, 1, 'the resumed old holder cannot use its expired generation');
      assert.match(first.stderrText, /\[LAND_LEASE_LOST\]/u, 'the resumed owner reports its typed authority refusal');
      assert.doesNotMatch(first.stderrText, /Error: kill EPERM|internal\/event_target/u, 'an uncaught cleanup error is not lease fencing');
      run(box, box.repo, 'land', '--max', '1');
      assert.equal(readBoard(box, board => store.landingBatches(board).length), 2);
      return;
    }
    if (!killParent) {
      assert.equal((await first.closed).code, 1, 'a surviving authority owner refuses after its worker stops');
      assert.match(first.stderrText, /\[LAND_WORKER\]/u, 'guardian loss reports a typed worker refusal');
      assert.doesNotMatch(first.stderrText, /Error: kill EPERM|internal\/event_target/u, 'an uncaught cleanup error is not guardian fencing');
    }
    assert.equal(existsSync(release), false, 'the owning test did not let the abandoned gate proceed');
    const waiting = await second.closed;
    assert.equal(waiting.code, 1);
    assert.match(second.stderrText, /LAND_ADOPT/u, 'a queued ordinary land preserves explicit interrupted-batch adoption');
    if (killParent) await interruptedBranchControls(box);
    rmSync(arm); // Future gates may run, but removing arm cannot unblock the old gate's release loop.
    const adopted = JSON.parse(run(box, box.repo, 'land', '--adopt', '--json'));
    assert.equal(adopted.batch.id, firstBatch.id);
    assert.deepEqual(adopted.landed, [entries[1].id]);
    run(box, box.repo, 'land', '--max', '1');
    assert.deepEqual(readBoard(box, board => store.landingBatches(board).flatMap(batch => batch.items.map(entry => entry.id))), [entries[1].id, entries[0].id]);
    return;
  }
  writeFileSync(release, 'released');
  const results = await Promise.all(children.map(child => child.closed));
  if (staleAfterFirst) {
    assert.equal(results[0].code, 0, results[0].failure);
    assert.equal(results[1].code, 1, 'the queued command refuses the now-stale acceptance');
    assert.match(second.stderrText, /STALE_VERDICT/u);
    assert.equal(readBoard(box, board => store.landingBatches(board).length), 1, 'a stale waiter starts no batch');
    assert.equal(readBoard(box, board => store.getItem(board, entries[0].id).item_merged_commit), null);
    return;
  }
  for (const result of results) assert.deepEqual({ code: result.code, signal: result.signal }, { code: 0, signal: null }, result.failure ?? 'land succeeds');
  const batches = readBoard(box, store.landingBatches);
  assert.equal(batches.length, 2);
  assert.ok(batches.every(batch => batch.state === 'landed'));
  assert.deepEqual(batches.flatMap(batch => batch.items.map(entry => entry.id)), [entries[1].id, entries[0].id]);
  assert.equal(batches[1].base, batches[0].tip, 'the waiter selects against the completed first landing');
  assert.equal(box.git(box.repo, 'rev-parse', 'main'), batches[1].tip);
  if (policyAfterFirst) {
    const records = readFileSync(policyCalls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const calls = landingPolicyCalls(box, batches, records);
    if (calls.length !== 2) t.diagnostic('policy-call-origins ' + readFileSync(policyOrigins, 'utf8'));
    assert.deepEqual(calls, [[], ['--new-policy']], 'the waiter uses the policy accepted while it queued');
    // These synthetic extra records test the fixture oracle, never claim another real gate ran.
    assert.throws(() => landingPolicyCalls(box, batches, [{ cwd: join(box.dir, 'unbound-gate'), args: [] }]),
      /unknown gate root/u);
    assert.notDeepEqual(landingPolicyCalls(box, batches, [...records, { cwd: batches[0].root, args: [] }]),
      [[], ['--new-policy']], 'an extra foreground gate remains a failure of the original oracle');
    const audit = records.find(record => !batches.some(batch => batch.root === record.cwd));
    if (audit) assert.throws(() => landingPolicyCalls(box, batches, [...records, audit]), /duplicate audit invocation/u);
    t.diagnostic(`policy journal: ${calls.length} foreground invocations; ${records.length - calls.length} independently bound audit invocations`);
  }
  for (const entry of entries) {
    assert.equal(readFileSync(join(box.repo, `web/queue-${entry.id}.txt`), 'utf8'), 'works\n');
    assert.equal(readBoard(box, board => board.db.prepare("SELECT COUNT(*) AS n FROM event WHERE event_kind='merged' AND item_id=?").get(entry.id).n), 1);
  }
  if (policyAfterFirst) await repairedPolicyControls(box, batches[0]);
}
