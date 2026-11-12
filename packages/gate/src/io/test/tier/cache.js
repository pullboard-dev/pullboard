/** A commit's tier snapshot in the machine cache, generated once per machine and tier code [C7]. */
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { deserialize } from 'node:v8';
import { serialize } from 'node:v8';
import { gunzipSync } from 'node:zlib';
import { gzipSync } from 'node:zlib';
import { userInfo } from 'node:os';
import { gateMachineHome } from '../../../logic/preload.js';
import { foreignNodeOptions } from '../isolation.js';

/** This machine's shared home, as the parse cache finds it; tests isolate it with their machine or account home. */
function machineDirectory() {
  const override = process.env.PULLBOARD_MACHINE_HOME, accountHome = process.env.PULLBOARD_ACCOUNT_HOME;
  return gateMachineHome({ override, accountHome, osHome: override || accountHome ? undefined : userInfo().homedir });
}

/** The cache file for a commit, or null when this process cannot use the cache. */
function entryFile(commit, code) {
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit ?? '') && /^[a-f0-9]{64}$/u.test(code ?? '') && !foreignNodeOptions(process.env.NODE_OPTIONS)
    ? join(machineDirectory(), 'tier-snapshots', code, `${commit}.v8.gz`) : null;
}

/**
 * The tier snapshot recorded for an exact commit by this tier code, or null. A commit names its bytes, so an entry for
 * the same commit and code is the same snapshot; a missing, damaged or foreign entry is a miss. Why: submit built the
 * claim head's and HEAD's tiers inside the board for clause inspection, about 10 s of a 12 s precheck, and every
 * process (precheck, handoff worker, review comparison) built them again (#3927).
 *
 * @param {string} commit
 * @param {string|null} code The digest of the tier code that builds snapshots, or null to skip the cache.
 * @returns {{ manifest: { files: object[] }, owners: Map<string, string>, packageFiles: Set<string>, helpers: Map<string, Set<string>> }|null}
 */
export function readTierSnapshot(commit, code) {
  const file = entryFile(commit, code);
  if (!file) return null;
  try {
    const data = deserialize(gunzipSync(readFileSync(file), { maxOutputLength: 512 * 1024 ** 2 }));
    if (data?.version !== 1 || data.commit !== commit || data.code !== code || !Array.isArray(data.manifest?.files)
      || !(data.owners instanceof Map) || !(data.packageFiles instanceof Set) || !(data.helpers instanceof Map)) return null;
    return { manifest: data.manifest, owners: data.owners, packageFiles: data.packageFiles, helpers: data.helpers };
  } catch { return null; } // A missing or damaged entry only costs a rebuild.
}

/** Record a commit's freshly built tier snapshot; a failed write only costs the next process a rebuild. */
export function writeTierSnapshot(commit, code, { manifest, owners, packageFiles, helpers }) {
  const file = entryFile(commit, code);
  if (!file || !(owners instanceof Map) || !(packageFiles instanceof Set) || !(helpers instanceof Map)) return;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, gzipSync(serialize({ version: 1, commit, code, manifest, owners, packageFiles, helpers })), { mode: 0o600 });
    renameSync(temporary, file);
  } catch { /* The cache is optional. */ }
}
