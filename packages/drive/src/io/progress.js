/**
 * A pulled job's test progress, as runner serve posts it: the lines the run's progress reporter appends (one
 * `{ file, state }` per change) folded into files finished and failing so far and each file's state [P7].
 *
 * Why a file: the test runner sits behind the gate bootstrap's own processes and pipes, so a side file the runner
 * names by env is the one channel that reaches runner serve unchanged. Only repository-relative paths are kept.
 */
import { readFileSync } from 'node:fs';

/** The env var the run's progress reporter reads (packages/gate/src/io/test/progress.js says the same name). */
export const PROGRESS_ENV = 'PULLBOARD_TEST_PROGRESS';
// Budget: a post every 5 s keeps the live page near the run with at most 12 small writes a minute per job.
export const PROGRESS_MS = 5_000;
// Budget: the newest finished files a post lists; the live page shows 8.
const LATEST = 8;
// Budget: one post stays under the board's 60 KiB progress cap; past this many named files, green ones are dropped first.
const NAMED_FILES = 600;
const RELATIVE = /^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\0\n\r\\]{1,1024}$/u;
const STATES = new Set(['running', 'green', 'red']);

/**
 * Fold a progress file's text into the step a post carries, or null when no file has started.
 *
 * @param {string} text
 * @param {{ selected?: number | null }} [options] - selected: the job's named file count, when it names them.
 * @returns {{ selected: number | null, finished: number, failures: number, files: Record<string, string>, latest: string[] } | null}
 */
export function foldProgress(text, { selected = null } = {}) {
  const states = new Map(), finishedOrder = [];
  for (const line of String(text).split('\n')) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!RELATIVE.test(String(entry?.file ?? '')) || !STATES.has(entry.state)) continue;
    if (states.get(entry.file) === 'green' || states.get(entry.file) === 'red') continue;
    states.set(entry.file, entry.state);
    if (entry.state !== 'running') finishedOrder.push(entry.file);
  }
  if (!states.size) return null;
  const failures = finishedOrder.filter(file => states.get(file) === 'red').length;
  let named = [...states];
  if (named.length > NAMED_FILES) named = [...named.filter(([, state]) => state !== 'green'), ...named.filter(([, state]) => state === 'green').reverse()].slice(0, NAMED_FILES);
  return { selected: Number.isSafeInteger(selected) ? selected : null, finished: finishedOrder.length, failures,
    files: Object.fromEntries(named), latest: finishedOrder.slice(-LATEST).reverse() };
}

/**
 * Post a job's progress every `everyMs` while it runs, only when it changed; `stop` posts the last change and ends.
 * A post that fails is skipped: progress is a view, and the receipt is what counts.
 *
 * @param {{ file: string, selected?: number | null, post: (progress: object) => Promise<unknown>, everyMs?: number }} options
 * @returns {{ stop: () => Promise<void> }}
 */
export function watchProgress({ file, selected = null, post, everyMs = PROGRESS_MS }) {
  let last = '', posting = Promise.resolve();
  const tick = () => {
    posting = posting.then(async () => {
      let text = '';
      try { text = readFileSync(file, 'utf8'); } catch { return; }
      const progress = foldProgress(text, { selected });
      const said = JSON.stringify(progress);
      if (!progress || said === last) return;
      last = said;
      await post(progress).catch(() => { /* a skipped post; the next tick or the receipt follows */ });
    });
    return posting;
  };
  const timer = setInterval(tick, everyMs);
  return { stop: async () => { clearInterval(timer); await tick(); } };
}
