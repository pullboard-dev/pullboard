/**
 * Following the relay's order (#1013): catch-up applies the relay's records to this board, and a send posts one
 * sealed move as its actor. Built over relay.js's own link and transport helpers, which it cannot import without a
 * cycle, as the checkpoint publisher is.
 */
import { join } from 'node:path';
import * as store from '../../../../store/index.js';
import * as conflictRecords from './conflict.js';
import {
  appliedSequence,
  engineReceipt,
} from '../../../../state/index.js';
import { restoreRelaySnapshot } from '../../../../store/index.js';
import {
  codeIsFromMain,
  repoInfo,
} from '../../../../git/index.js';
import { refusalFromReceipt } from '../../../../state/index.js';
import { Refused } from '../../../../kernel/index.js';
import { readBoardKey } from '../../../../keys/index.js';
import {
  outboxAhead,
  outboxParkedOnly,
  outboxWaiting,
} from '../relay.js';
import { withOutboxGuard } from './guard.js';
import {
  actorTransport,
  cacheSeatToken,
  nameNextSeat,
  seatReceipt,
} from '../../../../link/index.js';

/**
 * Build catch-up and send over relay.js's helpers.
 *
 * @param {{ request: Function, localRecords: Function, decoded: Function, replayRelayRecord: Function,
 *   reportRecoveredReply: Function, saveLink: Function, sealedRecord: Function, flush: Function, openBoard: Function }} relay
 * @returns {{ applyRecords: Function, fetchCheckpoint: Function, catchUp: Function, postPending: Function, sendPending: Function }}
 */
export function relayOrdering({ request, localRecords, decoded, replayRelayRecord, reportRecoveredReply, saveLink, sealedRecord, flush, openBoard }) {
  if (typeof openBoard !== 'function') throw new TypeError('relay ordering requires its actual native board opener');
  /** Apply authenticated relay records in order, each in its own board transaction with a durable receipt. */
  async function applyRecords(root, key, state, records, io) {
    const outcomes = [];
    for (const record of records) {
      const board = openBoard(join(repoInfo(root).commonDir, 'pullboard', 'board.sqlite'), undefined, { isMain: codeIsFromMain(), gitRoot: root });
      try { outcomes.push(await replayRelayRecord(board, key, state, record, io)); } finally { store.closeBoard(board); }
    }
    return outcomes;
  }

  /** Read and authenticate the relay's checkpoint without touching the board; the caller restores it. */
  async function fetchCheckpoint(state, io, key, senderPolicy) {
    const document = await request(state, '/api/v1/boards/' + state.board + '/state', {}, io);
    const snapshot = document.state;
    if (!snapshot || !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0) throw new Refused('RELAY_RESPONSE', 'the relay snapshot has no valid coverage sequence; fetch it again');
    const senderProblem = senderPolicy.relaySenderProblem(null, snapshot.sender, 'snapshot');
    if (senderProblem) throw senderProblem;
    return { native: await decoded(key, snapshot, state, 'snapshot', snapshot.sequence), sequence: snapshot.sequence };
  }

  /** Most catch-up passes one command makes when moves keep queuing on this machine meanwhile. */
  const CATCH_UP_PASSES = 10;

  /** Apply a validated relay prefix with durable, transaction-bound receipts on this replica. */
  async function catchUp(root, file, state, io, senderPolicy, pass = 0) {
    if (pass >= CATCH_UP_PASSES) throw new Refused('RELAY_BUSY', 'moves kept queuing on this machine while it caught up; they stay queued for the next send');
    // Queued moves sit on top of this board: the outbox rebuilds it from the relay's order with them on top (#1013).
    if (outboxAhead(state) || outboxWaiting(file)) await flush(root, file, state, io, senderPolicy);
    // Only parked moves are left: the flush already brought this board to the relay's order with them on top, and
    // another machine's moves must not land under them until pullboard relay recover resolves them (#6693).
    if (outboxParkedOnly(file)) return;
    const key = readBoardKey(state.board);
    const after = localRecords(root, appliedSequence);
    let remote;
    try { remote = await request(state, '/api/v1/boards/' + state.board + '/events?after=' + after, {}, io); }
    catch (error) {
      if (error.code !== 'SNAPSHOT_REQUIRED') throw error;
      const checkpoint = await fetchCheckpoint(state, io, key, senderPolicy);
      const restored = await withOutboxGuard(file, () => {
        if (outboxWaiting(file)) return false;
        localRecords(root, (board) => restoreRelaySnapshot(board, checkpoint.native, checkpoint.sequence));
        return true;
      });
      if (!restored) return catchUp(root, file, state, io, senderPolicy, pass + 1);
      if (localRecords(root, appliedSequence) <= after) throw new Refused('RELAY_RESPONSE', 'the relay checkpoint did not advance the missing prefix; fetch a consistent newer snapshot');
      return catchUp(root, file, state, io, senderPolicy, pass);
    }
    if ([remote.warning, ...(remote.warnings ?? [])].some((warning) => warning?.code === 'KEY_REQUESTS')) io.keyRequestsWaiting = true;
    // A recovery replaced the checkpoint at a sequence this machine already holds, so the log shows nothing new: take it (#7776).
    if (Number.isSafeInteger(remote.checkpointEpoch) && remote.checkpointEpoch > (state.checkpointEpoch ?? 0)) {
      const checkpoint = await fetchCheckpoint(state, io, key, senderPolicy);
      const restored = await withOutboxGuard(file, () => {
        if (outboxWaiting(file)) return false;
        localRecords(root, (board) => restoreRelaySnapshot(board, checkpoint.native, checkpoint.sequence));
        return true;
      });
      if (!restored) return catchUp(root, file, state, io, senderPolicy, pass + 1);
      state.checkpointEpoch = remote.checkpointEpoch;
      state.sequence = localRecords(root, appliedSequence);
      saveLink(file, state);
      return catchUp(root, file, state, io, senderPolicy, pass);
    }
    if (!Array.isArray(remote.events) || remote.events.some((record, index) => !record || record.event_id !== after + index + 1 || !['move', 'request'].includes(record.kind) || typeof record.sealed !== 'string')) {
      throw new Refused('RELAY_RESPONSE', 'the relay returned an invalid ordered prefix; fetch a consistent relay snapshot');
    }
    // Another machine's moves land only on a board with nothing queued on top; a move may have queued meanwhile.
    const outcomes = await withOutboxGuard(file, async () => {
      if (outboxWaiting(file) || localRecords(root, appliedSequence) !== after) return null;
      return applyRecords(root, key, state, remote.events, io);
    });
    if (!outcomes) return catchUp(root, file, state, io, senderPolicy, pass + 1);
    let pendingRefusal;
    remote.events.forEach((record, index) => {
      const outcome = outcomes[index];
      // Exact ciphertext identifies an interrupted send even when its document was refused before replay.
      if (record.kind === 'move' && state.pending?.move && record.event_id === state.pending.sequence
          && record.sealed === state.pending.sealed && outcome?.error
          && !localRecords(root, board => engineReceipt(board, state.pending.move.id))) {
        pendingRefusal = outcome.error;
        reportRecoveredReply(state.pending, io);
        delete state.pending;
        delete state.recovered;
      }
    });
    state.sequence = localRecords(root, appliedSequence);
    if (state.pending?.move && localRecords(root, (board) => engineReceipt(board, state.pending.move.id))) {
      reportRecoveredReply(state.pending, io);
      state.recovered = state.pending;
      delete state.pending;
    }
    saveLink(file, state);
    if (pendingRefusal) throw refusalFromReceipt(pendingRefusal);
  }

  /**
   * Post one sealed move to the relay as its actor, renewing an expired seat token once and taking the next free seat
   * name for a registration the relay already gave out. Network only: it applies nothing, so the outbox can send a
   * move while this machine's board still shows its queued moves on top (#1013).
   */
  async function postPending(root, file, state, pending, io, senderPolicy) {
    let renewedAgentToken = false;
    for (let tries = 0; tries < 100; tries += 1) {
      const actor = senderPolicy.credentialActor(pending.move);
      try {
        const transport = await conflictRecords.transport(root, pending.move,
          (checkout, move) => localRecords(checkout, board => board.enginePorts.requirePreparedComputedConflict(
            board, move.args[0], move.args[1].agentId, move.args[1].computedConflict)),
          () => actorTransport(root, file, state, actor, io));
        const reply = await request(transport, '/api/v1/boards/' + state.board + '/moves', { method: 'POST',
          body: { sequence: pending.sequence, sealed: pending.sealed, ...(pending.registration ? { registration: pending.registration } : {}) } }, io);
        if (reply.event?.event_id !== pending.sequence || reply.event.sealed !== pending.sealed) throw new Refused('RELAY_RESPONSE', 'the relay acknowledgement differs from this executable send; fetch the configured relay');
        if (pending.registration) {
          const enrollment = reply.enrollment;
          if (!enrollment || enrollment.board !== state.board || enrollment.agent !== pending.registration.target || typeof enrollment.id !== 'string') {
            throw new Refused('RELAY_RESPONSE', 'the relay registered the seat without its issuance; repeat this command to recover its token');
          }
          // A retried registration returns the same issuance without a token; its creator reissues it on first use.
          if (enrollment.token !== undefined) cacheSeatToken(file, state, pending.registration.target, enrollment);
        }
        return;
      } catch (error) {
        if (error.code === 'AUTH_REQUIRED' && !renewedAgentToken && actor !== 'machine' && actor !== 'person'
            && process.env.PULLBOARD_RELAY_TOKEN === undefined && state.agentTokens?.[actor]?.token) {
          // An expired cache renews only through the seat's creator; a live one the relay refused was revoked.
          if (state.agentTokens[actor].expires > Date.now()) {
            state.agentTokens[actor].revoked = true;
            saveLink(file, state);
            throw new Refused('TOKEN_REVOKED', `the relay token of ${actor} was revoked on this board; work from a seat with its own token, or ask the coordinator for a fresh worktree`);
          }
          delete state.agentTokens[actor].token;
          saveLink(file, state);
          renewedAgentToken = true;
          continue;
        }
        if (error.code === 'SEAT_TAKEN' && pending.registration) {
          // The relay already gave this name a token (a machine first mint): take the next free name.
          nameNextSeat(root, pending.move, Number(pending.move.args[0].id.slice(pending.move.args[0].lane.length + 1)) + 1, io);
          pending.sealed = await sealedRecord(readBoardKey(state.board), pending.move, state, 'move', pending.sequence);
          pending.registration = seatReceipt(pending.move, pending.sequence, pending.sealed);
          saveLink(file, state);
          continue;
        }
        throw error;
      }
    }
    throw new Refused('RELAY_BUSY', 'the relay kept refusing this seat name; retry this command after other clients finish');
  }

  /** Finish a durable executable send; a collision reseals its unchanged id after applying the winner. */
  async function sendPending(root, file, state, io, senderPolicy) {
    for (let tries = 0; state.pending && tries < 100; tries += 1) {
      try { await postPending(root, file, state, state.pending, io, senderPolicy); }
      catch (error) {
        if (!['SEQUENCE_REPEAT', 'SEQUENCE_GAP'].includes(error.code)) throw error;
        await catchUp(root, file, state, io, senderPolicy);
        if (state.pending) {
          state.pending.sequence = state.sequence + 1;
          if (state.pending.registration) nameNextSeat(root, state.pending.move, 0, io);
          state.pending.sealed = await sealedRecord(readBoardKey(state.board), state.pending.move, state, 'move', state.pending.sequence);
          state.pending.registration = seatReceipt(state.pending.move, state.pending.sequence, state.pending.sealed);
          saveLink(file, state);
        }
        continue;
      }
      await catchUp(root, file, state, io, senderPolicy);
    }
    if (state.pending) throw new Refused('RELAY_BUSY', 'the relay order stayed busy; retry this command after other clients finish');
  }

  return { applyRecords, fetchCheckpoint, catchUp, postPending, sendPending };
}
