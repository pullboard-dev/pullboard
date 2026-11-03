/** End processes a dead job left under a runner's jobs folder, so an idle proof can pass again [C7]. */
import { spawn } from 'node:child_process';
import { shellWord } from './runner-remote-tooling.js';
import { sshEnvironment } from './runner-remote-tooling.js';

/**
 * Build the remote script. The folder is split across two assignments and handed to awk through the
 * environment, so no process in the script's own command line contains the folder path and none can match itself.
 */
function stopScript(root) {
  const base = root ? shellWord(root) : '"$HOME/.pullboard-runner"';
  return `R=${base}; J="$R/jobs/"; me=$$; `
    + `pids=$(ps -axo pid=,args= | J="$J" awk -v me="$me" -v pp="$PPID" 'index($0,ENVIRON["J"])>0 && $1!=me && $1!=pp {print $1}'); `
    + `[ -n "$pids" ] || exit 0; kill $pids 2>/dev/null; sleep 1; `
    + `for p in $pids; do kill -0 $p 2>/dev/null && kill -9 $p 2>/dev/null; done; echo $pids`;
}

/**
 * Stop every process whose command line names a path under the runner's jobs folder and report the pids.
 * It never decides whether the runner is safe to touch: the caller proves there are no holders first.
 */
export async function stopLeakedRunnerJobs(runner) {
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
    '-o', 'SendEnv=-*', '-o', 'ConnectTimeout=5', '--', runner.host, stopScript(runner.root)];
  const child = spawn('ssh', args, { env: sshEnvironment(), stdio: ['ignore', 'pipe', 'ignore'] });
  let output = '';
  child.stdout.on('data', bytes => { output = (output + bytes).slice(0, 4096); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  const code = await new Promise(resolve => { child.once('error', () => resolve(-1)); child.once('close', status => resolve(status)); });
  clearTimeout(timer);
  const stopped = code === 0 ? output.split(/\s+/u).map(Number).filter(pid => Number.isSafeInteger(pid) && pid > 0).slice(0, 64) : [];
  return { stopped, ok: code === 0 };
}
