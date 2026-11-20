/**
 * The pre-commit hook's staged static check as one runner job, with the host only as the fallback [C7,#12570].
 * Why: on 20 Nov 34 of 37 pre-commit hooks hit the 120 s HOOK_TIMEOUT running this check on a host at load 55-162
 * while 94 of 96 runner slots sat idle. The staged index becomes a commit whose parent is HEAD; the runner checks it out,
 * moves HEAD back to that parent so its index holds exactly the staged bytes, and runs the named check there.
 */
import { setTimeout as pause } from 'node:timers/promises';
import { loadMachineSettings } from '../../../../../packages/config/index.js';
import { runnerDispatchMode } from '../../../../../packages/config/index.js';
import { tryGit } from '../../../../../packages/git/index.js';

/** The staged check a runner may run: the repository's own gate check, the one with a command-line entry. */
export const RUNNER_STAGED_CHECK = 'packages/gate/src/io/changed/scripts/static.js';
/** Budget: how long a runner has to take the job before the host runs the check itself. */
export const HOOK_RUNNER_CLAIM_MS = 15_000;
/** Budget: the whole runner answer, inside the shim's 120 s HOOK_TIMEOUT, before the host runs the check itself. */
export const HOOK_RUNNER_ANSWER_MS = 75_000;
// Budget: the hook reads its job row once a second, one small local read.
const POLL_MS = 1_000;

/**
 * Whether this commit's staged check goes to a runner first: the named check is the gate's own, jobs are pulled, and
 * this machine knows a runner. A machine with no runner keeps the in-process check and never waits on a job.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{ settings?: () => Record<string, any>, dispatch?: () => string }} [ports]
 * @returns {boolean}
 */
export function hookRunnerWanted(env, { settings = loadMachineSettings, dispatch = runnerDispatchMode } = {}) {
  if (env.PULLBOARD_HOOK_STATIC !== RUNNER_STAGED_CHECK || dispatch() !== 'pull') return false;
  return (settings().runners ?? []).length > 0;
}

/**
 * The shell command the job runs in the staged commit's checkout: main named as the host names it, since the check reads
 * existing debt from refs/heads/main; then HEAD back to the parent, so the index holds the staged bytes; then the check.
 *
 * @param {string} main - Accepted main's commit, a hex object name.
 * @param {string} [check]
 */
export function stagedCheckCommand(main, check = RUNNER_STAGED_CHECK) {
  if (!/^[0-9a-f]{40,64}$/u.test(String(main))) throw new Error(`accepted main ${main} is not a commit name`);
  return `git update-ref refs/heads/main ${main} && git reset -q --soft HEAD~1 && node --experimental-vm-modules --disable-warning=ExperimentalWarning ./${check} --staged-hook`;
}

/**
 * A commit holding exactly the staged index, whose parent is HEAD; null when git cannot write one (no HEAD yet).
 *
 * @param {string} root
 * @returns {string | null}
 */
export function stagedCommit(root) {
  const tree = tryGit(root, ['write-tree']);
  const head = tryGit(root, ['rev-parse', '--verify', 'HEAD']);
  if (tree.status !== 0 || head.status !== 0) return null;
  // A committing hook carries the author in its environment; the fallback name only lets a checkout with no identity write this throwaway commit.
  const made = tryGit(root, ['-c', 'user.name=pullboard', '-c', 'user.email=pullboard@localhost', 'commit-tree', tree.stdout.trim(), '-p', head.stdout.trim(), '-m', 'pullboard staged static check']);
  return made.status === 0 ? made.stdout.trim() || null : null;
}

/** The `path:line: message` rows of a check's output, in order. */
export function findingLines(output) {
  return String(output ?? '').split('\n').map(line => line.trim()).filter(line => /^\S+?:\d+: ./u.test(line));
}

/**
 * A job view's posted answer: green with no rows, red with its finding rows, or null when it has not answered or
 * answered red with no finding (the runner could not run the check), which the host then runs itself.
 *
 * @param {{ steps: { name: string, payload: any }[] }} view
 * @returns {{ answered: boolean, findings: string[] | null }}
 */
export function postedFindings(view) {
  const posted = [...(view?.steps ?? [])].reverse().find(step => step.name === 'receipt');
  if (!posted) return { answered: false, findings: null };
  const receipt = posted.payload?.receipt ?? {};
  const gate = receipt.gate ?? {};
  const phase = gate.phases?.[0] ?? null;
  if (receipt.status === 0 && gate.green === true && phase?.status === 0) return { answered: true, findings: [] };
  const rows = findingLines(phase?.tail ?? gate.error ?? receipt.tail ?? '');
  return { answered: true, findings: rows.length ? rows : null };
}

/** Offer the staged commit's job as a pulled test run offers its own, pinned under refs/pullboard/test until read. */
async function offerStagedJob(ctx, { commit, main, command }) {
  const [{ testJobRow, testRunsHolder, offerTestRow }, { offerJob }, { withBoard }] = await Promise.all([import('../test/pull.js'),
    import('../../../../../packages/api/index.js'), import('../context.js')]);
  // The thin hook's context opens no writable board of its own; the job row needs one, loaded only on this path.
  if (!ctx.nativeBoard) ctx.nativeBoard = await (ctx.io?.loadNativeBoard ?? (await import('../ports/process.js')).loadNativeBoard)();
  const runs = testRunsHolder(ctx);
  const { ref, row } = await testJobRow(ctx, { item: undefined, commit, main, command, files: [] });
  const job = runs ? offerTestRow(offerJob, { runs }, row) : withBoard(ctx, board => offerTestRow(offerJob, { board }, row));
  return { job: job.id, ref, runs };
}

/** The offered job's current view. */
async function readStagedJob(ctx, offered) {
  const [{ readTestRow }, { withBoardRead }] = await Promise.all([import('../test/pull.js'), import('../context.js')]);
  return offered.runs ? readTestRow({ runs: offered.runs }, offered.job) : withBoardRead(ctx, board => readTestRow({ board }, offered.job));
}

/** Cancel a job no runner answered in time, so no runner takes it after the host has run the check, and drop its pin. */
async function settleStagedJob(ctx, offered, { cancel }) {
  const [{ runsPort }, { withBoard }] = await Promise.all([import('../../../../../packages/store/index.js'), import('../context.js')]);
  if (cancel) {
    try { if (offered.runs) runsPort(offered.runs).cancel(offered.job, { reason: 'hook ran the check on the host' }); else withBoard(ctx, board => runsPort(board).cancel(offered.job, { reason: 'hook ran the check on the host' })); }
    catch { /* a job left offered only costs a runner one short check */ }
  }
  try { tryGit(ctx.info.root, ['update-ref', '-d', offered.ref]); } catch { /* a pin left behind only keeps a commit reachable */ }
}

/**
 * Run the staged check on a runner and return its findings, or null when the host must run it: no staged commit, no
 * runner took the job within `claimMs`, no answer within `answerMs`, the runner could not run the check, or the board
 * refused the offer. Never throws for any of those, so a commit is never stopped by the runner path itself.
 *
 * @param {object} ctx - The hook's CLI context; `ctx.info.root` is the committing checkout.
 * @param {{ main: string, check?: string, claimMs?: number, answerMs?: number, now?: () => number, wait?: (ms: number) => Promise<unknown>,
 *   offer?: Function, read?: Function, settle?: Function, commit?: (root: string) => string | null, say?: (line: string) => void }} options
 * @returns {Promise<string[] | null>}
 */
export async function stagedOnRunner(ctx, { main, check = RUNNER_STAGED_CHECK, claimMs = HOOK_RUNNER_CLAIM_MS, answerMs = HOOK_RUNNER_ANSWER_MS, now = Date.now, wait = pause,
  offer = offerStagedJob, read = readStagedJob, settle = settleStagedJob, commit = stagedCommit, say = () => {} }) {
  const staged = commit(ctx.info.root);
  if (!staged || !main) return null;
  let offered;
  try { offered = await offer(ctx, { commit: staged, main, command: stagedCheckCommand(main, check) }); }
  catch (error) { say(`pullboard pre-commit: no runner job for the staged check (${error?.code ?? error?.message}); running it here`); return null; }
  const started = now();
  let answer = null, done = false, claimed = false;
  try {
    // Bounded: the loop ends on an answer, on the claim budget while no runner holds the job, or on the answer budget.
    let spent = 0;
    while (spent < answerMs && (claimed || spent < claimMs)) {
      const view = await read(ctx, offered);
      const posted = postedFindings(view);
      if (posted.answered) { done = true; answer = posted.findings; break; }
      if (view?.leaseOwner && !claimed) { claimed = true; say(`pullboard pre-commit: runner ${view.leaseOwner} took the staged check`); }
      await wait(POLL_MS);
      spent = now() - started;
    }
    if (!done) say(`pullboard pre-commit: ${claimed ? `no runner answer within ${Math.round(answerMs / 1000)} s` : `no runner took the staged check within ${Math.round(claimMs / 1000)} s`}; running it here`);
  } catch (error) {
    say(`pullboard pre-commit: the staged check's runner job could not be read (${error?.code ?? error?.message}); running it here`);
  } finally {
    await settle(ctx, offered, { cancel: !done });
  }
  if (done && answer === null) say('pullboard pre-commit: the runner could not run the staged check; running it here');
  return answer;
}
