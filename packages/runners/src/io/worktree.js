/** Builder item folders hosted on a registered runner over SSH, so git and hooks leave the coordinator [C7]. */
import { spawn } from 'node:child_process';
import { shellWord } from './tooling/remote.js';
import { sshEnvironment } from './tooling/remote.js';

const HOST = /^[A-Za-z0-9][A-Za-z0-9_.@:\[\]-]{0,254}$/u;
const ITEM = /^[1-9]\d{0,8}$/u;
const REF = /^(?!.*\.\.)(?!\/)(?!.*\/$)[A-Za-z0-9._/-]{1,200}$/u;
const OUTPUT_LIMIT = 64 * 1024;

/**
 * Refuse a runner, item or ref that could leave the runner's builder root or the item's own branch.
 * @param {{ host: string }} runner A registered runner record.
 * @param {number|string} itemId The claimed item's number.
 * @param {string[]} refs Branch names the folder reads or writes.
 * @returns {void}
 */
function checkHosted(runner, itemId, refs) {
  if (!HOST.test(runner?.host ?? '')) throw new Error('hosted item folder needs a registered runner host');
  if (!ITEM.test(String(itemId))) throw new Error('hosted item folder needs an item number');
  for (const ref of refs) if (!REF.test(ref ?? '')) throw new Error(`hosted item folder refuses ref ${JSON.stringify(ref)}`);
}

/**
 * Name one item's folder under the runner's builder root; a relative root sits under the SSH user's home.
 * @param {{ host: string, builderRoot?: string, root?: string }} runner A registered runner record.
 * @param {number|string} itemId The claimed item's number.
 * @returns {string} The folder path as the runner's shell sees it.
 */
export function hostedItemFolderPath(runner, itemId) {
  checkHosted(runner, itemId, []);
  const root = runner.builderRoot ?? `${runner.root ?? '.pullboard-runner'}/builders`;
  if (/[\u0000-\u001f\u007f]/u.test(root) || root.split('/').includes('..')) throw new Error('invalid runner builder root');
  return `${root.replace(/\/+$/u, '')}/item-${itemId}`;
}

/**
 * Write the POSIX script that creates, or refreshes, one item folder on the runner from the coordinator's repository.
 * An existing item branch on the coordinator is continued; otherwise the branch starts at base.
 * @param {{ folder: string, origin: string, branch: string, base: string, hooksPath?: string }} plan The folder plan.
 * @returns {string} A remote shell script that prints the folder's HEAD on success.
 */
export function hostedFolderScript({ folder, origin, branch, base, hooksPath }) {
  const f = shellWord(folder), b = shellWord(branch), o = shellWord(origin);
  return [
    'set -eu',
    `if [ ! -d ${f}/.git ]; then mkdir -p "$(dirname ${f})"; git clone --quiet --no-checkout ${o} ${f}; fi`,
    `git -C ${f} fetch --quiet origin ${shellWord(`+refs/heads/*:refs/remotes/origin/*`)}`,
    `if git -C ${f} rev-parse --quiet --verify ${shellWord(`refs/heads/${branch}`)} >/dev/null; then git -C ${f} checkout --quiet ${b};`,
    `elif git -C ${f} rev-parse --quiet --verify ${shellWord(`refs/remotes/origin/${branch}`)} >/dev/null; then git -C ${f} checkout --quiet -b ${b} ${shellWord(`origin/${branch}`)};`,
    `else git -C ${f} checkout --quiet -b ${b} ${shellWord(`origin/${base}`)}; fi`,
    ...(hooksPath ? [`git -C ${f} config core.hooksPath ${shellWord(hooksPath)}`] : []),
    `git -C ${f} rev-parse HEAD`,
  ].join('\n');
}

/**
 * Run one remote shell script on the runner over a bounded, non-forwarding SSH connection; never a synchronous child.
 * @param {{ host: string }} runner A registered runner record.
 * @param {string} script The POSIX script the runner's shell runs.
 * @param {{ ssh?: string, timeoutMs?: number }} [options] The SSH client and an optional wall bound.
 * @returns {Promise<{ status: number|null, signal: string|null, stdout: string, stderr: string, host: string, error: string|null }>} The run.
 */
export function runOnRunnerShell(runner, script, { ssh = 'ssh', timeoutMs = 0 } = {}) {
  if (!HOST.test(runner?.host ?? '')) throw new Error('hosted item folder needs a registered runner host');
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
    '-o', 'SendEnv=-*', '--', runner.host, `/bin/sh -c ${shellWord(script)}`];
  const child = spawn(ssh, args, { env: sshEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', error = null, timer = null;
  child.stdout.setEncoding('utf8').on('data', part => { stdout = (stdout + part).slice(-OUTPUT_LIMIT); });
  child.stderr.setEncoding('utf8').on('data', part => { stderr = (stderr + part).slice(-OUTPUT_LIMIT); });
  child.once('error', failure => { error = failure.code ?? failure.name; });
  if (timeoutMs > 0) timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
  return new Promise(resolve => child.once('close', (status, signal) => {
    clearTimeout(timer);
    resolve({ status, signal, stdout, stderr, host: runner.host, error });
  }));
}

/**
 * Create or refresh one claimed item's folder on the runner; the coordinator keeps only the board move.
 * @param {{ host: string, builderRoot?: string, root?: string }} runner A registered runner record.
 * @param {{ itemId: number|string, origin: string, branch: string, base?: string, hooksPath?: string }} plan Where the folder's history comes from.
 * @param {{ ssh?: string, timeoutMs?: number }} [options] The SSH client and an optional wall bound.
 * @returns {Promise<{ host: string, folder: string, head: string }>} The runner-hosted item folder.
 */
export async function createHostedItemFolder(runner, { itemId, origin, branch, base = 'main', hooksPath }, options = {}) {
  checkHosted(runner, itemId, [branch, base]);
  if (typeof origin !== 'string' || !origin || /[\u0000-\u001f\u007f]/u.test(origin)) throw new Error('hosted item folder needs the coordinator origin');
  const folder = hostedItemFolderPath(runner, itemId);
  const run = await runOnRunnerShell(runner, hostedFolderScript({ folder, origin, branch, base, hooksPath }), options);
  const head = run.stdout.trim().split('\n').at(-1) ?? '';
  if (run.status !== 0 || !/^[0-9a-f]{40,64}$/u.test(head)) {
    throw new Error(`could not create the item folder on runner ${runner.host}: ${run.error ?? (run.stderr.trim().slice(-400) || `status ${run.status}`)}`);
  }
  return { host: runner.host, folder, head };
}

/**
 * Run one command (git, a hook-bearing commit, or submit's work) inside the runner-hosted item folder.
 * @param {{ host: string }} runner A registered runner record.
 * @param {string} folder The folder createHostedItemFolder returned.
 * @param {string[]} argv The command and its arguments, each quoted for the runner's shell.
 * @param {{ ssh?: string, timeoutMs?: number }} [options] The SSH client and an optional wall bound.
 * @returns {Promise<{ status: number|null, signal: string|null, stdout: string, stderr: string, host: string, error: string|null }>} The run.
 */
export function runInHostedItemFolder(runner, folder, argv, options = {}) {
  if (!Array.isArray(argv) || !argv.length) throw new Error('hosted item folder command needs an argv');
  return runOnRunnerShell(runner, `cd ${shellWord(folder)} && exec ${argv.map(shellWord).join(' ')}`, options);
}

/**
 * Hand the item branch back to the coordinator's repository so submit reads the same commit the runner built.
 * @param {{ host: string }} runner A registered runner record.
 * @param {string} folder The runner-hosted item folder.
 * @param {string} branch The item branch name.
 * @param {{ ssh?: string, timeoutMs?: number }} [options] The SSH client and an optional wall bound.
 * @returns {Promise<{ status: number|null, signal: string|null, stdout: string, stderr: string, host: string, error: string|null }>} The push run.
 */
export function returnHostedBranch(runner, folder, branch, options = {}) {
  if (!REF.test(branch ?? '')) throw new Error(`hosted item folder refuses ref ${JSON.stringify(branch)}`);
  return runInHostedItemFolder(runner, folder, ['git', 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`], options);
}

/**
 * Push a runner-hosted item folder's branch to the coordinator's repository, in one SSH run, for submit [C7].
 * A folder on another branch, or with uncommitted or untracked work, is refused before anything is pushed.
 * Why: submit reads the board and gates on the coordinator, so the runner hands over Git history and never writes the board.
 * @param {{ host: string, builderRoot?: string, root?: string }} runner A registered runner record.
 * @param {{ itemId: number|string, branch: string }} plan The claimed item and its branch.
 * @param {{ ssh?: string, timeoutMs?: number }} [options] The SSH client and an optional wall bound.
 * @returns {Promise<{ folder: string, head: string|null, problem: null|{ code: 'HOSTED_BRANCH_MISMATCH'|'DIRTY'|'HOSTED_PUSH_FAILED', message: string } }>}
 *   The runner folder and the commit it pushed, or the named problem the caller refuses with.
 */
export async function pushHostedItemBranch(runner, { itemId, branch }, options = {}) {
  checkHosted(runner, itemId, [branch]);
  const folder = hostedItemFolderPath(runner, itemId), b = shellWord(branch);
  const script = [
    `cd ${shellWord(folder)} || exit 6`,
    'current=$(git symbolic-ref --quiet --short HEAD || true)',
    `if [ "$current" != ${b} ]; then printf 'branch %s\\n' "$current"; exit 3; fi`,
    'if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then exit 4; fi',
    'head=$(git rev-parse HEAD) || exit 6',
    `git push --quiet origin ${shellWord(`HEAD:refs/heads/${branch}`)} 1>&2 || exit 5`,
    "printf 'head %s\\n' \"$head\"",
  ].join('\n');
  const run = await runOnRunnerShell(runner, script, options);
  const where = `runner ${runner.host} folder ${folder}`;
  const refused = (code, message) => ({ folder, head: null, problem: { code, message } });
  if (run.status === 3) {
    const current = run.stdout.match(/^branch (.*)$/mu)?.[1] || 'a detached HEAD';
    return refused('HOSTED_BRANCH_MISMATCH', `${where} is on ${current}, not the claimed branch ${branch}; switch it back to ${branch} on the runner and submit again`);
  }
  if (run.status === 4) return refused('DIRTY', `${where} has uncommitted or untracked files; commit them on the runner first, the gate must check what you submit`);
  const head = run.stdout.match(/^head ([0-9a-f]{40,64})$/mu)?.[1];
  if (run.status !== 0 || !head) {
    const said = run.error ?? (run.stderr.trim().slice(-400) || `status ${run.status}`);
    return refused('HOSTED_PUSH_FAILED', `${where} could not push ${branch} to the coordinator: ${said}; if the coordinator branch moved, run git pull origin ${branch} on the runner, then submit again`);
  }
  return { folder, head, problem: null };
}
