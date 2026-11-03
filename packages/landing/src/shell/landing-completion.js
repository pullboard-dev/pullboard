/** Account for complete native landing TAP streams without buffering their whole log [B3,C7]. */
import { closeSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { openSync } from 'node:fs';
import { readSync } from 'node:fs';

/** Read positive TAP completion counts while rejecting the canonical runner's incomplete accounts. */
function completionAccount(allowCancelled = false) {
  let early = false;
  let plan = null;
  let topLevel = 0;
  let counts = {};
  let prior = true;
  /** Require every completed TAP stream, not just the last appended phase, to account for its tests. */
  const finished = () => !early && Number.isSafeInteger(plan) && plan > 0 && plan === topLevel && Number.isSafeInteger(counts.tests)
    && Number.isSafeInteger(counts.pass) && Number.isSafeInteger(counts.fail) && (allowCancelled || (counts.cancelled ?? 0) === 0)
    && counts.pass + counts.fail + (allowCancelled ? counts.cancelled ?? 0 : 0) + (counts.skipped ?? 0) + (counts.todo ?? 0) === counts.tests;
  /** Recognize canonical incomplete accounts even when only a bounded line prefix is retained. */
  const markerPrefix = (text) => {
    if (/^(?:Landing gate stopped early after |Files not run: |Interrupted test files: )/u.test(text)) early = true;
  };
  return {
    markerPrefix,
    /** Consume one complete output line without retaining test output or diagnostic blocks. */
    line(text) {
      markerPrefix(text);
      if (/^TAP version \d+\s*$/u.test(text) && (plan !== null || topLevel || Object.keys(counts).length)) {
        prior = prior && finished(); plan = null; topLevel = 0; counts = {};
      }
      if (/^(?:not )?ok \d+\b/u.test(text)) topLevel++;
      const planned = /^1\.\.(\d+)\s*$/u.exec(text);
      if (planned) plan = Number(planned[1]);
      const count = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$/u.exec(text);
      if (count) counts[count[1]] = Number(count[2]);
    },
    /** A complete plan accounts for every test; only explicit known-main comparisons may account for cancelled children. */
    complete() {
      return prior && finished();
    },
  };
}

/** Require positive completion evidence; known-main comparisons may opt into fully counted cancellations, never interrupted files. */
export function completeGate(gate, { allowCancelled = false } = {}) {
  if (gate.complete === true || !allowCancelled && gate.complete === false) return gate.complete;
  const account = completionAccount(allowCancelled);
  if (typeof gate.output === 'string') {
    for (const line of gate.output.split('\n')) account.line(line);
    return account.complete();
  }
  if (!gate.logPath || !existsSync(gate.logPath)) return false;
  const input = openSync(gate.logPath, 'r');
  const chunk = Buffer.alloc(64 * 1024);
  let pending = '';
  let oversized = false;
  try {
    let count;
    while ((count = readSync(input, chunk, 0, chunk.length, null)) > 0) {
      const parts = chunk.toString('latin1', 0, count).split('\n');
      for (const [index, part] of parts.entries()) {
        if (index) {
          if (oversized) account.markerPrefix(pending);
          else account.line(pending);
          pending = ''; oversized = false;
        }
        if (pending.length + part.length > 256) oversized = true;
        pending += part.slice(0, 256 - pending.length);
      }
    }
    if (oversized) account.markerPrefix(pending);
    else account.line(pending);
    return account.complete();
  } finally { closeSync(input); }
}
