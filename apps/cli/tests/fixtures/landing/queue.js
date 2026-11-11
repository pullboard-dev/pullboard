import { landingPorts } from './ports.js';
import { createE2eHelpers } from '../e2e.js';
import { fixtureMachineSettings } from '../testkit.js';
import { HOST } from '../runner/ssh.js';
import { installSshStandIn } from '../runner/ssh.js';
import { checkAtCommit } from '../../../../runner/index.js';
import { fileURLToPath } from 'node:url';
const candidateWorkerFile = fileURLToPath(new URL('../../../../lib/src/io/landing/candidate.js', import.meta.url));
/** Public, real-Git landing contention fixture; no private drill data is used [B3,R3,Q1,Q2,E8]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { unlinkSync } from 'node:fs';
import {
  basename,
  dirname,
  join,
} from 'node:path';
import { mainAuditKey } from '../../../../../packages/gate/index.js';
import { readMainAudit } from '../../../../../packages/gate/index.js';
import { readAuditJob } from '../main/audit/project.js';
import {
  readGateReceipt,
  receiptStore,
} from '../../../../../packages/gate/index.js';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { invalidateGitFacts } from '../../../../../packages/git/index.js';
import { runLandingBatch } from '../../../../../packages/landing/index.js';
import { assertLandingLease } from '../../../../../packages/store/index.js';
import { LANDING_LEASE_MS } from '../../../../../packages/store/index.js';

/** Run an ordinary fixture command and retain its full refusal on failure. */
function run(box, root, ...args) {
  const result = box.run(root, ...args);
  const observation = result.code !== 0 && result.err.includes('[LAND_ITEM_MOVED]')
    ? readBoard(box, board => store.landingBatches(board).map(batch => ({
      id: batch.id, state: batch.state,
      items: batch.items.map(entry => {
        const item = store.getItem(board, entry.id);
        return { entry, status: item.item_status, commit: item.item_commit,
          checked: store.checkedLandingCommit(board, item),
          accepted: store.acceptedVerdict(board, item),
          sourceAdvance: board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?')
            .get(`item_source_advance:${entry.id}`)?.meta_value ?? null };
      }),
    }))) : null;
  assert.equal(result.code, 0, `${args.join(' ')}: ${result.err}\n${result.out}${observation ? '\npublication observation: ' + JSON.stringify(observation) : ''}`);
  return result.out;
}

/** Read the real board, always closing its SQLite handle. */
function readBoard(box, action) {
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
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

/** Run a setup add with a private runner so its baseline is measured before the claim. */
function withBaselineRunner(box, action) {
  const bin = join(box.dir, 'baseline-bin'), worker = join(box.dir, 'baseline-worker'), home = join(box.dir, 'baseline-home');
  const machine = box.env.PULLBOARD_MACHINE_HOME;
  for (const path of [bin, worker, home, join(home, '.pullboard'), machine]) mkdirSync(path, { recursive: true });
  installSshStandIn({ bin, worker, home, machineHome: join(home, '.pullboard'), requests: join(box.dir, 'baseline-ssh.jsonl'), nodeCommand: process.execPath });
  const settings = join(machine, 'settings.json'), previous = existsSync(settings) ? readFileSync(settings) : null;
  const previousPath = box.env.PATH;
  box.env.PATH = `${bin}:${previousPath}`;
  fixtureMachineSettings(machine, { gateSlots: 0, browserSlots: 0, gate: { browserFreeChecks: true, timingRunner: false },
    runners: [{ host: HOST, slots: 1, browser: 0, node: process.execPath, root: join(home, '.pullboard-runner') }] });
  try { return action(); }
  finally {
    box.env.PATH = previousPath;
    if (previous === null) unlinkSync(settings); else writeFileSync(settings, previous);
  }
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
    const added = JSON.parse(withBaselineRunner(box, () => run(box, box.repo, 'add', 'web', `Queue item ${number}`, '--specs', 'G1',
      '--criterion', `queue item ${number} works`, '--check', `grep -qx works ${file}`, '--route', 'strong', '--wait', '--brief',
      `Files: ${file}\nTest: the queued fixture check requires ${file} to contain exactly works`, '--json')));
    const id = added.item.item_id;
    assert.ok(added.item.item_check_baseline, 'the ordinary add observes its actual setup baseline');
    assert.notEqual(added.item.item_check_baseline.result, 'pending', 'no detached setup baseline remains to publish during claim');
    run(box, root, 'fact', String(id), 'diagnosis', `Files: ${file} Change: build the queued landing fixture file Test case: a suspended landing owner is fenced before the queued adopter runs`);
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

/** The shared bounded observation wait; this fixture's sandboxes are owned by its callers. */
const LEASE_WAIT = createE2eHelpers();

/** Use a real public lease and board for bounded internal boundary controls, never a fabricated grant. */
async function withFixtureLease(box, branch, action) {
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  const request = { agentId: 'coordinator', action: 'request', branch, token: randomUUID(), pid: process.pid };
  let fence;
  try {
    // A real lander may still hold the lease while it finishes; queue behind it and wait for the grant (#3137).
    const grant = await LEASE_WAIT.waitFor(() => { // budget: hang ceiling for the fixture's own landers releasing, not a speed target.
      const observed = store.landingLeaseMove(board, request);
      return observed.acquired ? observed : null;
    }, 'the fixture landers release the landing lease', 120_000);
    fence = { ...request, generation: grant.generation };
    invalidateGitFacts();
    const check = () => assertLandingLease(board, fence);
    return await action({ root: box.repo, board, fence, owner: 'private-boundary-control', say() {},
      write: async (operation, args) => board.enginePorts.store[operation](board, ...args), checkLease: async () => { check(); invalidateGitFacts(); }, checkLeaseNow: check });
  } finally {
    store.landingLeaseMove(board, { ...(fence ?? request), action: 'release' });
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
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    await runLandingBatch({ landingPorts, checkAtCommit, candidateWorkerFile, root: box.repo, board, config: { ...explicit, flakes: { quarantine: false } }, dryRun: true });
    assert.equal(board.quarantineEnabled(), false, 'explicit config and no-fence dry-run callers retain their behavior');
  } finally { store.closeBoard(board); }
}

/** Recognize only this board's recorded exact source composition, never a temporary-path prefix alone. */
function sourceAdvancePolicyCall(box, batches, record, board, audits) {
  const directory = join(box.repo, '.git', 'pullboard', 'source-advances');
  if (!existsSync(directory)) return false;
  const matches = readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/u.test(name))
    .map(name => ({ key: name.slice(0, -5), job: readMainAudit(join(directory, name)) }))
    .filter(({ job }) => job?.directory === record.cwd);
  if (!matches.length) return false;
  assert.equal(matches.length, 1, 'a gate root binds exactly one native source-advance job');
  const { key, job } = matches[0];
  const entry = batches.flatMap(batch => batch.items).find(item => item.id === job.item);
  assert.ok(entry, 'the source advance belongs to an item in these exact landed batches');
  assert.equal(job.version, 1);
  assert.equal(job.basis?.version, 1);
  assert.equal(job.basis.board, board);
  assert.equal(job.basis.submitted, entry.commit);
  assert.ok(batches.some(batch => batch.tip === job.basis.trunk), 'only a genuinely landed policy tip is independent');
  assert.equal(key, createHash('sha256').update(JSON.stringify([board, job.item, job.basis])).digest('hex'));
  assert.ok(['running', 'advanced', 'returned', 'incomplete'].includes(job.state), 'the native worker recorded the composition before its gate');
  assert.match(job.head, /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);
  assert.equal(box.git(box.repo, 'rev-parse', job.head + '^1'), job.basis.inputHead);
  assert.equal(box.git(box.repo, 'rev-parse', job.head + '^2'), job.basis.trunk);
  assert.equal(box.git(box.repo, 'rev-parse', job.head + '^{tree}'), job.tree);
  for (const id of job.receiptIds ?? []) {
    const receipt = readGateReceipt(receiptStore(box.repo), id);
    assert.ok(receipt, 'a closed source advance retains each genuine phase receipt');
    assert.equal(receipt.head, job.head);
    assert.equal(receipt.tree, job.tree);
    assert.equal(receipt.kind, 'submit');
  }
  const identity = `source-advance:${key}`;
  assert.equal(audits.has(identity), false, 'a duplicate audit invocation cannot disappear from the policy count');
  audits.add(identity);
  assert.deepEqual(record.args, ['--new-policy'], 'the exact native source advance uses its accepted policy');
  return true;
}

/** Close only a recorded native wake, never infer completion from current process absence. */
export async function closePolicySourceWake(box, helpers, expectedGeneration) {
  const directory = join(box.repo, '.git', 'pullboard', 'source-advances');
  assert.ok(Number.isSafeInteger(expectedGeneration) && expectedGeneration > 0);
  return helpers.waitFor(() => { // Budget: 120s runaway ceiling for actual native source publication and owner drain.
    const wake = readMainAudit(join(directory, 'wake.json'));
    const settled = readMainAudit(join(directory, 'settled.json'));
    return !existsSync(join(directory, 'owner.json')) && settled?.generation >= expectedGeneration
      && settled.generation === wake?.generation ? settled : false;
  }, 'the exact native source wake closes before private branch repair or cleanup', 120_000);
}

/** Count every foreground invocation; exclude only independently source-bound native work for these batches. */
function landingPolicyCalls(box, batches, records) {
  const roots = new Set(batches.map(batch => batch.root));
  const directory = join(box.repo, '.git', 'pullboard', 'main-audits');
  const board = readBoard(box, store.boardId);
  const calls = [];
  const audits = new Set();
  for (const record of records) {
    if (roots.has(record.cwd)) { calls.push(record.args); continue; }
    if (sourceAdvancePolicyCall(box, batches, record, board, audits)) continue;
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
  const sandbox = helpers.sandbox({ declareFamilies: policyAfterFirst });
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
    // Budget: the suspended-parent control holds beyond the real landing lease (LANDING_LEASE_MS) so only the guardian ends it; lease plus 80s is a runaway ceiling, not a speed target.
    `if (fs.existsSync(arm)) { fs.writeFileSync(gatePid, String(process.pid)); fs.writeFileSync(entered, process.cwd()); const end = Date.now() + ${suspendParent ? LANDING_LEASE_MS + 80_000 : 20000}; while (!fs.existsSync(release) && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20); assert.ok(fs.existsSync(release), 'owning test releases the gate'); }`,
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
  // Advance a real gate input after submission so the merged batch needs a fresh gate.
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web/queue-3.txt'), 'works\n');
  box.git(box.repo, 'add', 'web/queue-3.txt');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: advance queue fixture main');
  // Main moves after the submits, so landing cannot reuse a submit receipt proven on the older base (BASE_MOVED) and must run its real gate.
  const moved = helpers.commitFile(box, box.repo, 'web/moved.txt', 'moved\n', 'chore: move main after the submit receipts');
  assert.equal(moved.status, 0, moved.stderr);
  box.git(box.repo, 'push', '-q', 'origin', 'main');
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
  await helpers.waitFor(() => existsSync(entered) || first.exitCode !== null, 'first landing reaches its real gate', 60_000); // budget: ceiling for a loaded runner starting the first landing CLI; no speed target.
  assert.ok(existsSync(entered), first.failure ?? first.stderrText);
  const firstBatch = readBoard(box, board => store.landingBatches(board).at(-1));
  assert.equal(firstBatch.state, 'gating');
  assert.equal(readFileSync(entered, 'utf8'), firstBatch.root, 'the held gate belongs to the foreground batch');
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
        suspendParent ? LANDING_LEASE_MS + 60_000 : 8_000); // Budget: actual lease expiry (LANDING_LEASE_MS) plus owned-process drain, stretched for a loaded runner; not a speed threshold.
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
    // A plain main change withdraws the stale verdict and returns the item to its lane, so the waiter exits 0 [B3,C7].
    assert.equal(results[1].code, 0, `the queued command returns the now-stale acceptance to its lane: ${results[1].failure ?? ''}`);
    assert.match(second.stdoutText + second.stderrText, /STALE_VERDICT #\d+ reopened to its lane/u);
    assert.equal(readBoard(box, board => store.getItem(board, entries[0].id).item_status), 'open', 'the stale item left verified for its lane');
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
    if (audit) {
      assert.throws(() => landingPolicyCalls(box, batches, [...records, audit]), /duplicate audit invocation/u);
      assert.throws(() => landingPolicyCalls(box, batches, records.map(record => record === audit ? { ...record, args: [] } : record)),
        /accepted.*policy|accepted new policy/u, 'a bound background root never excuses the wrong policy');
    }
    t.diagnostic(`policy journal: ${calls.length} foreground invocations; ${records.length - calls.length} independently bound audit invocations`);
    const directory = join(box.repo, '.git', 'pullboard', 'source-advances');
    if (existsSync(directory) && readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/u.test(name))
      .some(name => records.some(record => record.cwd === readMainAudit(join(directory, name))?.directory))) {
      const wake = readMainAudit(join(directory, 'wake.json'));
      await closePolicySourceWake(box, helpers, wake?.generation);
    }
  }
  for (const entry of entries) {
    assert.equal(readFileSync(join(box.repo, `web/queue-${entry.id}.txt`), 'utf8'), 'works\n');
    assert.equal(readBoard(box, board => board.db.prepare("SELECT COUNT(*) AS n FROM event WHERE event_kind='merged' AND item_id=?").get(entry.id).n), 1);
  }
  if (policyAfterFirst) await repairedPolicyControls(box, batches[0]);
}

/** Exercise a real independently closed source-advance gate before the second foreground landing [Q1,B3]. */
export async function sourceAdvancePolicyCase(t, helpers) {
  const sandbox = helpers.sandbox({ declareFamilies: true });
  const callsFile = join(sandbox.dir, 'source-policy-calls.jsonl');
  const gate = join(sandbox.dir, 'source-policy-gate.cjs');
  const entered = join(sandbox.dir, 'source-policy-entered');
  const released = join(sandbox.dir, 'source-policy-released');
  t.after(() => writeFileSync(released, 'released'));
  writeFileSync(gate, [
    "const fs = require('node:fs'); const assert = require('node:assert/strict');",
    `fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}) + '\\n');`,
    `if (process.argv.includes('--new-policy') && !fs.existsSync(${JSON.stringify(released)})) { fs.writeFileSync(${JSON.stringify(entered)}, process.cwd()); const end = Date.now()+20000; while (!fs.existsSync(${JSON.stringify(released)}) && Date.now()<end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20); assert.ok(fs.existsSync(${JSON.stringify(released)}), 'owning test releases actual source gate'); }`,
    "for (const name of (fs.existsSync('web') ? fs.readdirSync('web') : []).filter(name => /^queue-\\d+\\.txt$/.test(name))) assert.match(fs.readFileSync('web/'+name,'utf8'), /^works/);",
    "console.log('TAP version 13\\nok 1 - actual source composition preserves queue behavior\\n1..1\\n# tests 1\\n# pass 1\\n# fail 0');",
  ].join('\n'));
  const box = helpers.project(`node ${JSON.stringify(gate)}`, sandbox);
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  config.lanes.web.owns.push('pullboard.json');
  writeFileSync(configFile, JSON.stringify(config, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: assign private source policy ownership');
  const remote = join(box.dir, 'source-policy-origin.git');
  box.git(box.dir, 'init', '-q', '--bare', remote);
  box.git(box.repo, 'remote', 'add', 'origin', remote);
  box.git(box.repo, 'push', '-q', '-u', 'origin', 'main');
  const entries = acceptedPair(helpers, box, false, true);
  writeFileSync(callsFile, '');
  const directory = join(box.repo, '.git', 'pullboard', 'source-advances');
  const wakeFile = join(directory, 'wake.json');
  const expectedGeneration = (readMainAudit(wakeFile)?.generation ?? 0) + 1;
  run(box, box.repo, 'land', '--max', '1');
  // The actual first landing must schedule this worker; no second nudge can consume its expected generation.
  await helpers.waitFor(() => existsSync(entered), 'the actual new-policy source gate enters');
  const liveOwner = readMainAudit(join(directory, 'owner.json'));
  assert.ok(Number.isSafeInteger(liveOwner?.pid), 'the held source gate has a real native worker owner');
  const enteredRoot = readFileSync(entered, 'utf8');
  assert.ok(readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/u.test(name))
    .some(name => readMainAudit(join(directory, name))?.directory === enteredRoot), 'the held gate belongs to a recorded source job');
  writeFileSync(released, 'released');
  const sourceJob = await helpers.waitFor(() => { // Budget: 120s runaway ceiling for an actual detached native gate and closed wake.
    const done = readMainAudit(join(directory, 'settled.json'));
    if (existsSync(join(directory, 'owner.json')) || !(done?.generation >= expectedGeneration)) return false;
    return readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/u.test(name))
      .map(name => readMainAudit(join(directory, name)))
      .find(job => job.item === entries[0].id && job.state === 'advanced' && job.receiptIds?.length);
  }, 'the genuine source-advance gate closes its expected generation', 120_000);
  const finalGeneration = (readMainAudit(wakeFile)?.generation ?? 0) + 1;
  run(box, box.repo, 'land', '--max', '1');
  await closePolicySourceWake(box, helpers, finalGeneration);
  const batches = readBoard(box, board => store.landingBatches(board).filter(batch => batch.state === 'landed'));
  assert.equal(batches.length, 2);
  const records = readFileSync(callsFile, 'utf8').trim().split(/\r?\n/u).map(line => JSON.parse(line));
  const foreground = landingPolicyCalls(box, batches, records);
  assert.deepEqual(foreground, [[], ['--new-policy']]);
  const background = records.filter(record => !batches.some(batch => batch.root === record.cwd));
  assert.ok(background.length > 0, 'at least one actual independent native gate was executed');
  assert.throws(() => landingPolicyCalls(box, batches, [...records, background[0]]), /duplicate audit invocation/u);
  assert.throws(() => landingPolicyCalls(box, batches, records.map(record => record === background[0] ? { ...record, args: [] } : record)), /accepted policy/u);
  assert.throws(() => landingPolicyCalls(box, batches, [...records, { cwd: join(box.dir, 'unbound-source'), args: ['--new-policy'] }]), /unknown gate root/u);
  await repairedPolicyControls(box, batches[0]);
  t.diagnostic(JSON.stringify({ liveOwner, finalGeneration, foreground: foreground.length, independentlyBound: background.length,
    expectedGeneration, items: entries.map(entry => entry.id), policyTip: batches[0].tip,
    sourceJob: { item: sourceJob.item, state: sourceJob.state, head: sourceJob.head, tree: sourceJob.tree,
      basis: sourceJob.basis, receiptIds: sourceJob.receiptIds } }));
}
