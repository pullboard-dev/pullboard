/**
 * The one place that reads node:fs: callers take an adapter, tests pass a fake source [C7].
 * Why: a fake source makes file-dependent code deterministic without touching the disk.
 */
import * as realFs from 'node:fs';

/**
 * Build a file-system adapter over a source of node:fs functions.
 * @param {Partial<typeof realFs>} [source] defaults to node:fs; a fake needs only the functions the caller uses
 * @returns {{ readFile: Function, writeFile: Function, exists: Function, list: Function,
 *   stat: Function, lstat: Function, realpath: Function, readlink: Function, access: Function, statfs: Function,
 *   constants: object }} Each metadata function passes its arguments and options to the source's sync form of the same name; `list` also takes options such as withFileTypes; `constants` is the source's.
 */
export function fileSystemAdapter(source = realFs) {
  return {
    readFile: (path, encoding = 'utf8') => source.readFileSync(path, encoding),
    writeFile: (path, data) => source.writeFileSync(path, data),
    exists: (path) => source.existsSync(path),
    list: (...args) => source.readdirSync(...args),
    stat: (...args) => source.statSync(...args),
    lstat: (...args) => source.lstatSync(...args),
    realpath: (...args) => source.realpathSync(...args),
    readlink: (...args) => source.readlinkSync(...args),
    access: (...args) => source.accessSync(...args),
    statfs: (...args) => source.statfsSync(...args),
    constants: source.constants,
  };
}
