/** Conservative current-account Chrome clone cleanup; uncertain or live browser custody always wins [C7]. */
import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { lstatSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { statfsSync } from 'node:fs';
import { join } from 'node:path';
import { chromeCloneDirectories } from '../../../../packages/gate/light.js';

const HOUR = 60 * 60 * 1000;
const NAME = /^code_sign_clone\.[A-Za-z0-9._-]{6}$/u;

/** Run only an owned metadata probe, yielding to the existing cleanup timer and never extending its deadline. */
async function nativeProbe(file, args, deadline, cap, maxBuffer) {
  const remaining = Math.min(cap, deadline - Date.now());
  if (!(remaining > 0)) return null;
  return new Promise(resolve => {
    execFile(file, args, { encoding: 'utf8', timeout: remaining, killSignal: 'SIGKILL', maxBuffer },
      (error, stdout, stderr) => resolve(error || stderr.trim() || Date.now() >= deadline ? null : { stdout }));
  });
}

/** Read a bounded native census and retain only clone-relevant facts, never unrelated command or path text. */
async function chromeCloneCustody(directory, { deadline }) {
  const ps = await nativeProbe('/bin/ps', ['-axo', 'pid=,comm='], deadline, 2000, 8 * 1024 * 1024);
  if (!ps) return null;
  for (const line of ps.stdout.split('\n')) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
    if (!match) return null;
    // Executables are hard-linked: absence of a clone path in lsof does not prove Chrome has released it.
    if (/chrome|chromium/iu.test(match[2])) return { browserLive: true, paths: [] };
  }
  const files = await nativeProbe('/usr/sbin/lsof', ['-b', '-nP', '-Fpcfn'], deadline, 8000, 16 * 1024 * 1024);
  if (!files) return null;
  const paths = [];
  const namespaces = [directory];
  let pid = null;
  for (const line of files.stdout.split('\n')) {
    if (!line) continue;
    if (/^p[1-9]\d*$/u.test(line)) pid = Number(line.slice(1));
    else if ((line.startsWith('c') || /^f[^\r\n]+$/u.test(line)) && pid) continue;
    else if (line.startsWith('n') && pid) {
      const path = line.slice(1).replace(/^\/var\//u, '/private/var/');
      if (namespaces.some(root => path === root || path.startsWith(`${root}/`))) paths.push(path);
    }
    else return null;
  }
  return { browserLive: false, paths };
}

/** Compare directory identity immediately before removal; symlinks and account mismatches grant no authority. */
function sameDirectory(path, expected) {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === expected.dev && stat.ino === expected.ino
      && stat.uid === process.getuid() && stat.mtimeMs === expected.mtimeMs && stat.birthtimeMs === expected.birthtimeMs;
  } catch { return false; }
}

/** Observe available filesystem bytes; COW and concurrent activity prevent attributing a net delta to one deletion. */
function available(path) {
  try { const stat = statfsSync(path); return stat.bavail * stat.bsize; } catch { return null; }
}

/** Remove only old unheld native clones; injected private roots and census ports exist solely for isolated fixtures. */
export async function sweepChromeClones({ directories = chromeCloneDirectories(), custody = chromeCloneCustody,
  now = Date.now(), deadline = Infinity, log = line => process.stderr.write(`${line}\n`) } = {}) {
  const summary = { removed: 0, kept: 0, unknown: false, deferred: 0, observedFreeBytesDelta: 0 };
  for (const directory of directories) {
    if (Date.now() >= deadline) { summary.unknown = true; break; }
    let canonical;
    let names;
    try {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) { summary.unknown = true; continue; }
      canonical = realpathSync(directory);
      names = readdirSync(directory).filter(name => NAME.test(name));
    } catch (error) { if (error.code !== 'ENOENT') summary.unknown = true; continue; }
    const before = available(canonical);
    // Initial custody skips known-held entries; fresh per-removal probes remain bounded by the original deadline.
    const observed = await custody(canonical, { deadline });
    if (!observed || observed.browserLive) { summary.kept += names.length; summary.unknown ||= !observed; continue; }
    for (const [index, name] of names.entries()) {
      if (Date.now() >= deadline || summary.removed >= 16) { summary.deferred += names.length - index; break; }
      const path = join(canonical, name);
      let stat;
      try { stat = lstatSync(path); } catch { summary.unknown = true; continue; }
      if (!sameDirectory(path, stat) || now - Math.max(stat.birthtimeMs, stat.mtimeMs) < HOUR) { summary.kept++; continue; }
      if (observed.paths.some(open => open === path || open.startsWith(`${path}/`))) { summary.kept++; continue; }
      const fresh = await custody(canonical, { deadline });
      if (!fresh || fresh.browserLive || fresh.paths.some(open => open === path || open.startsWith(`${path}/`))
        || Date.now() >= deadline || !sameDirectory(path, stat)) {
        summary.kept++; summary.unknown ||= !fresh; continue;
      }
      try { await rm(path, { recursive: true }); summary.removed++; }
      catch { summary.unknown = true; summary.kept++; }
    }
    const after = available(canonical);
    if (before === null || after === null) summary.observedFreeBytesDelta = null;
    else if (summary.observedFreeBytesDelta !== null) summary.observedFreeBytesDelta += after - before;
  }
  log(`PULLBOARD_CHROME_CLONE_SWEEP ${JSON.stringify(summary)}`);
  return summary;
}

/** Claim one hourly current-runner sweep without waiting or touching another worker's marker. */
export async function scheduledChromeCloneSweep(runnerRoot, { now = Date.now(), deadline = Infinity } = {}) {
  if (process.platform !== 'darwin') return null;
  const state = join(runnerRoot, 'chrome-clone-sweeps');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const claim = join(state, String(Math.floor(now / HOUR)));
  try { mkdirSync(claim, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') return null; throw error; }
  // These empty directories record attempted hours, not leases or process custody.
  for (const name of readdirSync(state)) {
    if (/^\d+$/u.test(name) && Number(name) < Math.floor(now / HOUR) - 1) {
      try { rmdirSync(join(state, name)); } catch { /* Preserve nonempty or substituted evidence. */ }
    }
  }
  // A failed or interrupted sweep remains an honest attempted hour; no same-hour retry loop.
  return sweepChromeClones({ now, deadline });
}
