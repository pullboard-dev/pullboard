/**
 * The fast doctrine path for submit [C7]. A rule whose command is `node bin/checks/<name>.js`, with
 * a script marked `@file-local`, reads only the files it walks, so submit narrows it to the files
 * the item changed and runs it right here: no runner, no source shipping. Counts only fall and can
 * only rise in changed files, so those files at the merge base and at the candidate decide it.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnCaptured } from '../../../sandbox/index.js';

/** The process environment without git's repository variables, so a hook's GIT_DIR never redirects a child. */
function cleanEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
}

const SCRIPT = /^node\s+(bin\/checks\/[\w.-]+\.js)$/u;

/**
 * The checkout-relative script a rule command runs when that script can be narrowed to files, else null.
 *
 * @param {string} root - A checkout holding the candidate.
 * @param {string} command
 * @returns {string | null}
 */
export function fastCheckScript(root, command) {
  const script = SCRIPT.exec(command.trim())?.[1];
  if (!script) return null;
  try { return /@file-local\b/u.test(readFileSync(join(root, script), 'utf8')) ? script : null; } catch { return null; } // no script, no fast path
}

/**
 * Write the given paths as committed at a revision into a fresh directory; paths the revision lacks are skipped.
 *
 * @param {string} root
 * @param {string} revision
 * @param {string[]} files
 * @returns {string} The directory; the caller removes it.
 */
export function materializeAt(root, revision, files) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-doctrine-files-'));
  for (const file of files) {
    const shown = spawnSync('git', ['--no-replace-objects', 'show', `${revision}:${file}`], { cwd: root, env: cleanEnv(), maxBuffer: 64 * 1024 * 1024 });
    if (shown.status !== 0) continue; // absent at the revision: a new file has no earlier problems
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    writeFileSync(join(directory, file), shown.stdout);
  }
  return directory;
}

/**
 * Run one narrowed check script over the given files, with the same counted-exit contract as any rule.
 *
 * @param {string} scriptRoot - The checkout whose script runs.
 * @param {string} script
 * @param {string} cwd - The tree holding the files.
 * @param {string[]} files
 * @param {number} timeoutMs
 * @returns {Promise<{ problems: string[], broken: string, seconds: number, partial: true }>}
 */
export async function runNarrowedCheck(scriptRoot, script, cwd, files, timeoutMs) {
  const started = Date.now();
  const result = await spawnCaptured(process.execPath, [join(scriptRoot, script)], { cwd, env: { ...cleanEnv(), PULLBOARD_CHECK_FILES: JSON.stringify(files) },
    encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024 });
  const seconds = Math.round((Date.now() - started) / 1000);
  if (result.error) return { problems: [], broken: result.error.code === 'ETIMEDOUT' ? `timed out after ${Math.round(timeoutMs / 1000)}s` : `could not run (${result.error.code ?? 'error'})`, seconds, partial: true };
  if (result.signal) return { problems: [], broken: `was killed by ${result.signal}`, seconds, partial: true };
  if (result.status !== 0 && result.status !== 1) return { problems: [], broken: `exited ${result.status}`, seconds, partial: true };
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return { problems: output.split(/\r?\n/u).map(line => line.trimEnd()).filter(line => line.trim()), broken: '', seconds, partial: true };
}

/**
 * Answer one hold request in-process when its rule can be narrowed; null when it cannot.
 *
 * @param {string} root - The clean submitting checkout.
 * @param {{ commit: string, command: string, timeoutMs: number, candidate: boolean, scope?: string[] }} request
 * @returns {Promise<ReturnType<typeof runNarrowedCheck> | null>}
 */
export async function fastAnswer(root, request) {
  const script = request.scope ? fastCheckScript(root, request.command) : null;
  if (!script) return null;
  if (request.candidate) return runNarrowedCheck(root, script, root, request.scope, request.timeoutMs);
  const directory = materializeAt(root, request.commit, request.scope);
  try { return await runNarrowedCheck(root, script, directory, request.scope, request.timeoutMs); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}
