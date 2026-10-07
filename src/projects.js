/**
 * The projects on this machine: every initialized repo, with optional project and display names.
 * The registry lives in the user's home (or PULLBOARD_HOME for isolated runs).
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
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
 * Wait synchronously while another process owns the registry lock.
 *
 * @param {number} milliseconds
 * @returns {void}
 */
function pause(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/**
 * Whether a process id still names a running process.
 *
 * @param {number} pid
 * @returns {boolean}
 */
function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * Acquire the registry lock, reclaiming a lock whose owner crashed.
 *
 * @param {string} lock
 * @returns {string} This process's unique lock token.
 */
function acquireLock(lock) {
  const token = randomUUID();
  const ownerFile = join(lock, 'owner.json');
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    let created = false;
    try {
      mkdirSync(lock);
      created = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    if (created) {
      try {
        writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, token }));
        return token;
      } catch (error) {
        rmSync(lock, { recursive: true, force: true });
        throw error;
      }
    }

    let owner;
    let stale = false;
    try {
      owner = JSON.parse(readFileSync(ownerFile, 'utf8'));
      stale = !Number.isInteger(owner.pid) || !processExists(owner.pid);
    } catch {
      try {
        stale = Date.now() - statSync(lock).mtimeMs > 1000;
      } catch {
        continue;
      }
    }
    if (stale) {
      const abandoned = `${lock}.abandoned-${randomUUID()}`;
      try {
        renameSync(lock, abandoned);
        rmSync(abandoned, { recursive: true, force: true });
      } catch (error) {
        if (error?.code !== 'ENOENT') pause(10);
      }
    } else {
      pause(10);
    }
  }
  throw new Error('timed out waiting for the project registry lock');
}

/**
 * Release this process's lock without removing a lock acquired by another process.
 *
 * @param {string} lock
 * @param {string} token
 * @returns {void}
 */
function releaseLock(lock, token) {
  try {
    const owner = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'));
    if (owner.pid !== process.pid || owner.token !== token) return;
    const released = `${lock}.released-${token}`;
    renameSync(lock, released);
    rmSync(released, { recursive: true, force: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
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
  const lock = `${file}.lock`;
  const token = acquireLock(lock);
  try {
    const state = readRegistry();
    return mutate(state.projects, state.readable);
  } finally {
    releaseLock(lock, token);
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
