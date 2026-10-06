/**
 * `pullboard run` (N14, B15): builds routed items with no one at the keyboard. For each item it may
 * take, it writes a context pack (the bar, the cited rows, the brief and the files as they are now),
 * runs the agent command the person configured, runs the item's check, and feeds a short digest of
 * any failure into the next attempt. Green work is committed, gated and submitted for a second agent
 * to verify. Work still red after the last attempt is pinned under refs/pullboard/attempts and
 * escalated one tier up, so a stronger model starts from what was tried.
 *
 * Pullboard never calls a model itself (E4): the agent command is whatever the person runs, such as
 * OpenCode on a local model or Claude Code headless on a smaller one.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as store from './board.js';
import { briefFiles } from './brief.js';
import { COORDINATOR } from './config.js';
import { runGate } from './gate.js';
import { git, headCommit, isClean, tryGit, untracked } from './git.js';
import { laneNames, outOfLane } from './lanes.js';
import { Refused } from './refused.js';

const DIGEST_CHARS = 3000;
const FILE_CHARS = 32_000;
const PACK_FILE_CHARS = 96_000;
const FAILURE_RE = /fail|error|expected|received|assert|not ok|✗|×|cannot|undefined|exception/i;

/**
 * A whole number from a flag, within bounds, or a refusal naming the flag.
 *
 * @param {string} text
 * @param {number} low
 * @param {number} high
 * @param {string} flag
 * @returns {number}
 */
function boundedInt(text, low, high, flag) {
  const value = Number(text);
  if (!Number.isInteger(value) || value < low || value > high) {
    throw new Refused('USAGE', `${flag} is a whole number from ${low} to ${high}`);
  }
  return value;
}

/**
 * Run a shell command in its own process group, so a timeout stops everything it started.
 *
 * @param {string} command
 * @param {{ cwd: string, env?: NodeJS.ProcessEnv, timeoutMs: number }} options
 * @returns {Promise<{ status: number | null, output: string, timedOut: boolean, seconds: number }>}
 */
function runCommand(command, { cwd, env = process.env, timeoutMs }) {
  const started = Date.now();
  return new Promise((done) => {
    const child = spawn(command, { cwd, env, shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const keep = (chunk) => {
      output = (output + chunk.toString()).slice(-200_000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    child.on('close', (status) => {
      clearTimeout(timer);
      done({ status, output, timedOut, seconds: Math.round((Date.now() - started) / 1000) });
    });
  });
}

/**
 * The lines of a failure worth a model's attention: those that look like failures first, then the
 * end of the output, capped, so a retry carries the reason and not the whole log.
 *
 * @param {string} output
 * @returns {string}
 */
export function digestOf(output) {
  const lines = output.split('\n').map((line) => line.trimEnd()).filter(Boolean);
  const failing = lines.filter((line) => FAILURE_RE.test(line)).slice(0, 25);
  const tail = lines.slice(-15);
  const kept = [...new Set([...failing, ...tail])].join('\n');
  return kept.length > DIGEST_CHARS ? `${kept.slice(0, DIGEST_CHARS)}\n...` : kept;
}

/**
 * Every path that differs from the commit the item started at, committed or not, untracked included.
 *
 * @param {string} root
 * @param {string} start
 * @returns {string[]}
 */
function changedSince(root, start) {
  const tracked = git(root, ['diff', '--name-only', '-z', start]).split('\0');
  const fresh = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0');
  return [...new Set([...tracked, ...fresh].filter(Boolean))];
}

/**
 * Put paths back as they were when the item started: restored if they existed, removed if not.
 *
 * @param {string} root
 * @param {string} start
 * @param {string[]} paths
 */
function restore(root, start, paths) {
  for (const path of paths) {
    if (tryGit(root, ['cat-file', '-e', `${start}:${path}`]).status === 0) git(root, ['checkout', start, '--', path]);
    else rmSync(join(root, path), { force: true });
  }
}

/**
 * The context pack for one attempt: everything a model needs to build the item from cold, the
 * files it may change included, so it reads them once here instead of again and again.
 *
 * @param {string} root
 * @param {any} item
 * @param {{ attempt: number, attempts: number, digest: string }} state
 * @returns {string}
 */
export function packText(root, item, { attempt, attempts, digest }) {
  const rows = item.item_frozen ? JSON.parse(item.item_frozen).rows : [];
  const files = briefFiles(item.item_brief);
  let budget = PACK_FILE_CHARS;
  const contents = files.map((path) => {
    const file = join(root, path);
    if (!existsSync(file) || !statSync(file).isFile()) return `### ${path}\n(does not exist yet; create it)`;
    const text = readFileSync(file, 'utf8');
    if (text.length > FILE_CHARS || text.length > budget) return `### ${path}\n(${text.length} characters; open it yourself)`;
    budget -= text.length;
    return `### ${path}\n\`\`\`\n${text}\n\`\`\``;
  });
  return [
    `# Item #${item.item_id}: ${item.item_title}`,
    '',
    `You are building one item in the ${item.item_lane} lane of this repo. Attempt ${attempt} of ${attempts}.`,
    '',
    '## Done when',
    item.item_criterion || '(see the brief)',
    '',
    `The check that proves it, which the runner runs after you finish: \`${item.item_check}\``,
    ...(rows.length ? ['', '## Spec rows it serves', ...rows.map((row) => `- ${row.id}: ${row.text}`)] : []),
    '',
    '## Brief',
    item.item_brief || '(none)',
    '',
    '## Rules',
    `- Change only the files the brief lists${files.length ? `: ${files.join(', ')}` : ''}. Changes anywhere else are reverted.`,
    '- Never run git commands; the runner commits your work.',
    '- Add no dependencies. Change a test only where the brief says to.',
    '- Run the check yourself before you finish, and stop when it passes.',
    ...(digest
      ? ['', '## Your previous attempt', 'It left the files as they are below. Continue from them. It failed with:', '```', digest, '```', 'Fix exactly that.']
      : []),
    ...(contents.length ? ['', '## The files, as they are now', ...contents] : []),
    '',
  ].join('\n');
}

/**
 * A commit header for the runner's commit, within the repo's rules: the item's title as a subject,
 * or its number when the title cannot be one.
 *
 * @param {any} item
 * @param {any} rules
 * @param {boolean} plain
 * @returns {string}
 */
function commitHeader(item, rules, plain) {
  const ids = item.item_spec_ids ? ` [${item.item_spec_ids}]` : '';
  const type = ids && rules.types.includes('feat') ? 'feat' : 'chore';
  const prefix = `${type}(${item.item_lane}): `;
  const title = item.item_title.replace(/\s+/g, ' ').replace(/[.\s]+$/, '');
  const subject = plain || !title ? `build item ${item.item_id}` : title[0].toLowerCase() + title.slice(1);
  const room = rules.maxHeader - prefix.length - ids.length;
  return `${prefix}${subject.slice(0, room).trimEnd()}${ids}`;
}

/**
 * Commit the item's changes, the paths it may change and nothing else, through the repo's hooks.
 * When the hooks refuse the title as a subject, it tries once more with the item's number.
 *
 * @param {string} root
 * @param {any} item
 * @param {any} config
 * @param {string[]} paths
 * @returns {{ ok: boolean, output: string }}
 */
function commitWork(root, item, config, paths) {
  git(root, ['add', '-A', '--', ...paths]);
  let output = '';
  for (const plain of [false, true]) {
    const result = spawnSync('git', ['commit', '-q', '-m', commitHeader(item, config.commits, plain)], { cwd: root, encoding: 'utf8' });
    if (result.status === 0) return { ok: true, output: '' };
    output = `${result.stdout}${result.stderr}`;
  }
  return { ok: false, output };
}

/**
 * Pin the worktree as it is, untracked files included, under refs/pullboard/attempts, without
 * touching the index or the files, so escalating never loses what was tried.
 *
 * @param {string} root
 * @param {number} id
 * @returns {string} The ref.
 */
function pinAttempt(root, id) {
  const index = join(git(root, ['rev-parse', '--path-format=absolute', '--git-dir']), 'pullboard-attempt-index');
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const step = (args) => {
    const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
    if (result.status !== 0) throw new Refused('PIN_FAILED', `could not pin the attempt: git ${args[0]} said ${result.stderr.trim()}`);
    return result.stdout.trim();
  };
  try {
    step(['read-tree', 'HEAD']);
    step(['add', '-A']);
    const tree = step(['write-tree']);
    const commit = step(['commit-tree', tree, '-p', 'HEAD', '-m', `pullboard: attempt at item #${id}`]);
    const ref = `refs/pullboard/attempts/${id}/${commit.slice(0, 12)}`;
    git(root, ['update-ref', ref, commit]);
    return ref;
  } finally {
    rmSync(index, { force: true });
  }
}

/**
 * Build one claimed item: attempts until the check and the gate pass, then submit; or pin, reset
 * and escalate.
 *
 * @param {any} ctx
 * @param {any} item
 * @param {any} options
 * @returns {Promise<'submitted' | 'escalated'>}
 */
async function buildItem(ctx, item, { agent, attempts, minutes, deps, me }) {
  const { root } = ctx.info;
  const id = item.item_id;
  const start = headCommit(root) ?? '';
  const listed = new Set(briefFiles(item.item_brief));
  const inScope = (path) => (!listed.size || listed.has(path)) && !outOfLane(ctx.config, item.item_lane, [path]).length;
  const packs = join(ctx.info.gitDir, 'pullboard', 'packs');
  mkdirSync(packs, { recursive: true });
  let digest = '';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const fresh = deps.withBoard(ctx, (board) => {
      store.claim(board, id, { agentId: me.id, lane: me.lane, leaseMs: ctx.config.leaseMs, freeze: deps.freezer(ctx) });
      return store.getItem(board, id);
    });
    const pack = join(packs, `${id}-${attempt}.md`);
    writeFileSync(pack, packText(root, fresh, { attempt, attempts, digest }));
    ctx.io.say(`#${id} attempt ${attempt}/${attempts}: running the agent`);
    const env = { ...process.env, PULLBOARD_PACK: pack, PULLBOARD_ITEM: String(id), PULLBOARD_ATTEMPT: String(attempt) };
    const built = await runCommand(agent, { cwd: root, env, timeoutMs: minutes * 60_000 });
    writeFileSync(join(packs, `${id}-${attempt}.log`), built.output);
    const outside = changedSince(root, start).filter((path) => !inScope(path));
    restore(root, start, outside);
    const reverted = outside.length ? `The runner reverted your changes outside the brief's files: ${outside.join(', ')}.\n` : '';
    const late = built.timedOut ? `The agent ran out of time after ${minutes} minutes.\n` : '';
    const checked = await runCommand(item.item_check, { cwd: root, timeoutMs: minutes * 60_000 });
    let result = 'green';
    if (checked.status !== 0) {
      result = 'red';
      digest = `${late}${reverted}The check \`${item.item_check}\` failed:\n${digestOf(checked.output)}`;
    } else {
      const isDirty = !isClean(root) || untracked(root).length > 0;
      const committed = isDirty ? commitWork(root, item, ctx.config, changedSince(root, start)) : { ok: true, output: '' };
      const gate = committed.ok ? runGate(root, ctx.config, { stdio: 'pipe' }) : { isGreen: false, output: committed.output };
      if (!gate.isGreen) {
        result = committed.ok ? 'gate-red' : 'commit-refused';
        digest = `${reverted}The check passed, but ${committed.ok ? "the repo's gate" : 'the commit'} failed:\n${digestOf(gate.output)}`;
      }
    }
    ctx.io.say(`#${id} attempt ${attempt}: ${result} (agent ${built.seconds}s, check ${checked.seconds}s)`);
    if (result === 'green') {
      try {
        deps.submitHere(ctx, id);
      } catch (error) {
        if (!(error instanceof Refused)) throw error;
        result = 'submit-refused';
        digest = `The check and the gate passed, but submit refused: ${error.message}`;
        ctx.io.say(`#${id} attempt ${attempt}: ${result}: ${error.message}`);
      }
    }
    deps.withBoard(ctx, (board) => store.recordAttempt(board, id, { agentId: me.id, n: attempt, seconds: built.seconds + checked.seconds, result }));
    if (result === 'green') return 'submitted';
  }
  const ref = pinAttempt(root, id);
  git(root, ['reset', '-q', '--hard', start]);
  git(root, ['clean', '-q', '-fd']);
  const moved = deps.withBoard(ctx, (board) => {
    const result = store.escalate(board, id, { agentId: me.id, note: `${attempts} attempts stayed red. Last failure:\n${digest}`.slice(0, 2000), attempt: ref });
    store.shout(board, { from: me.id, to: COORDINATOR, text: `#${id} escalated ${result.from} -> ${result.to} after ${attempts} red attempts; the work is pinned at ${ref}`, lanes: laneNames(ctx.config) });
    return result;
  });
  ctx.io.say(`#${id} escalated ${moved.from} -> ${moved.to}; the attempt is pinned at ${ref}`);
  return 'escalated';
}

/**
 * The runner: claims the items this worktree's agent may take, one at a time, and builds each.
 *
 * @param {any} io
 * @param {any} values
 * @param {{ context: Function, withBoard: Function, whoAmI: Function, nextOnce: Function, submitHere: Function, freezer: Function }} deps
 * @returns {Promise<number>}
 */
export async function runItems(io, values, deps) {
  const ctx = deps.context(io);
  if (ctx.info.isMain) {
    throw new Refused('MAIN_IS_COORDINATOR', 'the runner builds lane items, so it runs in a lane worktree: pullboard worktree <lane> --route light, then run it there');
  }
  const agent = String(values.agent ?? '').trim();
  if (!agent) {
    throw new Refused('USAGE', 'pullboard run --agent "<command>": the command that builds one item from the pack in $PULLBOARD_PACK, such as: opencode run "$(cat "$PULLBOARD_PACK")"');
  }
  const attempts = boundedInt(values.attempts ?? '3', 1, 10, '--attempts');
  const minutes = boundedInt(values.minutes ?? '15', 1, 240, '--minutes');
  const limit = values.items === undefined ? Infinity : boundedInt(values.items, 1, 1000, '--items');
  const waitMinutes = values.wait === undefined ? 0 : boundedInt(values.wait, 0, 240, '--wait');
  if (!ctx.config.gate.trim()) throw new Refused('NO_GATE', 'the runner submits through the gate; set "gate" in pullboard.json first');
  if (!isClean(ctx.info.root) || untracked(ctx.info.root).length) {
    throw new Refused('DIRTY', 'the runner starts from a clean worktree; commit or remove your changes first');
  }
  const me = deps.withBoard(ctx, (board) => deps.whoAmI(ctx, board));
  const totals = { submitted: 0, escalated: 0 };
  const deadline = Date.now() + waitMinutes * 60_000;
  while (totals.submitted + totals.escalated < limit) {
    const found = deps.nextOnce(ctx, { runnable: true });
    if (found.retry) continue;
    if (!found.item) {
      if (Date.now() >= deadline) {
        io.say(`nothing left to run: ${found.reasons.join('; ')}`);
        break;
      }
      await new Promise((done) => setTimeout(done, 5000));
      continue;
    }
    totals[await buildItem(ctx, found.item, { agent, attempts, minutes, deps, me })] += 1;
  }
  io.say(`runner done: ${totals.submitted} submitted, ${totals.escalated} escalated`);
  return 0;
}
