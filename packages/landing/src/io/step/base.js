import * as store from '../../../../store/index.js';

/**
 * The commit a batch gates on. With landing.pipeline on, a batch gates on main plus the merge of the newest earlier-started
 * batch still in flight on its branch, so batch N+1 proves the tree that exists once batch N lands. Off, or with none in
 * flight, it is the batch's own base, main as the caller recorded it, which is today's one-at-a-time landing.
 * Why: two batches gate side by side, and without this N+1 proves a tree that never exists once N has landed [C7,#3155,#8937].
 *
 * @param {{ config: object, board: object }} state
 * @param {{ id: string, branch: string, base: string, startedAt?: string }} batch
 * @param {{ batches?: () => object[] }} [options] The recorded batches; the board's by default.
 * @returns {string} The commit to gate the batch on.
 */
export function pipelineBase(state, batch, { batches = () => store.landingBatches(state.board) } = {}) {
  if (state.config?.landing?.pipeline !== true || !Number.isFinite(Date.parse(batch.startedAt ?? ''))) return batch.base;
  const started = other => Date.parse(other.startedAt ?? '');
  const below = batches().filter(other => other.id !== batch.id && other.branch === batch.branch && typeof other.tip === 'string' && other.tip
    && !['landed', 'blocked'].includes(other.state) && Number.isFinite(started(other))
    && (started(other) < started(batch) || started(other) === started(batch) && other.id < batch.id));
  below.sort((a, b) => started(b) - started(a) || (a.id < b.id ? 1 : -1));
  return below[0]?.tip ?? batch.base;
}
