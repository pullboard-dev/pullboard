/**
 * The projects on this machine: every initialized repo, with optional project and display names.
 * The registry lives in the user's home (or PULLBOARD_HOME for isolated runs).
 */
import {
  closeSync,
  chmodSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { projectRegistrationAllowed } from './registration.js';
import {
  basename,
  dirname,
  join,
  resolve,
} from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../../../config/index.js';
import { remoteRepository } from '../logic/github/remote.js';
import { withMachineHomeWrite } from '../../../resources/light.js';
import { boardReferenceId } from '../../../kernel/index.js';
import { environmentAdapter } from '../../../env/index.js';
import { repoInfo } from '../../../git/index.js';
import { tryGit } from '../../../git/index.js';
import { Refused } from '../../../kernel/index.js';
import { withProjectGitTimeout } from '../../../git/index.js';

/**
 * The registry file.
 *
 * @returns {string}
 */
export function registryFile() {
  return join(environmentAdapter().get('PULLBOARD_HOME') || join(homedir(), '.pullboard'), 'projects.json');
}

/** Return a stable team handle only when Git origin and the opened board identity are both exact. */
export function projectBoardIdentity(root, boardId) {
  const id = boardReferenceId(boardId);
  const repository = withProjectGitTimeout(root, () => remoteRepository(tryGit(root, ['remote', 'get-url', 'origin']), { optional: true }));
  if (!repository) return null;
  const [owner, name] = repository.split('/');
  return { boardId: id, owner, name };
}

/**
 * Locate one repo's device-local private board from the repo board's immutable identity.
 * @param {string} repoBoardId
 * @param {string} [home]
 * @returns {string}
 */
export function privateBoardPath(repoBoardId, home = environmentAdapter().get('PULLBOARD_HOME') || join(homedir(), '.pullboard')) {
  const id = boardReferenceId(repoBoardId);
  return join(resolve(home), 'private', id, 'board.sqlite');
}

/**
 * Prepare owner-only storage for one repo's private board without changing the shared repo board.
 * @param {string} repoBoardId
 * @param {string} [home]
 * @returns {string}
 */
export function preparePrivateBoardPath(repoBoardId, home) {
  const file = privateBoardPath(repoBoardId, home);
  const directory = dirname(file);
  const privateRoot = dirname(directory);
  withMachineHomeWrite(privateRoot, () => {
    mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
    chmodSync(privateRoot, 0o700);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  });
  return file;
}

/** Keep the private SQLite file readable and writable only by this machine account. */
export function protectPrivateBoard(file) {
  withMachineHomeWrite(file, () => chmodSync(file, 0o600));
}

/**
 * Open this device's private board for one repo; a reader may require an existing board, while add creates it.
 * The caller passes the store's openBoard, atomic and closeBoard as `store`, so the seats cell never loads the board.
 * @param {string} repoBoardId
 * @param {(board: any, file: string) => any} work
 * @param {{ create?: boolean, clock?: any, reference?: any, store: { openBoard: Function, atomic: Function, closeBoard: Function } }} options
 * @returns {Promise<any>}
 */
export async function withPrivateBoard(repoBoardId, work, { create = false, clock, reference = null, store }) {
  const ownerBoardId = boardReferenceId(repoBoardId);
  const file = create ? preparePrivateBoardPath(repoBoardId) : privateBoardPath(repoBoardId);
  if (!create && !existsSync(file)) throw new Refused('PRIVATE_BOARD_NOT_FOUND', 'this device has no private board for that repo; open it from the repo checkout first');
  const board = store.openBoard(file, clock, { isMain: true });
  try {
    protectPrivateBoard(file);
    const registered = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get('private_repo_board_id');
    if (!registered && create) store.atomic(board, () => board.db.prepare('INSERT OR IGNORE INTO board_meta (meta_key, meta_value) VALUES (?, ?)')
      .run('private_repo_board_id', ownerBoardId));
    const owner = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get('private_repo_board_id');
    if (!owner || owner.meta_value !== ownerBoardId) {
      throw new Refused('PRIVATE_BOARD_IDENTITY', 'the device-local board belongs to a different repo; keep its existing identity intact');
    }
    if (reference) {
      if (typeof reference.handle !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/u.test(reference.handle)
          || typeof reference.organization !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/u.test(reference.organization)
          || typeof reference.owner !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(reference.owner)) {
        throw new Refused('BOARD_REFERENCE', 'record the exact repository owner/name and signed-in GitHub login for a private board');
      }
      store.atomic(board, () => {
        const savedReference = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get('private_board_reference');
        const value = JSON.stringify({ version: 1, kind: 'private', repoBoardId: ownerBoardId, ...reference });
        if (!savedReference) board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?)').run('private_board_reference', value);
        else {
          const previous = JSON.parse(savedReference.meta_value);
          if (previous.version !== 1 || previous.kind !== 'private' || previous.repoBoardId !== ownerBoardId
              || previous.handle !== reference.handle || previous.organization !== reference.organization
              || previous.owner !== reference.owner) {
            throw new Refused('PRIVATE_BOARD_IDENTITY', 'the saved private board reference belongs to a different repo or signed-in GitHub login');
          }
        }
      });
    }
    return await work(board, file);
  } finally { store.closeBoard(board); }
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

/** Read registered project roots without refreshing or pruning the machine registry.
 *
 * @returns {string[] | null} A snapshot of paths, or null when the registry cannot be trusted.
 */
export function registeredProjectRootsSnapshot() {
  const state = readRegistry();
  return state.readable ? state.projects.map((project) => project.root) : null;
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
  return withMachineHomeWrite(join(file, '..'), () => {
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
  });
}

/**
 * Whether registry pruning should keep this root as a directory or inaccessible entry.
 *
 * @param {string} path
 * @returns {boolean} True for directories and non-missing stat errors; false for files or missing roots.
 */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch (error) {
    return error.code !== 'ENOENT' && error.code !== 'ENOTDIR';
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
 * Every registered project, oldest first. Refreshes valid live metadata and optionally prunes missing roots.
 *
 * @param {{ pruneMissing?: boolean }} [options]
 * @returns {{ root: string, name: string, project: string, added: string }[]}
 */
export function listProjects({ pruneMissing = true } = {}) {
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
      if (!isDirectory(root) && pruneMissing) {
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
 * Read API projects, pruning missing folders while preserving existing unreadable entries for warnings.
 *
 * @returns {{ root: string, name: string, project: string, added: string }[]}
 */
export function listApiProjects() {
  return listProjects();
}

/**
 * Add a project's main checkout once, preserving its original added timestamp on later registrations.
 *
 * @param {string} root
 * @param {Date} [now]
 * @param {object} [config]
 * @returns {boolean} Whether it was new.
 */
export function registerProject(root, now = new Date(), config = {}, identity = null) {
  if (!projectRegistrationAllowed(root)) return false;
  const normalizedRoot = resolve(root);
  return withRegistry((stored, readable) => {
    if (!readable) return false;
    const projects = stored.map((entry) => ({ ...entry, root: resolve(entry.root) }));
    const metadata = configMetadata(normalizedRoot, config);
    const handle = identity && typeof identity === 'object' ? {
      ...(typeof identity.boardId === 'string' && /^[0-9a-f]{32}$/u.test(identity.boardId) ? { boardId: identity.boardId } : {}),
      ...(typeof identity.owner === 'string' && /^[A-Za-z0-9_.-]{1,128}$/u.test(identity.owner) ? { owner: identity.owner } : {}),
      ...(typeof identity.name === 'string' && /^[A-Za-z0-9_.-]{1,128}$/u.test(identity.name) ? { handle: identity.name } : {}),
      kind: 'team',
    } : null;
    if (handle && (!handle.boardId || !handle.owner || !handle.handle)) {
      throw new Refused('BOARD_REFERENCE', 'record a complete origin owner/name and immutable board ID before adding it to the local board inventory');
    }
    const existing = projects.find((project) => project.root === normalizedRoot);
    if (existing) {
      if (metadata) {
        const changed = existing.name !== metadata.name || existing.project !== metadata.project;
        if (changed) {
          Object.assign(existing, metadata);
          writeRegistry(projects);
        }
      }
      if (handle && (existing.boardId !== handle.boardId || existing.owner !== handle.owner || existing.handle !== handle.handle || existing.kind !== 'team')) {
        Object.assign(existing, handle);
        writeRegistry(projects);
      }
      return false;
    }
    const initialMetadata = metadata ?? { name: basename(normalizedRoot), project: '' };
    projects.push({ root: normalizedRoot, ...initialMetadata, ...(handle ?? {}), added: now.toISOString() });
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

/**
 * Register locally and complete opted-in automatic relay linking before the CLI returns.
 * The CLI passes the store's board readers and the relay linker as `ports`, so the seats cell loads neither.
 */
export async function registerProjectAndLink(root, now, config, io, identity, { store, autoLinkProject }) {
  if (!projectRegistrationAllowed(root)) return false;
  let exactIdentity = identity;
  if (!exactIdentity) {
    const file = join(withProjectGitTimeout(root, () => repoInfo(root)).commonDir, 'pullboard', 'board.sqlite');
    if (existsSync(file)) {
      const board = store.openBoardForRead(file);
      try { exactIdentity = projectBoardIdentity(root, store.boardId(board)); }
      finally { store.closeBoard(board); }
    }
  }
  const added = registerProject(root, now, config, exactIdentity);
  await autoLinkProject(root, io);
  return added;
}
