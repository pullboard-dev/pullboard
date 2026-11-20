/** @pullboard-module-loads packages/doctrine/light.js apps/cli/src/io/item/folder/identity.js */
import { environmentAdapter } from '../../../../packages/env/index.js';
import { seatFamily } from '../../../../packages/items/light.js';
import {
  dependencyReferences,
  dependencyLabel,
  dependencyValues,
} from '../../../../packages/items/light.js';
/**
 * What every command shares and a read needs: the checkout's context, the board opened around one piece of work,
 * argument parsing and the one-line item format. It loads no gate, relay or landing module, so a read command that
 * imports only this pays for nothing it does not run [C7].
 */
import {
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { displayAgentName } from '../../../../packages/seats/browser.js';
import * as store from '../../../../packages/store/light.js';
import {
  CONFIG_FILE,
  COORDINATOR,
  loadConfig,
} from '../../../../packages/config/light.js';
import { createRequire } from 'node:module';
import {
  codeIsFromMain,
  differFromHead,
  headCommit,
  gitReadSignature,
  invalidateGitFacts,
  mainCheckout,
  repoInfo,
  resolveCommit,
  tryGit,
} from '../../../../packages/git/light.js';
import { Refused } from '../../../../packages/kernel/light.js';
import {
  RUNNER_POLICY_FILE,
  mainPolicy,
  policyAt,
  trunkRef,
} from '../../../../packages/sandbox/light.js';
import { familyIndex } from '../../../../packages/verify/read.js';
import { verdictProjector } from '../../../../packages/verify/read.js';
import { MAIN_MERGE_LABEL } from '../../../../packages/merge/light.js';
import { mainMergeFor } from '../../../../packages/merge/light.js';
/** The two reads the thin list door shares with this module, so the door adds no cell edge of its own [C7,#9091]. */
export { verdictProjector, mainMergeFor };
import { sessionRoute } from './route.js';
import { fileSystemAdapter } from '../../../../packages/fs/index.js';

const fs = fileSystemAdapter();

/**
 * A comma list of spec ids from a flag.
 *
 * @param {string | undefined} text
 * @returns {string[]}
 */
/** Ids from text or from a repeated option's texts, each piece split on commas and whitespace. */
export const idList = (text) => (Array.isArray(text) ? text : [text ?? '']).flatMap((piece) => String(piece).split(/[\s,]+/u)).filter(Boolean);

/**
 * The start of a command an agent can paste anywhere: agent shells often start each command in the
 * main checkout, so every command pullboard suggests names its folder (I5).
 *
 * @param {string} text
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

const requireModule = createRequire(import.meta.url);
/** The doctrine reader, loaded at the first ctx.doctrine read: a list or show never reads doctrine and never pays for it [C7,#7081]. */
const doctrineLoader = () => requireModule('../../../../packages/doctrine/light.js').loadDoctrine;
/** The item-folder identity reader, loaded only when no seat is registered at this checkout [C7,#7081]. */
const folderIdentity = () => requireModule('./item/folder/identity.js').itemFolderIdentity;

/**
 * Everything a command needs: the repo, its config, the board's file, and where output goes.
 *
 * @param {any} io
 * @returns {any}
 */
export function context(io) {
  // Every CLI io, whoever builds it (the handoff worker, hook work, the relay sender, tests), gets a silent queue-wait reporter unless one was supplied.
  io.gateWaitReporter ??= () => () => {};
  const info = repoInfo(io.cwd);
  if (info.isMain) io.caller?.('coordinator', info.root);
  const config = configHere(info);
  const file = join(info.commonDir, 'pullboard', 'board.sqlite');
  // Where the running code came from costs Git processes, and only a board behind this code's schema needs it.
  let allowSchemaUpgrade;
  let doctrine;
  const ctx = { info, config, file, nativeBoard: io.nativeBoard, get allowSchemaUpgrade() { return allowSchemaUpgrade ??= codeIsFromMain(); },
    get doctrine() { return doctrine ??= doctrineLoader()(info.root, config); }, io, clock: io.clock ?? store.systemClock };
  if (config.worktreeMaintenance?.enabled === true) io.worktreeMaintenanceContext = ctx;
  if (config.toolBuild?.autoGate === true) io.toolBuildGateContext = ctx;
  return ctx;
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
    if (info.isMain || !fs.exists(join(mainRoot, CONFIG_FILE))) throw error;
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
 * The states of an item's foreign waits, keyed repo#id, for itemLine to print; empty when it waits on none, and then
 * the full store never loads (the light store has no foreign reader). The caller names the reader, store.foreignDependencyStates.
 *
 * @param {any} board
 * @param {any} item
 * @param {() => Promise<(board: any, item: any) => any[]>} loadReader loads store.foreignDependencyStates from the full store
 * @returns {Promise<Map<string, { status: string, cause?: string, receivedAt?: string }>>}
 */
export async function foreignStates(board, item, loadReader) {
  if (!item.item_after || !dependencyReferences(item).some(ref => ref.kind !== 'local')) return new Map();
  const foreignDependencyStates = await loadReader();
  return new Map(foreignDependencyStates(board, item).map(ref => [`${ref.repo}#${ref.id}`, { status: ref.status, cause: ref.cause, receivedAt: ref.receivedAt }]));
}

/** How long ago a state was received, in whole units: 2 min ago, 3 h ago, 2 d ago. */
function receivedAge(receivedAt, now) {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(receivedAt)) / 60_000));
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} d ago`;
}

/** A wait's label with the state a foreign one is in: host#41 (verified on host, 2 min ago) or host#41 (unavailable: no link). */
function foreignLabel(ref, foreign, now) {
  const label = dependencyLabel(ref);
  const state = ref.kind === 'local' ? undefined : foreign.get(label);
  if (!state) return label;
  if (state.status === 'unavailable') return `${label} (unavailable: ${state.cause})`;
  const age = state.receivedAt && now && Number.isFinite(Date.parse(state.receivedAt)) ? `, ${receivedAge(state.receivedAt, now)}` : '';
  return `${label} (${state.status} on ${ref.repo}${age})`;
}

/**
 * One item on one line: id, status and holder, lane, title, spec ids.
 *
 * @param {any} item
 * @param {(id: string) => string} [name]
 * @param {boolean} [mainMerge]
 * @param {Map<string, { status: string, cause?: string, receivedAt?: string }>} [foreign] - Foreign waits by repo#id: a ref with an entry prints its state, the rest print as before.
 * @param {Date} [now] - The command clock's time; a foreign state with a receivedAt prints its age against it, one without prints none.
 * @returns {string}
 */
export function itemLine(item, name = (id) => id, mainMerge = false, foreign = new Map(), now = undefined) {
  const holder = item.item_status === 'claimed' ? ` ${name(item.item_owner)}` : '';
  const verifier = item.item_status === 'verified' && !item.item_rehome_import ? ` by ${name(item.item_verified_by)}` : '';
  const specs = item.item_spec_ids ? `  [${item.item_spec_ids}]` : '';
  const parent = item.item_parent_id ? `  under #${item.item_parent_id}` : '';
  const after = item.item_after ? `  after ${dependencyReferences(item).map(ref => foreignLabel(ref, foreign, now)).join(',')}` : '';
  const rejected = item.item_status === 'open' && item.item_verdict === 'REJECT' ? ' (rejected)' : mainMerge ? ` (${MAIN_MERGE_LABEL})` : '';
  const light = item.item_route === 'strong' ? '' : `  ${item.item_route}`;
  const staleVerdict = item.item_verdict_state ? `  ${item.item_verdict_state.code}` : '';
  const hold = item.item_hold_reason ? `  held by ${name(item.item_hold_by)}: ${item.item_hold_reason}` : '';
  // A hand-landed item is withdrawn with a merged commit: "(landed)" read as "not on main" and held dependents back (#11113), so the line names where it is on main.
  const handLanded = item.item_status === 'withdrawn' && item.item_stage === 'landed' && item.item_merged_commit;
  const stage = handLanded ? `on main at ${String(item.item_merged_commit).slice(0, 12)}` : `${item.item_stage}${item.item_gate_runner === 'none' ? ', no runner' : ''}`;
  return `#${item.item_id}  ${item.item_status}${holder}${item.item_stage && item.item_stage !== item.item_status ? ` (${stage})` : ''}${verifier}${rejected}  ${item.item_lane}  ${item.item_title}${specs}${parent}${after}${light}${hold}${staleVerdict}`;
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

/**
 * The coordinator's declared vendor families from accepted main. While the primary checkout is detached for review
 * (every verify there), the main policy read refuses, so the retained trunk branch's tip is read instead [#1794].
 *
 * @param {string} root
 * @returns {Record<string, string[]> | undefined}
 */
function declaredFamilies(root) {
  try { return mainPolicy(root).config.families; }
  catch (error) {
    if (!(error instanceof Refused) || error.code !== 'NO_POLICY' || mainCheckout(root)) throw error;
    const retained = trunkRef(root);
    const commit = retained ? resolveCommit(root, retained) : null;
    if (!commit) throw error;
    return policyAt(root, commit).config.families;
  }
}

/** Read the exact ref bytes as well as the canonical filesystem signature; missing refs remain observable. */
function policyRefBytes(file) {
  try { return fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
}

/** Observe primary and retained policy identities without invoking Git under SQLite admission. */
function writePolicySignature(ctx, ref) {
  if (ref && (!ref.startsWith('refs/heads/') || ref.includes('\\')
    || ref.split('/').some(part => !part || part === '.' || part === '..'))) return null;
  // Directory stats are left out: the command's own Git reads (index refresh, locks) touch them, and the policy-bearing
  // files (config, HEAD, refs, packed-refs, runner policy) keep their own markers, so a foreign write still shows [#2081].
  const options = { directories: false };
  const primary = gitReadSignature(resolve(ctx.info.commonDir, '..'), [], options);
  const local = gitReadSignature(ctx.info.root, [], options);
  const runner = gitReadSignature(ctx.info.root, [relative(ctx.info.root, join(ctx.info.gitDir, RUNNER_POLICY_FILE))], options);
  const loose = ref ? policyRefBytes(join(ctx.info.commonDir, ref)) : null;
  // Symbolic ref chains and alternate backends retain their original guarded reader until explicitly supported.
  if (loose?.startsWith('ref: ')) return null;
  const exact = [policyRefBytes(join(ctx.info.commonDir, 'HEAD')), ref, loose,
    policyRefBytes(join(ctx.info.commonDir, 'packed-refs'))];
  return primary && local && runner ? JSON.stringify([primary, local, runner, exact]) : null;
}

/**
 * Commands whose outcome never depends on accepted main's policy: they commit while the lander moves main, reading
 * quarantine and family aliases lazily once, instead of refusing POLICY_SNAPSHOT_STALE after main's ref moved (#6036).
 * Every other command, and any caller with no named command, keeps the full accepted-main snapshot.
 */
const MAIN_INDEPENDENT_WRITES = new Set(['claim', 'next', 'fact', 'release', 'shout', 'heartbeat', 'inbox', 'join', 'escalate', 'hold']);

/** Scope accepted-source preparation to this CLI board; mutable family and approval facts stay live. */
function installWritePolicy(ctx, board) {
  const command = ctx.io?.relayCommand?.cliOperation;
  const mainIndependent = MAIN_INDEPENDENT_WRITES.has(command);
  const names = ['quarantineEnabled', 'familyAliases', 'prepareWritePolicy'];
  const descriptors = names.map(name => Object.getOwnPropertyDescriptor(board, name));
  let quarantine, aliases, active;
  /** Diagnose only an actual lazy input evaluation inside an exceptional write, without changing its result. */
  function noteFallback(input) {
    if (!active?.fallback) return;
    try { ctx.io.err?.(`PULLBOARD_WRITE_POLICY_FALLBACK input=${input}`); }
    catch { /* Diagnostic failure cannot replace the original authority guard. */ }
  }
  /** Unavailable preparation retains the original guard instead of retaining a premature refusal [#2051]. */
  function fallback() {
    const frame = {
      fallback: true,
      /** No guessed accepted-source value is used on this compatibility path. */
      current() { return true; },
      /** Original lazy guards retain their existing live reads and refusals. */
      assertCurrent() {},
      /** Mark only the actual transaction, never read-only CLI queries. */
      enter() { active = frame; },
      /** Never retain a fallback state across writes. */
      leave() { if (active === frame) active = undefined; },
    };
    return frame;
  }
  /** A main-independent write pins no accepted-main snapshot, so main moving never refuses or retries it [#6036]. */
  function unpinned() {
    // Read both inputs now, before BEGIN: left lazy they ran under the writer lock, where a policy read may start Git and
    // a loaded machine held a release for 7.0 s (#8770). A read that fails stays lazy, keeping its original refusal.
    try {
      quarantine ??= mainPolicy(ctx.info.root).config.flakes?.quarantine === true;
      aliases ??= familyIndex(declaredFamilies(ctx.info.root));
    } catch { /* The consuming guard reads it again and refuses as before. */ }
    const frame = {
      /** Nothing was pinned, so nothing can go stale. */
      current() { return true; },
      /** No accepted-main source is judged by this command. */
      assertCurrent() {},
      /** Policy inputs stay lazy and are read at most once for this command. */
      enter() { active = frame; },
      /** Never retain this frame across writes. */
      leave() { if (active === frame) active = undefined; },
    };
    return frame;
  }
  /** Preserve lazy read behavior outside a prepared write, including original refusal order. */
  const readQuarantine = () => {
    if (active?.quarantine !== undefined) return active.quarantine;
    if (quarantine === undefined) noteFallback('quarantine');
    return quarantine ??= mainPolicy(ctx.info.root).config.flakes?.quarantine === true;
  };
  board.quarantineEnabled = readQuarantine;
  Object.defineProperty(board, 'familyAliases', { configurable: true, enumerable: true, get() {
    if (active?.aliases !== undefined) return active.aliases;
    if (aliases === undefined) noteFallback('familyAliases');
    return aliases ??= familyIndex(declaredFamilies(ctx.info.root));
  } });
  Object.defineProperty(board, 'prepareWritePolicy', { configurable: true, enumerable: false, value() {
    if (mainIndependent) return unpinned();
    let preparedContext;
    try { preparedContext = ctx.info.commonDir && ctx.info.gitDir ? ctx : { ...ctx, info: repoInfo(ctx.info.root) }; }
    catch { return fallback(); }
    invalidateGitFacts({ keepIdentity: true });
    // Resolve source selection outside BEGIN; the under-lock witness reads only these exact owned metadata files.
    let ref;
    try { ref = mainCheckout(ctx.info.root)?.branch ?? trunkRef(ctx.info.root); }
    catch { return fallback(); }
    let before;
    try { before = writePolicySignature(preparedContext, ref); } catch { return fallback(); }
    if (!before) return fallback(); // Unsupported Git metadata retains original guards, never a guessed policy.
    let nextQuarantine, nextAliases;
    // Do not retain a refusal: a command may establish policy before the original consuming guard.
    try {
      if (board.quarantineEnabled === readQuarantine) nextQuarantine = mainPolicy(ctx.info.root).config.flakes?.quarantine === true;
      nextAliases = familyIndex(declaredFamilies(ctx.info.root));
    } catch { return fallback(); }
    let after;
    try { after = writePolicySignature(preparedContext, ref); } catch { return fallback(); }
    if (!after) return fallback();
    /** A changed source aborts before work; a change during work refuses without replaying work. */
    const current = () => {
      try { return before === after && after === writePolicySignature(preparedContext, ref); }
      catch { return false; }
    };
    const frame = {
      quarantine: nextQuarantine, aliases: nextAliases,
      current,
      /** Refuse a mid-transaction source change without invoking Git or retrying arbitrary work. */
      assertCurrent() {
        if (!current()) throw new Refused('POLICY_SNAPSHOT_STALE', `accepted policy changed during this write (${ref} moved); retry the command against current main`);
      },
      /** Activate only after the pre-work source comparison succeeds under BEGIN. */
      enter() { active = frame; },
      /** Never leave a prepared frame installed across transactions or rollback. */
      leave() { if (active === frame) active = undefined; },
    };
    return frame;
  } });
  /** Restore caller-owned providers/getters even when work or close throws. */
  return () => names.forEach((name, index) => {
    if (descriptors[index]) Object.defineProperty(board, name, descriptors[index]);
    else delete board[name];
  });
}

/** Run work on an opened board with the same caller, quarantine, event and close lifecycle. */
export function withOpenedBoard(ctx, work, board) {
  board.reviewIndependence = ctx.config?.review?.independence ?? 'off'; // review.independence, a connection-local setting read by the verifier identity checks.
  board.reviewExcludeEarlierHolders = ctx.config?.review?.excludeEarlierHolders === true; // review.excludeEarlierHolders, read by the reservation guards.
  const restorePolicy = installWritePolicy(ctx, board);
  const firstEvent = board.emittedEvents?.length ?? 0;
  /** Forward committed events before releasing either synchronous or asynchronous work. */
  const finish = () => {
    try {
      for (const event of board.emittedEvents?.slice(firstEvent) ?? []) ctx.io.onEvent?.(event);
      // The migration belongs to the committing command, never a later read or a write-lock callback.
      const notice = board.reviewDefaultNotice;
      delete board.reviewDefaultNotice;
      for (const line of notice ?? []) ctx.io.err(line);
    } finally {
      try { store.closeBoard(board); }
      finally { restorePolicy(); }
    }
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
 * @returns {{ id: string, lane: string, route?: string, family: string | null, model: string | null, displayName: string, role?: string }}
 */
export function identifyCaller(ctx, board, { environmentAgent, relayLinked }, readers = store) {
  // A CI or cloud session works as the agent its environment token names, on that one board [E18].
  // A seat joined over the served API acts as itself at the board root, which has no worktree of its own [P7].
  const seat = environmentAgent(ctx.info.root, board) ?? (ctx.io.remoteAgent ? readers.agentById(board, ctx.io.remoteAgent) : null);
  if (seat) return { id: seat.agent_id, lane: seat.agent_lane, route: sessionRoute(seat.agent_route, seat.agent_model, environmentAdapter().get('PULLBOARD_MODEL'), ctx.config.modelTiers), family: seatFamily(board, seat.agent_id), model: seat.agent_model ?? 'unknown', displayName: displayAgentName(seat, ctx.config.agents.names), ...(seat.agent_role ? { role: seat.agent_role } : {}) };
  if (ctx.info.isMain) {
    ctx.io.caller?.('coordinator', ctx.info.root);
    const registered = readers.agentById(board, COORDINATOR);
    const linked = relayLinked(ctx.info.root);
    if (linked && !registered) throw new Refused('NO_AGENT', 'the linked snapshot has no coordinator; restore a consistent relay snapshot before acting');
    const id = linked ? COORDINATOR : readers.ensureCoordinator(board, ctx.info.root);
    const agent = registered ?? readers.agentAt(board, ctx.info.root);
    return { id, lane: COORDINATOR, family: agent ? seatFamily(board, agent.agent_id) : null, model: agent?.agent_model ?? 'unknown', displayName: displayAgentName(agent ?? { agent_id: id }, ctx.config.agents.names), ...(agent?.agent_role ? { role: agent.agent_role } : {}) };
  }
  const agent = readers.agentAt(board, ctx.info.root) ?? folderIdentity()(board, ctx.info.root)?.agent;
  if (!agent) {
    throw new Refused('NOT_JOINED', 'this worktree has not joined a lane: pullboard join <lane> --model "<model name>" (see: pullboard lanes)');
  }
  ctx.io.caller?.('seat', ctx.info.root);
  // The route follows the model this session declares, not only the one the seat joined with (#3678).
  return { id: agent.agent_id, lane: agent.agent_lane, route: sessionRoute(agent.agent_route, agent.agent_model, environmentAdapter().get('PULLBOARD_MODEL'), ctx.config.modelTiers), family: seatFamily(board, agent.agent_id), model: agent.agent_model ?? 'unknown', displayName: displayAgentName(agent, ctx.config.agents.names), ...(agent.agent_role ? { role: agent.agent_role } : {}) };
}

/** Parse an edit's dependency replacement, with the explicit word `none` meaning clear all. */
export function editAfter(text) {
  if (text === undefined) return undefined;
  const pieces = Array.isArray(text) ? text : [text];
  if (pieces.length === 1 && pieces[0].trim() === 'none') return [];
  const joined = pieces.join(',');
  const parts = joined.split(/[\s,]+/u).filter(Boolean);
  if (!joined.trim() || !parts.length || parts.includes('none')) {
    throw new Refused('USAGE', 'use --after <id>[,<id>...] or --after none');
  }
  return dependencyValues(parts);
}
/**
 * Text a command was given as --<name> "..." or as --<name>-file <file>, or undefined when neither.
 * A file carries text past the shell exactly: backticks, dollar signs and quotes included.
 *
 * @param {any} io
 * @param {any} values
 * @param {string} name
 * @returns {string | undefined}
 */
export function textArg(io, values, name) {
  const path = values[`${name}-file`];
  if (values[name] !== undefined && path !== undefined) {
    throw new Refused('USAGE', `give the ${name} once: --${name} "..." or --${name}-file <file>`);
  }
  if (path === undefined) return values[name];
  const file = resolve(io.cwd, path);
  if (!fs.exists(file)) throw new Refused('NO_FILE', `no file ${path}`);
  return fs.readFile(file, 'utf8');
}
