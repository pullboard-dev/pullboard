/**
 * The thin entry for a Git commit hook: pre-commit, pre-merge-commit and commit-msg run hookCommand with a minimal io
 * and a light context, never the full dispatcher, so a commit pays one small module graph [H24]. An agent session
 * binds its checkout lease first, as the full path does; a seat this entry cannot name takes the full path (#5719).
 */
import { resolve } from 'node:path';
import { commandOutput } from '../../../../../packages/config/browser.js';
import { loadConfig } from '../../../../../packages/config/light.js';
import { loadDoctrine } from '../../../../../packages/doctrine/light.js';
import { repoInfo } from '../../../../../packages/git/light.js';
import { withGitCommandMemo } from '../../../../../packages/git/light.js';
import { withGitFacts } from '../../../../../packages/git/light.js';
import { Refused } from '../../../../../packages/kernel/light.js';
import { agentSessionDigest } from '../../../../../packages/stats/light.js';
import { sessionBound } from '../../../../../packages/seats/light.js';
import { COORDINATOR } from '../../../../../packages/config/light.js';
import { hookClock } from '../commands/hook.js';
import { hookCommand } from '../commands/hook.js';
import { hookSeatId } from '../commands/hook.js';
import { appendTrace } from '../trace.js';

/** The light context a commit hook reads: checkout facts, config, board file and doctrine, with no board writes. */
function lightContext(io) {
  const info = repoInfo(io.cwd);
  if (info.isMain) io.caller?.('coordinator', info.root);
  const config = loadConfig(info.root);
  let doctrine;
  return { info, config, file: resolve(info.commonDir, 'pullboard', 'board.sqlite'), nativeBoard: undefined, io,
    get doctrine() { return doctrine ??= loadDoctrine(info.root, config); }, clock: hookClock };
}

/**
 * The checkout lease bind the full path makes before a commit hook in an agent session: a checkout already bound to
 * this session takes nothing; any other binds through the seats' lease, waiting at most the hook's limit. Returns null
 * when the seat is not one this entry can name (unjoined, a publish or landing worktree), so the full path decides.
 *
 * @param {ReturnType<typeof lightContext>} ctx
 * @param {string} hook
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<{ release(): void } | null>}
 */
async function bindHookSession(ctx, hook, env) {
  const digest = agentSessionDigest(env);
  if (!digest) return { release() {} };
  const { info } = ctx;
  const agent = info.isMain ? COORDINATOR : hookSeatId(ctx, info.root);
  if (!agent) return null;
  if (hook !== 'pre-merge-commit' && sessionBound(info, { agent, digest })) return { release() {} };
  // The lease machinery loads only for a checkout this session has not bound yet: the first commit of a session.
  const { bindLocalSession, HOOK_CHECKOUT_WAIT_MS } = await import('../../../../../packages/seats/index.js');
  const lease = await bindLocalSession(info, { agent, digest, keepLease: true, waitLimitMs: HOOK_CHECKOUT_WAIT_MS });
  return { release: () => lease?.release?.() };
}

/**
 * Run one commit hook and return its exit code, or null when the full path must run it.
 *
 * @param {string[]} args hook, the hook name, then git's arguments
 * @param {{ cwd: string, stdout: any, stderr: any, stdin: any, env?: NodeJS.ProcessEnv }} streams
 * @returns {Promise<number | null>}
 */
export function runThinHook(args, streams) {
  // One facts scope per hook run: checkout, config and trunk reads ask Git once, however many checks repeat them [C7].
  const startedAt = Date.now();
  const seen = { stderr: '', refusal: null, seat: null };
  return withGitFacts(() => runThinHookOnce(args, streams, seen)).then(status => {
    if (status) traceBlock(args, streams, seen, status, startedAt);
    return status;
  });
}

/**
 * The refusal a blocked hook reports: a Refused it threw, else the first problem it printed, with the code that problem
 * names or the hook's own stable code, such as HOOK_PRE_COMMIT_BLOCKED.
 * Why: a blocked commit left a trace line with exit 1 and no code, so no count could tell one kind of block from another [C7].
 */
function hookRefusal(hook, seen) {
  if (seen.refusal) return { code: seen.refusal.code, message: seen.refusal.message };
  const problem = /^pullboard [a-z-]+: blocked\n {2}- (.+)$/mu.exec(seen.stderr)?.[1] ?? seen.stderr.split('\n').find(line => line.trim()) ?? 'blocked';
  const named = /^([A-Z][A-Z0-9_]{3,}):\s/u.exec(problem)?.[1];
  return { code: named ?? `HOOK_${hook.toUpperCase().replaceAll('-', '_')}_BLOCKED`, message: problem };
}

/** Append the trace line of a blocked hook: the hook name as the command, the seat, and the refusal code. Never throws. */
function traceBlock(args, streams, seen, status, startedAt) {
  appendTrace({ argv: [args[1]], cwd: streams.cwd, startedAt, status, refusal: hookRefusal(args[1], seen), seat: seen.seat, env: streams.env ?? process.env });
}

/** The body of runThinHook, run inside its Git facts scope. */
async function runThinHookOnce(args, streams, seen) {
  const io = commandOutput(args, streams, { nextActions: false,
    loadRefusal: async () => (await import('../../logic/step/words.js')).refusalDocument });
  io.hookContext = lightContext;
  io.gateWaitReporter = () => () => {};
  // Everything the hook prints to stderr is remembered, unchanged, so a block can name its first problem in the trace.
  const printErr = io.err;
  io.err = (text, ...rest) => { seen.stderr += String(text); return printErr.call(io, text, ...rest); };
  let session;
  try {
    let ctx = null;
    try { ctx = lightContext(io); } catch (error) { if (!(error instanceof Refused && error.code === 'NO_CONFIG')) throw error; }
    // A repo without pullboard.json binds nothing: hookCommand passes it.
    if (ctx) seen.seat = hookSeatId(ctx, ctx.info.root);
    session = ctx ? await bindHookSession(ctx, args[1], streams.env ?? process.env) : { release() {} };
    if (!session) return null;
    const code = await withGitCommandMemo(() => hookCommand(io, { first: args[1], second: args[2] }));
    io.flush(io.exitCode(code));
    return io.exitCode(code);
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    seen.refusal = error;
    io.refusal?.(error);
    await io.prepareRefusal();
    io.err(`pullboard: ${io.guidance(error.message.replace(/\r?\nnext:[ \t]*[^\r\n]*\S[ \t]*(?:\r?\n)*$/u, ''))}\nnext: ${io.refusalDocument(error).error.next}`);
    io.flush(1);
    return 1;
  } finally { session?.release(); }
}
