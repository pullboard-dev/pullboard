/**
 * The pullboard command line: every command, bound to who is asking (B3). The main checkout is the
 * coordinator; every other worktree is the agent that joined from it.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import * as store from './board.js';
import { CONFIG_FILE, COORDINATOR, loadConfig } from './config.js';
import { digestOf, gateReport, runGate, runShell } from './gate.js';
import { contains, git, headCommit, headTree, isClean, repoInfo, resolveCommit, tryGit, untracked } from './git.js';
import {
  FIX_NOTE,
  applyFixers,
  commitMsgProblems,
  installHooks,
  preCommitProblems,
  prePushProblems,
} from './hooks.js';
import { initRepo } from './init.js';
import { productLine, productProblems, productSummaries } from './products.js';
import { isLane, laneNames, laneOf, outOfLane } from './lanes.js';
import { Refused } from './refused.js';
import { commitCitations, committedIds } from './history.js';
import { promptFor } from './skills.js';
import {
  frozenCriterion,
  idProblems,
  lintSpec,
  loadSpec,
  permanenceProblems,
  readSignoffs,
  signOff,
  standings,
  unmetRows,
} from './spec.js';
import { briefFiles } from './brief.js';
import { runItems } from './run.js';
import { parseProblems, sweepItems } from './sweep.js';
import { renderSpecView } from './view.js';
import { tour } from './tour.js';
import { registerProject } from './projects.js';
import { serveView } from './serve.js';

const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const VERSION = PACKAGE.version;

export const HELP = `pullboard ${VERSION}: the local-first work board for teams of coding agents.
Nothing ships until a second agent verifies it.

Set up
  pullboard tour                        see it work: a reject and its rework, scripted, in thirty seconds
  pullboard init                        config, SPEC.md, agent instructions, git hooks, board
  pullboard worktree <lane> [--route light]   make a worktree for a new agent in a lane, joined, and say what to run next
  pullboard join <lane> [--route light] register the worktree you are in as an agent in a lane
                                        --route light: a lighter model that takes only items routed light
  pullboard whoami | lanes | status     who you are, the lanes, the board at a glance
  pullboard view [--port N] [--no-open] every project on this machine in your browser: items, shouts, doctrine,
                                        agents and activity, live; add items, shout and hold lanes from it
  pullboard resume                      where you are: your claim, branch, uncommitted work, what came back,
                                        unread shouts, what to do next; run it to start any session
  pullboard hooks                       reinstall the git hooks (e.g. after a fresh clone)

Work
  pullboard add <lane> <title> [--criterion "..."] [--specs G1.2,K3] [--after 3,4] [--parent <id>]
                [--brief "..." | --brief-file <file>] [--route light|mid]
                                        --after: claiming waits until those items are verified
                                        --brief: what a cold agent needs; --route light: any model can build it
                [--check "<command>"]  the command that proves it; with --criterion and a brief, needed below strong
  pullboard edit <id> [--brief "..." | --brief-file <file>] [--route light|mid|strong] [--criterion "..."] [--check "..."]
  pullboard escalate <id> --note "what was tried and how it failed"   hand it one tier up
  pullboard run --agent "<command>" [--attempts 3] [--minutes 15] [--items N] [--wait M]
                                        build routed items unattended in this worktree: the agent command reads
                                        the context pack at $PULLBOARD_PACK (and $PULLBOARD_CHECK, $PULLBOARD_ITEM,
                                        $PULLBOARD_ATTEMPT, $PULLBOARD_TIER); green work is submitted, red escalated
                [--agent-light "..."] [--agent-mid "..."] [--agent-strong "..."]   a command per tier
  pullboard list [lane] [--all] [--route light|mid|strong]   open and active items; --all adds closed ones
  pullboard show <id>                   an item, the criterion frozen at claim, its verdicts
  pullboard next [--wait <minutes>]     claim the next item in your lane that is free to start
  pullboard next --verify               name the next submitted item you can check
  pullboard check [id]                  run your item's check, the command that proves it (the project gate is pullboard gate)
                                        in the main checkout, verifying needs --as coordinator
  pullboard claim <id>                  take or renew a lease; the first claim freezes the criterion
  pullboard release <id>                hand it back
  pullboard submit <id>                 needs a clean tree and the gate green at HEAD (alias: done)
  pullboard verify <id> accept --note "what you broke or which edge you tried, and what happened"
  pullboard verify <id> reject --reason TEST_FAILURE --note "what failed"
                                        any --note can be --note-file <file>, which keeps quotes, $ and backticks intact
  pullboard shout <lane|agent|all> <text>       pullboard inbox

Coordinator
  pullboard sweep --run "<checker>" --check "<checker on {file}>" [--route light] [--max 20] [--dry-run]
                                        file one item per file a linter, type checker or test reporter flags
  pullboard merged <id> <commit>        record where verified work landed
  pullboard withdraw <id> <reason>      drop an item nobody should build
  pullboard refreeze <id>               re-freeze a criterion after its spec rows changed
  pullboard hold <lane> --reason "..."   pause a lane: next there claims nothing and names the reason
  pullboard hold <lane> --off           release it

Receipts
  pullboard ledger                      markdown: what was built, by whom, verified by whom
  pullboard log [id]                    every move, in order

Spec
  pullboard spec check                  lint SPEC.md and PRACTICE.md
  pullboard spec view [--out file]      the spec, open questions, sign-offs and practice as one page
  pullboard spec show <id> | unmet [--must] | signoff <ids> --by <initials>

Role guides
  pullboard prompt decompose|plan|signoff|review|verify   how to do each role; Claude Code gets them as skills

Gate and hooks
  pullboard gate                        run the configured gate
  pullboard hook pre-commit|commit-msg|pre-push   git runs these

Reject reasons: TEST_FAILURE, BEHAVIOR_MISMATCH, INSUFFICIENT_EVIDENCE, STALE_HEAD, OTHER.
--json prints list, show and status as JSON.`;

const OPTIONS = {
  criterion: { type: 'string' },
  specs: { type: 'string' },
  parent: { type: 'string' },
  reason: { type: 'string' },
  off: { type: 'boolean' },
  port: { type: 'string' },
  'no-open': { type: 'boolean' },
  note: { type: 'string' },
  'note-file': { type: 'string' },
  by: { type: 'string' },
  out: { type: 'string' },
  after: { type: 'string' },
  brief: { type: 'string' },
  'brief-file': { type: 'string' },
  route: { type: 'string' },
  as: { type: 'string' },
  check: { type: 'string' },
  agent: { type: 'string' },
  'agent-light': { type: 'string' },
  'agent-mid': { type: 'string' },
  'agent-strong': { type: 'string' },
  attempts: { type: 'string' },
  minutes: { type: 'string' },
  items: { type: 'string' },
  run: { type: 'string' },
  max: { type: 'string' },
  'dry-run': { type: 'boolean' },
  wait: { type: 'string' },
  verify: { type: 'boolean' },
  all: { type: 'boolean' },
  must: { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

/**
 * A positive whole number from an argument, or a refusal naming what was expected.
 *
 * @param {string | undefined} text
 * @param {string} what
 * @returns {number}
 */
function idArg(text, what = 'an item id') {
  const id = Number(String(text ?? '').replace(/^#/, ''));
  if (!Number.isInteger(id) || id < 1) throw new Refused('USAGE', `expected ${what}, got "${text ?? ''}"`);
  return id;
}

/**
 * A comma list of spec ids from a flag.
 *
 * @param {string | undefined} text
 * @returns {string[]}
 */
const idList = (text) => (text ?? '').split(',').map((id) => id.trim()).filter(Boolean);

/**
 * Text a command was given as --<name> "..." or as --<name>-file <file>, or undefined when neither.
 * A file carries text past the shell exactly: backticks, dollar signs and quotes included.
 *
 * @param {any} io
 * @param {any} values
 * @param {string} name
 * @returns {string | undefined}
 */
function textArg(io, values, name) {
  const path = values[`${name}-file`];
  if (values[name] !== undefined && path !== undefined) {
    throw new Refused('USAGE', `give the ${name} once: --${name} "..." or --${name}-file <file>`);
  }
  if (path === undefined) return values[name];
  const file = resolve(io.cwd, path);
  if (!existsSync(file)) throw new Refused('NO_FILE', `no file ${path}`);
  return readFileSync(file, 'utf8');
}

/**
 * The brief a command was given, from --brief or --brief-file.
 *
 * @param {any} io
 * @param {any} values
 * @returns {string | undefined}
 */
const briefArg = (io, values) => textArg(io, values, 'brief');

/**
 * The start of a command an agent can paste anywhere: agent shells often start each command in the
 * main checkout, so every command pullboard suggests names its folder (I5).
 *
 * @param {string} root
 * @returns {string}
 */
const shellWord = (text) => (/^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`);

/**
 * `cd <folder> &&`, the folder quoted for any POSIX shell: single quotes, so a space, a quote or a
 * dollar sign in the path reaches cd as written (I7).
 *
 * @param {string} root
 * @returns {string}
 */
const cdTo = (root) => `cd ${shellWord(root)} &&`;

/**
 * Verifying from the main checkout files the verdict as the coordinator's (V9). An agent whose
 * shell started there would be taken for the coordinator, so the coordinator says so explicitly
 * and anyone else is sent back to a worktree.
 *
 * @param {any} ctx
 * @param {any} board
 * @param {any} values
 */
function checkMainVerifier(ctx, board, values) {
  if (values.as !== undefined && values.as !== COORDINATOR) throw new Refused('USAGE', '--as takes one value: coordinator');
  if (!ctx.info.isMain) {
    if (values.as) throw new Refused('USAGE', '--as coordinator works only in the main checkout; here you are the agent this worktree joined as');
    return;
  }
  if (values.as === COORDINATOR) return;
  const agents = store.listAgents(board).filter((agent) => agent.agent_id !== COORDINATOR);
  const listed = agents.length ? ` Agent worktrees: ${agents.slice(0, 6).map((agent) => `${agent.agent_id} at ${agent.agent_path}`).join('; ')}.` : '';
  const detached = tryGit(ctx.info.root, ['symbolic-ref', '-q', 'HEAD']).status !== 0 ? ' The main checkout is not on its branch; whoever switched it puts it back.' : '';
  throw new Refused(
    'MAIN_IS_COORDINATOR',
    `this is the main checkout, so this verdict would be the coordinator's. An agent verifies from its own worktree, starting every command with cd <worktree> &&.${listed}${detached} The coordinator adds --as coordinator`,
  );
}

/**
 * A brief whose Files section stays inside the item's lane (B14), so a builder working from it
 * never runs into the lane check: an item's files sit in its lane.
 *
 * @param {any} ctx
 * @param {string} lane
 * @param {string} brief
 * @returns {string}
 */
function briefInLane(ctx, lane, brief) {
  const foreign = outOfLane(ctx.config, lane, briefFiles(brief));
  if (foreign.length) {
    throw new Refused('BRIEF_LANE', `the brief names files outside the ${lane} lane: ${foreign.join(', ')}; split the item by lane, or wait on the other lane's item with --after`);
  }
  return brief;
}

/**
 * Print an item's brief, indented under a heading, when it has one.
 *
 * @param {any} io
 * @param {string} brief
 */
function sayBrief(io, brief) {
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
function context(io) {
  const info = repoInfo(io.cwd);
  const config = loadConfig(info.root);
  const file = join(info.commonDir, 'pullboard', 'board.sqlite');
  return { info, config, file, io, clock: io.clock ?? store.systemClock };
}

/**
 * Open the board, run `work`, and always close it.
 *
 * @template T
 * @param {any} ctx
 * @param {(board: any) => T} work
 * @returns {T}
 */
function withBoard(ctx, work) {
  const board = store.openBoard(ctx.file, ctx.clock);
  try {
    return work(board);
  } finally {
    store.closeBoard(board);
  }
}

/**
 * Who is asking: the coordinator in the main checkout, or the agent this worktree joined as.
 *
 * @param {any} ctx
 * @param {any} board
 * @returns {{ id: string, lane: string }}
 */
function whoAmI(ctx, board) {
  if (ctx.info.isMain) return { id: store.ensureCoordinator(board, ctx.info.root), lane: COORDINATOR };
  const agent = store.agentAt(board, ctx.info.root);
  if (!agent) {
    throw new Refused('NOT_JOINED', 'this worktree has not joined a lane: pullboard join <lane> (see: pullboard lanes)');
  }
  return { id: agent.agent_id, lane: agent.agent_lane, route: agent.agent_route };
}

/**
 * The criterion an item is held to, frozen from the spec as it reads now.
 *
 * @param {any} ctx
 * @returns {(item: any) => { text: string, digest: string }}
 */
const freezer = (ctx) => (item) => frozenCriterion(loadSpec(ctx.info.root, ctx.config), item);

/**
 * One item on one line: id, status and holder, lane, title, spec ids.
 *
 * @param {any} item
 * @returns {string}
 */
function itemLine(item) {
  const holder = item.item_status === 'claimed' ? ` ${item.item_owner}` : '';
  const verifier = item.item_status === 'verified' ? ` by ${item.item_verified_by}` : '';
  const specs = item.item_spec_ids ? `  [${item.item_spec_ids}]` : '';
  const parent = item.item_parent_id ? `  under #${item.item_parent_id}` : '';
  const after = item.item_after ? `  after ${item.item_after.split(',').map((id) => `#${id}`).join(',')}` : '';
  const rejected = item.item_status === 'open' && item.item_verdict === 'REJECT' ? ' (rejected)' : '';
  const light = item.item_route === 'strong' ? '' : `  ${item.item_route}`;
  return `#${item.item_id}  ${item.item_status}${holder}${verifier}${rejected}  ${item.item_lane}  ${item.item_title}${specs}${parent}${after}${light}`;
}

/**
 * The files an agent has been working in (N20): what its latest three items touched, and what is
 * uncommitted in its worktree now.
 *
 * @param {any} ctx
 * @param {any} board
 * @param {{ id: string }} me
 * @returns {string[]}
 */
function warmFiles(ctx, board, me) {
  const recent = store
    .listItems(board, { all: true })
    .filter((item) => item.item_built_by === me.id)
    .sort((first, second) => second.item_updated_at.localeCompare(first.item_updated_at))
    .slice(0, 3)
    .flatMap((item) => store.itemFiles(item));
  return [...new Set([...recent, ...dirtyFiles(ctx.info.root)])];
}

/**
 * The paths with uncommitted changes in a worktree, untracked files included.
 *
 * @param {string} root
 * @returns {string[]}
 */
function dirtyFiles(root) {
  return tryGit(root, ['status', '--porcelain', '--untracked-files=all']).stdout.split('\n').filter(Boolean).map((line) => line.slice(3));
}

/**
 * The files an item's own commits changed since its claim (N21). First parents only, so main merged
 * into a lane branch is not counted as the item's work; and nothing another item submitted, such as
 * a verified dependency fast-forwarded in, which merges no commit to skip.
 *
 * @param {string} root
 * @param {number} id
 * @param {string | null} from
 * @param {string} to
 * @returns {string[]}
 */
function filesSince(root, id, from, to) {
  if (!from) return [];
  const others = [`--exclude=refs/pullboard/items/${id}/*`, '--glob=refs/pullboard/items/*'];
  const result = tryGit(root, ['log', '--first-parent', '--no-merges', '--format=', '--name-only', to, '--not', from, ...others]);
  return result.status === 0 ? [...new Set(result.stdout.split('\n').filter(Boolean))].sort() : [];
}

/**
 * How long ago an ISO time was, or how long until it, in the board's clock: 45m, 3h, 2d.
 *
 * @param {any} ctx
 * @param {string} iso
 * @returns {string}
 */
function span(ctx, iso) {
  const minutes = Math.round(Math.abs(ctx.clock.now().getTime() - Date.parse(iso)) / 60_000);
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

/**
 * A shout's text cut to one short line.
 *
 * @param {string} text
 * @returns {string}
 */
const firstLine = (text) => {
  const line = String(text).split('\n')[0];
  return line.length > 100 ? `${line.slice(0, 99)}…` : line;
};

/**
 * `pullboard resume` (N19): one short card that puts an agent back to work after a fresh start,
 * a restart or a compaction, from the board rather than from a summary.
 *
 * @param {any} io
 * @returns {number}
 */
function resumeHere(io) {
  const ctx = context(io);
  const { root, isMain } = ctx.info;
  const card = withBoard(ctx, (board) => {
    const me = whoAmI(ctx, board);
    const all = store.listItems(board, { all: true });
    return {
      me,
      all,
      holding: all.filter((item) => item.item_status === 'claimed' && item.item_owner === me.id),
      sentBack: all
        .filter((item) => item.item_status === 'open' && item.item_verdict === 'REJECT' && item.item_built_by === me.id)
        .map((item) => ({ item, verdict: store.verdictsFor(board, item.item_id).at(-1) })),
      awaiting: all.filter((item) => item.item_status === 'submitted' && item.item_built_by === me.id),
      toVerify: all.filter((item) => item.item_status === 'submitted' && item.item_built_by !== me.id),
      toMerge: all.filter((item) => item.item_status === 'verified' && !item.item_merged_commit),
      open: all.filter((item) => item.item_status === 'open'),
      hold: store.laneHold(board, me.lane),
      holds: store.laneHolds(board),
      unread: store.unreadCount(board, me.id),
      newest: store.peekShouts(board, me.id, 1),
    };
  });
  const { me } = card;
  const say = (line) => io.say(line);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  say(`resume: ${me.id}, ${me.lane} lane${isMain ? ', the main checkout' : ''}, at ${root}`);
  const dirty = dirtyFiles(root).length;
  if (!isMain) {
    const branch = tryGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout || 'HEAD';
    // Against the main checkout's branch, not its HEAD, which is detached while the coordinator verifies.
    const mainRef = /^branch (.+)$/m.exec(tryGit(root, ['worktree', 'list', '--porcelain']).stdout.split('\n\n')[0])?.[1];
    const [behind = 0, ahead = 0] = mainRef ? tryGit(root, ['rev-list', '--left-right', '--count', `${mainRef}...HEAD`]).stdout.split(/\s+/).map(Number) : [];
    const against = mainRef ? `${ahead} ahead of main, ${behind} behind${behind ? ' (merge main before you submit)' : ''}` : 'main is detached for a verification, so ahead and behind are unknown';
    say(`branch ${branch}: ${against}${dirty ? `; ${plural(dirty, 'file')} uncommitted` : ''}`);
  } else if (dirty) {
    say(`${plural(dirty, 'file')} uncommitted in the main checkout`);
  }
  for (const item of card.holding) {
    say(`holding #${item.item_id} ${item.item_title}, lease ${span(ctx, item.item_lease_until)} left${item.item_check ? `; check: ${item.item_check}` : ''}`);
    const files = briefFiles(item.item_brief);
    if (files.length) say(`  files: ${files.join(', ')}`);
  }
  for (const { item, verdict } of card.sentBack) {
    say(`sent back: #${item.item_id} ${verdict ? `${verdict.verdict_reason} by ${verdict.verdict_by}: ${firstLine(verdict.verdict_note)}` : 'rejected'}`);
  }
  if (card.awaiting.length) say(`awaiting a verdict: ${card.awaiting.map((item) => `#${item.item_id} (${span(ctx, item.item_updated_at)})`).join(', ')}`);
  if (isMain) {
    if (card.toVerify.length) say(`to verify: ${card.toVerify.map((item) => `#${item.item_id} ${item.item_lane} (${span(ctx, item.item_updated_at)})`).join(', ')}`);
    if (card.toMerge.length) say(`verified, not merged: ${card.toMerge.map((item) => `#${item.item_id} at ${item.item_commit.slice(0, 12)}`).join(', ')}; pullboard merged <id> <commit> records each`);
    for (const hold of card.holds) say(`held: the ${hold.hold_lane} lane, ${hold.hold_reason}`);
    const byLane = Object.entries(Map.groupBy(card.open, (item) => item.item_lane)).map(([lane, items]) => `${lane} ${items.length}`);
    say(`open: ${card.open.length}${byLane.length ? ` (${byLane.join(', ')})` : ''}`);
  } else if (card.hold) {
    say(`the ${me.lane} lane is held by ${card.hold.hold_by}: ${card.hold.hold_reason}`);
  }
  if (card.unread) say(`${plural(card.unread, 'unread shout')}; newest from ${card.newest[0].shout_from}: ${firstLine(card.newest[0].shout_text)} (pullboard inbox reads them)`);
  const inLane = card.open.filter((item) => item.item_lane === me.lane);
  const isVerified = (id) => card.all.find((other) => other.item_id === Number(id))?.item_status === 'verified';
  const ready = inLane.filter((item) => !item.item_after || item.item_after.split(',').every(isVerified)).length;
  let next;
  if (card.holding.length) next = `build #${card.holding[0].item_id}, commit, then pullboard submit ${card.holding[0].item_id}`;
  else if (card.sentBack.length) next = `pullboard claim ${card.sentBack[0].item.item_id}, fix what the verifier found, and submit again`;
  else if (isMain) next = card.toVerify.length ? 'pullboard next --verify --as coordinator' : 'curate the queue: pullboard add, edit, hold';
  else if (card.hold) next = 'wait for the hold to lift: pullboard next --wait 9 (minutes)';
  else if (ready) next = `pullboard next (${ready} ready in your lane)`;
  else if (inLane.length) next = `pullboard next --wait 9 (minutes); ${inLane.length} in your lane ${inLane.length === 1 ? 'waits' : 'wait'} on other work`;
  else if (card.awaiting.length) next = 'pullboard next --wait 9 (minutes); a rejected item comes back to your lane';
  else next = 'nothing open in your lane; pullboard next --verify names work you can check';
  say(`next: ${next}`);
  return 0;
}

/**
 * \`pullboard view\` (N26): serve the micro site for every project on this machine until stopped,
 * registering the repo it starts in, and open it in the browser unless asked not to.
 *
 * @param {any} io
 * @param {any} values
 * @returns {Promise<number>}
 */
async function viewHere(io, values) {
  try {
    const info = repoInfo(io.cwd);
    if (info.isMain && existsSync(join(info.root, CONFIG_FILE))) registerProject(info.root);
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
  }
  const port = values.port === undefined ? 0 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Refused('USAGE', '--port is a number from 0 to 65535; 0 picks a free one');
  const view = await serveView({ port });
  io.say(`Pullboard view: ${view.url}`);
  io.say('Only this machine can reach it, and only with that link. Ctrl-C stops it.');
  if (!values['no-open']) {
    const opener = process.platform === 'darwin' ? ['open', [view.url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', view.url]] : ['xdg-open', [view.url]];
    spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  }
  await new Promise((stop) => {
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  await view.close();
  return 0;
}

/**
 * The commands that set a repo or a worktree up.
 *
 * @param {any} io
 * @param {{ first?: string }} args
 * @returns {Record<string, () => number>}
 */
function setupCommands(io, { first, values }) {
  return {
    init: () => {
      const info = repoInfo(io.cwd);
      const notes = initRepo({
        info,
        openBoardHere: () => store.openBoard(join(info.commonDir, 'pullboard', 'board.sqlite'), io.clock),
        register: store.register,
        closeBoard: store.closeBoard,
      });
      notes.forEach((note) => io.say(note));
      if (registerProject(info.root)) io.say('registered this project on this machine, so pullboard view lists it');
      io.say('next: write SPEC.md rows, declare lanes in pullboard.json, then: pullboard add <lane> <title>');
      return 0;
    },
    hooks: () => {
      installHooks(repoInfo(io.cwd).root).forEach((note) => io.say(note));
      return 0;
    },
    join: () => {
      const ctx = context(io);
      if (ctx.info.isMain) throw new Refused('MAIN_IS_COORDINATOR', 'the main checkout is the coordinator; join from a worktree: git worktree add ../<dir>');
      if (!first || first === COORDINATOR || !isLane(ctx.config, first)) {
        throw new Refused('NO_LANE', `no lane "${first ?? ''}"; lanes: ${laneNames(ctx.config).slice(1).join(', ') || 'none yet, declare them in pullboard.json'}`);
      }
      const route = values.route ?? 'strong';
      const id = withBoard(ctx, (board) => store.register(board, { lane: first, path: ctx.info.root, route }));
      io.say(`joined as ${id} in the ${first} lane${route === 'light' ? ', on the light route' : ''}`);
      return 0;
    },
    worktree: () => worktreeFor(io, first, values.route ?? 'strong'),
  };
}

/**
 * Make a worktree for a new agent in a lane, beside the main checkout, on its own branch, already
 * joined: one command where a new agent would otherwise copy three with placeholders in them.
 *
 * @param {any} io
 * @param {string | undefined} lane
 * @param {string} route
 * @returns {number}
 */
function worktreeFor(io, lane, route) {
  const ctx = context(io);
  if (!lane || lane === COORDINATOR || !isLane(ctx.config, lane)) {
    throw new Refused('NO_LANE', `no lane "${lane ?? ''}"; lanes: ${laneNames(ctx.config).slice(1).join(', ') || 'none yet, declare them in pullboard.json'}`);
  }
  if (!store.ROUTES.includes(route)) {
    throw new Refused('BAD_ROUTE', `route "${route}" is strong (needs a frontier model) or light (any model can build it from the brief)`);
  }
  const mainRoot = resolve(ctx.info.commonDir, '..');
  const pathFor = (n) => join(dirname(mainRoot), `${basename(mainRoot)}-${lane}-${n}`);
  const isTaken = (n) => existsSync(pathFor(n)) || tryGit(mainRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${lane}/${n}`]).status === 0;
  let n = 1;
  while (isTaken(n)) n += 1;
  git(mainRoot, ['worktree', 'add', '-q', '-b', `${lane}/${n}`, pathFor(n), git(mainRoot, ['rev-parse', 'HEAD'])]);
  const root = git(pathFor(n), ['rev-parse', '--show-toplevel']);
  const id = withBoard(ctx, (board) => store.register(board, { lane, path: root, route }));
  io.say(`made ${root} on branch ${lane}/${n}, joined as ${id} in the ${lane} lane${route === 'light' ? ', on the light route' : ''}`);
  io.say(`Work only in that folder. A shell that starts each command in the main checkout acts as the coordinator there, so start every command with: ${cdTo(root)}`);
  if (existsSync(join(root, 'package.json'))) io.say(`  ${cdTo(root)} npm install    (its own install, so its tests run its own code)`);
  io.say(`  ${cdTo(root)} pullboard inbox`);
  io.say(`  ${cdTo(root)} pullboard next`);
  // A subagent inherits the instructions of the session that launched it, often another repo's (I7).
  io.say('For a subagent working here, begin its prompt with:');
  io.say(`  You are ${id}, in the ${lane} lane. Work only in ${shellWord(root)}, and start every command with ${cdTo(root)}`);
  io.say(`  Read ${shellWord(join(root, 'AGENTS.md'))} first. Its rules govern this work, over any other repo's instructions you were given.`);
  return 0;
}

/**
 * The commands that read the board without changing it.
 *
 * @param {any} io
 * @param {any} args
 * @returns {Record<string, () => number>}
 */
function readCommands(io, { first, values }) {
  return {
    resume: () => resumeHere(io),
    whoami: () => {
      const ctx = context(io);
      const me = withBoard(ctx, (board) => whoAmI(ctx, board));
      io.say(`${me.id} (${me.lane} lane${me.route === 'light' ? ', light route' : ''}) at ${ctx.info.root}`);
      return 0;
    },
    lanes: () => {
      const { config } = context(io);
      io.say(`${COORDINATOR.padEnd(14)} everything no lane owns; verifies, merges, may change any path`);
      for (const [name, lane] of Object.entries(config.lanes)) {
        const specs = lane.specs?.length ? `  [${lane.specs.join(', ')}]` : '';
        const starts = lane.starts ? `  starts: ${lane.starts}` : '';
        io.say(`${name.padEnd(14)} ${lane.owns.length ? lane.owns.join(' ') : '(owns no folders)'}${specs}${starts}`);
      }
      if (config.shared.length) io.say(`${'shared'.padEnd(14)} ${config.shared.join(' ')} (any lane)`);
      return 0;
    },
    list: () => {
      const ctx = context(io);
      const items = withBoard(ctx, (board) => store.listItems(board, { lane: first, all: values.all }))
        .filter((item) => !values.route || item.item_route === values.route);
      if (values.json) io.say(JSON.stringify(items, null, 2));
      else if (!items.length) io.say(values.all ? 'no items yet' : 'nothing open; --all shows closed items');
      else items.forEach((item) => io.say(itemLine(item)));
      return 0;
    },
    show: () => {
      const ctx = context(io);
      const id = idArg(first);
      const { item, verdicts, moves, related } = withBoard(ctx, (board) => ({
        item: store.getItem(board, id),
        verdicts: store.verdictsFor(board, id),
        moves: store.events(board, { itemId: id }).filter((event) => ['attempt', 'escalate'].includes(event.event_kind)),
        related: store.relatedItems(board, store.getItem(board, id)),
      }));
      if (values.json) {
        io.say(JSON.stringify({ ...item, verdicts }, null, 2));
        return 0;
      }
      io.say(itemLine(item));
      if (item.item_criterion) io.say(`criterion: ${item.item_criterion}`);
      if (item.item_check) io.say(`check: ${item.item_check}`);
      sayBrief(io, item.item_brief);
      for (const { item: other, shared } of related) {
        io.say(`related: #${other.item_id} ${other.item_title}: ${shared.slice(0, 4).join(', ')}${shared.length > 4 ? ', ...' : ''} (git log -p -1 ${other.item_commit.slice(0, 12)} -- ${shared[0]})`);
      }
      const attempts = moves.filter((event) => event.event_kind === 'attempt').map((event) => JSON.parse(event.event_detail).result);
      if (attempts.length) io.say(`unattended attempts: ${attempts.join(', ')}`);
      for (const event of moves.filter((entry) => entry.event_kind === 'escalate')) {
        const detail = JSON.parse(event.event_detail);
        io.say(`escalated ${detail.from} -> ${detail.to} by ${event.event_by}${detail.attempt ? `, pinned at ${detail.attempt}` : ''}: ${detail.note.split('\n')[0]}`);
      }
      if (item.item_frozen) {
        const frozen = JSON.parse(item.item_frozen);
        io.say(`frozen at claim (${item.item_frozen_digest.slice(0, 12)}):`);
        frozen.rows.forEach((row) => io.say(`  ${row.id}: ${row.text}${row.gate ? `  | gate: ${row.gate}` : ''}`));
      }
      if (item.item_commit) io.say(`submitted by ${item.item_built_by} at ${item.item_commit}`);
      verdicts.forEach((verdict) => io.say(`${verdict.verdict_decision} ${verdict.verdict_reason} by ${verdict.verdict_by} at ${verdict.verdict_commit.slice(0, 12)}${verdict.verdict_note ? `: ${verdict.verdict_note}` : ''}`));
      if (item.item_merged_commit) io.say(`merged as ${item.item_merged_commit}`);
      if (item.item_withdrawn_reason) io.say(`withdrawn: ${item.item_withdrawn_reason}`);
      return 0;
    },
    status: () => {
      const ctx = context(io);
      const summary = withBoard(ctx, (board) => {
        const me = whoAmI(ctx, board);
        const mine = store.listItems(board).filter((item) => item.item_status === 'claimed' && item.item_owner === me.id);
        return { me, mine, stats: store.stats(board), unread: store.unreadCount(board, me.id) };
      });
      if (values.json) {
        io.say(JSON.stringify(summary, null, 2));
        return 0;
      }
      const { items, accepted, rejected } = summary.stats;
      io.say(`${summary.me.id}: ${summary.unread} unread shouts; holding ${summary.mine.map((item) => `#${item.item_id}`).join(', ') || 'nothing'}`);
      io.say(`board: ${items.open} open, ${items.claimed} claimed, ${items.submitted} awaiting verification, ${items.verified} verified, ${items.withdrawn} withdrawn`);
      io.say(`verdicts: ${accepted} accepted, ${rejected} rejected`);
      if (Object.keys(ctx.config.products).length) {
        const all = withBoard(ctx, (board) => store.listItems(board, { all: true }));
        productSummaries(ctx.config, loadSpec(ctx.info.root, ctx.config), all).forEach((product) => io.say(productLine(product)));
      }
      return 0;
    },
    inbox: () => {
      const ctx = context(io);
      const shouts = withBoard(ctx, (board) => store.inbox(board, whoAmI(ctx, board).id));
      if (!shouts.length) io.say('no new shouts');
      shouts.forEach((shout) => io.say(`${shout.shout_at.slice(0, 16)}  ${shout.shout_from} -> ${shout.shout_to}: ${shout.shout_text}`));
      return 0;
    },
    ledger: () => {
      const ctx = context(io);
      const { items, stats } = withBoard(ctx, (board) => ({
        items: store.listItems(board, { all: true }),
        stats: store.stats(board),
      }));
      const built = items.filter((item) => item.item_built_by && item.item_status !== 'withdrawn').reverse();
      const cell = (text) => String(text ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ');
      io.say(`${stats.items.verified} verified by a second agent · ${stats.items.submitted} awaiting verification · ${stats.rejected} rejection${stats.rejected === 1 ? '' : 's'} along the way`);
      io.say('');
      io.say('| # | Lane | Item | Spec | Built by | Verified by | Commit | Merged |');
      io.say('| --- | --- | --- | --- | --- | --- | --- | --- |');
      for (const item of built) {
        io.say(`| ${item.item_id} | ${item.item_lane} | ${cell(item.item_title)} | ${cell(item.item_spec_ids)} | ${item.item_built_by} | ${item.item_verified_by ?? ''} | ${(item.item_commit ?? '').slice(0, 12)} | ${(item.item_merged_commit ?? '').slice(0, 12)} |`);
      }
      return 0;
    },
    log: () => {
      const ctx = context(io);
      const itemId = first ? idArg(first) : undefined;
      const rows = withBoard(ctx, (board) => store.events(board, { itemId }));
      rows.forEach((event) => io.say(`${event.event_at.slice(0, 19)}  ${event.event_by.padEnd(14)} ${event.event_kind.padEnd(9)} ${event.item_id ? `#${event.item_id}` : ''} ${event.event_detail === '{}' ? '' : event.event_detail}`.trimEnd()));
      return 0;
    },
  };
}

/**
 * Submit: a clean tree, nothing untracked, the gate green at HEAD, then the board (V4).
 *
 * The cheap checks run before the gate, so a submit that cannot succeed fails fast.
 *
 * @param {any} ctx
 * @param {number} id
 * @returns {number}
 */
function submitHere(ctx, id) {
  const { root } = ctx.info;
  const { me, claimHead } = withBoard(ctx, (board) => {
    const who = whoAmI(ctx, board);
    const item = store.getItem(board, id);
    if (item.item_status !== 'claimed' || item.item_owner !== who.id) {
      throw new Refused('NOT_YOURS', `item #${id} is not claimed by you; claim it first`);
    }
    // A bar that moved since claim can get no verdict (V3), so say so now, not after a verifier's run (V11).
    // A cited row taken out of force (retired, wont) cannot be frozen at all, and says so too.
    if (item.item_frozen_digest) {
      let digest = null;
      let unusable = '';
      try {
        digest = freezer(ctx)(item).digest;
      } catch (error) {
        if (!(error instanceof Refused)) throw error;
        unusable = error.message.replace(/^\[\w+\] /, '').split(';')[0];
      }
      if (digest !== item.item_frozen_digest) {
        const step = unusable
          ? `the coordinator either restores the row and runs pullboard refreeze ${id}, or withdraws #${id}`
          : `${who.id === COORDINATOR ? '' : 'the coordinator runs '}pullboard refreeze ${id}, then you claim it and submit again`;
        throw new Refused('CRITERIA_CHANGED', `the spec rows #${id} cites changed after it was claimed${unusable ? ` (${unusable})` : ''}, so no verifier could judge it; ${step}`);
      }
    }
    return { me: who, claimHead: item.item_claim_head };
  });
  if (!isClean(root)) throw new Refused('DIRTY', 'commit your changes first; the gate must check what you submit');
  const stray = untracked(root);
  if (stray.length) throw new Refused('UNTRACKED', `commit or ignore ${stray.length} untracked file(s), e.g. ${stray[0]}`);
  const commit = headCommit(root);
  if (!commit) throw new Refused('NO_COMMIT', 'nothing committed yet');
  const gate = runGate(root, ctx.config);
  if (!gate.isGreen) throw new Refused('GATE_RED', `the gate is red at ${commit.slice(0, 12)}; fix it, commit, submit again. ${gateReport(gate)}`);
  withBoard(ctx, (board) => store.submit(board, id, { agentId: me.id, commit, tree: headTree(root) ?? '', files: filesSince(root, id, claimHead, commit) }));
  const pin = `refs/pullboard/items/${id}/${commit.slice(0, 12)}`;
  git(root, ['update-ref', pin, commit]);
  ctx.io.say(`submitted #${id} at ${commit.slice(0, 12)}; ${gateReport(gate)}`);
  ctx.io.say(`pinned as ${pin}, so this work can't be lost; keep your worktree until it is merged`);
  ctx.io.say(`next: another agent checks out ${commit.slice(0, 12)} and runs: pullboard verify ${id} accept|reject`);
  return 0;
}

/**
 * Verify from this checkout (V3, V7): the submitted commit must be here, at or under HEAD, and the
 * criterion is re-read from the spec, so a verdict is never given against a moved bar.
 *
 * @param {any} ctx
 * @param {number} id
 * @param {any} args
 * @returns {number}
 */
function verifyHere(ctx, id, { second, values }) {
  const decision = { accept: 'ACCEPT', reject: 'REJECT' }[String(second ?? '').toLowerCase()];
  if (!decision) throw new Refused('USAGE', 'pullboard verify <id> accept, or reject --reason CODE --note "..."');
  const { root } = ctx.info;
  const result = withBoard(ctx, (board) => {
    checkMainVerifier(ctx, board, values);
    const me = whoAmI(ctx, board);
    const item = store.getItem(board, id);
    if (item.item_status !== 'submitted') {
      throw new Refused('NOT_SUBMITTED', `item #${id} is ${item.item_status}, not submitted`);
    }
    const head = headCommit(root) ?? '';
    const commit = resolveCommit(root, item.item_commit);
    if (!commit || !contains(root, commit, head)) {
      throw new Refused('NOT_AT_COMMIT', `check out the submitted commit first: ${cdTo(root)} git switch --detach ${item.item_commit.slice(0, 12)}`);
    }
    let digest = 'missing';
    try {
      digest = freezer(ctx)(item).digest;
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
    }
    return store.verify(board, id, {
      agentId: me.id,
      decision,
      reason: values.reason,
      note: textArg(ctx.io, values, 'note') ?? '',
      head,
      digest,
      policy: ctx.config.verify,
    });
  });
  ctx.io.say(result.decision === 'ACCEPT' ? `verified #${id}: ${result.reason}` : `rejected #${id}: ${result.reason}; it is open again for rework`);
  return 0;
}

/**
 * One loop of `next`: claim the next free item, or name the next one to verify. A claim that loses a
 * race to another agent is not an error; the caller looks again.
 *
 * @param {any} ctx
 * @param {any} values
 * @returns {{ item?: any, held?: boolean, retry?: boolean, reasons?: string[] }}
 */
function nextOnce(ctx, values) {
  return withBoard(ctx, (board) => {
    if (values.verify) checkMainVerifier(ctx, board, values);
    const me = whoAmI(ctx, board);
    const warm = values.verify ? [] : warmFiles(ctx, board, me);
    const { item, reasons, shared } = store.nextFor(board, { agentId: me.id, lane: me.lane, verify: values.verify, runnable: values.runnable, routes: values.routes, warm });
    if (!item) return { reasons };
    if (values.verify) return { item };
    if (item.item_status === 'claimed') return { item, held: true };
    try {
      store.claim(board, item.item_id, { agentId: me.id, lane: me.lane, leaseMs: ctx.config.leaseMs, freeze: freezer(ctx), head: headCommit(ctx.info.root) });
    } catch (error) {
      if (error instanceof Refused && ['HELD', 'BLOCKED', 'ONE_CLAIM'].includes(error.code)) return { retry: true };
      throw error;
    }
    return { item: store.getItem(board, item.item_id), shared };
  });
}

/**
 * `pullboard next` (N2): the whole start of an agent's loop in one command. With --wait, it keeps
 * looking until something is free, so an agent blocked on other work needs no polling of its own.
 *
 * @param {any} io
 * @param {any} values
 * @returns {Promise<number>}
 */
async function nextHere(io, values) {
  const ctx = context(io);
  const minutes = values.wait === undefined ? 0 : Number(values.wait);
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 240) {
    throw new Refused('USAGE', '--wait is a number of minutes from 0 to 240');
  }
  const deadline = Date.now() + minutes * 60_000;
  for (;;) {
    const found = nextOnce(ctx, values);
    if (found.item) {
      const item = found.item;
      const here = cdTo(ctx.info.root);
      const as = ctx.info.isMain ? ' --as coordinator' : '';
      if (values.verify) {
        io.say(`next to verify: #${item.item_id} ${item.item_title}, built by ${item.item_built_by} at ${item.item_commit.slice(0, 12)}`);
        io.say(`check out exactly that commit, here: ${here} git switch --detach ${item.item_commit}`);
        io.say(`then: ${here} pullboard verify ${item.item_id} accept${as} --note "how you proved it", or reject${as} --reason CODE --note "what failed"`);
      } else {
        io.say(`${found.held ? 'you hold' : 'claimed'} #${item.item_id}: ${item.item_title}`);
        if (found.shared?.length) io.say(`it touches ${found.shared.length === 1 ? 'a file' : `${found.shared.length} files`} you worked in recently: ${found.shared.slice(0, 4).join(', ')}`);
        if (item.item_criterion) io.say(`criterion: ${item.item_criterion}`);
        if (item.item_check) io.say(`check: ${item.item_check}   (run it before you submit)`);
        for (const row of item.item_frozen ? JSON.parse(item.item_frozen).rows : []) io.say(`  ${row.id}: ${row.text}`);
        sayBrief(io, item.item_brief);
        io.say(`when it is built and committed: ${here} pullboard submit ${item.item_id}`);
      }
      return 0;
    }
    if (!found.retry && Date.now() >= deadline) {
      const waited = minutes ? ` after ${minutes} minutes` : '';
      io.err(`pullboard: [NOTHING_FREE] ${found.reasons.join('; ')}${waited}. To keep looking: pullboard next --wait 9${values.verify ? ' --verify' : ''} (minutes; give the command a ten-minute timeout)`);
      return 1;
    }
    if (!found.retry) await new Promise((done) => setTimeout(done, 5000));
  }
}

/**
 * `pullboard sweep` (N15, N17): run a checker, then file one routed item per file it flags, each
 * with the problems in its brief and the checker on that file as its check. Each check runs once
 * first, on the file as it is: it must fail there, or it could never prove a fix.
 *
 * @param {any} ctx
 * @param {any} board
 * @param {{ id: string }} me
 * @param {any} values
 * @returns {number}
 */
function sweepHere(ctx, board, me, values) {
  if (me.id !== COORDINATOR) throw new Refused('COORDINATOR_ONLY', 'the coordinator files sweep items, from the main checkout');
  const report = String(values.run ?? '').trim();
  const check = String(values.check ?? '').trim();
  if (!report || !check.includes('{file}')) {
    throw new Refused('USAGE', 'pullboard sweep --run "<checker over the repo>" --check "<the checker on one file, with {file} where its path goes>"');
  }
  const max = values.max === undefined ? 20 : idArg(values.max, 'a number after --max');
  const ran = spawnSync(report, { cwd: ctx.info.root, shell: true, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const problems = parseProblems(`${ran.stdout ?? ''}\n${ran.stderr ?? ''}`, ctx.info.root);
  if (!problems.length) {
    ctx.io.say(`the checker reported no problems I can read (exit ${ran.status}); nothing to file`);
    return 0;
  }
  const covered = new Set(store.listItems(board).filter((item) => item.item_title.startsWith('fix ')).flatMap((item) => briefFiles(item.item_brief)));
  const { items, skipped } = sweepItems(problems, {
    laneOf: (path) => laneOf(ctx.config, path),
    covered,
    check,
    report,
    route: values.route ?? 'light',
    max,
  });
  const blind = [];
  for (const item of items) {
    const canary = spawnSync(item.check, { cwd: ctx.info.root, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (canary.status === 0) {
      blind.push(item.file);
      continue;
    }
    if (values['dry-run']) {
      ctx.io.say(`would file: ${item.title} (${item.lane} lane, ${item.route})`);
      continue;
    }
    const id = store.addItem(board, { by: me.id, lane: item.lane, title: item.title, criterion: item.criterion, brief: item.brief, route: item.route, check: item.check });
    ctx.io.say(`#${id} ${item.title} (${item.lane} lane, ${item.route})`);
  }
  if (skipped.length) ctx.io.say(`already open: ${skipped.join(', ')}`);
  if (blind.length) {
    ctx.io.err(`pullboard: [CHECK_CANNOT_FAIL] the check passes on ${blind.join(', ')} although the checker flags problems there, so it could never prove a fix; not filed. A check ending in a pipe takes its exit status from the last command`);
  }
  const filed = items.length - blind.length;
  ctx.io.say(`${problems.length} problems in ${new Set(problems.map((problem) => problem.file)).size} files; ${values['dry-run'] ? 'would file' : 'filed'} ${filed}`);
  return blind.length ? 1 : 0;
}

/**
 * The commands that change the board.
 *
 * @param {any} io
 * @param {any} args
 * @returns {Record<string, () => number>}
 */
function workCommands(io, args) {
  const { first, second, rest, values } = args;
  const act = (work) => {
    const ctx = context(io);
    return withBoard(ctx, (board) => work(ctx, board, whoAmI(ctx, board)));
  };
  return {
    add: () => act((ctx, board, me) => {
      if (!first || !isLane(ctx.config, first)) throw new Refused('NO_LANE', `no lane "${first ?? ''}"; see: pullboard lanes`);
      const specIds = idList(values.specs);
      const problems = idProblems(loadSpec(ctx.info.root, ctx.config), specIds);
      if (problems.length) throw new Refused('UNKNOWN_SPEC', `${problems.join('; ')}`);
      const parentId = values.parent ? idArg(values.parent, 'a parent item id') : null;
      const after = idList(values.after).map((text) => idArg(text, 'an item id after --after'));
      const title = [second, ...rest].filter(Boolean).join(' ');
      const id = store.addItem(board, {
        by: me.id,
        lane: first,
        title,
        criterion: values.criterion ?? '',
        specIds,
        parentId,
        after,
        brief: briefInLane(ctx, first, briefArg(io, values) ?? ''),
        route: values.route ?? 'strong',
        check: values.check ?? '',
      });
      io.say(`#${id}`);
      return 0;
    }),
    edit: () => act((ctx, board, me) => {
      const id = idArg(first);
      const brief = briefArg(io, values);
      store.editItem(board, id, {
        agentId: me.id,
        brief: brief === undefined ? undefined : briefInLane(ctx, store.getItem(board, id).item_lane, brief),
        route: values.route,
        criterion: values.criterion,
        check: values.check,
      });
      io.say(`edited #${id}`);
      return 0;
    }),
    escalate: () => act((ctx, board, me) => {
      const id = idArg(first);
      const note = textArg(io, values, 'note') ?? '';
      const moved = store.escalate(board, id, { agentId: me.id, note });
      if (me.id !== COORDINATOR) {
        store.shout(board, { from: me.id, to: COORDINATOR, text: `#${id} escalated ${moved.from} -> ${moved.to}: ${note}`, lanes: laneNames(ctx.config) });
      }
      io.say(`#${id} escalated ${moved.from} -> ${moved.to}; it is open for a ${moved.to} agent`);
      return 0;
    }),
    run: () => runItems(io, values, { context, withBoard, whoAmI, nextOnce, submitHere, freezer }),
    sweep: () => act((ctx, board, me) => sweepHere(ctx, board, me, values)),
    next: () => nextHere(io, values),
    check: () => {
      const ctx = context(io);
      const item = withBoard(ctx, (board) => {
        if (first) return store.getItem(board, idArg(first));
        const me = whoAmI(ctx, board);
        const held = store.listItems(board).find((entry) => entry.item_status === 'claimed' && entry.item_owner === me.id && entry.item_parent_id === null);
        if (!held) throw new Refused('NOT_HOLDING', 'you hold no item; name one, pullboard check <id>, or run the project gate: pullboard gate');
        return held;
      });
      if (!item.item_check) throw new Refused('NO_CHECK', `#${item.item_id} has no check command; its proof is the project gate: pullboard gate`);
      const run = runShell(ctx.info.root, item.item_check);
      io.say(`check ${run.isGreen ? 'green' : 'red'} in ${run.seconds}s: ${item.item_check}`);
      if (!run.isGreen) io.say(digestOf(run.output).replace(/^/gm, '  '));
      return run.isGreen ? 0 : 1;
    },
    claim: () => act((ctx, board, me) => {
      const result = store.claim(board, idArg(first), { agentId: me.id, lane: me.lane, leaseMs: ctx.config.leaseMs, freeze: freezer(ctx), head: headCommit(ctx.info.root) });
      io.say(`${result.renewed ? 'renewed' : 'claimed'} #${first} until ${result.leaseUntil}; criterion frozen as ${result.digest.slice(0, 12)}`);
      return 0;
    }),
    hold: () => act((ctx, board, me) => {
      if (!first || !isLane(ctx.config, first)) throw new Refused('NO_LANE', `no lane "${first ?? ''}"; see: pullboard lanes`);
      if (values.off) {
        store.releaseLane(board, first, { agentId: me.id });
        io.say(`released the ${first} lane`);
      } else {
        store.holdLane(board, first, { agentId: me.id, reason: values.reason ?? '' });
        io.say(`holding the ${first} lane: ${values.reason}. Release it with: pullboard hold ${first} --off`);
      }
      return 0;
    }),
    release: () => act((ctx, board, me) => {
      store.release(board, idArg(first), me.id);
      io.say(`released #${first}`);
      return 0;
    }),
    submit: () => submitHere(context(io), idArg(first)),
    done: () => submitHere(context(io), idArg(first)),
    verify: () => verifyHere(context(io), idArg(first), args),
    merged: () => act((ctx, board, me) => {
      const commit = resolveCommit(ctx.info.root, second ?? '');
      if (!commit) throw new Refused('NO_COMMIT', `no commit "${second ?? ''}" in this repo`);
      store.merged(board, idArg(first), { agentId: me.id, commit });
      io.say(`#${first} merged as ${commit.slice(0, 12)}`);
      return 0;
    }),
    withdraw: () => act((ctx, board, me) => {
      store.withdraw(board, idArg(first), { agentId: me.id, reason: [second, ...rest].filter(Boolean).join(' ') });
      io.say(`withdrew #${first}`);
      return 0;
    }),
    refreeze: () => act((ctx, board, me) => {
      const result = store.refreeze(board, idArg(first), { agentId: me.id, freeze: freezer(ctx) });
      io.say(`#${first} refrozen ${String(result.before).slice(0, 12)} -> ${result.after.slice(0, 12)}; open again`);
      return 0;
    }),
    shout: () => act((ctx, board, me) => {
      store.shout(board, { from: me.id, to: first ?? '', text: [second, ...rest].filter(Boolean).join(' '), lanes: laneNames(ctx.config) });
      io.say(`shouted to ${first}`);
      return 0;
    }),
  };
}

/**
 * Every spec id something cites (S8): commit headers since the spec's first commit, and every item
 * on the board, open or closed. Each must still be in the spec. The board is shared by every
 * checkout, so at an older commit an item may cite a row a later commit added: that id is not lost
 * here, only not written yet, and it counts once any ref has committed it (S10).
 *
 * @param {any} ctx
 * @param {{ ids: Map<string, string>, since: string | null }} history - this checkout's.
 * @returns {Map<string, string>} Each id, with who cites it.
 */
function citations(ctx, { ids, since }) {
  const cited = since ? commitCitations(ctx.info.root, since) : new Map();
  if (!existsSync(ctx.file)) return cited;
  const byItems = new Map();
  for (const item of withBoard(ctx, (board) => store.listItems(board, { all: true }))) {
    for (const id of item.item_spec_ids ? item.item_spec_ids.split(',') : []) {
      if (!cited.has(id) && !byItems.has(id)) byItems.set(id, `item #${item.item_id}`);
    }
  }
  const unseen = [...byItems.keys()].some((id) => !ids.has(id));
  const elsewhere = unseen ? committedIds(ctx.info.root, ctx.config.spec, ['--all']).ids : new Map();
  for (const [id, where] of byItems) if (ids.has(id) || !elsewhere.has(id)) cited.set(id, where);
  return cited;
}

/**
 * The spec commands: check, show, unmet, signoff.
 *
 * @param {any} io
 * @param {any} args
 * @returns {number}
 */
function specCommand(io, { first, second, rest, values }) {
  const ctx = context(io);
  const spec = loadSpec(ctx.info.root, ctx.config);
  if (!spec.exists) throw new Refused('NO_SPEC', `no ${ctx.config.spec}; run: pullboard init`);
  const practice = loadSpec(ctx.info.root, { ...ctx.config, spec: ctx.config.practice });
  if (first === 'check' || first === undefined) {
    const files = [[ctx.config.spec, spec], ...(practice.exists ? [[ctx.config.practice, practice]] : [])];
    let errors = 0;
    for (const [name, parsed] of files) {
      const findings = lintSpec(parsed);
      findings.forEach((finding) => io.say(`${name}:${finding.line} ${finding.id ?? ''} ${finding.level}: ${finding.message}`.replace('  ', ' ')));
      const history = committedIds(ctx.info.root, name);
      const cited = name === ctx.config.spec ? citations(ctx, history) : new Map();
      const lost = permanenceProblems(parsed, { committed: history.ids, cited });
      lost.forEach((problem) => io.say(`${name}: ${problem.id} error: ${problem.message}`));
      const fileErrors = findings.filter((finding) => finding.level === 'error').length + lost.length;
      errors += fileErrors;
      io.say(`${name}: ${parsed.rows.length} rows, ${fileErrors} errors, ${findings.length + lost.length - fileErrors} warnings`);
    }
    const unnamed = productProblems(ctx.config, spec);
    unnamed.forEach((problem) => io.say(`${ctx.config.spec}: error: ${problem}`));
    errors += unnamed.length;
    return errors ? 1 : 0;
  }
  const signoffs = readSignoffs(ctx.info.root);
  if (first === 'view') {
    const out = values.out ? resolve(ctx.io.cwd, values.out) : join(ctx.info.gitDir, 'pullboard', 'spec.html');
    const html = renderSpecView({
      title: spec.title,
      spec,
      practice,
      signoffs,
      generatedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
      files: { spec: ctx.config.spec, practice: ctx.config.practice },
    });
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, html);
    io.say(`wrote ${out}`);
    io.say(`open: ${pathToFileURL(out).href}`);
    return 0;
  }
  if (first === 'show') {
    const row = spec.rows.find((entry) => entry.id === second);
    if (!row) throw new Refused('NO_ROW', `no row ${second ?? ''} in ${ctx.config.spec}`);
    const standing = standings(spec.rows, signoffs).get(row.id) ?? { met: [], stale: [] };
    io.say(`${row.id} [${row.status}${row.tier ? `, ${row.tier}` : ''}] ${row.text}`);
    if (row.gate) io.say(`gate: ${row.gate}`);
    if (row.serves.length) io.say(`serves: ${row.serves.join(', ')}`);
    io.say(`signed: ${standing.met.map((entry) => `${entry.by} ${entry.on}`).join(', ') || 'no'}${standing.stale.length ? `; stale: ${standing.stale.length}` : ''}`);
    return 0;
  }
  if (first === 'unmet') {
    const rows = unmetRows(spec.rows, signoffs, { mustOnly: values.must });
    rows.forEach((row) => io.say(`${row.id} [${row.tier || 'no tier'}] ${row.text}`));
    io.say(`${rows.length} approved rows without a current sign-off`);
    return 0;
  }
  if (first === 'signoff') {
    const ids = [second, ...rest].filter(Boolean).flatMap((text) => idList(text));
    const count = signOff(ctx.info.root, spec, { ids, by: values.by ?? '', on: new Date().toISOString().slice(0, 10) });
    io.say(`signed ${count} rows as ${values.by}; commit .pullboard/signoffs.jsonl`);
    return 0;
  }
  throw new Refused('USAGE', 'pullboard spec check | view | show <id> | unmet [--must] | signoff <ids> --by <initials>');
}

/**
 * Read everything git writes on a hook's stdin, or nothing when run by hand.
 *
 * @param {any} stdin
 * @returns {Promise<string>}
 */
async function readStdin(stdin) {
  if (!stdin || stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The hooks git runs. In a repo without pullboard.json they pass, so a stray hook never blocks.
 *
 * @param {any} io
 * @param {any} args
 * @returns {Promise<number>}
 */
async function hookCommand(io, { first, second }) {
  const info = repoInfo(io.cwd);
  let ctx;
  try {
    ctx = context(io);
  } catch (error) {
    if (error instanceof Refused && error.code === 'NO_CONFIG') return 0;
    throw error;
  }
  let problems = [];
  if (first === 'pre-commit') {
    applyFixers(info.root, ctx.config.fix).forEach((note) => io.err(`pullboard pre-commit: ${note}`));
    const agent = info.isMain ? null : withBoard(ctx, (board) => store.agentAt(board, info.root));
    problems = preCommitProblems({ root: info.root, isMain: info.isMain, config: ctx.config, agent });
  } else if (first === 'commit-msg') {
    const message = readFileSync(second ?? '', 'utf8');
    problems = commitMsgProblems(message, { rules: ctx.config.commits, spec: loadSpec(info.root, ctx.config) });
  } else if (first === 'pre-push') {
    problems = prePushProblems(info.root, await readStdin(io.stdin));
    if (!problems.length) {
      const gate = runGate(info.root, ctx.config);
      if (gate.isCached) io.say('pre-push: the gate passed on this exact tree; not running it twice');
      if (!gate.isGreen) problems = [`the gate is red; fix it before pushing. ${gateReport(gate)}`];
    }
  } else {
    throw new Refused('USAGE', 'pullboard hook pre-commit | commit-msg <file> | pre-push');
  }
  if (!problems.length) return 0;
  io.err(`pullboard ${first}: blocked\n${problems.map((problem) => `  - ${problem}`).join('\n')}\n${FIX_NOTE}`);
  return 1;
}

/**
 * Run one command. Returns the exit code: 0 done, 1 refused, 2 usage.
 *
 * @param {string[]} argv
 * @param {{ cwd: string, stdout: any, stderr: any, stdin?: any, clock?: any }} streams
 * @returns {Promise<number>}
 */
export async function main(argv, streams) {
  const io = {
    ...streams,
    say: (line) => streams.stdout.write(`${line}\n`),
    err: (line) => streams.stderr.write(`${line}\n`),
  };
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (error) {
    io.err(`pullboard: ${error.message}\n\n${HELP}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command = '', first, second, ...rest] = positionals;
  if (values.version || command === 'version') {
    io.say(VERSION);
    return 0;
  }
  if (values.help || !command || command === 'help') {
    io.say(HELP);
    return 0;
  }
  const args = { first, second, rest, values };
  try {
    if (command === 'tour') return tour(io);
    if (command === 'view') return await viewHere(io, values);
    if (command === 'spec') return specCommand(io, args);
    if (command === 'prompt') {
      let root = io.cwd;
      try {
        root = repoInfo(io.cwd).root;
      } catch (error) {
        if (!(error instanceof Refused)) throw error;
      }
      io.say(promptFor(root, first ?? '').trimEnd());
      return 0;
    }
    if (command === 'hook') return await hookCommand(io, args);
    if (command === 'gate') {
      const ctx = context(io);
      const gate = runGate(ctx.info.root, ctx.config);
      io.say(gateReport(gate));
      return gate.isGreen ? 0 : 1;
    }
    const commands = { ...setupCommands(io, args), ...readCommands(io, args), ...workCommands(io, args) };
    const run = commands[command];
    if (!run) {
      io.err(`pullboard: no command "${command}"\n\n${HELP}`);
      return 2;
    }
    return await run();
  } catch (error) {
    if (error instanceof Refused) {
      io.err(`pullboard: ${error.message}`);
      return 1;
    }
    throw error;
  }
}
