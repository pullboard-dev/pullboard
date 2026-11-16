import { nextStepFor } from '../../logic/step/words.js';
export {
  COORDINATOR_PERSON_REQUEST,
  NEXT_STEPS,
  nextStepFor,
  personRequestGuidance,
  personRequestStep,
} from '../../logic/step/words.js';
/**
 * The next step for every refusal code the CLI and API can raise (P4, W4).
 *
 * A raise site that knows more (an item id, a commit, a path) says so in its message or passes its
 * own step to Refused; this table is the step a refusal falls back to when it does neither, so no
 * refusal ends without one. Each step is a command or an action that gets past the rule, never a
 * step that leads straight back to the same refusal. apps/cli/journeys/submit/steps.test.js checks that
 * every code raised in src/ has a row here.
 */
import { Refused } from '../../../../../packages/kernel/index.js';
import {
  blockMoveKey,
  blockMoveKeys,
  blockOwner,
  recordBlock,
} from '../../../../../packages/items/index.js';
import { repoInfo } from '../../../../../packages/git/index.js';



/** Name open build lanes without claiming their work as the coordinator [N2,B26]. */
export function mainLaneWork(items) {
  const counts = new Map();
  for (const item of items) {
    if (item.item_status !== 'open' || item.item_lane === 'coordinator') continue;
    counts.set(item.item_lane, (counts.get(item.item_lane) ?? 0) + 1);
  }
  const lanes = [...counts].sort(([a], [b]) => a.localeCompare(b));
  if (!lanes.length) return null;
  return {
    summary: lanes.map(([lane, count]) => `${count} ${count === 1 ? 'item' : 'items'} open in lane ${lane}`).join('; '),
    next: `pullboard worktree ${lanes[0][0]} --model "<model name>"`,
  };
}

/** Preserve empty-queue refusals while sending a main-checkout newcomer to existing lane work. */
export function refuseNextIdle(io, reasons, displayed, { minutes, verify, laneWork, lane, route }) {
  const waited = minutes ? ` after ${minutes} minutes` : '';
  const repair = laneWork ? `. ${laneWork.summary}. Start there: ${laneWork.next}`
    : `${waited}. To keep looking: pullboard next ${verify ? '--verify' : '--take'}`;
  const scope = lane && route ? `lane ${lane}, route ${route}: ` : '';
  io.refusal?.(new Refused('NOTHING_FREE', scope + reasons.join('; ') + repair, laneWork?.next));
  io.err(`pullboard: [NOTHING_FREE] ${scope}${displayed.join('; ')}${repair}`);
  return 1;
}
import { existsSync } from 'node:fs';
import {
  basename,
  dirname,
  join,
} from 'node:path';

/** Give a separate agent session one pasteable startup line, without claiming or verifying for it [V1,B26]. */
export function reviewerStartup(root, config, id) {
  if (!root) return 'ask the coordinator to locate the main checkout for a different agent session; the reviewer must not be the builder';
  const lanes = Object.entries(config.lanes).filter(([name]) => name !== 'coordinator');
  const lane = lanes.find(([, value]) => !value.owns.length)?.[0] ?? lanes[0]?.[0];
  if (!lane) return 'ask the coordinator to declare a reviewer lane for a different agent session; the reviewer must not be the builder';
  /** Quote the whole path so spaces, apostrophes and dollar signs remain literal. */
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  /** Respect the configured placement while avoiding an existing checkout. */
  const location = number => config.worktrees === 'inside'
    ? join(root, '.claude', 'worktrees', `reviewer-${number}`)
    : join(dirname(root), `${basename(root)}-reviewer-${number}`);
  let number = 1;
  while (existsSync(location(number))) number++;
  const path = location(number);
  const command = `cd ${quote(root)} && mkdir -p ${quote(dirname(path))} && git worktree add --detach ${quote(path)} HEAD && cd ${quote(path)} && pullboard join ${lane} --model "<model name>" --family "<vendor family>" && pullboard next --verify${id ? ' ' + id : ''}`;
  return `Use a different agent session; the reviewer must not be the builder and must declare a different vendor family. Run: ${command}`;
}

/**
 * Name the pullboard command that makes a review seat, for the verify refusal in the main checkout [V1] (#7925).
 * Why: `pullboard worktree <lane>` creates and joins the seat and prints its path, so a new user never
 * hand-builds a worktree; --family is named only when the board requires a different vendor family.
 */
export function reviewerSeatStep(root, config, id) {
  if (!root) return 'ask the coordinator to locate the main checkout for a different agent session; the reviewer must not be the builder';
  const lanes = Object.entries(config.lanes).filter(([name]) => name !== 'coordinator');
  const lane = lanes.find(([, value]) => !value.owns.length)?.[0] ?? lanes[0]?.[0];
  if (!lane) return 'ask the coordinator to declare a reviewer lane for a different agent session; the reviewer must not be the builder';
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const family = config.verify?.family === 'require' ? ' --family "<vendor family>"' : '';
  return `Use a different agent session; the reviewer must not be the builder. Run: cd ${quote(root)} && pullboard worktree ${lane} --model "<model name>"${family}, then cd into the path it prints and run: pullboard next --verify${id ? ' ' + id : ''}`;
}

/** Refusals no move recovers from by itself: a typo is not Pullboard blocking anyone. */
const NOT_BLOCKS = new Set(['USAGE', 'UNKNOWN_COMMAND']);

/**
 * Who clears each refusal that is not the blocked agent's own to clear, by code, beside the steps
 * above: the person (a person-only move) or the coordinator. Every other code is the agent's.
 * apps/cli/journeys/health/blocks.test.js sends every person code here through to Needs you [C6,B26].
 *
 * @type {Readonly<Record<string, 'person'|'coordinator'|'either'>>}
 */
export const BLOCK_AUDIENCE = Object.freeze({
  AGENT_APPROVAL_REQUIRED: 'person',
  B26_PERSON_APPROVAL: 'person',
  B26_PERSON_CHANNEL: 'person',
  CHECK_ACCEPT_PERSON_ONLY: 'person',
  HUMAN_REQUIRED: 'person',
  LAND_PERSON_ONLY: 'person',
  NOT_APPROVER: 'person',
  PHONE_APPROVAL_PENDING: 'person',
  RELAY_PERSON_ONLY: 'person',
  RIGOR_PERSON_ONLY: 'person',
  B26_PERSON_ANSWER: 'coordinator',
  B26_PERSON_DECISION: 'coordinator',
  COORDINATOR_CHECK: 'coordinator',
  COORDINATOR_ONLY: 'coordinator',
  COORDINATOR_VERIFIES: 'coordinator',
  JOB_CADENCE_COORDINATOR_ONLY: 'coordinator',
  LAND_TIMEOUT_CUSTODY: 'coordinator',
  LAND_GATE_OUTPUT: 'coordinator',
  LAND_GATE_TIMEOUT: 'coordinator',
  SPEC_APPROVAL_BASELINE: 'coordinator',
  TOKEN_REVOKED: 'coordinator',
  // One code, two holders: the coordinator's own token is reissued by the person, a seat's by the coordinator.
  TOKEN_EXPIRED: 'either',
});

/**
 * Who can take a refusal's step, from its code alone. Only a code that serves both audiences
 * reads its message, and only to tell which of the two raised it.
 *
 * @param {string} code
 * @param {string} message
 * @returns {'person'|'coordinator'|'agent'}
 */
export function blockAudience(code, message) {
  const audience = BLOCK_AUDIENCE[code] ?? 'agent';
  if (audience !== 'either') return audience;
  return /\bthe coordinator relay token\b/iu.test(message) ? 'person' : 'coordinator';
}

/** Plain words: no bracketed rule code, no backticks, one line [P4]. */
function plain(text) {
  return String(text).split('\n')[0].replace(/\[[A-Z][A-Z0-9_]*\]\s*/gu, '').replaceAll('`', '').replace(/\s+/gu, ' ').trim();
}

/**
 * One block from a refusal that stopped a command: its code, command, who was stopped, who can
 * clear it, and a plain one-line reason and step. Null for a usage slip, which blocks nobody.
 *
 * @param {{ code?: string, message: string, next?: string }} error
 * @param {{ command: string, by: string, path: string, at: Date, caller?: string }} context
 */
export function blockNotice(error, { command, by, path, at, caller }) {
  const code = typeof error?.code === 'string' ? error.code : 'INTERNAL';
  if (NOT_BLOCKS.has(code)) return null;
  const message = String(error.message).replace(/^\[[A-Z][A-Z0-9_]*\] /u, '');
  const step = plain(nextStepFor(error, message, { caller }));
  const first = plain(message);
  const cut = first.indexOf(step.slice(0, 24));
  const reason = (cut > 0 ? first.slice(0, cut) : first).replace(/[\s;:,.]+$/u, '') || first;
  const audience = blockAudience(code, message);
  // The person never needs to know how the relay works: a relay token is their sign-in [C6].
  const said = audience === 'person' ? reason.replace(/\b(?:the )?coordinator relay token\b/giu, 'your sign-in for the coordinator').replace(/\brelay token\b/giu, 'sign-in') : reason;
  return { at: at.toISOString(), code, command: `pullboard ${command}`.trim(), by, path, audience, reason: said, step };
}

/**
 * The line a stopped command prints after its refusal, aimed at whoever can take the step. The
 * agent's own step is already the refusal's next line, so only a step for someone else adds one.
 *
 * @param {ReturnType<typeof blockNotice>} block
 * @returns {string | null}
 */
export function blockLine(block) {
  if (block?.audience === 'person') return 'pullboard: only the person can clear this; it is in their Needs you list now';
  if (block?.audience === 'coordinator') return `pullboard: only the coordinator can clear this; tell them: pullboard shout coordinator --kind blocker "blocked by ${block.code} on ${block.command}: ${block.reason.replaceAll('"', "'")}"`;
  return null;
}

/**
 * Record a refusal that stopped a command and print the line aimed at whoever can clear it. A
 * ledger that cannot be written says so; it never hides the refusal it was recording.
 *
 * @param {any} io
 * @param {{ code?: string, message: string, next?: string }} error
 * @param {{ command: string, info?: { commonDir: string, root: string, isMain: boolean }, now?: Date }} context - info defaults to the checkout at io.cwd
 */
export function reportBlock(io, error, { command, info: given, now = io.clock?.now?.() ?? new Date() }) {
  let info = given;
  try { info ??= repoInfo(io.cwd); } catch { return null; /* Outside a repository there is no board to record on. */ }
  const caller = io.callerRole?.();
  const block = blockNotice(error, { command, at: now, path: info.root, caller,
    by: caller === 'person' ? 'person' : info.isMain ? 'coordinator' : 'agent' });
  if (!block) return null;
  const moveKey = blockMoveKey(io);
  if (moveKey) Object.assign(block, { moveKey, moveKeys: blockMoveKeys(io), owner: blockOwner(block.audience, info) });
  try { recordBlock(info.commonDir, block); }
  catch (failure) { io.err(`pullboard: this block was not recorded (${failure.message}); the refusal above still stands`); }
  const line = blockLine(block);
  if (line) io.err(line);
  return block;
}
