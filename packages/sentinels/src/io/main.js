import {
  sentinelDraftNeeds,
  sentinels,
} from "../../../store/index.js";
/** Person-approved board watches and their append-only run history [A6,D1,D3]. */
import { createHash } from 'node:crypto';
import { atomic } from "../../../store/index.js";
import { listAgents } from "../../../store/index.js";
import { logEvent } from "../../../store/index.js";
import { PERSON } from "../../../store/index.js";
import { shout } from "../../../store/index.js";
import { ENGINE_VERSION } from "../../../state/index.js";
import { Refused } from "../../../kernel/index.js";

/** Coordinator allocation, 18 Oct: all new board-watch moves begin here [H16]. */
import { BOARD_SENTINEL_ENGINE } from "../../../state/light.js";
export { BOARD_SENTINEL_ENGINE } from "../../../state/light.js";
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const INTERVALS = Object.freeze({ '10m': 600_000, hourly: 3_600_000, daily: 86_400_000 });

/** Normalize the exact row the person approves; no execution settings live outside its digest. */
export function sentinelDefinition(value) {
  if (!value || typeof value.name !== 'string' || !NAME.test(value.name) || typeof value.check !== 'string' || !value.check.trim()
      || value.check.length > 8_192 || typeof value.every !== 'string' || !Object.hasOwn(INTERVALS, value.every)
      || typeof value.owner !== 'string' || !value.owner.trim() || /\s/u.test(value.owner)) {
    throw new Refused('BAD_SENTINEL', 'name a watch, its check, owner and --every 10m, hourly or daily: pullboard sentinel propose <name> --check "<command>" --owner <seat or lane> --every 10m');
  }
  const directory = value.directory ?? '.';
  if (typeof directory !== 'string' || !directory || directory.startsWith('/') || directory.includes('\\')
      || directory.split('/').some(part => part === '..') || /[\r\n\0]/u.test(directory)) {
    throw new Refused('BAD_SENTINEL', 'use a working directory inside this project with --directory <relative path>');
  }
  const timeoutMs = value.timeoutMs ?? 30_000; // budget: default hang ceiling for an approved external check.
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) {
    throw new Refused('BAD_SENTINEL', 'set --timeout to a whole number of milliseconds from 100 through 300000');
  }
  const next = value.next ?? `inspect the check and propose a repair for sentinel ${value.name}`;
  if (typeof next !== 'string' || !next.trim() || next.length > 1_024 || /[\r\n\0]/u.test(next)) {
    throw new Refused('BAD_SENTINEL', 'give one readable next step with --next "<what to do>"');
  }
  return { name: value.name, check: value.check, directory, every: value.every, owner: value.owner,
    timeoutMs, next: next.trim() };
}

/**
 * The evidence a proposal cites, kept beside the row and outside its digest: the person approves the watch,
 * and the evidence says why it was proposed (#776). A Rigor draft cites its repeated cause, the items it
 * failed on and the red and green commits that prove its check; an agent's own proposal cites none.
 */
export function sentinelEvidence(value) {
  if (value === undefined || value === null) return null;
  const commit = (side) => side && typeof side.commit === 'string' && /^[0-9a-f]{7,64}$/u.test(side.commit) && Number.isSafeInteger(side.exit);
  if (typeof value !== 'object' || typeof value.key !== 'string' || !value.key.trim() || value.key.length > 512
      || !Array.isArray(value.items) || value.items.length > 100 || value.items.some(item => !Number.isSafeInteger(item?.id))
      || !Number.isSafeInteger(value.occurrences) || value.occurrences < 0
      || value.proof !== undefined && !(value.proof && typeof value.proof.check === 'string' && commit(value.proof.red) && commit(value.proof.green))) {
    throw new Refused('BAD_SENTINEL', 'a sentinel cites its evidence as a repeated cause, its items and a proven check; draft it with pullboard rigor draft <key> --sentinel');
  }
  return { key: value.key, items: value.items.map(item => ({ id: item.id, commits: Array.isArray(item.commits) ? item.commits.filter(commit => typeof commit === 'string').slice(0, 20) : [] })),
    occurrences: value.occurrences, ...(value.proof ? { proof: { check: value.proof.check,
      red: { commit: value.proof.red.commit, exit: value.proof.red.exit }, green: { commit: value.proof.green.commit, exit: value.proof.green.exit } } } : {}) };
}

/** A watch name for a repeated cause: lower case, safe characters, at most 64 long. */
export function rigorSentinelName(key) {
  const slug = String(key).toLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/^[^a-z0-9]+|-+$/gu, '');
  return ('rigor-' + slug).slice(0, 64).replace(/[-._]+$/u, '');
}

export { sentinelDraftNeeds } from "../../../store/index.js";

/** Bind approval to every execution and notification field, including schedule and timeout. */
export function sentinelDigest(value) {
  return createHash('sha256').update(JSON.stringify(sentinelDefinition(value))).digest('hex');
}

export { sentinels } from "../../../store/index.js";

/** All mutations retain their allocated replay minimum and require a registered actor. */
function requireSentinelActor(board, agentId, person = false) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < BOARD_SENTINEL_ENGINE) {
    throw new Refused('ENGINE_VERSION', `board watches require engine ${BOARD_SENTINEL_ENGINE}; upgrade Pullboard`);
  }
  if (person ? agentId !== PERSON : !listAgents(board).some(agent => agent.agent_id === agentId)) {
    throw new Refused(person ? 'B26_PERSON_APPROVAL' : 'NOT_JOINED', person
      ? 'only the person approves or declines a sentinel; use their terminal or Pullboard View'
      : 'join this board before proposing or running a sentinel: pullboard join <lane>');
  }
}

/** Read one current proposal, refusing a replaced approval or run receipt before any mutation. */
function currentSentinel(board, name, digest) {
  const row = sentinels(board).find(entry => entry.name === name);
  if (!row || row.digest !== digest) throw new Refused('STALE_SENTINEL', 'read the current proposal with pullboard sentinels; the person approves its exact command, directory and schedule');
  return row;
}

/** Propose or replace a watch; every replacement becomes pending and loses all prior approval. */
export function proposeSentinel(board, { agentId, row: value, evidence: cited }) {
  return atomic(board, () => {
    requireSentinelActor(board, agentId);
    const row = sentinelDefinition(value);
    const evidence = sentinelEvidence(cited);
    const agents = listAgents(board);
    if (row.owner !== 'coordinator' && !agents.some(agent => [agent.agent_id, agent.agent_lane].includes(row.owner))) {
      throw new Refused('BAD_SENTINEL', 'choose the coordinator, a registered seat or a lane as the sentinel owner');
    }
    const digest = sentinelDigest(row);
    logEvent(board, agentId, 'sentinel-proposal', null, { row, digest, engine: BOARD_SENTINEL_ENGINE, ...(evidence ? { evidence } : {}) });
    return sentinels(board).find(entry => entry.name === row.name);
  });
}

/** Approve or decline precisely the row the person saw, through the same person channels as spec rows. */
export function decideSentinel(board, { agentId, channel, name, digest, decision, reason = '' }) {
  return atomic(board, () => {
    requireSentinelActor(board, agentId, true);
    if (!['terminal', 'view'].includes(channel)) throw new Refused('B26_PERSON_CHANNEL', 'sentinel decisions use the person’s terminal or Pullboard View');
    if (!['approve', 'decline'].includes(decision) || typeof reason !== 'string'
        || /[\r\n]/u.test(reason) || decision === 'decline' && !reason.trim()) {
      throw new Refused('BAD_SENTINEL', 'approve the current sentinel, or decline it with --reason "<why>"');
    }
    const row = currentSentinel(board, name, digest);
    if (decision === 'approve' && row.status === 'approved') return row;
    logEvent(board, PERSON, 'sentinel-decision', null, { name, digest, decision, reason: reason.trim(), channel, engine: BOARD_SENTINEL_ENGINE });
    return sentinels(board).find(row => row.name === name);
  });
}

/** Apply the same cadence and live-run rules to a notice and an atomic run claim. */
function isDue(row, now) {
  return row.status === 'approved' && !(row.activeRun && Date.parse(row.activeRun.until) > now)
    && !(row.lastRun && !row.lastRun.aborted && Date.parse(row.lastRun.at) + INTERVALS[row.every] > now);
}

/** List due watches without starting a command or consuming a run lease. */
export function dueSentinels(board) {
  const now = board.clock.now().getTime();
  return sentinels(board).filter(row => isDue(row, now));
}

/** Atomically claim a due approved check, so simultaneous scheduled workers cannot run it twice. */
export function beginSentinelRun(board, { agentId, name, digest, run }) {
  return atomic(board, () => {
    requireSentinelActor(board, agentId);
    const row = currentSentinel(board, name, digest);
    const now = board.clock.now().getTime();
    if (typeof run !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/u.test(run)) throw new Refused('BAD_SENTINEL', 'start a sentinel with a unique run id');
    if (!isDue(row, now)) return null;
    const until = new Date(now + row.timeoutMs + 10_000).toISOString(); // budget: command hang ceiling plus exact-child shutdown grace.
    logEvent(board, agentId, 'sentinel-start', null, { name, digest, run, until, engine: BOARD_SENTINEL_ENGINE });
    return { ...row, run, until };
  });
}

/** Keep completed receipts small and internally consistent before writing any event or consuming a lease. */
function completedWatchResult(value) {
  const fields = ['green', 'code', 'timedOut', 'signal', 'aborted', 'durationMs', 'output'];
  const result = value && {
    green: value.green, code: value.code, timedOut: value.timedOut,
    signal: value.signal ?? null, aborted: value.aborted ?? false,
    durationMs: value.durationMs, output: value.output,
  };
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))
      || typeof result.green !== 'boolean' || typeof result.timedOut !== 'boolean' || typeof result.aborted !== 'boolean'
      || result.code !== null && (!Number.isInteger(result.code) || result.code < 0 || result.code > 255)
      || result.signal !== null && (typeof result.signal !== 'string' || !/^SIG[A-Z0-9]+$/u.test(result.signal) || result.code !== null)
      || !Number.isFinite(result.durationMs) || result.durationMs < 0 || typeof result.output !== 'string' || result.output.length > 16_384
      || result.green !== (result.code === 0 && !result.timedOut && !result.aborted && result.signal === null)) {
    throw new Refused('BAD_SENTINEL', 'record a completed check with its exit status, bounded final output, timeout and elapsed time');
  }
  return result;
}

/** Retain every red receipt for Rigor, but notify the owner only on the red/green transitions. */
export function finishSentinelRun(board, { agentId, name, digest, run, result }) {
  return atomic(board, () => {
    requireSentinelActor(board, agentId);
    const row = currentSentinel(board, name, digest);
    if (row.status !== 'approved' || row.activeRun?.id !== run || row.activeRun.by !== agentId) {
      throw new Refused('STALE_SENTINEL', 'this sentinel run no longer owns the approved proposal; read pullboard sentinels and retry when due');
    }
    result = completedWatchResult(result);
    logEvent(board, agentId, 'sentinel-run', null, { name, digest, run, result, engine: BOARD_SENTINEL_ENGINE });
    if (!result.green && !result.aborted) logEvent(board, 'sentinel', 'sentinel-failure', null, {
      name, digest, run, cause: `sentinel:${name}`, engine: BOARD_SENTINEL_ENGINE,
    });
    const previous = row.history.findLast(entry => !entry.aborted);
    if (!result.aborted && (!result.green && previous?.green !== false || result.green && previous?.green === false)) {
      const cleared = result.green;
      const text = `${cleared ? 'Cleared' : 'Sentinel failed'}: ${name}\n${row.check}\n${result.output || '(no output)'}\nNext: ${row.next}`;
      shout(board, { from: 'sentinel', to: row.owner, text, lanes: [...new Set(listAgents(board).map(agent => agent.agent_lane))] });
    }
    return sentinels(board).find(entry => entry.name === name);
  });
}
