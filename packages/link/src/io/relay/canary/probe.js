/** A bounded ordinary sealed-move round trip on a person-linked canary board [H2,H15,C7]. */
import { randomUUID } from 'node:crypto';
import * as store from '../../../../../store/index.js';
import { engineReceipt } from '../../../../../state/index.js';
import { requireSupportedEngine } from '../../../../../state/index.js';
import { ENGINE_VERSION } from '../../../../../state/index.js';
import { repoInfo } from '../../../../../git/index.js';
import { relayLinkFile } from '../../../../../store/index.js';
import { actorTransport } from '../seats.js';
import { localRecords } from '../../relay.js';
import { relayMachineContext } from '../../relay.js';
import { relayOperation } from '../../relay.js';
import { request } from '../../relay.js';
import { readBoardKey } from '../../../../../keys/index.js';
import { unseal } from '../../../../../kernel/index.js';
import { Refused } from '../../../../../kernel/light.js';

/** Keep the recorded result bounded and credential-free, even for unexpected errors. */
function safeCode(error) {
  return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/u.test(error.code)
    ? error.code : 'RELAY_CANARY_FAILURE';
}

/** Verify the exact returned sealed move, not a local write or a successful health response. */
async function verifyReturnedMove(root, state, remote, expected, io) {
  if (!Array.isArray(remote.events)) throw new Refused('RELAY_RESPONSE', 'the canary pull returned no event list');
  const matches = remote.events.filter(record => record.event_id === expected.sequence);
  if (matches.length !== 1 || matches[0].kind !== 'move') {
    throw new Refused('RELAY_RESPONSE', 'the canary pull did not return the exact acknowledged move');
  }
  const record = matches[0];
  if (typeof record.sealed !== 'string') throw new Refused('RELAY_RESPONSE', 'the canary move has no sealed bytes');
  const sealed = Buffer.from(record.sealed, 'base64url');
  if (!sealed.length || sealed.toString('base64url') !== record.sealed) {
    throw new Refused('RELAY_RESPONSE', 'the canary move has invalid sealed bytes');
  }
  expected.stage('unseal');
  const plain = await unseal(readBoardKey(state.board), sealed,
    { boardId: state.board, kind: 'move', sequence: record.event_id });
  expected.stage('version');
  let move;
  try { move = JSON.parse(new TextDecoder().decode(plain)); }
  catch { throw new Refused('RELAY_MOVE', 'the canary move is not a supported sealed document'); }
  if (move?.version !== 1 || !Number.isSafeInteger(move.engine) || move.engine < 1) {
    throw new Refused('RELAY_MOVE', 'the canary move format is unsupported');
  }
  requireSupportedEngine(move);
  const shout = move.args?.[0];
  if (move.id !== expected.moveId || move.operation !== 'shout' || move.actor !== expected.agentId
    || shout?.from !== expected.agentId || shout.to !== 'coordinator' || shout.text !== expected.text
    || move.engine > ENGINE_VERSION) {
    throw new Refused('RELAY_RESPONSE', 'the canary returned a different move or nonce');
  }
  const receipt = localRecords(io.openBoard, root, board => engineReceipt(board, move.id));
  if (!receipt || receipt.sequence !== expected.sequence || receipt.outcome?.error) {
    throw new Refused('RELAY_RESPONSE', 'the canary has no successful native receipt for its returned move');
  }
}

/**
 * Exercise saved authentication, ordinary actor push, fresh pull and device-only unsealing under one deadline.
 * A failed probe may already have recorded its nonce; the next run finishes that exact receipt before a fresh nonce.
 */
export async function probeRelayCanary(root, { agentId, deadlineMs = 5000, io = {}, clock = () => Date.now() } = {}) {
  const started = clock();
  const at = new Date(started).toISOString();
  let step = 'sign-in', relayVersion = null, sequence = null, moveId = null;
  const controller = new AbortController();
  /** Stop this probe's own I/O when its watch is shutting down. */
  const stop = () => controller.abort();
  if (io.relaySignal?.aborted) stop();
  io.relaySignal?.addEventListener('abort', stop, { once: true });
  let timer;
  /** Enforce the absolute deadline between local phases as well as inside requests and lock waits. */
  function remaining() {
    const left = deadlineMs - (clock() - started);
    if (controller.signal.aborted || left <= 0) throw new Refused('RELAY_CANARY_DEADLINE', 'the relay canary deadline elapsed');
    return Math.max(1, Math.ceil(left));
  }
  /** Bound the public result to protocol facts; never retain error messages, tokens or key material. */
  function result(ok, code) {
    return { at, ok, step: ok ? 'complete' : step, code, roundTripMs: Math.max(0, clock() - started),
      relayVersion, sequence, moveId };
  }
  try {
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 2_147_483_647) {
      throw new Refused('RELAY_CANARY_CONFIG', 'configure a positive bounded canary deadline');
    }
    timer = setTimeout(() => controller.abort(), deadlineMs);
    let state = relayMachineContext(root);
    if (!state || state.unlinking || state.environment) {
      throw new Refused('RELAY_OFF', 'link this dedicated canary board through the person before probing it');
    }
    const actor = localRecords(io.openBoard, root, board => store.listAgents(board).find(agent => agent.agent_id === agentId));
    if (!actor || actor.agent_lane === 'coordinator') {
      throw new Refused('NOT_JOINED', 'join an ordinary noncoordinator seat on the dedicated canary board');
    }
    if (!Number.isSafeInteger(state.sequence) || state.sequence < 0) {
      throw new Refused('RELAY_STORAGE', 'restore the canary link sequence before probing it');
    }
    const probeIo = Object.create(io);
    Object.assign(probeIo, { relayCanary: true, relaySignal: controller.signal, stderr: io.stderr ?? { write() {} },
      stdout: io.stdout ?? { write() {} }, err: io.err ?? (() => {}), say: io.say ?? (() => {}) });
    Object.defineProperty(probeIo, 'relayTimeoutMs', { get: remaining });
    Object.defineProperty(probeIo, 'relayLockWaitMs', { get: remaining });
    /** Observe the actual transport phase without affecting routing, credential choice or responses. */
    probeIo.onRelayRequest = ({ method, path }) => {
      remaining();
      if (path.startsWith('/auth/')) step = 'sign-in';
      else if (method === 'GET' && /\/(?:events|state)(?:\?|$)/u.test(path)) step = 'pull';
      else if (method === 'POST' && path.endsWith('/moves')) step = 'push';
      io.onRelayRequest?.({ method, path });
    };
    const transport = await actorTransport(root, relayLinkFile(repoInfo(root).commonDir), state, agentId, probeIo);
    const signed = await request(transport, '/auth/session?board=' + state.board, { signal: controller.signal }, probeIo);
    relayVersion = signed.version;
    if (signed.session?.kind !== 'board' || signed.session.agent !== agentId) {
      throw new Refused('RELAY_ACTOR', 'the canary sign-in does not belong to its configured seat');
    }
    const interrupted = state.pending?.move ?? state.recovered?.move;
    if (interrupted) {
      const prior = interrupted.args?.[0];
      if (interrupted.operation !== 'shout' || interrupted.actor !== agentId || prior?.from !== agentId
        || prior.to !== 'coordinator' || !/^Relay canary [a-f0-9-]{36}$/u.test(prior.text ?? '')) {
        throw new Refused('RELAY_RETRY_PENDING', 'finish the interrupted ordinary command before probing this canary board');
      }
      // Receive the original outcome through normal replay; this is not the fresh probe's health evidence.
      remaining();
      await relayOperation(root, interrupted.operation, interrupted.args, probeIo);
      state = relayMachineContext(root);
    }
    const text = 'Relay canary ' + randomUUID();
    let verified;
    /** Inspect each durable acknowledgement once, before legitimate checkpoint compaction. */
    probeIo.onRelayMoveRecorded = ({ moveId: recordedId, sequence: recordedSequence }) => {
      if (verified) return verified;
      moveId = recordedId; sequence = recordedSequence;
      verified = (async () => {
        remaining(); step = 'pull';
        if (!Number.isSafeInteger(recordedSequence) || recordedSequence < 1) {
          throw new Refused('RELAY_RESPONSE', 'the canary acknowledgement has no positive native receipt sequence');
        }
        // Ordinary replay already caught up peer checkpoints; only the acknowledged nonce must remain in this fresh pull.
        const pulled = await request(transport, '/api/v1/boards/' + state.board + '/events?after=' + (recordedSequence - 1),
          { signal: controller.signal }, probeIo);
        relayVersion = pulled.version;
        await verifyReturnedMove(root, state, pulled, { moveId, sequence, agentId, text,
          stage(value) { remaining(); step = value; } }, probeIo);
        remaining();
      })();
      return verified;
    };
    remaining(); step = 'push';
    await relayOperation(root, 'shout', [{ from: agentId, to: 'coordinator', text, lanes: [] }], probeIo);
    if (!verified) throw new Refused('RELAY_RESPONSE', 'the canary write was not acknowledged by the relay');
    await verified;
    remaining();
    return result(true, 'OK');
  } catch (error) {
    if (['RELAY_VERSION', 'ENGINE_VERSION', 'SEAL_VERSION'].includes(error?.code)) step = 'version';
    else if (/^SEAL_/u.test(error?.code ?? '') || error?.code === 'RELAY_KEY_MISSING') step = 'unseal';
    if (Number.isSafeInteger(error?.relayVersion)) relayVersion = error.relayVersion;
    return result(false, controller.signal.aborted ? 'RELAY_CANARY_DEADLINE' : safeCode(error));
  } finally {
    clearTimeout(timer);
    io.relaySignal?.removeEventListener('abort', stop);
  }
}
