/** Isolate speculative landing gates while their one parent retains the board lease [B3,V4]. */
import { spawn } from './windows-child-process.js';
import {
  join,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './board.js';
import {
  invalidateGitFacts,
  mainCheckout,
  repoInfo,
} from './git.js';
import { assertLandingLease } from './landing-lease.js';
import { Refused } from './refused.js';

const FILE = fileURLToPath(import.meta.url);

/** Recognize only the exact worktrees registered by an active canonical landing batch. */
export function landingBatchOwnsRoot(batch, root) {
  if (['landed', 'blocked'].includes(batch.state)) return false;
  return batch.root === root || (batch.parallelCandidates ?? []).some(candidate => candidate.snapshot?.root === root
    && candidate.snapshot.base === batch.base && candidate.snapshot.branch === batch.branch);
}

/** Run one exact prefix in the existing guardian's process group, never publishing it. */
export async function runLandingCandidateWorker(options, { write, checkLease, say, onWait, onStart }) {
  const child = spawn(process.execPath, [FILE, 'candidate'], {
    cwd: options.root, env: process.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let value;
  let failure;
  let stderr = '';
  const pending = new Set();
  child.stderr.setEncoding('utf8').on('data', text => { stderr = (stderr + text).slice(-65536); });
  /** Answer only this owned child, keeping every canonical move in the lease-owning parent. */
  const answer = (id, result, error) => {
    if (child.connected) child.send({ type: 'answer', id, value: result,
      error: error ? { code: error.code ?? 'LAND_CANDIDATE', message: error.message } : null }, () => {});
  };
  child.on('message', message => {
    if (message.type === 'result') { value = message.value; return; }
    if (message.type === 'failure') { failure = new Refused(message.code, message.message); return; }
    if (message.type === 'say') { say(message.text); return; }
    if (message.type !== 'call') return;
    /** Expose the same narrow receipt operations as an ordinary gate, with virtual batch saves. */
    const act = async () => {
      await checkLease();
      if (message.operation === 'check') return null;
      if (message.operation === 'wait') return await onWait?.(message.args[0]);
      if (!['recordLandingBatch', 'recordGateRun', 'recordFlakeObservation', 'claimGate', 'finishGate'].includes(message.operation)) {
        throw new Refused('LAND_CANDIDATE', 'a speculative gate requested a publishing operation; inspect the landing before adopting');
      }
      return await write(message.operation, message.args);
    };
    const request = act().then(result => answer(message.id, result), error => answer(message.id, null, error));
    pending.add(request);
    void request.finally(() => pending.delete(request));
  });
  const terminal = new Promise(resolveClose => {
    child.once('error', error => { failure = error; });
    child.once('close', (code, signal) => resolveClose({ code, signal }));
  });
  await new Promise((resolveSpawn, reject) => { child.once('spawn', resolveSpawn); child.once('error', reject); });
  try {
    await onStart?.(child.pid);
    await checkLease();
    child.send({ type: 'start', options }, error => { if (error) failure ??= error; });
  } catch (error) {
    // A child waiting for its initial message has no gate or Git descendants to interrupt.
    child.disconnect();
    await terminal;
    throw error;
  }
  const status = await terminal;
  await Promise.allSettled(pending);
  if (failure) throw failure;
  if (status.code !== 0 || status.signal || value === undefined) {
    throw new Refused('LAND_CANDIDATE', `a speculative gate stopped without a result; inspect its saved checkpoint${stderr ? ': ' + stderr.trim() : ''}`);
  }
  return value;
}

/** Execute only through an owned IPC channel; a candidate can ask its parent, never publish. */
function candidateMain(options) {
  let next = 0;
  const pending = new Map();
  /** Ask the current landing owner to fence and acknowledge one operation. */
  const call = (operation, args = []) => new Promise((resolveAnswer, reject) => {
    const id = ++next;
    pending.set(id, { resolveAnswer, reject });
    process.send({ type: 'call', id, operation, args }, error => {
      if (error) { pending.delete(id); reject(error); }
    });
  });
  process.on('message', message => {
    if (message.type !== 'answer') return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Refused(message.error.code, message.error.message));
    else request.resolveAnswer(message.value);
  });
  /** Recheck authority synchronously immediately before a physical Git action. */
  const checkLeaseNow = board => {
    if (!options.fence) return;
    assertLandingLease(board, options.fence);
    invalidateGitFacts();
    if (mainCheckout(options.root)?.branch !== options.fence.branch) {
      throw new Refused('LAND_LEASE_LOST', 'the trunk branch changed while a candidate waited; inspect the landing before adopting');
    }
  };
  /** Keep the shared board read-only here; all receipts are acknowledged through the parent. */
  const run = async () => {
    const board = store.openBoardForRead(join(repoInfo(options.root).commonDir, 'pullboard', 'board.sqlite'));
    if (!board) throw new Refused('LAND_CANDIDATE', 'the candidate cannot read its landing board; restore it before adopting');
    try {
      const { runLandingCandidate } = await import('./land.js');
      return await runLandingCandidate({ ...options, board,
        write: (operation, args) => call(operation, args),
        claimGate: (tree, plan) => call('claimGate', [tree, plan]),
        finishGate: (tree, gate) => call('finishGate', [tree, gate]),
        checkLease: async () => { await call('check'); invalidateGitFacts(); checkLeaseNow(board); },
        checkLeaseNow: () => checkLeaseNow(board),
        say: text => process.send({ type: 'say', text }),
        onWait: state => call('wait', [state]),
      });
    } finally { store.closeBoard(board); }
  };
  void run().then(value => process.send({ type: 'result', value }, () => process.disconnect()), error => {
    process.exitCode = 1;
    process.send({ type: 'failure', code: error.code ?? 'LAND_CANDIDATE', message: error.message }, () => process.disconnect());
  });
}

if (process.argv[1] && resolve(process.argv[1]) === FILE && process.argv[2] === 'candidate' && process.send) {
  let started = false;
  process.on('disconnect', () => { if (!started) process.exitCode = 1; });
  process.once('message', message => {
    if (message.type !== 'start') { process.disconnect(); return; }
    started = true;
    candidateMain(message.options);
  });
}
