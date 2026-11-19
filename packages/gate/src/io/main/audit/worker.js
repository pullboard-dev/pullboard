import { fileSystemAdapter } from '../../../../../fs/index.js';
import {
  planMainAudit,
  measuredAuditCoverage,
  retainGreenAudit,
  retainAuditCadence,
  lastGreenAudit,
} from './economics.js';
import {
  scheduleMainAudit,
} from './scheduler.js';
import { mainCommitJob } from './commits.js';
import {
  attributeAuditFailures,
  auditRegressionNote,
  fileAuditRegressions,
} from './attribution.js';
/** Finite exact-source main audits, one native admitted run at a time [C7,H16]. */
import {
  execFileSync,
} from 'node:child_process';
import { gitExecFileSync } from '../../../../../git/index.js';
import {
  createHash,
} from 'node:crypto';
import {
  join,
} from 'node:path';
import * as store from '../../../../../store/index.js';
import { Refused } from '../../../../../kernel/index.js';
import {
  codeIsFromMain,
} from '../../../../../git/index.js';
import {
  gitChildEnv,
} from '../../../../../git/index.js';
import {
  repoInfo,
} from '../../../../../git/index.js';
import {
  policyAt,
} from '../../../../../sandbox/index.js';
import {
  runGate,
} from '../../main.js';
import {
  readGateReceipt,
} from '../../run/receipt.js';
import {
  receiptStore,
} from '../../run/receipt.js';
import {
  laneOf,
} from '../../../../../seats/index.js';
import {
  withFileLock,
} from '../../../../../outbox/index.js';
import {
  mainAuditDirectory,
} from './state.js';
import {
  mainAuditKey,
} from './state.js';
import {
  readMainAudit,
} from './state.js';
import {
  saveMainAudit,
} from './state.js';
import {
  mainRedCheckFiles,
  mainRedFilesProven,
  mainRedFrozenCheck,
} from '../../test/economics.js';
import { storeName } from '../../store-names.js';

const fs = fileSystemAdapter();

/** Run Git with the same sanitized repository environment as ordinary native code. */
function git(root, args, encoding = 'utf8') {
  return gitExecFileSync(args, { cwd: root, env: gitChildEnv(root), encoding, stdio: ['ignore', 'pipe', 'pipe'] });
}
/** Read native history without retaining an open board across locks, admission or execution. */
function readBoard(info, action, openBoardForRead) {
  if (typeof openBoardForRead !== 'function') throw new TypeError('main audit requires its actual native read opener');
  const board = openBoardForRead(join(info.commonDir, 'pullboard', 'board.sqlite'));
  if (!board) throw new Error('main audit board is unavailable');
  try { return action(board); } finally { store.closeBoard(board); }
}
/** Bound ordinary native/relay writes retain exact session and origin receipt validation. */
function writer(root, { context, ordered, withBoard, nativeBoard }) {
  const io = { cwd: root, nativeBoard, say() {}, err() {}, stderr: { write() {} } };
  const ctx = context(io);
  return (operation, args) => withBoard(ctx, board => withAuditedMain(root, board,
    operation === 'withdraw' ? args[1]?.expected : null, () => ordered(ctx, board, operation, args)));
}

/** Bind an audit withdrawal to the existing native policy witness across queued SQLite admission. */
export async function withAuditedMain(root, board, expected, write) {
  if (expected === null || expected === undefined) return write();
  const descriptor = Object.getOwnPropertyDescriptor(board, 'prepareWritePolicy');
  const prepare = board.prepareWritePolicy;
  Object.defineProperty(board, 'prepareWritePolicy', { configurable: true, value() {
    // Preparation runs before BEGIN. The existing witness then detects ref changes under the lock and at commit.
    const policy = typeof prepare === 'function' ? prepare.call(board) : null;
    if (!policy || typeof policy.current !== 'function' || typeof policy.assertCurrent !== 'function'
      || git(root, ['rev-parse', 'main^{commit}']).trim() !== expected.head || !policy.current()) {
      throw new Refused('STALE_MAIN_RED', 'main changed after the captured passing audit; retain the item for the next current-tip audit');
    }
    return policy;
  } });
  try { return await write(); }
  finally {
    if (descriptor) Object.defineProperty(board, 'prepareWritePolicy', descriptor);
    else delete board.prepareWritePolicy;
  }
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
/** Build obligations from landed batches on local main, then main's own tip however it moved. */
function snapshot(root, info, activation, openBoardForRead) {
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
    const tipJob = mainCommitJob({ git, store }, root, board, mainAuditDirectory(info), activation, [...jobs.values()]);
    if (tipJob) jobs.set(mainAuditKey(tipJob), tipJob);
    return [...jobs.values()];
  }, openBoardForRead);
}
/** The audit jobs queued now for an activated main checkout; an unactivated one has none [C7]. */
export function mainAuditJobs(root, openBoardForRead) {
  const info = repoInfo(root);
  const activation = readMainAudit(join(mainAuditDirectory(info), 'activation.json'));
  return activation ? snapshot(root, info, activation, openBoardForRead) : [];
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
/**
 * Route every failing file of one audit through the same last-green..tip attribution.
 *
 * Why: a test that passed in the last green audit was broken by the items whose `Pullboard-Item` trailers
 * sit in that range, so its repair goes to their lane, never to the test owner's lane, whether main moved
 * by a landed batch or by a plain commit. A landed batch keeps the native defect record, which carries its
 * landing provenance, escape count and dedupe, and gains a note naming both tips and the suspects. A file
 * with no green audit to attribute from keeps the ownership route; a main-commit job has no batch for it.
 */
export async function routeAuditFailures(source, job, receipt, config, write, sinceEventId, openBoardForRead) {
  const read = action => readBoard(repoInfo(source), action, openBoardForRead);
  const directory = mainAuditDirectory(repoInfo(source));
  const files = [...new Set(receipt.failures.map(failure => failure.file))];
  if (!receipt.green && !files.length) throw new Error('red main audit has no named failing file; not complete');
  if (job.source === 'main-commits') {
    const filed = await fileAuditRegressions({ git, store, read, write }, source, directory, job, receipt.failures);
    const unrouted = files.filter(file => !filed.some(row => row.test === file));
    if (unrouted.length) throw new Error(`main audit failures have no green audit to attribute from: ${unrouted.join(', ')}`);
    return;
  }
  const regressions = read(board => attributeAuditFailures({ git, store }, source, board, directory, job, receipt.failures));
  for (const file of files) {
    const bytes = git(source, ['show', `${job.tip}:${file}`], null);
    const blob = git(source, ['rev-parse', `${job.tip}:${file}`]).trim();
    let trunkBlob = null;
    try { trunkBlob = git(source, ['rev-parse', `${job.base}:${file}`]).trim(); } catch { /* A new file has no parent blob. */ }
    const regression = regressions.find(row => row.test === file), owner = laneOf(config, file);
    // A trailer item names the suspect; a batch with no trailers still names the items it landed.
    const lane = regression ? (regression.items.length ? regression.lane : job.items[0]?.lane ?? regression.lane)
      : owner === 'coordinator' ? job.items[0]?.lane : owner;
    if (!lane) throw new Error(`main audit has no legitimate repair lane for ${file}`);
    const names = [...new Set(receipt.failures.filter(failure => failure.file === file).map(failure => failure.name))];
    // Existing native operation's bounded names limit is authoritative; oversized routing remains incomplete.
    const defect = await write('recordLandingTestDefect', [{ agentId: 'coordinator', test: file,
      hash: createHash('sha256').update(bytes).digest('hex'), blob, trunkBlob, names,
      lane, batchId: job.batchId, branch: job.branch, requireOpen: true, auditSinceEventId: sinceEventId }]);
    // Native routing must return an actual outstanding repair, not a previously closed same-blob item.
    if (!Number.isSafeInteger(defect?.item) || !names.every(name => defect.names?.includes(name))
      || !readBoard(repoInfo(source), board => ['open', 'claimed', 'submitted'].includes(store.getItem(board, defect.item).item_status), openBoardForRead)) {
      throw new Error(`main audit repair route is not open for ${file}`);
    }
    if (regression) await noteRegression(read, write, defect.item, auditRegressionNote(regression));
  }
}
/**
 * Append the attribution note to a repair once.
 *
 * Why: an audit resumes after a crash and reruns routing; the board's own facts say whether it is there.
 */
async function noteRegression(read, write, item, text) {
  const present = read(board => board.db.prepare("SELECT 1 FROM event WHERE event_kind='fact' AND item_id=? AND json_extract(event_detail,'$.text')=? LIMIT 1").get(item, text));
  if (!present) await write('appendFact', [item, { agentId: 'coordinator', kind: 'measurement', text }]);
}
/** Withdraw only a still-identical frozen Main red whose every named file passed this current-tip audit. */
export async function closeAuditedMainReds(root, job, plan, receipt, write, openBoardForRead) {
  const info = repoInfo(root);
  const candidates = readBoard(info, board => store.listItems(board).filter(item => item.item_status === 'open'
    && item.item_title.startsWith('Main red:')), openBoardForRead);
  let closed = 0;
  for (const item of candidates) {
    const check = mainRedFrozenCheck(item);
    if (!check || !mainRedCheckFiles(check)) continue;
    const currentHead = git(root, ['rev-parse', 'main^{commit}']).trim();
    const currentTree = git(root, ['rev-parse', 'main^{tree}']).trim();
    if (currentHead !== job.tip || currentTree !== job.tree) break;
    if (!mainRedFilesProven(check, { plan, receipt, auditedHead: job.tip, currentHead,
      auditedTree: job.tree, currentTree })) continue;
    try {
      await write('withdraw', [item.item_id, { agentId: 'coordinator',
        reason: `Every named frozen-check file passed on main at ${job.tip}.`,
        expected: { status: 'open', title: item.item_title, check, frozenDigest: item.item_frozen_digest, head: job.tip } }]);
    } catch (error) {
      if (error?.code === 'STALE_MAIN_RED') continue;
      throw error;
    }
    closed++;
  }
  return closed;
}
/** Run or finish routing one job; a durable complete receipt avoids rerunning an already observed suite. */
async function audit(root, directory, job, write, options, testValueServices, executionServices, openBoardForRead, collectCellsBacklog) {
  const key = mainAuditKey(job) + (options.forceFull ? `-release-${options.runId}` : ''), file = join(directory, storeName(key));
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
      if (registered || fs.exists(source)) git(root, ['worktree', 'remove', source]);
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
      const plan = await readBoard(repoInfo(root), board => planMainAudit(source, board, directory, job, config, options, testValueServices), openBoardForRead);
      const cellsBacklog = typeof collectCellsBacklog === 'function' ? await collectCellsBacklog(source, job) : null;
      if (cellsBacklog !== null && cellsBacklog !== undefined) {
        if (cellsBacklog.version !== 1 || cellsBacklog.tip !== job.tip || cellsBacklog.tree !== job.tree
          || !Array.isArray(cellsBacklog.cells) || !Number.isSafeInteger(cellsBacklog.count)) {
          throw new Error('main audit cell cuts backlog is not bound to its exact source');
        }
        saveMainAudit(join(directory, key, 'cells-backlog.json'), cellsBacklog);
      }
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
      const artifact = join(directory, key); fs.mkdir(artifact, { recursive: true, mode: 0o700 });
      fs.writeFile(join(artifact, 'gate.log'), run.output ?? '', { mode: 0o600 });
      fs.writeFile(join(artifact, 'profile.json'), JSON.stringify(run.profile ?? null), { mode: 0o600 });
      if (!receipt || receipt.head !== job.tip || receipt.tree !== job.tree || receipt.kind !== 'land') throw new Error('native audit receipt is missing or source-unbound');
      saved = { ...job, plan, coverage: measuredAuditCoverage(source, run.output ?? ''), runSeconds: run.seconds, state: 'measured', receiptId: receipt.id, cleanupVerified: cleanupAllowed };
      fs.writeFile(join(artifact, 'coverage.json'), JSON.stringify(saved.coverage) + '\n', { mode: 0o600 });
      saveMainAudit(file, saved);
    }
    if (receipt.head !== job.tip || receipt.tree !== job.tree || receipt.collection?.batchId !== job.batchId) throw new Error('retained audit receipt changed source identity');
    await write('recordGateRun', [{ agentId: 'coordinator', receipt,
      lane: job.items[0]?.lane ?? Object.keys(config.lanes)[0] }]);
    // Routing can be resumed with the same genuine receipt without another execution.
    // Source is needed only for immutable Git objects; original repo retains the same objects after cleanup.
    await routeAuditFailures(root, job, receipt, config, write, saved.plan?.previousEventId ?? 0, openBoardForRead);
    if (receipt.collection?.complete !== true || (saved.plan?.reused.length
      ? JSON.stringify(receipt.collection.files) !== JSON.stringify(saved.plan.run) : receipt.collection.full !== true)) throw new Error('not all planned files completed; audit obligation remains incomplete');
    await closeAuditedMainReds(root, job, saved.plan, receipt, write, openBoardForRead);
    const { incomplete, error, noticeRecorded, ...completed } = saved;
    saveMainAudit(file, { ...completed, state: 'complete', green: receipt.green });
    retainGreenAudit(directory, job, saved, receipt);
    readBoard(repoInfo(root), board => retainAuditCadence(board, directory, config, { runSeconds: saved.runSeconds ?? 0 }), openBoardForRead);
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
/**
 * Run the audit's board-command budget check, when the composition root supplies one, for the newest audited tip. A
 * breach is filed to the lane owning the CLI entry the caller names (ownerPath), or the newest landed item's lane when the coordinator owns it.
 * Why it never throws: a measurement that fails must not leave an audit obligation incomplete.
 */
async function checkCommandBudget(root, { directory, job, write, openBoardForRead, ownerPath }, check) {
  if (typeof check !== 'function') return;
  try {
    const config = policyAt(root, job.tip).config;
    const owner = laneOf(config, ownerPath);
    const lane = owner && owner !== 'coordinator' ? owner : job.items?.[0]?.lane ?? Object.keys(config.lanes)[0];
    await check({ directory, job, lane, write, read: action => readBoard(repoInfo(root), action, openBoardForRead) });
  } catch (error) {
    try { saveMainAudit(join(directory, 'board-command-budget-error.json'), { at: new Date().toISOString(), tip: job.tip, error: String(error.message) }); }
    catch { /* The next drain measures again. */ }
  }
}

/** Drain finite snapshots until all wakes observed by this owner have been serviced. */
export async function runMainAudits(root, token, { scheduled = false, forceFull = false } = {}, services) {
  const info = repoInfo(root);
  const openBoardForRead = services?.openBoardForRead;
  if (typeof openBoardForRead !== 'function') throw new TypeError('main audit requires its actual native read opener');
  if (!info.isMain || !codeIsFromMain() || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(token ?? '')) return;
  const directory = mainAuditDirectory(info);
  if (!fs.exists(join(directory, 'activation.json'))) return;
  const activation = readMainAudit(join(directory, 'activation.json'));
  if (!activation) return; // No implicit historical barrier or retroactive full-suite queue.
  if (activation.version !== 1 || !Number.isSafeInteger(activation.afterEventId) || activation.afterEventId < 0) throw new Error('invalid main audit activation');
  fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const schedule = readMainAudit(join(directory, 'schedule.json'));
  if (scheduled && (!schedule || schedule.dueAt === null || Date.parse(schedule.dueAt) > Date.now())) {
    if (schedule?.dueAt) await scheduleMainAudit(root, directory, schedule.dueAt, services.workerUrl);
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
      const jobs = snapshot(root, info, activation, openBoardForRead);
      for (const job of scheduled || forceFull ? jobs.slice(-1) : jobs) {
        const key = mainAuditKey(job);
        if (visited.has(key)) continue;
        visited.add(key);
        try { await audit(root, directory, job, write, { forceFull, runId: token }, services.testValue, services.executionServices, openBoardForRead, services.cellsBacklog); }
        catch (error) {
          const file = join(directory, storeName(key));
          const saved = readMainAudit(file) ?? job;
          saveMainAudit(file, { ...saved, incomplete: true, error: String(error.message) });
          // A refused notice or malformed job must not prevent remaining obligations.
        }
      }
      if (jobs.length) await checkCommandBudget(root, { directory, job: jobs.at(-1), write, openBoardForRead, ownerPath: services.commandBudgetOwnerPath }, services.commandBudget);
      const next = await withFileLock(lock, () => {
        const owner = readMainAudit(ownerFile);
        if (owner?.pid !== process.pid || owner.token !== token) throw new Error('main audit ownership changed');
        const wake = readMainAudit(wakeFile);
        if (wake?.version !== 1 || wake.board !== activation.board
          || !Number.isSafeInteger(wake.generation) || wake.generation < generation) throw new Error('invalid main audit wake');
        if (wake.generation !== generation) return wake.generation;
        // Wake observation and owner release are atomic: a later nudge becomes the next owner.
        fs.rm(ownerFile);
        return null;
      });
      if (next === null) {
        const cadence = readMainAudit(join(directory, 'schedule.json'));
        if (scheduled && cadence?.dueAt && Date.parse(cadence.dueAt) > Date.now()) await scheduleMainAudit(root, directory, cadence.dueAt, services.workerUrl);
        return;
      }
      generation = next;
    }
  } finally {
    await withFileLock(lock, () => { const owner = readMainAudit(ownerFile);
      if (owner?.pid === process.pid && owner.token === token) fs.rm(ownerFile); });
  }
}
