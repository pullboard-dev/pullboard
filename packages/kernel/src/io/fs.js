/**
 * The one place that reads node:fs: callers take an adapter, tests pass a fake source [C7].
 * Why: a fake source makes file-dependent code deterministic without touching the disk.
 */
import * as realFs from 'node:fs';

/**
 * Build a file-system adapter over a source of node:fs functions.
 * @param {Pick<typeof realFs, 'readFileSync' | 'writeFileSync' | 'existsSync' | 'readdirSync'>} [source] defaults to node:fs
 * @returns {{ readFile: Function, writeFile: Function, exists: Function, list: Function }}
 */
export function fileSystemAdapter(source = realFs) {
  return {
    readFile: (path, encoding = 'utf8') => source.readFileSync(path, encoding),
    writeFile: (path, data) => source.writeFileSync(path, data),
    exists: (path) => source.existsSync(path),
    list: (path) => source.readdirSync(path),
  };
}
