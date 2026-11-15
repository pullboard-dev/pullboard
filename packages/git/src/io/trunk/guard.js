/**
 * The trunk guard: a pre-receive hook on trunk.remote that refuses any push to trunk without a land job's receipt and
 * lease, so main moves only through a landing (#5848) [B3,P7]. A local merge in the board host's checkout is not a push
 * and never runs this hook; only pushes into the guarded repository do.
 * This file imports only node: built-ins and the permit logic, since installTrunkGuard copies both into the remote.
 * So its one literal Git launch cannot use the adapter, and the launch allowance records it in place of a migrated caller.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { trunkPushVerdict } from '../../logic/permit.js';

/** Run git against one repository; its trimmed stdout and whether it exited 0. */
function gitIn(gitDir, args, env) {
  return new Promise(resolve => execFile('git', ['--git-dir', gitDir, ...args], { encoding: 'utf8', env },
    (error, stdout) => resolve({ ok: !error, stdout: String(stdout ?? '').trim() })));
}

/**
 * Judge one push as the pre-receive hook sees it: update lines on stdin, push options in GIT_PUSH_OPTION_<n>, and the
 * landing key and trunk ref from the repository's pullboard.landingKey and pullboard.trunk settings.
 *
 * @param {{ input: string, env?: NodeJS.ProcessEnv, gitDir?: string, now?: number }} push
 * @returns {Promise<Awaited<ReturnType<typeof trunkPushVerdict>>>}
 */
export async function runTrunkGuard({ input, env = process.env, gitDir = env.GIT_DIR ?? '.', now = Date.now() }) {
  const updates = input.split('\n').filter(Boolean).map(line => { const [old, next, ref] = line.split(' '); return { old, new: next, ref }; });
  const options = Array.from({ length: Number(env.GIT_PUSH_OPTION_COUNT ?? 0) || 0 }, (_, index) => env[`GIT_PUSH_OPTION_${index}`] ?? '');
  const key = (await gitIn(gitDir, ['config', '--get', 'pullboard.landingKey'], env)).stdout || null;
  const trunk = (await gitIn(gitDir, ['config', '--get', 'pullboard.trunk'], env)).stdout || 'refs/heads/main';
  const isAncestor = async (ancestor, of) => (await gitIn(gitDir, ['merge-base', '--is-ancestor', ancestor, of], env)).ok;
  return trunkPushVerdict({ updates, options, key, trunk, now, isAncestor });
}

/** Run as the pre-receive hook: refuse the push with the guard's reason, else accept it. */
export async function trunkGuardMain() {
  const verdict = await runTrunkGuard({ input: readFileSync(0, 'utf8') });
  if (verdict.ok) return;
  process.stderr.write(`pullboard: [${verdict.code}] ${verdict.reason}\n`);
  process.exitCode = 1;
}
