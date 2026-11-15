/** Run bounded Git inside the worker's owned process groups, keeping a redacted cause when it fails [C7]. */
import { drainOwned } from './process.js';
import { spawnOwned } from './process.js';
import { pipeline } from 'node:stream/promises';

/** Bound Git diagnostics and hide runner-private paths, URL credentials and credential assignments. */
export function safeGitDiagnostic(S, value, root, env) {
  let text = String(value).replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '').replace(/\r\n?/gu, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '');
  for (const [path, label] of [[root, '<source>'], [env.HOME, '<job-home>'], [process.env.HOME, '<runner-home>'], [env.TMPDIR, '<job-tmp>'], ...[...S.setupPrivatePaths].map(path => [path, '<runner-state>'])]) {
    if (path && path.length > 1) text = text.split(path).join(label);
  }
  text = text.replace(/https?:\/\/[^\s"'<>]+/giu, '<url>')
    .replace(/\b(authorization|cookie)\s*[:=][ \t]*[^\n]+/giu, '$1=<redacted>')
    .replace(/\b(authorization|cookie|token|secret|password|api[_-]?key|access[_-]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s;]+)/giu, '$1=<redacted>')
    .replace(/\b(?:gh[pousr]_|github_pat_|ps_|pa_|pm_|pg_|sk-)[A-Za-z0-9_-]{8,}/gu, '<redacted>')
    .replace(/\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/gu, '<private-address>').trim();
  const bytes = Buffer.from(text);
  return bytes.length > 2_048 ? `${bytes.subarray(0, 768).toString('utf8')}\n...[truncated]...\n${bytes.subarray(-1_024).toString('utf8')}` : text;
}

/** The Git operations a setup failure names, and those a timed preparation also counts. */
const FAILED = new Set(['init', 'fetch', 'checkout', 'index-pack', 'cat-file', 'rev-parse', 'rev-list', 'for-each-ref', 'update-ref', 'merge-base', 'verify-pack', 'check-ref-format', 'repack', 'commit-graph']);
const TIMED = new Set([...FAILED, 'config', 'status']);

/** Keep the failed Git operation and bounded cause without exposing command arguments or raw errors. */
function gitSetupFailure(S, root, args, env, result, stderr, overflow, inputError) {
  const operation = args.find(arg => FAILED.has(arg)) ?? 'command';
  const role = root.endsWith('.git') || args.includes('--bare') ? 'source cache' : 'source checkout';
  const code = result.error?.code ?? inputError?.code;
  const status = overflow ? 'stdout limit exceeded' : result.error && /^[A-Z][A-Z0-9_]{0,63}$/u.test(code ?? '') ? code
    : Number.isInteger(result.code) && result.code !== 0 ? `exit ${result.code}`
    : result.signal ? `signal ${result.signal}` : /^[A-Z][A-Z0-9_]{0,63}$/u.test(code ?? '') ? code : 'input failed';
  const error = new Error('source checkout could not be verified');
  error.runnerSetup = { step: `${role}: git ${operation}`, status, stderr: safeGitDiagnostic(S, stderr, root, env) };
  return error;
}

/** Invoke bounded Git in an owned group, retaining stderr if it fails instead of erasing the cause. */
export async function gitBytes(S, root, args, env, input) {
  const started = performance.now();
  // Runner-owned Git is short and reaped on close; its leader is bound at the next census instead of by a census per launch.
  const owned = spawnOwned(S, 'git', args, { cwd: root, env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], bindLater: true });
  const output = [];
  let stderr = Buffer.alloc(0);
  owned.child.stderr.on('data', chunk => { stderr = Buffer.concat([stderr, chunk]).subarray(-8_192); });
  let bytes = 0;
  let overflow = false;
  let inputError;
  let inputDone;
  if (input !== undefined) {
    owned.child.stdin.on('error', error => { inputError ??= error; });
    if (typeof input.pipe === 'function') inputDone = pipeline(input, owned.child.stdin).catch(error => { inputError ??= error; });
    else owned.child.stdin.end(input);
  }
  owned.child.stdout.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > 128 * 1024 * 1024) {
      if (!overflow) { overflow = true; drainOwned(S, owned, true).catch(() => {}); }
    } else if (!overflow) output.push(chunk);
  });
  const result = await owned.closed;
  await inputDone;
  await drainOwned(S, owned);
  if (overflow || inputError || result.error || result.code !== 0 || result.signal) throw gitSetupFailure(S, root, args, env, result, stderr.toString('utf8'), overflow, inputError);
  if (S.sourcePreparation) {
    const operation = args.find(arg => TIMED.has(arg)) ?? 'unknown';
    const row = S.sourcePreparation.git[operation] ??= { calls: 0, ms: 0 };
    row.calls++;
    row.ms += Math.round(performance.now() - started);
  }
  return Buffer.concat(output);
}

/** Preserve existing text-command decoding while raw Git batches retain exact byte framing. */
export async function git(S, root, args, env, input) {
  return (await gitBytes(S, root, args, env, input)).toString('utf8').trim();
}
