/** Scratch folders and cross-volume moves [C7]. */
import { fileSystemAdapter } from '../../../../fs/index.js';
import { join } from 'node:path';
import { loadMachineSettings } from '../settings.js';
import { scratchRoot } from '../scratch.js';
import { environmentAdapter } from '../../../../env/index.js';

const fs = fileSystemAdapter();

/**
 * Makes a fresh throwaway folder under the scratch root, so every sentinel and sandbox lands in one place.
 *
 * @param {string} prefix - Folder name prefix.
 * @param {{ scratch?: unknown } | null | undefined} [settings] - Parsed machine settings, defaulting to the machine's.
 * @param {Record<string, string | undefined>} [env] - Environment, defaulting to process.env.
 * @returns {string} The new folder's path.
 */
export function scratchFolder(prefix, settings = loadMachineSettings(), env) {
  return fs.mkdtemp(join(scratchRoot(settings, env), prefix));
}

/**
 * Moves a file or folder, copying then removing the source when the two sit on different volumes.
 * Why: a rename between scratch and a repo can cross volumes and fail with EXDEV.
 *
 * @param {string} from - Source path.
 * @param {string} to - Destination path.
 * @param {{ rename?: (from: string, to: string) => void }} [ops] - Rename override, for tests.
 * @returns {void}
 */
export function moveAcross(from, to, { rename = fs.rename } = {}) {
  try {
    rename(from, to);
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    fs.cp(from, to, { recursive: true });
    fs.rm(from, { recursive: true, force: true });
  }
}

/**
 * Hands the `scratch` machine setting down as PULLBOARD_SCRATCH, so cells below config land under it without importing config.
 * Why: the setting is config's to read, and an environment already naming a root wins [C7].
 *
 * @param {Record<string, string | undefined>} [env] - Environment, defaulting to process.env.
 * @returns {void}
 */
export function applyMachineScratch(env) {
  const environment = environmentAdapter(env);
  if (environment.get('PULLBOARD_SCRATCH')) return;
  try {
    const { scratch } = loadMachineSettings();
    if (typeof scratch === 'string' && scratch) environment.set('PULLBOARD_SCRATCH', scratch);
  } catch {
    // Unreadable settings are reported by the commands that need them; the scratch root then stays os.tmpdir().
  }
}
