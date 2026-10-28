import {
  dependencyReferences,
  dependencyLabel,
} from './item-dependencies.js';
/**
 * What every command shares and a read needs: the checkout's context, the board opened around one piece of work,
 * argument parsing and the one-line item format. It loads no gate, relay or landing module, so a read command that
 * imports only this pays for nothing it does not run [C7].
 */
import { existsSync } from 'node:fs';
import {
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { displayAgentName } from './agent-names.js';
import * as store from './board-query.js';
import {
  CONFIG_FILE,
  COORDINATOR,
  loadConfig,
} from './config.js';
import { loadDoctrine } from './doctrine.js';
import {
  codeIsFromMain,
  differFromHead,
  headCommit,
  repoInfo,
  tryGit,
} from './git.js';
import { Refused } from './refused.js';
import { mainPolicy } from './trusted-policy-read.js';
import { familyIndex } from './review-policy.js';
import { MAIN_MERGE_LABEL } from './trunk-conflict.js';

/**
 * A comma list of spec ids from a flag.
 *
 * @param {string | undefined} text
 * @returns {string[]}
 */
export const idList = (text) => (text ?? '').split(',').map((id) => id.trim()).filter(Boolean);

/**
 * The start of a command an agent can paste anywhere: agent shells often start each command in the
 * main checkout, so every command pullboard suggests names its folder (I5).
 *
 * @param {string} root
 * @returns {string}
 */
export const shellWord = (text) => (/^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`);

/**
 * `cd <folder> &&`, the folder quoted for any POSIX shell: single quotes, so a space, a quote or a
 * dollar sign in the path reaches cd as written (I7).
 *
 * @param {string} root
 * @returns {string}
 */
export const cdTo = (root) => `cd ${shellWord(root)} &&`;

/** How many characters of an earlier verdict's note show prints (N30). */
const NOTE_LINE = 120;

/**
 * A positive whole number from an argument, or a refusal naming what was expected.
 *
 * @param {string | undefined} text
 * @param {string} what
 * @returns {number}
 */
export function idArg(text, what = 'an item id') {
  const id = Number(String(text ?? '').replace(/^#/, ''));
  if (!Number.isInteger(id) || id < 1) throw new Refused('USAGE', `expected ${what}, got "${text ?? ''}"`);
  return id;
}

/**
 * Print an item's brief, indented under a heading, when it has one.
 *
 * @param {any} io
 * @param {string} brief
 */
export function sayBrief(io, brief) {
  if (!brief) return;
  io.say('brief:');
  brief.split('\n').forEach((line) => io.say(`  ${line}`.trimEnd()));
}

/**
 * Everything a command needs: the repo, its config, the board's file, and where output goes.
 *
 * @param {any} io
 * @returns {any}
 */
export function context(io) {
  const info = repoInfo(io.cwd);
  if (info.isMain) io.caller?.('coordinator', info.root);
  const config = configHere(info);
  const file = join(info.commonDir, 'pullboard', 'board.sqlite');
  // Where the running code came from costs Git processes, and only a board behind this code's schema needs it.
  let allowSchemaUpgrade;
  return { info, config, file, get allowSchemaUpgrade() { return allowSchemaUpgrade ??= codeIsFromMain(); },
    doctrine: loadDoctrine(info.root, config), io, clock: io.clock ?? store.systemClock };
}

/**
 * This checkout's config. Init is the fix only where pullboard never was (C4): a config deleted
 * from a checkout whose last commit has it is restored, and a linked worktree made from a commit
 * that lacks it, beside a main checkout that has one, is made again from there.
 *
 * @param {{ root: string, commonDir: string, isMain: boolean }} info
 * @returns {any}
 */
function configHere(info) {
  try {
    return loadConfig(info.root);
  } catch (error) {
    if (!(error instanceof Refused) || error.code !== 'NO_CONFIG') throw error;
    if (tryGit(info.root, ['cat-file', '-e', `HEAD:${CONFIG_FILE}`]).status === 0) {
      throw new Refused('NO_CONFIG', `${CONFIG_FILE} is deleted here, though this checkout's last commit has it: restore it: ${cdTo(info.root)} git checkout HEAD -- ${CONFIG_FILE}`);
    }
    const mainRoot = resolve(info.commonDir, '..');
    if (info.isMain || !existsSync(join(mainRoot, CONFIG_FILE))) throw error;
    let setup;
    try {
      setup = uncommittedSetup(mainRoot, loadConfig(mainRoot));
    } catch {
      // Keep the existing recovery for invalid or incomplete main-checkout configuration.
    }
    if (setup) {
      throw new Refused(
        'NO_CONFIG',
        `this worktree has no ${CONFIG_FILE}, and the main checkout has uncommitted Pullboard setup files: ${setup.files.join(', ')}. Commit them in the main checkout first: ${setup.stage}`,
      );
    }
    throw new Refused(
      'NO_CONFIG',
      `this worktree's commit has no ${CONFIG_FILE}, though the main checkout has one: make a new worktree from the main checkout, which says what to commit first: ${cdTo(mainRoot)} pullboard worktree <lane> --model "<model name>"`,
    );
  }
}

/**
 * A note's first line, cut to NOTE_LINE characters with … marking the cut. A line ends at any break
 * Unicode makes mandatory (UAX #14): LF, VT, FF, CR, CRLF, NEL, LS and PS. Characters are counted
 * as a reader sees them, so a cut never splits an emoji or an accented letter.
 *
 * @param {string} note
 * @returns {string}
 */
export function firstLineOf(note) {
  const line = note.split(/[\n\v\f\r\x85\u2028\u2029]/)[0];
  const characters = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(line)];
  return characters.length > NOTE_LINE ? `${characters.slice(0, NOTE_LINE).map((part) => part.segment).join('')}…` : line;
}

/**
 * One item on one line: id, status and holder, lane, title, spec ids.
 *
 * @param {any} item
 * @returns {string}
 */
export function itemLine(item, name = (id) => id, mainMerge = false) {
  const holder = item.item_status === 'claimed' ? ` ${name(item.item_owner)}` : '';
  const verifier = item.item_status === 'verified' && !item.item_rehome_import ? ` by ${name(item.item_verified_by)}` : '';
  const specs = item.item_spec_ids ? `  [${item.item_spec_ids}]` : '';
  const parent = item.item_parent_id ? `  under #${item.item_parent_id}` : '';
  const after = item.item_after ? `  after ${dependencyReferences(item).map(dependencyLabel).join(',')}` : '';
  const rejected = item.item_status === 'open' && item.item_verdict === 'REJECT' ? ' (rejected)' : mainMerge ? ` (${MAIN_MERGE_LABEL})` : '';
  const light = item.item_route === 'strong' ? '' : `  ${item.item_route}`;
  const staleVerdict = item.item_verdict_state ? `  ${item.item_verdict_state.code}` : '';
  const hold = item.item_hold_reason ? `  held by ${name(item.item_hold_by)}: ${item.item_hold_reason}` : '';
  return `#${item.item_id}  ${item.item_status}${holder}${verifier}${rejected}  ${item.item_lane}  ${item.item_title}${specs}${parent}${after}${light}${hold}${staleVerdict}`;
}

/** Format a stable agent id for human-facing CLI output. */
export function agentDisplayName(agents, config, id) {
  if (!id) return '';
  const agent = agents.find((entry) => entry.agent_id === id);
  if (agent) return displayAgentName(agent, config.agents.names);
  if (id === 'person' || id === 'all' || Object.hasOwn(config.lanes, id)) return id;
  return displayAgentName({ agent_id: id }, config.agents.names);
}

/**
 * The files a new worktree takes from the main checkout's last commit and works by: the config, the
 * spec, the practice file, the rules its opening lines name, and the hooks, when git looks for them
 * inside each worktree.
 *
 * @param {string} mainRoot
 * @param {any} config
 * @returns {string[]}
 */
export function setupFiles(mainRoot, config) {
  const hooks = tryGit(mainRoot, ['config', '--get', 'core.hooksPath']).stdout;
  const inEach = hooks && !isAbsolute(hooks) && !relative(mainRoot, resolve(mainRoot, hooks)).startsWith('..');
  return [CONFIG_FILE, config.spec, config.practice, 'AGENTS.md', ...(inEach ? [hooks] : [])].filter(Boolean);
}

/** Find setup files in the main checkout that a new worktree would not receive from HEAD. */
export function uncommittedSetup(mainRoot, config) {
  if (headCommit(mainRoot) === null) return null;
  const differ = differFromHead(mainRoot, setupFiles(mainRoot, config));
  if (!differ.length) return null;
  const words = differ.map(({ path }) => shellWord(path)).join(' ');
  const force = differ.some(({ ignored }) => ignored) ? ' -f' : '';
  return {
    files: differ.map(({ path }) => path), differ,
    stage: `${cdTo(mainRoot)} git add${force} -- ${words}`,
  };
}

/**
 * How long ago an ISO time was, or how long until it, in the board's clock: 45m, 3h, 2d.
 *
 * @param {any} ctx
 * @param {string} iso
 * @returns {string}
 */
export function span(ctx, iso) {
  const minutes = Math.round(Math.abs(ctx.clock.now().getTime() - Date.parse(iso)) / 60_000);
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

/** Run work on an opened board with the same caller, quarantine, event and close lifecycle. */
export function withOpenedBoard(ctx, work, board) {
  // Whether a proven flake stops blocking a landing is the coordinator's setting, read from accepted main on first use.
  let quarantine;
  board.quarantineEnabled = () => quarantine ??= mainPolicy(ctx.info.root).config.flakes?.quarantine === true;
  // The explicit vendor alias list comes from accepted main, as quarantine does; it is read on first family comparison [#1762].
  let aliases;
  Object.defineProperty(board, 'familyAliases', { configurable: true, enumerable: true, get: () => aliases ??= familyIndex(mainPolicy(ctx.info.root).config.families) });
  const firstEvent = board.emittedEvents?.length ?? 0;
  /** Forward committed events before releasing either synchronous or asynchronous work. */
  const finish = () => {
    for (const event of board.emittedEvents?.slice(firstEvent) ?? []) ctx.io.onEvent?.(event);
    store.closeBoard(board);
  };
  let result;
  try {
    // Reuse the already-open board to identify a registered seat, without another lock or migration.
    if (ctx.io.caller && !ctx.info.isMain && !ctx.io.callerKnown?.(ctx.info.root) && store.agentAt(board, ctx.info.root)) ctx.io.caller('seat', ctx.info.root);
    result = work(board);
  }
  catch (error) { finish(); throw error; }
  if (result && typeof result.then === 'function') return result.finally(finish);
  finish();
  return result;
}

/**
 * Who is asking: the coordinator in the main checkout, or the agent this worktree joined as.
 *
 * @param {any} ctx
 * @param {any} board
 * @returns {{ id: string, lane: string, route?: string, family: string | null, model: string | null, displayName: string }}
 */
export function identifyCaller(ctx, board, { environmentAgent, relayLinked }, readers = store) {
  // A CI or cloud session works as the agent its environment token names, on that one board [E18].
  const seat = environmentAgent(ctx.info.root, board);
  if (seat) return { id: seat.agent_id, lane: seat.agent_lane, route: seat.agent_route, family: seat.agent_family ?? null, model: seat.agent_model ?? 'unknown', displayName: displayAgentName(seat, ctx.config.agents.names) };
  if (ctx.info.isMain) {
    ctx.io.caller?.('coordinator', ctx.info.root);
    const registered = readers.agentById(board, COORDINATOR);
    const linked = relayLinked(ctx.info.root);
    if (linked && !registered) throw new Refused('NO_AGENT', 'the linked snapshot has no coordinator; restore a consistent relay snapshot before acting');
    const id = linked ? COORDINATOR : readers.ensureCoordinator(board, ctx.info.root);
    const agent = registered ?? readers.agentAt(board, ctx.info.root);
    return { id, lane: COORDINATOR, family: agent?.agent_family ?? null, model: agent?.agent_model ?? 'unknown', displayName: displayAgentName(agent ?? { agent_id: id }, ctx.config.agents.names) };
  }
  const agent = readers.agentAt(board, ctx.info.root);
  if (!agent) {
    throw new Refused('NOT_JOINED', 'this worktree has not joined a lane: pullboard join <lane> --model "<model name>" (see: pullboard lanes)');
  }
  ctx.io.caller?.('seat', ctx.info.root);
  return { id: agent.agent_id, lane: agent.agent_lane, route: agent.agent_route, family: agent.agent_family ?? null, model: agent.agent_model ?? 'unknown', displayName: displayAgentName(agent, ctx.config.agents.names) };
}
