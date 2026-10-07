/**
 * The projects on this machine: every initialized repo, with optional project and display names.
 * The registry lives in the user's home (or PULLBOARD_HOME for isolated runs).
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from './config.js';

/**
 * The registry file.
 *
 * @returns {string}
 */
export function registryFile() {
  return join(process.env.PULLBOARD_HOME || join(homedir(), '.pullboard'), 'projects.json');
}

/**
 * Read the registry, treating unreadable or malformed content as empty without authorizing a rewrite.
 *
 * @returns {{ projects: any[], readable: boolean }}
 */
function readRegistry() {
  const file = registryFile();
  if (!existsSync(file)) return { projects: [], readable: true };
  try {
    const projects = JSON.parse(readFileSync(file, 'utf8')).projects;
    return Array.isArray(projects)
      ? { projects: projects.filter((project) => typeof project?.root === 'string'), readable: true }
      : { projects: [], readable: false };
  } catch {
    return { projects: [], readable: false };
  }
}

/**
 * Open the small SQLite file that serializes registry mutations. SQLite releases its OS lock when
 * a process exits, so a killed writer cannot strand a directory lock or evict a newer owner.
 *
 * @param {string} file
 * @returns {DatabaseSync} A connection holding BEGIN IMMEDIATE.
 */
function openRegistryLock(file) {
  const database = new DatabaseSync(`${file}.lock.sqlite`);
  try {
    database.exec('PRAGMA busy_timeout = 30000');
    database.exec('CREATE TABLE IF NOT EXISTS registry_lock (id INTEGER PRIMARY KEY CHECK (id = 1), generation INTEGER NOT NULL DEFAULT 0)');
    database.prepare('INSERT OR IGNORE INTO registry_lock (id, generation) VALUES (1, 0)').run();
    database.exec('BEGIN IMMEDIATE');
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

/**
 * Run a registry mutation while holding the cross-process lock.
 *
 * @template T
 * @param {(projects: any[], readable: boolean) => T} mutate
 * @returns {T}
 */
function withRegistry(mutate) {
  const file = registryFile();
  mkdirSync(join(file, '..'), { recursive: true });
  const database = openRegistryLock(file);
  try {
    const state = readRegistry();
    const result = mutate(state.projects, state.readable);
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // A failed commit may already have ended the transaction.
    }
    throw error;
  } finally {
    database.close();
  }
}

/**
 * Whether a path currently names a directory.
 *
 * @param {string} path
 * @returns {boolean}
 */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Metadata from a validated config, or null when the config cannot be trusted.
 *
 * @param {string} root
 * @param {object} [provided]
 * @returns {{ name: string, project: string } | null}
 */
function configMetadata(root, provided = {}) {
  let current;
  try {
    current = loadConfig(root);
  } catch {
    current = null;
  }
  const hasProvidedMetadata = provided && typeof provided === 'object'
    && (provided.name !== undefined || provided.project !== undefined);
  if (!current && !hasProvidedMetadata) return null;
  const candidate = { ...(current ?? {}) };
  if (provided && typeof provided === 'object') {
    if (provided.name !== undefined) candidate.name = provided.name;
    if (provided.project !== undefined) candidate.project = provided.project;
  }
  /**
   * Whether optional metadata is trimmed, nonempty text with no control characters.
   *
   * @param {unknown} value
   * @returns {boolean}
   */
  const validText = (value) => typeof value === 'string' && value.length > 0 && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
  if (candidate.name !== undefined && (!validText(candidate.name) || /[#,]/u.test(candidate.name))) return null;
  if (candidate.project !== undefined && !validText(candidate.project)) return null;
  return { name: candidate.name ?? basename(root), project: candidate.project ?? '' };
}

/**
 * Persist a registry only after a caller has determined that its contents changed.
 *
 * @param {any[]} projects
 * @returns {void}
 */
function writeRegistry(projects) {
  const file = registryFile();
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify({ projects }, null, 2)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, file);
}

/**
 * Every registered project, oldest first. Refreshes valid live metadata and prunes missing roots.
 *
 * @returns {{ root: string, name: string, project: string, added: string }[]}
 */
export function listProjects() {
  /**
   * Refresh and prune the latest on-disk entries.
   *
   * @param {any[]} storedProjects
   * @returns {{ projects: any[], changed: boolean }}
   */
  function refresh(storedProjects) {
    let changed = false;
    const projects = [];
    for (const stored of storedProjects) {
      const root = resolve(stored.root);
      if (!isDirectory(root)) {
        changed = true;
        continue;
      }
      const metadata = configMetadata(root);
      const project = {
        ...stored,
        root,
        name: stored.name ?? basename(root),
        project: stored.project ?? '',
      };
      if (metadata) {
        project.name = metadata.name;
        project.project = metadata.project;
      }
      if (project.root !== stored.root || project.name !== stored.name || project.project !== stored.project) changed = true;
      projects.push(project);
    }
    return { projects, changed };
  }
  const state = readRegistry();
  if (!state.readable) return [];
  const current = refresh(state.projects);
  if (!current.changed) return current.projects;
  return withRegistry((latest, readable) => {
    if (!readable) return [];
    const updated = refresh(latest);
    if (updated.changed) writeRegistry(updated.projects);
    return updated.projects;
  });
}

/**
 * Add a project's main checkout once, preserving its original added timestamp on later registrations.
 *
 * @param {string} root
 * @param {Date} [now]
 * @param {object} [config]
 * @returns {boolean} Whether it was new.
 */
export function registerProject(root, now = new Date(), config = {}) {
  const normalizedRoot = resolve(root);
  return withRegistry((stored, readable) => {
    if (!readable) return false;
    const projects = stored.map((entry) => ({ ...entry, root: resolve(entry.root) }));
    const metadata = configMetadata(normalizedRoot, config);
    const existing = projects.find((project) => project.root === normalizedRoot);
    if (existing) {
      if (metadata) {
        const changed = existing.name !== metadata.name || existing.project !== metadata.project;
        if (changed) {
          Object.assign(existing, metadata);
          writeRegistry(projects);
        }
      }
      return false;
    }
    const initialMetadata = metadata ?? { name: basename(normalizedRoot), project: '' };
    projects.push({ root: normalizedRoot, ...initialMetadata, added: now.toISOString() });
    writeRegistry(projects);
    return true;
  });
}

/**
 * Remove exactly the registered project at a normalized absolute path.
 *
 * @param {string} path
 * @returns {boolean} Whether one registered project was removed.
 */
export function forgetProject(path) {
  const normalized = resolve(path);
  return withRegistry((stored, readable) => {
    if (!readable) return false;
    const projects = stored.filter((project) => resolve(project.root) !== normalized);
    if (projects.length === stored.length) return false;
    writeRegistry(projects);
    return true;
  });
}
