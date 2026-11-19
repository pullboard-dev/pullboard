/**
 * The one place that reads node:fs: callers take an adapter, tests pass a fake source [C7].
 * Why: a fake source makes file-dependent code deterministic without touching the disk.
 */
import * as realFs from 'node:fs';

/**
 * Build a file-system adapter over a source of node:fs functions.
 * @param {Partial<typeof realFs>} [source] defaults to node:fs; a fake needs only the functions the caller uses
 * @returns {{ readFile: Function, writeFile: Function, exists: Function, list: Function,
 *   mkdir: Function, mkdtemp: Function, rm: Function, rmdir: Function, rename: Function, unlink: Function,
 *   appendFile: Function, copyFile: Function, cp: Function, chmod: Function, utimes: Function,
 *   symlink: Function, link: Function }} Each change function passes its arguments and options to the source's sync form of the same name.
 */
export function fileSystemAdapter(source = realFs) {
  return {
    readFile: (path, encoding = 'utf8') => source.readFileSync(path, encoding),
    writeFile: (path, data) => source.writeFileSync(path, data),
    exists: (path) => source.existsSync(path),
    list: (path) => source.readdirSync(path),
    mkdir: (...args) => source.mkdirSync(...args),
    mkdtemp: (...args) => source.mkdtempSync(...args),
    rm: (...args) => source.rmSync(...args),
    rmdir: (...args) => source.rmdirSync(...args),
    rename: (...args) => source.renameSync(...args),
    unlink: (...args) => source.unlinkSync(...args),
    appendFile: (...args) => source.appendFileSync(...args),
    copyFile: (...args) => source.copyFileSync(...args),
    cp: (...args) => source.cpSync(...args),
    chmod: (...args) => source.chmodSync(...args),
    utimes: (...args) => source.utimesSync(...args),
    symlink: (...args) => source.symlinkSync(...args),
    link: (...args) => source.linkSync(...args),
  };
}
