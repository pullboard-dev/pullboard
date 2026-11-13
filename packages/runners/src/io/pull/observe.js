/** What a pulled job's caller watches while it waits: its source folders and its item, as the controller did [C7,#5465]. */
import { runnerItemState } from '../../../../resources/index.js';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Watch one request's source identities and item, from the caller's own process.
 * Why: the old controller did this for the whole run in its observe(); a pulled job has no such process, so the waiter
 * calls this once per tick. The checks and the cancellation records are the controller's, unchanged.
 *
 * @param {string} root - The checkout the run belongs to.
 * @param {{ metadata?: { item?: string|number } }} options
 * @param {{ observationProblem(problem?: string): void }} custody - The caller-held lease custody.
 * @param {{ runnerItemState?: Function }} [ports]
 * @returns {() => ({ version: 1, reason: string, root: string, board?: string, item?: number } | null)} The cancellation record once one source or item change is seen.
 */
export function watchSource(root, options, custody, ports = {}) {
  const itemState = ports.runnerItemState ?? runnerItemState;
  const roots = [...new Set([root, fileURLToPath(new URL('../../../../../', import.meta.url))])];
  const identities = roots.map(entry => {
    try { const state = statSync(entry); return { root: entry, dev: state.dev, ino: state.ino }; }
    catch (error) { return { root: entry, error: error.code }; }
  });
  let item, cancellation = null;
  try {
    item = itemState(root, options.metadata?.item);
    const label = String(options.metadata?.item ?? ''), id = Number(label);
    if (!item && /^[1-9][0-9]*$/u.test(label) && Number.isSafeInteger(id)) {
      item = { item: id, board: null };
      custody.observationProblem('item status is unavailable');
    }
  } catch (error) {
    item = { item: Number(options.metadata?.item), board: null };
    custody.observationProblem(`initial item observation failed: ${error.code ?? error.name}`);
  }
  return () => {
    if (cancellation) return cancellation;
    for (const expected of identities) {
      let reason;
      try {
        const state = statSync(expected.root);
        if (expected.error || !state.isDirectory() || state.dev !== expected.dev || state.ino !== expected.ino) reason = 'source identity changed';
      } catch (error) { reason = `source observation failed: ${error.code}`; }
      if (reason) return (cancellation ??= { version: 1, reason, root: expected.root });
    }
    if (item) {
      let problem;
      try {
        const current = itemState(root, item.item);
        if (!current) problem = 'item status is unavailable';
        else if (current.item !== item.item || item.board && current.board !== item.board) problem = 'item board identity changed';
        else {
          if (!item.board) item = current;
          if (current.terminal) return (cancellation = { version: 1, reason: 'item is terminal', root, board: item.board, item: item.item });
        }
      } catch (error) { problem = `item observation failed: ${error.code ?? error.name}`; }
      custody.observationProblem(problem);
    }
    return null;
  };
}
