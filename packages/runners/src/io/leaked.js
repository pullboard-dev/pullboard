/** End processes a dead job left under a runner's jobs folder, so an idle proof can pass again [C7]. */
import { shellWord } from './tooling/remote.js';
import { spawnSsh } from '../../../transport/index.js';
import { sshEnvironment } from './tooling/remote.js';

/**
 * Build the remote script. The folder is split across two assignments and handed to awk through the
 * environment, so no process in the script's own command line contains the folder path and none can match itself.
 * A process whose command line names jobs/<id> for a live job id is never signalled; the ids reach awk through the environment too.
 */
export function stopScript(root, liveJobs = []) {
  const live = liveJobs.filter(id => /^[A-Za-z0-9._-]+$/u.test(id));
  const base = root ? shellWord(root) : '"$HOME/.pullboard-runner"';
  // Each target is recorded as pid@start-time and signalled again only while that exact start time still belongs to the pid.
  const stamp = "awk '{print $1\"_\"$2\"_\"$3\"_\"$4\"_\"$5}'";
  const script = `R=${base}; J="$R/jobs/"; L=${shellWord(live.join(' '))}; me=$$; `
    + `recs=$(ps -axo pid=,lstart=,args= | J="$J" L="$L" awk -v me="$me" -v pp="$PPID" 'BEGIN{n=split(ENVIRON["L"],ids," ")} index($0,ENVIRON["J"])>0 && $1!=me && $1!=pp {for(i=1;i<=n;i++) if(index($0,ENVIRON["J"] ids[i])>0) next; print $1"@"$2"_"$3"_"$4"_"$5"_"$6}'); `
    + `[ -n "$recs" ] || exit 0; `
    + `same() { [ "$(ps -o lstart= -p "\${1%%@*}" 2>/dev/null | ${stamp} | tr -s '_')" = "$(echo "\${1#*@}" | tr -s '_')" ]; }; `
    + `for r in $recs; do same "$r" && kill "\${r%%@*}" 2>/dev/null; done; sleep 1; `
    + `for r in $recs; do same "$r" && kill -9 "\${r%%@*}" 2>/dev/null; done; `
    + `for r in $recs; do echo "\${r%%@*}"; done`;
  // The remote login shell may not split words (zsh), so a plain POSIX shell runs the script.
  return 'sh -c ' + shellWord(script);
}

/**
 * Stop every process whose command line names a path under the runner's jobs folder and report the pids.
 * Processes of the live job ids are spared. It never decides whether the runner is safe to touch: the caller proves there are no holders first.
 */
export async function stopLeakedRunnerJobs(runner, { liveJobs = [] } = {}) {
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
    '-o', 'SendEnv=-*', '-o', 'ConnectTimeout=5', '--', runner.host, stopScript(runner.root, liveJobs)];
  const child = spawnSsh(args, { env: sshEnvironment(), stdio: ['ignore', 'pipe', 'ignore'] });
  let output = '';
  child.stdout.on('data', bytes => { output = (output + bytes).slice(0, 4096); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  const code = await new Promise(resolve => { child.once('error', () => resolve(-1)); child.once('close', status => resolve(status)); });
  clearTimeout(timer);
  const stopped = code === 0 ? output.split(/\s+/u).map(Number).filter(pid => Number.isSafeInteger(pid) && pid > 0).slice(0, 64) : [];
  return { stopped, ok: code === 0 };
}
