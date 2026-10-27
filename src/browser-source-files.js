/** Read-only source files for browser graph logic; runtime executable trust always uses real IO [C7]. */
import { AsyncLocalStorage } from 'node:async_hooks';
import * as fs from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

const selected = new AsyncLocalStorage();
export const realBrowserSourceFiles = Object.freeze({
  /** Read exact source bytes through the ordinary filesystem. */
  readFile(path, encoding) { return fs.readFile(path, encoding); },
  /** Resolve real symlinks before graph containment checks. */
  realpath(path) { return fs.realpath(path); },
  /** Follow a candidate's symlinks before deciding whether it is a file. */
  stat(path) { return fs.stat(path); },
});

/** Supply one immutable source view to one asynchronous graph walk, never a global test switch. */
export function withBrowserSourceFiles(adapter, work) {
  for (const key of ['readFile', 'realpath', 'stat']) {
    if (typeof adapter?.[key] !== 'function') throw new TypeError(`source files need ${key}`);
  }
  return selected.run(adapter, work);
}

/** Return the source-only boundary for this call chain; production defaults to real IO. */
export function browserSourceFiles() { return selected.getStore() ?? realBrowserSourceFiles; }

/** Preserve ordinary missing/directory/link failures instead of falling back to the real machine. */
function refused(code, path) {
  const error = new Error(`${code}: source file ${path}`);
  error.code = code;
  return error;
}

/** Model file bytes, directories and symlinks; all resolution remains inside this supplied tree. */
export function memoryBrowserSourceFiles(entries) {
  const nodes = new Map();
  for (const [path, entry] of entries) {
    const key = resolve(path);
    nodes.set(key, { ...entry, ...(entry.bytes === undefined ? {} : { bytes: Buffer.from(entry.bytes) }) });
    for (let parent = dirname(key); !nodes.has(parent); parent = dirname(parent)) {
      nodes.set(parent, { kind: 'directory' });
      if (parent === dirname(parent)) break;
    }
  }
  /** Follow symlinks component by component, retaining ENOTDIR and loop behavior. */
  function canonical(path, links = 0) {
    const absolute = resolve(path);
    if (links > 40) throw refused('ELOOP', path);
    const root = parse(absolute).root;
    let current = root;
    const parts = absolute.slice(root.length).split(sep).filter(Boolean);
    for (let index = 0; index < parts.length; index++) {
      current = join(current, parts[index]);
      const node = nodes.get(current);
      if (!node) throw refused('ENOENT', path);
      if (node.kind === 'symlink') return canonical(resolve(dirname(current), node.target, ...parts.slice(index + 1)), links + 1);
      if (index < parts.length - 1 && node.kind !== 'directory') throw refused('ENOTDIR', path);
    }
    if (!nodes.has(current)) throw refused('ENOENT', path);
    return current;
  }
  return Object.freeze({
    /** Return a fresh byte buffer so graph readers cannot mutate the captured source. */
    async readFile(path, encoding) {
      const node = nodes.get(canonical(path));
      if (node.kind !== 'file') throw refused('EISDIR', path);
      if (node.bytes === undefined) throw refused('EACCES', path);
      return encoding ? node.bytes.toString(encoding) : Buffer.from(node.bytes);
    },
    /** Resolve only facts explicitly supplied to this memory tree. */
    async realpath(path) { return canonical(path); },
    /** Expose only the file-type facts the graph needs, without real disk access. */
    async stat(path) {
      const node = nodes.get(canonical(path));
      return { isFile: () => node.kind === 'file', isDirectory: () => node.kind === 'directory' };
    },
  });
}

/** Capture actual tracked bytes and symlink targets once; missing facts stay missing, never guessed. */
export async function snapshotBrowserSourceFiles(root, files) {
  const entries = new Map();
  const visited = new Set();
  const actualRoot = await fs.realpath(root);
  /** Capture parent metadata as well as followed targets so containment has the same real facts. */
  async function capture(path) {
    path = resolve(path);
    if (visited.has(path)) return;
    visited.add(path);
    if (path !== dirname(path)) await capture(dirname(path));
    let info;
    try { info = await fs.lstat(path); }
    catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return; throw error; }
    const key = path === dirname(path) ? path : join(await fs.realpath(dirname(path)), basename(path));
    if (info.isSymbolicLink()) {
      const target = await fs.readlink(path);
      entries.set(key, { kind: 'symlink', target });
      await capture(resolve(dirname(path), target));
    } else if (info.isDirectory()) entries.set(key, { kind: 'directory' });
    else if (info.isFile()) entries.set(key, { kind: 'file',
      ...(key.startsWith(actualRoot + sep) ? { bytes: await fs.readFile(path) } : {}) });
  }
  await capture(root);
  for (const file of files) {
    if (typeof file !== 'string' || isAbsolute(file) || relative(root, resolve(root, file)).split(sep).includes('..')) {
      throw new TypeError('snapshot paths must stay inside the source root');
    }
    await capture(resolve(root, file));
  }
  return memoryBrowserSourceFiles(entries);
}
