/** Decide a first board upload whose outcome was lost, before any move may commit outside relay order (#919). */
import { Refused } from '../../../../kernel/index.js';
import { transientRelayFailure } from '../../../../link/index.js';

/**
 * How long an undecided upload is probed, how often the waiting command says so, and the pause between probes.
 * Why: the criterion bounds the wait at 2 minutes; one probe may still run its own 10 s transport ceiling
 * after the last start, so probing stops at 110 s.
 */
const SETTLE_WAIT_MS = 110000;
const SETTLE_PROGRESS_MS = 10000;
const SETTLE_RETRY_MS = 2000;

/**
 * Whether a failed first-upload send leaves its outcome unknown: no reply, a reply that is no acknowledgement,
 * a gateway that may have forwarded it, or an error raised by this client after the request went out.
 * Why: a relay that answers with its own refusal did not store the board, but a lost reply says nothing,
 * and treating it as "not accepted" let a move commit outside an order the relay already had (#919).
 */
export function uncertainUploadFailure(error) {
  if (!(error instanceof Refused)) return true;
  if (error.transportFailure || error.code === 'RELAY_RESPONSE') return true;
  return [502, 504].includes(error.httpStatus);
}

/** Whether a state read is the relay's authenticated statement that it holds no board here. */
export function remoteBoardMissing(error) {
  return error?.httpStatus === 404 && error.relayVersion === 1 && ['NO_BOARD', 'NO_SNAPSHOT'].includes(error.code);
}

/**
 * Probe the relay until it says whether it holds this board's pending first snapshot: 'accepted' when its state
 * is that exact sealed snapshot at sequence 0, 'absent' when it holds no board, 'other' for any other state.
 * A relay that keeps failing to answer ends in one RELAY_BASELINE_UNCERTAIN refusal naming the cause and the retry.
 * Why: the caller holds the link lock, so the decision is made once, here, instead of by a later local guess.
 */
export async function settleUncertainBaseline(state, io, read) {
  const startedAt = Date.now();
  const wait = io?.relayUncertainWaitMs ?? SETTLE_WAIT_MS;
  const every = io?.relayUncertainProgressMs ?? SETTLE_PROGRESS_MS;
  const pause = io?.relayUncertainRetryMs ?? SETTLE_RETRY_MS;
  const seconds = (ms) => Math.round(ms / 1000);
  const progress = typeof io?.err === 'function'
    ? setInterval(() => io.err(`pullboard: checking whether the relay kept this board's first upload (${seconds(Date.now() - startedAt)} s of ${seconds(wait)} s)`), every)
    : null;
  let cause = 'no answer';
  try {
    for (;;) {
      try {
        const saved = (await read())?.state;
        return saved?.sequence === 0 && typeof saved.sealed === 'string' && saved.sealed === state.snapshot?.sealed ? 'accepted' : 'other';
      } catch (error) {
        if (remoteBoardMissing(error)) return 'absent';
        if (!transientRelayFailure(error)) throw error;
        cause = error.transportFailure ?? (Number.isInteger(error.httpStatus) ? `HTTP ${error.httpStatus}` : error.code);
      }
      if (Date.now() - startedAt + pause >= wait) break;
      await new Promise((resolve) => setTimeout(resolve, pause));
    }
  } finally {
    if (progress) clearInterval(progress);
  }
  throw new Refused('RELAY_BASELINE_UNCERTAIN', `the relay may already hold this board's first upload but did not say so within ${seconds(Date.now() - startedAt)} s (${cause}); the move was not saved, so run the command again when the relay answers`);
}

/**
 * Decide, under the link lock, whether the relay kept a first upload whose reply was lost: true when it holds
 * that exact snapshot, false when it holds no board; another board fences, and no answer refuses once.
 * Why: a client that only saw no reply cannot know the relay has no ordered history, so no move may commit
 * locally until this says so (#919). The link's own read, accept, fence, save and remember steps are passed in.
 */
export async function decideUncertainBaseline(state, io, link) {
  try {
    const verdict = await settleUncertainBaseline(state, io, link.read);
    if (verdict === 'other') link.fence();
    if (verdict === 'accepted') { link.accept(); return true; }
    delete state.baselineUncertain;
    link.save();
    return false;
  } catch (error) {
    link.remember(error);
    throw error;
  }
}
