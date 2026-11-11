/** The SSH adapter's shards: files under the runner root, a detached `sh` worker, results read over the shell [C7]. */
import { Refused } from '../../../../kernel/light.js';
import { parseResult } from '../../logic/result.js';
import { shardIds } from '../../logic/result.js';
import { shellWord } from '../../logic/frames.js';

/**
 * The runner folder holding one shard of one job: `<root>/transport/jobs/<job>/<shard>`, as a shell expression.
 *
 * Why: files named by job and shard let a driver that took over a lapsed job find the result the old one started.
 *
 * @param {string | undefined} root - The runner's registered root, or the runner user's home default.
 * @param {{ job: string, shard: string }} ids
 * @returns {string}
 */
function shardFolder(root, ids) {
  const { job, shard } = shardIds(ids);
  const base = typeof root === 'string' && root ? shellWord(root) : '"$HOME/.pullboard-runner"';
  return `${base}/transport/jobs/${job}/${shard}`;
}

/**
 * Start one shard: write its job and command files, then run the command detached so it writes its result file
 * whether or not this channel or its driver is still there. A shard already started or done is left alone.
 *
 * @param {{ run: Function, runner: object }} shell - The SSH channel's shell.
 * @param {{ job: string, shard: string, command: string, cwd?: string, owner?: string }} spec
 * @returns {Promise<{ state: 'started' | 'running' | 'done', job: string, shard: string }>}
 */
export async function sshStartShard(shell, { job, shard, command, cwd, owner }) {
  if (typeof command !== 'string' || !command) throw new Refused('TRANSPORT_SHARD_COMMAND', 'a shard needs the project command to run');
  const folder = shardFolder(shell.runner.root, { job, shard });
  const record = JSON.stringify({ version: 1, job, shard, ...(owner ? { owner } : {}), ...(cwd ? { cwd } : {}) });
  // The worker writes result.tmp and renames it, so a result file is either whole or absent.
  const worker = [
    `cd ${cwd ? shellWord(cwd) : '"$1"'} || { printf 'cannot enter the working folder\\n' > "$1/output"; s=126; }`,
    `[ -n "$s" ] || { sh "$1/command" > "$1/output" 2>&1 </dev/null; s=$?; }`,
    `n=$(wc -c < "$1/output" | tr -d ' ')`,
    `{ printf 'PBRESULT 1 %s %s\\n' "$s" "$n"; cat "$1/output"; } > "$1/result.tmp" && mv "$1/result.tmp" "$1/result"`,
  ].join('\n');
  const reply = await shell.run([
    `d=${folder}`,
    `if [ -f "$d/result" ]; then printf done; exit 0; fi`,
    `if [ -f "$d/started" ]; then printf running; exit 0; fi`,
    `mkdir -p "$d" || exit 3`,
    `printf '%s' ${shellWord(record)} > "$d/job.json" || exit 3`,
    `printf '%s\\n' ${shellWord(command)} > "$d/command" || exit 3`,
    `: > "$d/started"`,
    `nohup sh -c ${shellWord(worker)} pullboard-shard "$d" >/dev/null 2>&1 </dev/null &`,
    `printf started`,
  ].join('\n'));
  const state = reply.output.toString('utf8');
  if (reply.status !== 0 || !['started', 'running', 'done'].includes(state)) {
    throw new Refused('TRANSPORT_SHARD_START', `shard ${shard} of job ${job} did not start on runner ${shell.runner.host} (status ${reply.status}); check the runner root is writable`);
  }
  return { state, job, shard };
}

/**
 * Remove a shard's files so it reads as not started.
 *
 * @param {{ run: Function, runner: object }} shell
 * @param {{ job: string, shard: string }} ids
 * @returns {Promise<void>}
 */
export async function sshResetShard(shell, ids) {
  const reply = await shell.run(`rm -rf ${shardFolder(shell.runner.root, ids)}`);
  if (reply.status !== 0) throw new Refused('TRANSPORT_SHARD_RESET', `shard ${ids.shard} of job ${ids.job} could not be reset on runner ${shell.runner.host}; check the runner root is writable`);
}

/**
 * Read a shard's result file; an invalid one is import.invalid and the shard is reset to not started.
 *
 * @param {{ run: Function, runner: object }} shell
 * @param {{ job: string, shard: string, digest?: string }} spec
 * @returns {Promise<object>} See fetchResult on the front door.
 */
export async function sshFetchResult(shell, { job, shard, digest }) {
  const folder = shardFolder(shell.runner.root, { job, shard });
  const reply = await shell.run(`d=${folder}\nif [ -f "$d/result" ]; then printf R; cat "$d/result"; elif [ -f "$d/started" ]; then printf S; else printf N; fi`);
  const mark = reply.output.subarray(0, 1).toString('latin1');
  if (reply.status !== 0 || !['R', 'S', 'N'].includes(mark)) {
    throw new Refused('TRANSPORT_SHARD_READ', `shard ${shard} of job ${job} could not be read on runner ${shell.runner.host} (status ${reply.status}); retry on a fresh channel`);
  }
  if (mark === 'N') return { state: 'absent' };
  if (mark === 'S') return { state: 'running' };
  const parsed = parseResult(reply.output.subarray(1), digest);
  if (parsed.valid) return { state: 'done', status: parsed.status, output: parsed.output, digest: parsed.digest };
  await sshResetShard(shell, { job, shard });
  return { state: 'import.invalid', reason: parsed.reason, digest: parsed.digest, reset: true };
}
