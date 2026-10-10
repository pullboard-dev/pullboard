/** Capture bounded filesystem and live-holder evidence for a fixture cleanup failure. */
import { readdirSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/** List the newest filesystem entries below a failed cleanup path. */
function newestEntries(directory) {
  const entries = [];
  /** Walk only the failing fixture tree and retain paths with their actual mtimes. */
  function visit(path) {
    let children;
    try { children = readdirSync(path, { withFileTypes: true }); }
    catch (error) { entries.push({ path, error: error.code ?? error.message, mtimeMs: 0 }); return; }
    for (const child of children) {
      const file = join(path, child.name);
      try {
        const stat = statSync(file);
        entries.push({ path: file, mtimeMs: stat.mtimeMs });
        if (child.isDirectory()) visit(file);
      } catch (error) { entries.push({ path: file, error: error.code ?? error.message, mtimeMs: 0 }); }
    }
  }
  visit(directory);
  return entries.sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, 12);
}

/** Report processes with open files under the fixture tree without exposing arguments or environment. */
function fileOwners(directory) {
  const result = spawnSync('lsof', ['-nP', '-Fpcn', '+D', directory], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 3_000,
  });
  if (result.error) return `unavailable (${result.error.code ?? result.error.message})`;
  if (result.status !== 0 && !result.stdout) return `unavailable (lsof exit ${result.status})`;
  const owners = [];
  let current = {};
  for (const line of (result.stdout ?? '').split('\n')) {
    const value = line.slice(1);
    if (line.startsWith('p')) {
      current = { pid: value, command: '', paths: [] };
      owners.push(current);
    } else if (line.startsWith('c') && current.pid) current.command = value;
    else if (line.startsWith('n') && current.pid) current.paths.push(value);
  }
  return owners.filter(owner => owner.paths.length)
    .slice(0, 12)
    .map(owner => `pid=${owner.pid} command=${owner.command || '(unknown)'} paths=${owner.paths.slice(0, 3).join(',')}`)
    .join('\n') || 'none';
}

/** Format evidence after a real ENOTEMPTY error, keeping paths scoped to the fixture. */
export function cleanupFailureReport(error, directory) {
  const entries = newestEntries(directory);
  const listing = entries.map(entry => `  ${new Date(entry.mtimeMs).toISOString()} ${entry.path}${entry.error ? ` (${entry.error})` : ''}`).join('\n') || '  (no entries found)';
  return `cleanup ${error.code ?? 'error'} at ${error.path ?? directory}\nnewest fixture entries:\n${listing}\nopen-file owners:\n${fileOwners(directory)}`;
}

/** Remove a test fixture and retain bounded evidence if a concurrent writer prevents cleanup.
 * @param {string} directory
 * @param {{ remove?: () => void, emit?: (message: string) => void }} [options] - Real filesystem operation and evidence sink, overridable for a deterministic control.
 */
export function removeFixtureDirectory(directory, { remove = () => rmSync(directory, { recursive: true, force: true }), emit = message => process.stderr.write(message) } = {}) {
  try { remove(); }
  catch (error) {
    if (error.code === 'ENOTEMPTY') emit(`${cleanupFailureReport(error, error.path ?? directory)}\n`);
    throw error;
  }
}
