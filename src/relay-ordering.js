/**
 * Following the relay's order (#1013): catch-up applies the relay's records to this board, and a send posts one
 * sealed move as its actor. Built over relay.js's own link and transport helpers, which it cannot import without a
 * cycle, as the checkpoint publisher is.
 */
import { join } from 'node:path';
import * as store from './board.js';
import * as conflictRecords from './relay-conflict-record.js';
import {
  appliedSequence,
  engineReceipt,
} from './engine.js';
import { exportBoard, importBoard, restoreRelaySnapshot } from './exchange.js';
import { ENGINE_VERSION } from './machine.js';
import {
  codeIsFromMain,
  repoInfo,
} from './git.js';
import { refusalFromReceipt } from './recorded-refusal.js';
import { Refused } from './refused.js';
import { readBoardKey } from './relay-key.js';
import {
  outboxAhead,
  outboxWaiting,
} from './relay-outbox.js';
import { withOutboxGuard } from './relay-outbox-guard.js';
import {
  actorTransport,
  cacheSeatToken,
  nameNextSeat,
  seatReceipt,
} from './relay-seats.js';
import {
  credentialActor,
  relaySenderProblem,
} from './relay-sender.js';

/**
 * Build catch-up and send over relay.js's helpers.
 *
 * @param {{ request: Function, localRecords: Function, decoded: Function, replayRelayRecord: Function,
 *   reportRecoveredReply: Function, saveLink: Function, sealedRecord: Function, flush: Function }} relay
 * @returns {{ applyRecords: Function, advanceCheckpoint: Function, fetchCheckpoint: Function, catchUp: Function, postPending: Function, sendPending: Function }}
 */
export function relayOrdering({ request, localRecords, decoded, replayRelayRecord, reportRecoveredReply, saveLink, sealedRecord, flush }) {
  /** Apply authenticated relay records in order, each in its own board transaction with a durable receipt. */
  async function applyRecords(root, key, state, records) {
    const outcomes = [];
    for (const record of records) {
      const board = store.openBoard(join(repoInfo(root).commonDir, 'pullboard', 'board.sqlite'), undefined, { isMain: codeIsFromMain(), gitRoot: root });
      try { outcomes.push(await replayRelayRecord(board, key, state, record)); } finally { store.closeBoard(board); }
    }
    return outcomes;
  }

  /** Reconstruct a covering checkpoint in isolation; never roll the live board back or send a move. */
  async function advanceCheckpoint(key, state, checkpoint, records, minimum) {
    const meta = new Map((checkpoint.native?.tables?.board_meta ?? []).map(row => [row.meta_key, row.meta_value]));
    if (meta.get('board_id') !== state.board || !Number.isSafeInteger(checkpoint.sequence)
        || checkpoint.sequence < 0 || String(checkpoint.sequence) !== meta.get('relay_applied_sequence')) {
      throw new Refused('RELAY_SNAPSHOT', 'the checkpoint does not identify this board and prefix; keep the local board and fetch a consistent checkpoint');
    }
    const engine = Number(meta.get('relay_engine_version'));
    if (!Number.isSafeInteger(engine) || engine < 1 || engine > ENGINE_VERSION) {
      throw new Refused('ENGINE_VERSION', 'the checkpoint needs another supported engine; keep the local board and use that engine before recovery');
    }
    if (!Number.isSafeInteger(minimum) || minimum < checkpoint.sequence || !Array.isArray(records)
        || records.some((record, index) => record?.event_id !== checkpoint.sequence + index + 1)
        || (records.at(-1)?.event_id ?? checkpoint.sequence) < minimum) {
      throw new Refused('RELAY_OUTBOX', 'the authenticated checkpoint history does not cover the current prefix; keep the local board and obtain its missing ordered records');
    }
    const board = store.openBoard(':memory:');
    try {
      importBoard(board, checkpoint.native);
      for (const record of records) {
        await replayRelayRecord(board, key, state, record);
        if (appliedSequence(board) !== record.event_id) {
          throw new Refused('RELAY_RESPONSE', 'checkpoint replay did not advance to its ordered record; keep the local board and inspect that record');
        }
      }
      return { native: exportBoard(board), sequence: appliedSequence(board), reconstructed: true };
    } finally { store.closeBoard(board); }
  }

  /** Read and authenticate the relay's checkpoint without touching the board; the caller restores it. */
  async function fetchCheckpoint(state, io, key) {
    const document = await request(state, '/api/v1/boards/' + state.board + '/state', {}, io);
    const snapshot = document.state;
    if (!snapshot || !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0) throw new Refused('RELAY_RESPONSE', 'the relay snapshot has no valid coverage sequence; fetch it again');
    const senderProblem = relaySenderProblem(null, snapshot.sender, 'snapshot');
    if (senderProblem) throw senderProblem;
    return { native: await decoded(key, snapshot, state, 'snapshot', snapshot.sequence), sequence: snapshot.sequence };
  }

  /** Most catch-up passes one command makes when moves keep queuing on this machine meanwhile. */
  const CATCH_UP_PASSES = 10;

  /** Apply a validated relay prefix with durable, transaction-bound receipts on this replica. */
  async function catchUp(root, file, state, io, pass = 0) {
    if (pass >= CATCH_UP_PASSES) throw new Refused('RELAY_BUSY', 'moves kept queuing on this machine while it caught up; they stay queued for the next send');
    // Queued moves sit on top of this board: the outbox rebuilds it from the relay's order with them on top (#1013).
    if (outboxAhead(state) || outboxWaiting(file)) await flush(root, file, state, io);
    const key = readBoardKey(state.board);
    const after = localRecords(root, appliedSequence);
    let remote;
    try { remote = await request(state, '/api/v1/boards/' + state.board + '/events?after=' + after, {}, io); }
    catch (error) {
      if (error.code !== 'SNAPSHOT_REQUIRED') throw error;
      const checkpoint = await fetchCheckpoint(state, io, key);
      const restored = await withOutboxGuard(file, () => {
        if (outboxWaiting(file)) return false;
        localRecords(root, (board) => restoreRelaySnapshot(board, checkpoint.native, checkpoint.sequence));
        return true;
      });
      if (!restored) return catchUp(root, file, state, io, pass + 1);
      if (localRecords(root, appliedSequence) <= after) throw new Refused('RELAY_RESPONSE', 'the relay checkpoint did not advance the missing prefix; fetch a consistent newer snapshot');
      return catchUp(root, file, state, io, pass);
    }
    if ([remote.warning, ...(remote.warnings ?? [])].some((warning) => warning?.code === 'KEY_REQUESTS')) io.keyRequestsWaiting = true;
    if (!Array.isArray(remote.events) || remote.events.some((record, index) => !record || record.event_id !== after + index + 1 || !['move', 'request'].includes(record.kind) || typeof record.sealed !== 'string')) {
      throw new Refused('RELAY_RESPONSE', 'the relay returned an invalid ordered prefix; fetch a consistent relay snapshot');
    }
    // Another machine's moves land only on a board with nothing queued on top; a move may have queued meanwhile.
    const outcomes = await withOutboxGuard(file, async () => {
      if (outboxWaiting(file) || localRecords(root, appliedSequence) !== after) return null;
      return applyRecords(root, key, state, remote.events);
    });
    if (!outcomes) return catchUp(root, file, state, io, pass + 1);
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
  async function postPending(root, file, state, pending, io) {
    let renewedAgentToken = false;
    for (let tries = 0; tries < 100; tries += 1) {
      const actor = credentialActor(pending.move);
      try {
        const transport = await conflictRecords.transport(root, pending.move, localRecords, () => actorTransport(root, file, state, actor, io));
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
          nameNextSeat(root, pending.move, Number(pending.move.args[0].id.slice(pending.move.args[0].lane.length + 1)) + 1);
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
  async function sendPending(root, file, state, io) {
    for (let tries = 0; state.pending && tries < 100; tries += 1) {
      try { await postPending(root, file, state, state.pending, io); }
      catch (error) {
        if (!['SEQUENCE_REPEAT', 'SEQUENCE_GAP'].includes(error.code)) throw error;
        await catchUp(root, file, state, io);
        if (state.pending) {
          state.pending.sequence = state.sequence + 1;
          if (state.pending.registration) nameNextSeat(root, state.pending.move, 0);
          state.pending.sealed = await sealedRecord(readBoardKey(state.board), state.pending.move, state, 'move', state.pending.sequence);
          state.pending.registration = seatReceipt(state.pending.move, state.pending.sequence, state.pending.sealed);
          saveLink(file, state);
        }
        continue;
      }
      await catchUp(root, file, state, io);
    }
    if (state.pending) throw new Refused('RELAY_BUSY', 'the relay order stayed busy; retry this command after other clients finish');
  }

  return { applyRecords, advanceCheckpoint, fetchCheckpoint, catchUp, postPending, sendPending };
}
