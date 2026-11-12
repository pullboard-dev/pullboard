/** Reload one committed CLI generation after an infrastructure refusal [C7,P3,V4]. */
import { spawn } from 'node:child_process';
import { gitSpawnSync } from '../../../git/index.js';
import { dirname } from 'node:path';
import { resolve } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RETRIED = 'PULLBOARD_SUBMIT_TOOLING_RETRY';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Read source identity without inheriting the submitting project's Git selectors. */
function sourceGit(root, args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  const run = gitSpawnSync(args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return run.status === 0 ? run.stdout.trim() : null;
}

/** Capture the command's source generation before any slow submit work. */
export function captureSubmitTooling(root = ROOT) {
  if (sourceGit(root, ['rev-parse', '--show-toplevel']) !== resolve(root)) return null;
  const commit = sourceGit(root, ['rev-parse', '--verify', 'HEAD']);
  return commit ? { root, commit } : null;
}

/** A fresh process may use only a newer clean committed generation, once per original command. */
export function prepareSubmitToolingRetry(snapshot, { env = process.env, cwd = process.cwd(), argv = process.argv.slice(2) } = {}) {
  if (!snapshot || env[RETRIED] === JSON.stringify([resolve(cwd), argv])) return null;
  const current = captureSubmitTooling(snapshot.root);
  if (!current || current.commit === snapshot.commit || sourceGit(snapshot.root, ['ls-files', '--error-unmatch', 'apps/cli/pullboard.js']) === null || sourceGit(snapshot.root, ['status', '--porcelain', '--untracked-files=all']) !== '') return null;
  return { ...current, entry: join(current.root, 'apps/cli/pullboard.js') };
}

/** Run the fresh CLI after its predecessor has released its checkout lease; preserve arguments and final output. */
export async function retrySubmitTooling(selection, argv, streams, { env = process.env, spawnProcess = spawn } = {}) {
  streams.stderr.write(`runner tooling changed; retrying submit once from committed CLI ${selection.commit.slice(0, 12)}\n`);
  const child = spawnProcess(process.execPath, [selection.entry, ...argv], {
    cwd: streams.cwd, env: { ...env, [RETRIED]: JSON.stringify([resolve(streams.cwd ?? process.cwd()), argv]) }, stdio: ['inherit', 'pipe', 'pipe'],
  });
  child.stdout.on('data', bytes => streams.stdout.write(bytes));
  child.stderr.on('data', bytes => streams.stderr.write(bytes));
  /** Forward only this invocation's cancellation to its own retry child. */
  const interrupt = () => child.kill('SIGINT');
  /** Retain termination ownership while the retry holds native resources. */
  const terminate = () => child.kill('SIGTERM');
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)));
    });
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
  }
}
