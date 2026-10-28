/** Finite autonomous main-merge work uses ordinary admission, native receipts and ordered writes [C7,V4,H16]. */
import { copyFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import * as store from './board.js';
import { context } from './cli.js';
import { ordered } from './cli.js';
import { withBoard } from './cli.js';
import { codeIsFromMain } from './git.js';
import { gitChildEnv } from './git.js';
import { repoInfo } from './git.js';
import { runSubmitGate } from './gate.js';
import { frozenCheck } from './trusted-policy.js';
import { mainPolicy } from './trusted-policy-read.js';
import { captureSourceAdvanceBasis } from './source-advance-origin.js';
import { prepareSourceAdvance } from './source-advance-origin.js';
import { prepareSourceAdvanceReturn } from './source-advance-origin.js';
import { withSourceComposition } from './source-advance-compose.js';
import { withFileLock } from './relay-outbox-guard.js';
import { readMainAudit } from './main-audit-state.js';
import { saveMainAudit } from './main-audit-state.js';
import { landingLeaseState } from './landing-lease.js';

/** Read immutable Git facts with a bounded child; never execute repository hooks. */
function git(root, args) {
  return execFileSync('git', args, { cwd: root, env: gitChildEnv(root), encoding: 'utf8', timeout: 30000 }).trim();
}

/** The private advisory folder is repository-owned and contains no new board authority. */
export function sourceAdvanceDirectory(info) { return join(info.commonDir, 'pullboard', 'source-advances'); }

/** Read a short native snapshot and close its connection before tests, admission or network work. */
function readBoard(info, work) {
  const board = store.openBoardForRead(join(info.commonDir, 'pullboard', 'board.sqlite'));
  if (!board) throw new Error('source-advance board is unavailable');
  try { return work(board); } finally { store.closeBoard(board); }
}

/** Native writes always use the accepted coordinator context and normal ordered sender binding. */
function writer(root) {
  const ctx = context({ cwd: root, say() {}, err() {}, stderr: { write() {} } });
  return work => withBoard(ctx, board => work(board, (operation, args) => ordered(ctx, board, operation, args)));
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
function snapshot(root, info) {
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
  });
}

/** Exact readonly eligibility probe used by the foreground nudge before it spawns a worker. */
export function hasSourceAdvanceJobs(root, info = repoInfo(root)) {
  if (snapshot(root, info).length > 0) return true;
  const directory = sourceAdvanceDirectory(info);
  if (!existsSync(directory)) return false;
  const ownerFile = join(directory, 'owner.json'), wakeFile = join(directory, 'wake.json');
  // An empty current snapshot does not erase an already-issued wake. Let the
  // serialized owner settle that generation before treating the repository as idle.
  if (existsSync(ownerFile)) return true;
  if (!existsSync(wakeFile)) return false;
  const wake = readMainAudit(wakeFile), settled = readMainAudit(join(directory, 'settled.json'));
  if (!Number.isSafeInteger(wake?.generation) || wake.generation < 0) return true;
  return !Number.isSafeInteger(settled?.generation) || settled.generation < wake.generation;
}

/** Signal incomplete work once through the ordinary item thread without a self-shout or fabricated authority. */
async function incomplete(write, file, job, reason) {
  const saved = readMainAudit(file) ?? {};
  saveMainAudit(file, { ...saved, state: 'incomplete', reason: String(reason).slice(0,2000) });
  if (saved.notified) return;
  await write(async (_board, order) => order('appendFact', [job.item.item_id, { agentId: 'coordinator', kind: 'measurement',
    text: `Automatic main merge is incomplete at ${job.basis.trunk}: ${String(reason).slice(0,300)}. No new source or verdict was endorsed.` }]));
  saveMainAudit(file, { ...readMainAudit(file), notified: true });
}

/** Retain the actual raw phase logs and profiles before removing their private Git directory. */
function retainArtifacts(directory, job, gate, composition) {
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
async function advance(root, directory, job, write) {
  const file = join(directory, `${job.key}.json`);
  const old = readMainAudit(file);
  if (old) return; // Unknown/crashed or logically incomplete work is not a hot retry on every health wake.
  saveMainAudit(file, { version: 1, item: job.item.item_id, basis: job.basis, state: 'pending' });
  if (job.error) { await incomplete(write, file, job, job.error); return; }
  let entered = false;
  try {
    await withSourceComposition(root, job.basis.inputHead, job.basis.trunk, async (composition, custody) => {
      entered = true;
      saveMainAudit(file, { ...readMainAudit(file), state: 'running', directory: composition.directory, head: composition.head, tree: composition.tree });
      const policy = mainPolicy(root);
      if (policy.commit !== job.basis.trunk) throw new Error('main changed before source-advance admission');
      const config = policy.config;
      custody.started();
      const gate = await runSubmitGate(composition.directory, config, { base: composition.inputHead, changed: composition.changed,
        check: frozenCheck(job.item), agent: 'coordinator', item: String(job.item.item_id), sourceAdvance: true,
        proofContext: { item: job.item.item_id, frozenDigest: job.basis.bar, seat: 'coordinator', kind: 'submit' } });
      if (!gate.cleanupUnverified && !(gate.profile?.landingShards?.unverified?.length > 0)) custody.terminal();
      const artifacts = retainArtifacts(directory, job, gate, composition);
      const result = await write(async (board, order) => {
        const request = gate.isGreen ? prepareSourceAdvance(root, board, job.item, composition, gate, job.basis)
          : prepareSourceAdvanceReturn(root, board, job.item, job.basis, { composition, gate });
        for (const receiptId of gate.proofReceiptIds.filter(Boolean)) await order('recordProofRun', [{ agentId: 'coordinator', itemId: job.item.item_id, receiptId }]);
        git(root, ['update-ref', `refs/pullboard/items/${job.item.item_id}/${composition.head.slice(0,12)}`, composition.head]);
        return gate.isGreen ? order('advanceItemSource', [job.item.item_id, request]) : order('reopen', [job.item.item_id, request]);
      });
      saveMainAudit(file, { ...readMainAudit(file), state: gate.isGreen ? 'advanced' : 'returned', result,
        receiptIds: gate.proofReceiptIds.filter(Boolean), artifacts });
    });
  } catch (error) {
    if (!entered && error.code === 'MERGE_CONFLICT' && error.files?.length) {
      try {
        const result = await write((board, order) => order('reopen', [job.item.item_id,
          prepareSourceAdvanceReturn(root, board, job.item, job.basis)]));
        saveMainAudit(file, { ...readMainAudit(file), state: 'returned', files: error.files, result });
        return;
      } catch (returned) { error = returned; }
    }
    await incomplete(write, file, job, error.message);
  }
}

/** Drain each wake generation once; no timer daemon, time stealing or parallel gate runs are introduced. */
export async function runSourceAdvances(root, token) {
  const info = repoInfo(root);
  if (!info.isMain || !codeIsFromMain() || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(token ?? '')) return;
  // A wake with no source obligations must be observationally inert. A successful CLI
  // command can start this worker just before its caller removes a private fixture repo;
  // creating advisory state before discovering an empty snapshot races that cleanup.
  // The serialized snapshot below remains authoritative for every real job.
  if (!hasSourceAdvanceJobs(root, info)) return;
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
  const write = writer(root), visited = new Set();
  let generation = acquired;
  try {
    for (;;) {
      for (const job of snapshot(root, info)) {
        if (visited.has(job.key)) continue;
        visited.add(job.key);
        await advance(root, directory, job, write);
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
