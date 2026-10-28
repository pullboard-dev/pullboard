import {
  planMainAudit,
  measuredAuditCoverage,
  retainGreenAudit,
  retainAuditCadence,
  lastGreenAudit,
} from './main-audit-economics.js';
import {
  scheduleMainAudit,
} from './main-audit-scheduler.js';
/** Finite exact-source main audits, one native admitted run at a time [C7,H16]. */
import {
  execFileSync,
} from 'node:child_process';
import { gitExecFileSync } from './git-adapter.js';
import {
  createHash,
} from 'node:crypto';
import {
  mkdirSync,
} from 'node:fs';
import {
  existsSync,
} from 'node:fs';
import {
  readFileSync,
} from 'node:fs';
import {
  rmSync,
} from 'node:fs';
import {
  writeFileSync,
} from 'node:fs';
import {
  join,
} from 'node:path';
import * as store from './board.js';
import {
  codeIsFromMain,
} from './git.js';
import {
  gitChildEnv,
} from './git.js';
import {
  repoInfo,
} from './git.js';
import {
  policyAt,
} from './trusted-policy-read.js';
import {
  runGate,
} from './gate.js';
import {
  readGateReceipt,
} from './gate-run-receipt.js';
import {
  receiptStore,
} from './gate-run-receipt.js';
import {
  laneOf,
} from './lanes.js';
import {
  withFileLock,
} from './relay-outbox-guard.js';
import {
  mainAuditDirectory,
} from './main-audit-state.js';
import {
  mainAuditKey,
} from './main-audit-state.js';
import {
  readMainAudit,
} from './main-audit-state.js';
import {
  saveMainAudit,
} from './main-audit-state.js';

/** Run Git with the same sanitized repository environment as ordinary native code. */
function git(root, args, encoding = 'utf8') {
  return gitExecFileSync(args, { cwd: root, env: gitChildEnv(root), encoding, stdio: ['ignore', 'pipe', 'pipe'] });
}
/** Read native history without retaining an open board across locks, admission or execution. */
function readBoard(info, action) {
  const board = store.openBoardForRead(join(info.commonDir, 'pullboard', 'board.sqlite'));
  if (!board) throw new Error('main audit board is unavailable');
  try { return action(board); } finally { store.closeBoard(board); }
}
/** Bound ordinary native/relay writes retain exact session and origin receipt validation. */
function writer(root, { context, ordered, withBoard }) {
  const io = { cwd: root, say() {}, err() {}, stderr: { write() {} } };
  const ctx = context(io);
  return (operation, args) => withBoard(ctx, board => ordered(ctx, board, operation, args));
}
/** Identify the actual owning process, never an expiry-based permission to steal a controller. */
function processStart(pid) {
  try { return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 1000 }).trim() || null; }
  catch { return null; }
}
/** Unknown PID/group inspection is live; a surviving owned group prevents replacement after parent death. */
function ownerLive(owner) {
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string'
    || owner.started !== null && typeof owner.started !== 'string') throw new Error('invalid main audit owner');
  try {
    process.kill(owner.pid, 0);
    const current = processStart(owner.pid);
    // A known changed OS start identity proves PID reuse; never signal the unrelated new process.
    return !current || !owner.started || current === owner.started;
  } catch (error) { if (error.code !== 'ESRCH') return true; }
  try {
    return execFileSync('/bin/ps', ['-axo', 'pgid='], { encoding: 'utf8', timeout: 1000 })
      .split('\n').some(value => Number(value.trim()) === owner.pid);
  } catch { return true; }
}
/** Build obligations only from genuinely landed receipts whose tip is on actual local main. */
function snapshot(root, info, activation) {
  return readBoard(info, board => {
    const boardId = store.boardId(board);
    if (activation.board !== boardId) throw new Error('main audit activation belongs to another board');
    const states = new Map(), jobs = new Map();
    const rows = board.db.prepare("SELECT event_id,event_detail FROM event WHERE event_kind='landing_batch' ORDER BY event_id").all();
    for (const row of rows) {
      const batch = JSON.parse(row.event_detail).batch;
      const previous = states.get(batch.id);
      states.set(batch.id, batch.state);
      if (row.event_id <= activation.afterEventId || batch.state !== 'landed' || previous === 'landed') continue;
      if (!/^[a-zA-Z0-9_-]{1,80}$/u.test(batch.id ?? '') || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(batch.tip ?? '')) throw new Error('invalid native landing identity');
      try { git(root, ['merge-base', '--is-ancestor', batch.tip, 'main']); }
      catch { continue; } // Recorded finish before real FF remains discoverable on the next nudge.
      const tree = git(root, ['rev-parse', `${batch.tip}^{tree}`]).trim();
      const job = { version: 1, board: boardId, batchId: batch.id, tip: batch.tip, tree,
        landedEventId: row.event_id, branch: batch.branch, base: batch.base,
        items: batch.items.map(entry => ({ id: entry.id, lane: store.getItem(board, entry.id).item_lane })) };
      jobs.set(mainAuditKey(job), job);
    }
    return [...jobs.values()];
  });
}
/** Publish one ordinary coordinator notice for an incomplete job; failures retain the need to notify. */
async function notifyIncomplete(file, job, reason, write) {
  const saved = readMainAudit(file) ?? job;
  if (saved.noticeRecorded) return;
  const text = `Main audit ${job.batchId} at ${job.tip.slice(0, 12)} is incomplete: ${String(reason).slice(0, 180)}. Inspect ${file}`;
  const itemId = job.items[0]?.id;
  if (!itemId) throw new Error('main audit notice has no native landed item');
  await write('appendFact', [itemId, { agentId: 'coordinator', kind: 'measurement', text }]);
  saveMainAudit(file, { ...saved, noticeRecorded: true });
}
/** Route every file and named assertion using the normal existing defect operation. */
async function routeFailures(source, job, receipt, config, write, sinceEventId) {
  const files = [...new Set(receipt.failures.map(failure => failure.file))];
  for (const file of files) {
    const bytes = git(source, ['show', `${job.tip}:${file}`], null);
    const blob = git(source, ['rev-parse', `${job.tip}:${file}`]).trim();
    let trunkBlob = null;
    try { trunkBlob = git(source, ['rev-parse', `${job.base}:${file}`]).trim(); } catch { /* A new file has no parent blob. */ }
    const owner = laneOf(config, file);
    const lane = owner === 'coordinator' ? job.items[0]?.lane : owner;
    if (!lane) throw new Error(`main audit has no legitimate repair lane for ${file}`);
    const names = [...new Set(receipt.failures.filter(failure => failure.file === file).map(failure => failure.name))];
    // Existing native operation's bounded names limit is authoritative; oversized routing remains incomplete.
    const defect = await write('recordLandingTestDefect', [{ agentId: 'coordinator', test: file,
      hash: createHash('sha256').update(bytes).digest('hex'), blob, trunkBlob, names,
      lane, batchId: job.batchId, branch: job.branch, requireOpen: true, auditSinceEventId: sinceEventId }]);
    // Native routing must return an actual outstanding repair, not a previously closed same-blob item.
    if (!Number.isSafeInteger(defect?.item) || !names.every(name => defect.names?.includes(name))
      || !readBoard(repoInfo(source), board => ['open', 'claimed', 'submitted'].includes(store.getItem(board, defect.item).item_status))) {
      throw new Error(`main audit repair route is not open for ${file}`);
    }
  }
  if (!receipt.green && !files.length) throw new Error('red main audit has no named failing file; not complete');
}
/** Run or finish routing one job; a durable complete receipt avoids rerunning an already observed suite. */
async function audit(root, directory, job, write, options, testValueServices, executionServices) {
  const key = mainAuditKey(job) + (options.forceFull ? `-release-${options.runId}` : ''), file = join(directory, `${key}.json`);
  const source = join(directory, `source-${key}`);
  let saved = readMainAudit(file);
  if (saved?.cleanupNeeded && saved.cleanupNeeded !== source) throw new Error('main audit cleanup path is not the owned source');
  if (saved?.cleanupNeeded) {
    // Retry only a previously drained owned worktree. Unknown custody needs inspection, never force removal.
    if (saved.cleanupVerified !== true) {
      await notifyIncomplete(file, job, `cleanup custody remains unknown: ${saved.cleanupNeeded}`, write);
      return;
    }
    try {
      const registered = git(root, ['worktree', 'list', '--porcelain', '-z']).split('\0').includes(`worktree ${source}`);
      if (registered || existsSync(source)) git(root, ['worktree', 'remove', source]);
      const { cleanupNeeded, cleanupReason, noticeRecorded, incomplete, error, ...retained } = saved;
      saved = retained;
      saveMainAudit(file, saved);
    } catch (error) {
      await notifyIncomplete(file, job, `cleanup retry failed: ${error.message}`, write);
      return;
    }
  }
  if (saved?.state === 'complete') return;
  const config = policyAt(root, job.tip).config;
  // A previous controller may have died with unknown remote work: never automatically duplicate that execution.
  if (saved?.state === 'running' && !saved.receiptId) {
    await notifyIncomplete(file, job, 'previous controller has no durable native receipt; inspect owned processes before recovery', write);
    return;
  }
  let created = false, cleanupAllowed = true;
  try {
    let receipt = saved?.receiptId && readGateReceipt(receiptStore(root), saved.receiptId);
    if (!receipt) {
      saveMainAudit(file, { ...job, state: 'pending' });
      git(root, ['worktree', 'add', '--detach', source, job.tip]); created = true;
      if (git(source, ['rev-parse', 'HEAD']).trim() !== job.tip || git(source, ['rev-parse', 'HEAD^{tree}']).trim() !== job.tree
        || git(source, ['status', '--porcelain', '--untracked-files=all']) !== '') throw new Error('audit source is not the exact clean landed tree');
      const plan = await readBoard(repoInfo(root), board => planMainAudit(source, board, directory, job, config, options, testValueServices));
      if (!plan.run.length) {
        const previous = lastGreenAudit(root, directory);
        if (!previous) throw new Error('all-reused plan lost its complete green origin');
        const completed = { ...job, state: 'complete', green: true, plan, reusedOnly: true, originReceiptId: previous.receiptId };
        saveMainAudit(file, completed);
        saveMainAudit(join(directory, 'last-green.json'), { ...previous, tip: job.tip, tree: job.tree, landedEventId: job.landedEventId, keys: plan.keys, reused: plan.reused });
        return; // No native run or new receipt is claimed for a completely reused audit.
      }
      saveMainAudit(file, { ...job, plan, state: 'running', source, controller: process.pid, started: processStart(process.pid) });
      cleanupAllowed = false;
      const run = await runGate(source, config, { executionServices, landing: true, collectAll: true, auditBatchId: job.batchId, auditCoverage: true, ...(plan.reused.length ? { auditFiles: plan.run } : {}), trustStamp: false, agent: 'coordinator' });
      cleanupAllowed = run.cleanupVerified === true && !run.cleanupUnverified
        && !(run.profile?.landingShards?.unverified?.length > 0);
      receipt = run.receiptId && readGateReceipt(receiptStore(root), run.receiptId);
      const artifact = join(directory, key); mkdirSync(artifact, { recursive: true, mode: 0o700 });
      writeFileSync(join(artifact, 'gate.log'), run.output ?? '', { mode: 0o600 });
      writeFileSync(join(artifact, 'profile.json'), JSON.stringify(run.profile ?? null), { mode: 0o600 });
      if (!receipt || receipt.head !== job.tip || receipt.tree !== job.tree || receipt.kind !== 'land') throw new Error('native audit receipt is missing or source-unbound');
      saved = { ...job, plan, coverage: measuredAuditCoverage(source, run.output ?? ''), runSeconds: run.seconds, state: 'measured', receiptId: receipt.id, cleanupVerified: cleanupAllowed };
      writeFileSync(join(artifact, 'coverage.json'), JSON.stringify(saved.coverage) + '\n', { mode: 0o600 });
      saveMainAudit(file, saved);
    }
    if (receipt.head !== job.tip || receipt.tree !== job.tree || receipt.collection?.batchId !== job.batchId) throw new Error('retained audit receipt changed source identity');
    await write('recordGateRun', [{ agentId: 'coordinator', receipt,
      lane: job.items[0]?.lane ?? Object.keys(config.lanes)[0] }]);
    // Routing can be resumed with the same genuine receipt without another execution.
    // Source is needed only for immutable Git objects; original repo retains the same objects after cleanup.
    await routeFailures(root, job, receipt, config, write, saved.plan?.previousEventId ?? 0);
    if (receipt.collection?.complete !== true || (saved.plan?.reused.length
      ? JSON.stringify(receipt.collection.files) !== JSON.stringify(saved.plan.run) : receipt.collection.full !== true)) throw new Error('not all planned files completed; audit obligation remains incomplete');
    const { incomplete, error, noticeRecorded, ...completed } = saved;
    saveMainAudit(file, { ...completed, state: 'complete', green: receipt.green });
    retainGreenAudit(directory, job, saved, receipt);
    readBoard(repoInfo(root), board => retainAuditCadence(board, directory, config, { runSeconds: saved.runSeconds ?? 0 }));
  } catch (error) {
    const current = readMainAudit(file) ?? job;
    saveMainAudit(file, { ...current, error: String(error.message), incomplete: true });
    try { await notifyIncomplete(file, job, error.message, write); } catch { /* A later nudge retries the ordinary notice. */ }
  } finally {
    if (created) {
      try {
        if (!cleanupAllowed) throw new Error('controller cleanup is unknown or explicitly unverified');
        git(root, ['worktree', 'remove', source]);
      } catch (error) {
        const current = readMainAudit(file) ?? job;
        saveMainAudit(file, { ...current, cleanupNeeded: source, cleanupVerified: cleanupAllowed, cleanupReason: String(error.message), noticeRecorded: false });
        try { await notifyIncomplete(file, job, `cleanup needed: ${source}`, write); } catch { /* Retain need for ordinary coordinator delivery. */ }
      }
    }
  }
}
/** Drain finite snapshots until all wakes observed by this owner have been serviced. */
export async function runMainAudits(root, token, { scheduled = false, forceFull = false } = {}, services) {
  const info = repoInfo(root);
  if (!info.isMain || !codeIsFromMain() || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(token ?? '')) return;
  const directory = mainAuditDirectory(info); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const activation = readMainAudit(join(directory, 'activation.json'));
  if (!activation) return; // No implicit historical barrier or retroactive full-suite queue.
  if (activation.version !== 1 || !Number.isSafeInteger(activation.afterEventId) || activation.afterEventId < 0) throw new Error('invalid main audit activation');
  const schedule = readMainAudit(join(directory, 'schedule.json'));
  if (scheduled && (!schedule || schedule.dueAt === null || Date.parse(schedule.dueAt) > Date.now())) {
    if (schedule?.dueAt) await scheduleMainAudit(root, directory, schedule.dueAt);
    return; // Unknown cadence needs an explicit manual/release audit, never an invented immediate schedule.
  }
  const ownerFile = join(directory, 'owner.json'), lock = join(directory, 'owner.guard.sqlite');
  const wakeFile = join(directory, 'wake.json');
  const acquired = await withFileLock(lock, () => {
    const wake = readMainAudit(wakeFile);
    if (wake && (wake.version !== 1 || typeof wake.board !== 'string'
      || !Number.isSafeInteger(wake.generation) || wake.generation < 0)) throw new Error('invalid main audit wake');
    const generation = wake?.board === activation.board ? wake.generation : 0;
    if (generation === Number.MAX_SAFE_INTEGER) throw new Error('main audit wake generation exhausted');
    // A contender must leave a durable wake before observing the live singleton.
    saveMainAudit(wakeFile, { version: 1, board: activation.board, generation: generation + 1 });
    const old = readMainAudit(ownerFile);
    if (old && ownerLive(old)) return null;
    saveMainAudit(ownerFile, { pid: process.pid, started: processStart(process.pid), token });
    return generation + 1;
  });
  if (acquired === null) return;
  let generation = acquired;
  const visited = new Set(); // Never hot-retry an incomplete obligation in a wake-draining invocation.
  try {
    if (!['context', 'ordered', 'withBoard'].every(name => typeof services?.[name] === 'function')) throw new TypeError('main audit needs explicit native writer services');
    const write = writer(root, services);
    for (;;) {
      const jobs = snapshot(root, info, activation);
      for (const job of scheduled || forceFull ? jobs.slice(-1) : jobs) {
        const key = mainAuditKey(job);
        if (visited.has(key)) continue;
        visited.add(key);
        try { await audit(root, directory, job, write, { forceFull, runId: token }, services.testValue, services.executionServices); }
        catch (error) {
          const file = join(directory, `${key}.json`);
          const saved = readMainAudit(file) ?? job;
          saveMainAudit(file, { ...saved, incomplete: true, error: String(error.message) });
          // A refused notice or malformed job must not prevent remaining obligations.
        }
      }
      const next = await withFileLock(lock, () => {
        const owner = readMainAudit(ownerFile);
        if (owner?.pid !== process.pid || owner.token !== token) throw new Error('main audit ownership changed');
        const wake = readMainAudit(wakeFile);
        if (wake?.version !== 1 || wake.board !== activation.board
          || !Number.isSafeInteger(wake.generation) || wake.generation < generation) throw new Error('invalid main audit wake');
        if (wake.generation !== generation) return wake.generation;
        // Wake observation and owner release are atomic: a later nudge becomes the next owner.
        rmSync(ownerFile);
        return null;
      });
      if (next === null) {
        const cadence = readMainAudit(join(directory, 'schedule.json'));
        if (scheduled && cadence?.dueAt && Date.parse(cadence.dueAt) > Date.now()) await scheduleMainAudit(root, directory, cadence.dueAt);
        return;
      }
      generation = next;
    }
  } finally {
    await withFileLock(lock, () => { const owner = readMainAudit(ownerFile);
      if (owner?.pid === process.pid && owner.token === token) rmSync(ownerFile); });
  }
}
