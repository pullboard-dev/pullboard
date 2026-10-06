/**
 * The pullboard command line: every command, bound to who is asking (B3). The main checkout is the
 * coordinator; every other worktree is the agent that joined from it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import * as store from './board.js';
import { COORDINATOR, loadConfig } from './config.js';
import { runGate } from './gate.js';
import { contains, git, headCommit, headTree, isClean, repoInfo, resolveCommit, tryGit, untracked } from './git.js';
import {
  FIX_NOTE,
  commitMsgProblems,
  installHooks,
  preCommitProblems,
  prePushProblems,
} from './hooks.js';
import { initRepo } from './init.js';
import { isLane, laneNames } from './lanes.js';
import { Refused } from './refused.js';
import { promptFor } from './skills.js';
import {
  frozenCriterion,
  idProblems,
  lintSpec,
  loadSpec,
  readSignoffs,
  signOff,
  standings,
  unmetRows,
} from './spec.js';
import { renderSpecView } from './view.js';

const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const VERSION = PACKAGE.version;

export const HELP = `pullboard ${VERSION}: the local-first work board for teams of coding agents.
Nothing ships until a second agent verifies it.

Set up
  pullboard init                        config, SPEC.md, agent instructions, git hooks, board
  pullboard worktree <lane>             make a worktree for a new agent in a lane, joined, and say what to run next
  pullboard join <lane>                 register the worktree you are in as an agent in a lane
  pullboard whoami | lanes | status     who you are, the lanes, the board at a glance
  pullboard hooks                       reinstall the git hooks (e.g. after a fresh clone)

Work
  pullboard add <lane> <title> [--criterion "..."] [--specs G1.2,K3] [--after 3,4] [--parent <id>]
                                        --after: claiming waits until those items are verified
  pullboard list [lane] [--all]         open and active items; --all adds verified and withdrawn
  pullboard show <id>                   an item, the criterion frozen at claim, its verdicts
  pullboard next [--wait <minutes>]     claim the next item in your lane that is free to start
  pullboard next --verify               name the next submitted item you can check
  pullboard claim <id>                  take or renew a lease; the first claim freezes the criterion
  pullboard release <id>                hand it back
  pullboard submit <id>                 needs a clean tree and the gate green at HEAD (alias: done)
  pullboard verify <id> accept --note "what you broke or which edge you tried, and what happened"
  pullboard verify <id> reject --reason TEST_FAILURE --note "what failed"
  pullboard shout <lane|agent|all> <text>       pullboard inbox

Coordinator
  pullboard merged <id> <commit>        record where verified work landed
  pullboard withdraw <id> <reason>      drop an item nobody should build
  pullboard refreeze <id>               re-freeze a criterion after its spec rows changed

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
  note: { type: 'string' },
  by: { type: 'string' },
  out: { type: 'string' },
  after: { type: 'string' },
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
  return { id: agent.agent_id, lane: agent.agent_lane };
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
  return `#${item.item_id}  ${item.item_status}${holder}${verifier}${rejected}  ${item.item_lane}  ${item.item_title}${specs}${parent}${after}`;
}

/**
 * The commands that set a repo or a worktree up.
 *
 * @param {any} io
 * @param {{ first?: string }} args
 * @returns {Record<string, () => number>}
 */
function setupCommands(io, { first }) {
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
      const id = withBoard(ctx, (board) => store.register(board, { lane: first, path: ctx.info.root }));
      io.say(`joined as ${id} in the ${first} lane`);
      return 0;
    },
    worktree: () => worktreeFor(io, first),
  };
}

/**
 * Make a worktree for a new agent in a lane, beside the main checkout, on its own branch, already
 * joined: one command where a new agent would otherwise copy three with placeholders in them.
 *
 * @param {any} io
 * @param {string | undefined} lane
 * @returns {number}
 */
function worktreeFor(io, lane) {
  const ctx = context(io);
  if (!lane || lane === COORDINATOR || !isLane(ctx.config, lane)) {
    throw new Refused('NO_LANE', `no lane "${lane ?? ''}"; lanes: ${laneNames(ctx.config).slice(1).join(', ') || 'none yet, declare them in pullboard.json'}`);
  }
  const mainRoot = resolve(ctx.info.commonDir, '..');
  const pathFor = (n) => join(dirname(mainRoot), `${basename(mainRoot)}-${lane}-${n}`);
  const isTaken = (n) => existsSync(pathFor(n)) || tryGit(mainRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${lane}/${n}`]).status === 0;
  let n = 1;
  while (isTaken(n)) n += 1;
  git(mainRoot, ['worktree', 'add', '-q', '-b', `${lane}/${n}`, pathFor(n), git(mainRoot, ['rev-parse', 'HEAD'])]);
  const root = git(pathFor(n), ['rev-parse', '--show-toplevel']);
  const id = withBoard(ctx, (board) => store.register(board, { lane, path: root }));
  io.say(`made ${root} on branch ${lane}/${n}, joined as ${id} in the ${lane} lane`);
  io.say('next, from that folder:');
  io.say(`  cd ${root}`);
  if (existsSync(join(root, 'package.json'))) io.say('  npm install    (its own install, so its tests run its own code)');
  io.say(`  pullboard inbox, then pullboard list ${lane}`);
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
    whoami: () => {
      const ctx = context(io);
      const me = withBoard(ctx, (board) => whoAmI(ctx, board));
      io.say(`${me.id} (${me.lane} lane) at ${ctx.info.root}`);
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
      const items = withBoard(ctx, (board) => store.listItems(board, { lane: first, all: values.all }));
      if (values.json) io.say(JSON.stringify(items, null, 2));
      else if (!items.length) io.say(values.all ? 'no items yet' : 'nothing open; --all shows closed items');
      else items.forEach((item) => io.say(itemLine(item)));
      return 0;
    },
    show: () => {
      const ctx = context(io);
      const id = idArg(first);
      const { item, verdicts } = withBoard(ctx, (board) => ({
        item: store.getItem(board, id),
        verdicts: store.verdictsFor(board, id),
      }));
      if (values.json) {
        io.say(JSON.stringify({ ...item, verdicts }, null, 2));
        return 0;
      }
      io.say(itemLine(item));
      if (item.item_criterion) io.say(`criterion: ${item.item_criterion}`);
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
      io.say(`${stats.items.verified} verified by a second agent · ${stats.items.submitted} awaiting verification · ${stats.rejected} rejections along the way`);
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
  const me = withBoard(ctx, (board) => {
    const who = whoAmI(ctx, board);
    const item = store.getItem(board, id);
    if (item.item_status !== 'claimed' || item.item_owner !== who.id) {
      throw new Refused('NOT_YOURS', `item #${id} is not claimed by you; claim it first`);
    }
    return who;
  });
  if (!isClean(root)) throw new Refused('DIRTY', 'commit your changes first; the gate must check what you submit');
  const stray = untracked(root);
  if (stray.length) throw new Refused('UNTRACKED', `commit or ignore ${stray.length} untracked file(s), e.g. ${stray[0]}`);
  const commit = headCommit(root);
  if (!commit) throw new Refused('NO_COMMIT', 'nothing committed yet');
  const gate = runGate(root, ctx.config);
  if (!gate.isGreen) throw new Refused('GATE_RED', `the gate is red at ${commit.slice(0, 12)}; fix it, commit, submit again`);
  withBoard(ctx, (board) => store.submit(board, id, { agentId: me.id, commit, tree: headTree(root) ?? '' }));
  const pin = `refs/pullboard/items/${id}/${commit.slice(0, 12)}`;
  git(root, ['update-ref', pin, commit]);
  ctx.io.say(`submitted #${id} at ${commit.slice(0, 12)}; gate green${gate.isCached ? ' (this tree already passed)' : ''}`);
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
    const me = whoAmI(ctx, board);
    const item = store.getItem(board, id);
    if (item.item_status !== 'submitted') {
      throw new Refused('NOT_SUBMITTED', `item #${id} is ${item.item_status}, not submitted`);
    }
    const head = headCommit(root) ?? '';
    const commit = resolveCommit(root, item.item_commit);
    if (!commit || !contains(root, commit, head)) {
      throw new Refused('NOT_AT_COMMIT', `check out the submitted commit first: git switch --detach ${item.item_commit.slice(0, 12)}`);
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
      note: values.note ?? '',
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
    const me = whoAmI(ctx, board);
    const { item, reasons } = store.nextFor(board, { agentId: me.id, lane: me.lane, verify: values.verify });
    if (!item) return { reasons };
    if (values.verify) return { item };
    if (item.item_status === 'claimed') return { item, held: true };
    try {
      store.claim(board, item.item_id, { agentId: me.id, lane: me.lane, leaseMs: ctx.config.leaseMs, freeze: freezer(ctx) });
    } catch (error) {
      if (error instanceof Refused && ['HELD', 'BLOCKED', 'ONE_CLAIM'].includes(error.code)) return { retry: true };
      throw error;
    }
    return { item: store.getItem(board, item.item_id) };
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
      if (values.verify) {
        io.say(`next to verify: #${item.item_id} ${item.item_title}, built by ${item.item_built_by} at ${item.item_commit.slice(0, 12)}`);
        io.say(`check out exactly that commit: git switch --detach ${item.item_commit}`);
        io.say(`then: pullboard verify ${item.item_id} accept --note "how you proved it", or reject --reason CODE --note "what failed"`);
      } else {
        io.say(`${found.held ? 'you hold' : 'claimed'} #${item.item_id}: ${item.item_title}`);
        if (item.item_criterion) io.say(`criterion: ${item.item_criterion}`);
        for (const row of item.item_frozen ? JSON.parse(item.item_frozen).rows : []) io.say(`  ${row.id}: ${row.text}`);
        io.say(`when it is built and committed: pullboard submit ${item.item_id}`);
      }
      return 0;
    }
    if (!found.retry && Date.now() >= deadline) {
      const waited = minutes ? ` after ${minutes} minutes` : '';
      io.err(`pullboard: [NOTHING_FREE] ${found.reasons.join('; ')}${waited}. To keep looking: pullboard next --wait 30${values.verify ? ' --verify' : ''}`);
      return 1;
    }
    if (!found.retry) await new Promise((done) => setTimeout(done, 5000));
  }
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
      const id = store.addItem(board, { by: me.id, lane: first, title, criterion: values.criterion ?? '', specIds, parentId, after });
      io.say(`#${id}`);
      return 0;
    }),
    next: () => nextHere(io, values),
    claim: () => act((ctx, board, me) => {
      const result = store.claim(board, idArg(first), { agentId: me.id, lane: me.lane, leaseMs: ctx.config.leaseMs, freeze: freezer(ctx) });
      io.say(`${result.renewed ? 'renewed' : 'claimed'} #${first} until ${result.leaseUntil}; criterion frozen as ${result.digest.slice(0, 12)}`);
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
      const fileErrors = findings.filter((finding) => finding.level === 'error').length;
      errors += fileErrors;
      io.say(`${name}: ${parsed.rows.length} rows, ${fileErrors} errors, ${findings.length - fileErrors} warnings`);
    }
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
      if (!gate.isGreen) problems = ['the gate is red; fix it before pushing'];
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
      io.say(gate.isGreen ? `gate green${gate.isCached ? ' (this tree already passed)' : ''}` : 'gate red');
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
