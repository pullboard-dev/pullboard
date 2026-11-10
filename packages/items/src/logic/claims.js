import { takeoverReady } from "../../../seats/browser.js";
/** Durable first-refusal windows for reopened work [B13,B5]. */
import { Refused } from "../../../kernel/light.js";


/** Give the original builder first refusal while preserving every ordinary claim guard. */
export function firstRefusalProblem(board, id, agentId, ports) {
  const reason = firstRefusalReason(board, id, agentId, ports);
  return reason ? new Refused('REOPEN_HELD_FOR_BUILDER', reason) : null;
}

/**
 * Explain ineligible build work without raising an item refusal from review selection. The optional seatGone port
 * ends a builder's first-refusal window early when that builder's seat is gone (#3447).
 */
export function firstRefusalReason(board, id, agentId, { firstRefusal, exitContinuationProblem, otherBuilderFirst = false, offering = false, seatGone }) {
  const continuation = exitContinuationProblem?.(board, id, agentId);
  if (continuation) return continuation.message;
  const window = firstRefusal(board, id);
  if (window?.otherSeatFirst && otherBuilderFirst) {
    // A reviewer of this item never gets the first refusal; the original builder may re-claim, since no one else is held off [B4,B5].
    const reviewed = board.db.prepare("SELECT 1 FROM event WHERE item_id=? AND event_by=? AND event_kind IN ('accept','reject','reserve') LIMIT 1").get(id, agentId);
    if (reviewed) return `item #${id} returned for lack of progress; a reviewer of it cannot take the first refusal; take another item`;
    // Offering skips the original builder so another seat is asked first; an explicit claim by the builder still works [B4,B5].
    return offering && window.builder === agentId
      ? `item #${id} returned for lack of progress; another seat is offered it first until ${window.until}; claim it by id to take it back` : null;
  }
  if (window?.otherSeatFirst) return window.builder === agentId
    ? `item #${id} returned for lack of progress; another seat gets first refusal until ${window.until}; take another item` : null;
  // The window protects a builder who can still come back; a gone seat never will, so it ends at once (#3447).
  // Heartbeats are private local state, so an ordered (sealed) move keeps the recorded window, as liveRouteProblem does.
  const builderGone = board.executionEngineVersion === undefined && Boolean(window) && seatGone?.(board, window.builder) === true;
  return window && window.builder !== agentId && !takeoverReady(board, id) && !builderGone
    ? `item #${id} waits for ${window.builder} until ${window.until}; claim it after that time, or ask its builder to release it`
    : null;
}

/** Freeze an enabled reservation into the return event so replicas need no local configuration. */
export function firstRefusalDetail(board, item, minutes, at) {
  if (minutes === undefined || minutes === 0 || !item.item_built_by) return {};
  const until = (at ?? board.clock.now()).getTime() + minutes * 60_000;
  if (!Number.isSafeInteger(minutes) || minutes < 0 || !Number.isFinite(until) || Math.abs(until) > 8_640_000_000_000_000) {
    throw new Refused('BAD_CONFIG', 'claim.reopenFirstRefusalMinutes must be a non-negative whole number within the supported date range; set it to 0 to disable');
  }
  return { reopenFirstRefusal: { builder: item.item_built_by, until: new Date(until).toISOString() } };
}

/** Record one notice in the same transaction as the return and its frozen window. */
export function tellFirstRefusal(board, item, detail, persistShout) {
  const window = detail.reopenFirstRefusal;
  if (window) persistShout(board, { from: 'coordinator', to: window.builder,
    text: `Item #${item.item_id} waits for you until ${window.until}; claim it to resume, or run pullboard release ${item.item_id} --reason ROUTED_ELSEWHERE to let another builder take it.` });
}

/**
 * Copy only enabled coordinator policy into ordered moves before they are sealed for replay. With claim.returnToBoard
 * on, a reject seals zero minutes, so the rejected work goes back to the board with no builder first refusal (#3541).
 *
 * @param {string} operation the ordered move
 * @param {any[]} args its arguments
 * @param {any} config the coordinator's configuration
 * @returns {any[]} the arguments to seal
 */
export function firstRefusalArgs(operation, args, config) {
  if (config.claim?.returnToBoard === true && operation === 'verify' && args[1]?.decision === 'REJECT') {
    return [args[0], { ...args[1], reopenFirstRefusalMinutes: 0 }, ...args.slice(2)];
  }
  const minutes = config.claim?.reopenFirstRefusalMinutes;
  if (!minutes || !['verify', 'reopen'].includes(operation)) return args;
  if (operation === 'verify' && args[1]?.decision !== 'REJECT') return args;
  return [args[0], { ...args[1], reopenFirstRefusalMinutes: minutes }, ...args.slice(2)];
}



/** Read a quoted test name and its end offset, refusing malformed escapes or multiline text. */
function quotedLandingTestName(text, start) {
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (character === '\r' || character === '\n') return null;
    if (escaped) { escaped = false; continue; }
    if (character === '\\') { escaped = true; continue; }
    if (character !== '"') continue;
    let name;
    try { name = JSON.parse(text.slice(start, index + 1)); }
    catch { return null; }
    if (typeof name !== 'string' || !name.trim() || /[\r\n]/u.test(name)) return null;
    return { name, end: index + 1 };
  }
  return null;
}

/** Parse the manual failure list when its sealed move declares quoted names. */
function quotedManualLandingFailure(failureText, mergeCommit) {
  const tests = [];
  let offset = 0;
  while (offset < failureText.length) {
    const entry = /^(?<file>(?:[\w.-]+\/)*[\w.-]+\.[a-z0-9]+):[ \t]*/iu.exec(failureText.slice(offset));
    if (!entry) return null;
    offset += entry[0].length;
    let name;
    if (failureText[offset] === '"') {
      const quoted = quotedLandingTestName(failureText, offset);
      if (!quoted) return null;
      name = quoted.name;
      offset = quoted.end;
      while (failureText[offset] === ' ' || failureText[offset] === '\t') offset += 1;
    } else {
      const separator = failureText.indexOf(';', offset);
      const end = separator < 0 ? failureText.length : separator;
      name = failureText.slice(offset, end).trim();
      offset = end;
    }
    if (!name.trim() || /[\r\n]/u.test(name)) return null;
    tests.push({ file: entry.groups.file, name });
    if (offset === failureText.length) break;
    if (failureText[offset] !== ';') return null;
    offset += 1;
    while (failureText[offset] === ' ' || failureText[offset] === '\t') offset += 1;
    if (offset === failureText.length) return null;
  }
  return tests.length ? { tests, mergeCommit } : null;
}

/** Read test and merge-commit evidence from a hand-written landing note without checking Git. */
export function manualLandingFailure(note, { quoted = false } = {}) {
  const generatedPrefix = /^Landing batch [a-z0-9_-]{1,80} failed /iu.exec(note);
  const body = generatedPrefix ? note.slice(generatedPrefix[0].length) : note;
  const evidence = body.match(/;[ \t]*merge commit[ \t]+(?<mergeCommit>[a-f0-9]{40}|[a-f0-9]{64})$/iu);
  if (!evidence) return null;
  const failureText = body.slice(0, evidence.index);
  if (quoted) return quotedManualLandingFailure(failureText, evidence.groups.mergeCommit);
  const firstTest = /(?<file>(?:[\w.-]+\/)*[\w.-]+\.[a-z0-9]+):[ \t]*/iu.exec(failureText);
  if (!firstTest) return null;
  const tests = failureText.slice(firstTest.index).split(/;[ \t]*/u).map((entry) => {
    const test = entry.match(/^(?<file>(?:[\w.-]+\/)*[\w.-]+\.[a-z0-9]+):[ \t]*(?<name>[^;\r\n]+)$/iu);
    if (!test || !test.groups.name.trim()) return null;
    return { file: test.groups.file, name: test.groups.name.trim() };
  });
  if (!tests.length || tests.some((test) => !test)) return null;
  return { tests, mergeCommit: evidence.groups.mergeCommit };
}


/** Refusal codes raised by the runner stage of submit: the gate and the frozen check. */
const RUNNER_STAGE_CODES = new Set(['GATE_RED', 'CHECK_RED', 'TEST_FAILURE']);

/** Derive progress from native moves: renewals and notes never restart the two-hour submit clock [B4,B5]. */
export function claimProgress(board, item, now, { runnerOnly = false } = {}) {
  const history = board.db.prepare('SELECT event_id,event_at,event_by,event_kind,event_detail FROM event WHERE item_id=? ORDER BY event_id').all(item.item_id);
  let holder = null, since = null, failures = 0;
  const notes = [];
  for (const event of history) {
    const detail = JSON.parse(event.event_detail);
    if (event.event_kind === 'claim') {
      if (holder !== event.event_by) { holder = event.event_by; since = event.event_at; failures = 0; }
      since ??= event.event_at;
    }
    if (event.event_kind === 'fact' && event.event_by === item.item_owner && detail.kind === 'note') notes.push(detail.id);
    if (event.event_kind === 'submit') since = null;
    if (event.event_kind === 'accept') failures = 0;
    // From the returns engine on, only the runner stage counts: a fast-stage refusal (conflict, lint, cuts, static) is fixed in minutes [B4,B5].
    const real = !runnerOnly || (RUNNER_STAGE_CODES.has(detail.submitOutcome?.code) && detail.submitOutcome?.stage !== 'fast');
    if ((detail.submitOutcome && real && event.event_by === item.item_owner) || (event.event_kind === 'reject' && holder === item.item_owner)) failures += 1;
    if (['release', 'withdraw', 'merged'].includes(event.event_kind) && !detail.review) { holder = null; since = null; failures = 0; }
  }
  const elapsed = now - Date.parse(since);
  const trigger = failures >= 3 ? 'three failed submits in a row' : Number.isFinite(elapsed) && elapsed >= 7_200_000 ? 'two hours without a new submit' : null;
  return { trigger, since, failures, notes };
}
