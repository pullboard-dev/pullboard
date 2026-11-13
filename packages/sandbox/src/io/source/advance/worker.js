import {
  frozenCheckTiming,
} from '../../../../../items/light.js';
/** Finite autonomous main-merge work uses ordinary admission, native receipts and ordered writes [C7,V4,H16]. */
import {
  copyFileSync,
} from 'node:fs';
import {
  existsSync,
} from 'node:fs';
import {
  readFileSync,
} from 'node:fs';
import {
  createHash,
} from 'node:crypto';
import {
  execFileSync,
} from 'node:child_process';
import {
  gitExecFileSync,
} from '../../../../../git/index.js';
import {
  mkdirSync,
} from 'node:fs';
import {
  rmSync,
} from 'node:fs';
import {
  join,
} from 'node:path';
import * as store from '../../../../../store/index.js';
import {
  codeIsFromMain,
} from '../../../../../git/index.js';
import {
  codeUsesRepository,
} from '../../../../../git/index.js';
import {
  gitChildEnv,
} from '../../../../../git/index.js';
import {
  repoInfo,
} from '../../../../../git/index.js';
import {
  frozenCheck,
} from '../../trusted/policy.js';
import {
  mainPolicy,
} from '../../trusted/policy/committed.js';
import {
  captureSourceAdvanceBasis,
} from './origin.js';
import {
  prepareSourceAdvance,
} from './origin.js';
import {
  prepareSourceAdvanceReturn,
} from './origin.js';
import {
  withSourceComposition,
} from '../../../../../merge/index.js';

/** Read immutable Git facts with a bounded child; never execute repository hooks. */
function git(root, args) {
  return gitExecFileSync(args, { cwd: root, env: gitChildEnv(root), encoding: 'utf8', timeout: 30000 }).trim();
}

/** The private advisory folder is repository-owned and contains no new board authority. */
export function sourceAdvanceDirectory(info) { return join(info.commonDir, 'pullboard', 'source-advances'); }

/** Read a short native snapshot and close its connection before tests, admission or network work. */
function readBoard(info, work, openBoardForRead) {
  if (typeof openBoardForRead !== 'function') throw new TypeError('source advance requires its actual native read opener');
  const board = openBoardForRead(join(info.commonDir, 'pullboard', 'board.sqlite'));
  if (!board) throw new Error('source-advance board is unavailable');
  try { return work(board); } finally { store.closeBoard(board); }
}

/** Native writes always use the accepted coordinator context and normal ordered sender binding. */
function writer(root, { context, ordered, withBoard, nativeBoard }) {
  const ctx = context({ cwd: root, nativeBoard, say() {}, err() {}, stderr: { write() {} } });
  return work => withBoard(ctx, board => work(board, (operation, args) => ordered(ctx, board, operation, args)));
}

/** Serialize only the final ordered source change with publication, never its gate execution. */
function complete(root, write, { takeLandingResource }, action) {
  if (typeof takeLandingResource !== 'function') throw new TypeError('source-advance completion needs native landing admission');
  return write(async (board, order) => {
    const lease = await takeLandingResource({ board, branch: git(root, ['symbolic-ref', 'HEAD']),
      write: order });
    try {
      await lease.assertHeld();
      return await action(board, order, lease);
    } finally { await lease.release(); }
  });
}

/** Known process start identity prevents PID reuse from blocking or stealing an unrelated owner. */
function processStart(pid) {
  try { return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 1000 }).trim() || null; }
  catch { return null; }
}

/** Unknown custody stays live; a surviving owned group cannot be stolen after parent death. */
function ownerLive(owner) {
  if (!Number.isSafeInteger(owner?.pid) || owner.pid < 1 || typeof owner.token !== 'string') throw new Error('invalid source-advance owner');
  try {
    process.kill(owner.pid, 0);
    const current = processStart(owner.pid);
    return !current || !owner.started || current === owner.started;
  } catch (error) { if (error.code !== 'ESRCH') return true; }
  try { return execFileSync('ps', ['-axo','pgid='], { encoding: 'utf8', timeout: 1000 }).split('\n').some(value => Number(value.trim()) === owner.pid); }
  catch { return true; }
}

/** Capture finite exact-main obligations; an active landing completes before this worker starts a gate. */
function snapshot(root, info, { landingLeaseState, openBoardForRead }) {
  return readBoard(info, board => {
    if (landingLeaseState(board).holder) return [];
    return store.listItems(board, { all: true }).filter(item => ['submitted','verified'].includes(item.item_status)
      && item.item_commit && !item.item_merged_commit && !store.reviewHolder(board, item)).flatMap(item => {
      try {
        const basis = captureSourceAdvanceBasis(root, board, item);
        try { git(root, ['merge-base','--is-ancestor',basis.trunk,basis.inputHead]); return []; }
        catch { /* A moved main needs its own exact composition and genuine rerun. */ }
        return [{ item: store.getItem(board, item.item_id), basis,
          key: createHash('sha256').update(JSON.stringify([store.boardId(board),item.item_id,basis])).digest('hex') }];
      } catch (error) {
        const trunk = mainPolicy(root).commit;
        return [{ item, basis: { trunk }, error: String(error.message),
          key: createHash('sha256').update(JSON.stringify([store.boardId(board),item.item_id,item.item_commit,item.item_frozen_digest,trunk,'unavailable'])).digest('hex') }];
      } // Unavailable objects/invalid inputs stay explicitly incomplete, never endorsed or silently dropped.
    });
  }, openBoardForRead);
}

/** Exact readonly eligibility probe used by the foreground nudge before it spawns a worker. */
export function hasSourceAdvanceJobs(root, services, info = repoInfo(root)) {
  if (snapshot(root, info, services).length > 0) return true;
  const directory = sourceAdvanceDirectory(info);
  // Once this repository has advisory state, a foreground wake must enter the
  // serialized drain even when the current snapshot is empty. It may be the
  // next generation after an earlier real job, and only the owner can settle it.
  return existsSync(directory);
}

/** Signal incomplete work once through the ordinary item thread without a self-shout or fabricated authority. */
async function incomplete(write, file, job, reason, { readMainAudit, saveMainAudit }) {
  const saved = readMainAudit(file) ?? {};
  saveMainAudit(file, { ...saved, state: 'incomplete', reason: String(reason).slice(0,2000) });
  if (saved.notified) return;
  await write(async (_board, order) => order('appendFact', [job.item.item_id, { agentId: 'coordinator', kind: 'measurement',
    text: `Automatic main merge is incomplete at ${job.basis.trunk}: ${String(reason).slice(0,300)}. No new source or verdict was endorsed.` }]));
  saveMainAudit(file, { ...readMainAudit(file), notified: true });
}

/** Retain the actual raw phase logs and profiles before removing their private Git directory. */
function retainArtifacts(directory, job, gate, composition, { saveMainAudit }) {
  const folder = join(directory, job.key); mkdirSync(folder, { recursive: true, mode: 0o700 });
  const sources = new Map();
  for (const [role,source] of [['combined',gate.log],['combined-profile',gate.profilePath],['criterion',gate.check?.log],
    ['criterion-profile',gate.check?.profilePath],['affected',gate.proofLog],['affected-profile',gate.proofProfilePath]]) {
    if (typeof source !== 'string' || !source) continue;
    sources.set(source,[...(sources.get(source) ?? []),role]);
  }
  const artifacts = [...sources].map(([source,roles],index) => {
    const file = join(folder,`${index}${source.endsWith('.json')?'.json':'.log'}`);
    copyFileSync(source,file);
    return { roles, source, file, sha256:createHash('sha256').update(readFileSync(file)).digest('hex') };
  });
  saveMainAudit(join(folder,'manifest.json'), { version:1, head:composition.head, tree:composition.tree, trunk:job.basis.trunk, artifacts });
  return artifacts;
}

/** Execute one exact composition; any known returned child is cleaned before its terminal advisory state is written. */
async function advance(root, directory, job, write, services) {
  const { readMainAudit, saveMainAudit, runSubmitGate } = services;
  const file = join(directory, `${job.key}.json`);
  const old = readMainAudit(file);
  if (old) return; // Unknown/crashed or logically incomplete work is not a hot retry on every health wake.
  saveMainAudit(file, { version: 1, item: job.item.item_id, basis: job.basis, state: 'pending' });
  if (job.error) { await incomplete(write, file, job, job.error, services); return; }
  let entered = false;
  try {
    await withSourceComposition(root, job.basis.inputHead, job.basis.trunk, async (composition, custody) => {
      entered = true;
      saveMainAudit(file, { ...readMainAudit(file), state: 'running', directory: composition.directory, head: composition.head, tree: composition.tree });
      const policy = mainPolicy(root);
      if (policy.commit !== job.basis.trunk) throw new Error('main changed before source-advance admission');
      const config = policy.config;
      const quarantines = readBoard(repoInfo(root), board => {
        board.quarantineEnabled = () => config.flakes?.quarantine === true;
        return board.nativePorts.quarantine.quarantineVerdictSnapshot(board);
      }, services.openBoardForRead);
      custody.started();
      const gate = await runSubmitGate(composition.directory, config, { base: composition.inputHead, changed: composition.changed,
        executionServices: services.executionServices, check: frozenCheck(job.item), timing: frozenCheckTiming(job.item), agent: 'coordinator', item: String(job.item.item_id), sourceAdvance: true,
        proofContext: { item: job.item.item_id, frozenDigest: job.basis.bar, seat: 'coordinator', kind: 'submit', quarantines } });
      if (!gate.cleanupUnverified && !(gate.profile?.landingShards?.unverified?.length > 0)) custody.terminal();
      const artifacts = retainArtifacts(directory, job, gate, composition, services);
      const result = await complete(root, write, services, async (board, order, lease) => {
        const request = gate.isGreen ? prepareSourceAdvance(root, board, job.item, composition, gate, job.basis, services.selectors)
          : prepareSourceAdvanceReturn(root, board, job.item, job.basis, { composition, gate }, services.selectors);
        for (const receiptId of gate.proofReceiptIds.filter(Boolean)) {
          await lease.assertHeld();
          await order('recordProofRun', [{ agentId: 'coordinator', itemId: job.item.item_id, receiptId }]);
        }
        git(root, ['update-ref', `refs/pullboard/items/${job.item.item_id}/${composition.head.slice(0,12)}`, composition.head]);
        await lease.assertHeld();
        const fenced = { ...request, landingFence: lease.fence };
        return gate.isGreen ? order('advanceItemSource', [job.item.item_id, fenced]) : order('reopen', [job.item.item_id, fenced]);
      });
      saveMainAudit(file, { ...readMainAudit(file), state: gate.isGreen ? 'advanced' : 'returned', result,
        receiptIds: gate.proofReceiptIds.filter(Boolean), artifacts });
    });
  } catch (error) {
    if (!entered && error.code === 'MERGE_CONFLICT' && error.files?.length) {
      try {
        const result = await complete(root, write, services, async (board, order, lease) => {
          const request = prepareSourceAdvanceReturn(root, board, job.item, job.basis);
          await lease.assertHeld();
          return order('reopen', [job.item.item_id, { ...request, landingFence: lease.fence }]);
        });
        saveMainAudit(file, { ...readMainAudit(file), state: 'returned', files: error.files, result });
        return;
      } catch (returned) { error = returned; }
    }
    await incomplete(write, file, job, error.message, services);
  }
}

/** Drain each wake generation once; no timer daemon, time stealing or parallel gate runs are introduced. */
export async function runSourceAdvances(root, token, services) {
  const info = repoInfo(root);
  // The nudge's own rule: a worktree of this repository's own code is never main's code; a runner job's work folder belongs to another repository.
  if (!info.isMain || !(codeIsFromMain() || !codeUsesRepository(info.commonDir)) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(token ?? '')) return;
  if (typeof services?.openBoardForRead !== 'function') throw new TypeError('source advance requires its actual native read opener');
  if (typeof services?.selectors?.selectAffectedTests !== 'function' || typeof services?.selectors?.selectTestTreeGuards !== 'function') throw new TypeError('source advance worker needs explicit test selector operations');
  const selectors = Object.freeze({ selectAffectedTests: services.selectors.selectAffectedTests, selectTestTreeGuards: services.selectors.selectTestTreeGuards });
  services = { ...services, selectors };
  const { withFileLock, readMainAudit, saveMainAudit } = services;
  // A wake with no source obligations must be observationally inert. A successful CLI
  // command can start this worker just before its caller removes a private fixture repo;
  // creating advisory state before discovering an empty snapshot races that cleanup.
  // The serialized snapshot below remains authoritative for every real job.
  if (!hasSourceAdvanceJobs(root, services, info)) return;
  const directory = sourceAdvanceDirectory(info); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const ownerFile = join(directory,'owner.json'), wakeFile = join(directory,'wake.json'), lock = join(directory,'owner.guard.sqlite');
  const acquired = await withFileLock(lock, () => {
    const wake = readMainAudit(wakeFile);
    if (wake && (!Number.isSafeInteger(wake.generation) || wake.generation < 0 || wake.generation === Number.MAX_SAFE_INTEGER)) throw new Error('invalid source-advance wake');
    const generation = (wake?.generation ?? 0) + 1;
    saveMainAudit(wakeFile, { generation });
    const owner = readMainAudit(ownerFile);
    if (owner && ownerLive(owner)) return null;
    saveMainAudit(ownerFile, { pid: process.pid, started: processStart(process.pid), token });
    return generation;
  });
  if (acquired === null) return;
  const write = writer(root, services), visited = new Set();
  let generation = acquired;
  try {
    for (;;) {
      for (const job of snapshot(root, info, services)) {
        if (visited.has(job.key)) continue;
        visited.add(job.key);
        await advance(root, directory, job, write, services);
      }
      const next = await withFileLock(lock, () => {
        const owner = readMainAudit(ownerFile), wake = readMainAudit(wakeFile);
        if (owner?.pid !== process.pid || owner.token !== token) throw new Error('source-advance ownership changed');
        if (!Number.isSafeInteger(wake?.generation) || wake.generation < generation) throw new Error('invalid source-advance wake');
        if (wake.generation !== generation) return wake.generation;
        saveMainAudit(join(directory,'settled.json'), { generation, token });
        rmSync(ownerFile); return null;
      });
      if (next === null) return;
      generation = next;
    }
  } finally {
    await withFileLock(lock, () => { const owner = readMainAudit(ownerFile);
      if (owner?.pid === process.pid && owner.token === token) rmSync(ownerFile); });
  }
}
