/**
 * The one place that reads node:fs: callers take an adapter, tests pass a fake source [C7].
 * Why: a fake source makes file-dependent code deterministic without touching the disk.
 */
import * as realFs from 'node:fs';
import * as realPromises from 'node:fs/promises';

/**
 * Build a file-system adapter over a source of node:fs functions.
 * Descriptor, stream and watch calls pass through to the source's own functions; `promises` reaches the source's promises,
 * or node:fs/promises when the source has none.
 * Why: callers that open descriptors or stream files can then run against a fake source too.
 * @param {Partial<typeof realFs>} [source] defaults to node:fs
 * @returns {Record<string, Function> & { promises: Record<string, Function> }}
 */
export function fileSystemAdapter(source = realFs) {
  return {
    readFile: (path, encoding = 'utf8') => source.readFileSync(path, encoding),
    writeFile: (path, data) => source.writeFileSync(path, data),
    exists: (path) => source.existsSync(path),
    list: (path) => source.readdirSync(path),
    open: (...args) => source.openSync(...args),
    close: (...args) => source.closeSync(...args),
    read: (...args) => source.readSync(...args),
    write: (...args) => source.writeSync(...args),
    fstat: (...args) => source.fstatSync(...args),
    fsync: (...args) => source.fsyncSync(...args),
    createReadStream: (...args) => source.createReadStream(...args),
    createWriteStream: (...args) => source.createWriteStream(...args),
    watch: (...args) => source.watch(...args),
    promises: Object.fromEntries(PROMISE_CALLS.map(name => [name, (...args) => (source.promises ?? realPromises)[name](...args)])),
  };
}

/** The promise-form calls the adapter passes through, by node:fs/promises name. */
const PROMISE_CALLS = ['readFile', 'readdir', 'stat', 'rm', 'mkdtemp', 'open', 'readlink', 'glob'];
