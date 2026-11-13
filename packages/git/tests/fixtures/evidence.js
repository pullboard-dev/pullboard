/** A private flake project's evidence reader, kept free of the CLI so the git cell test can load it [C7,H16]. */
import {
  lstatSync,
  readFileSync,
} from 'node:fs';
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

/**
 * Build a reader that returns real evidence bytes only from one counter file or the board evidence directory under root.
 *
 * Why: a flake fixture must never read source files as evidence, through `..` or a symbolic link.
 *
 * @param {{ scratch: string, root: string, counter: string }} box - The owned scratch, its repo root and the counter file.
 * @returns {(file: string, encoding?: BufferEncoding) => string | Buffer}
 */
export function evidenceReader({ scratch, root, counter }) {
  return function readData(file, encoding) {
    if (typeof file !== 'string' || !isAbsolute(file)) throw new Error('private flake evidence requires an absolute file');
    const path = resolve(file), evidence = join(root, '.git/pullboard');
    const within = relative(evidence, path);
    if (path !== counter && (!within || within === '..' || within.startsWith('..' + sep) || isAbsolute(within))) {
      throw new Error('private flake evidence escaped its counter or board evidence');
    }
    let current = scratch;
    const parts = relative(scratch, path).split(sep);
    if (lstatSync(current).isSymbolicLink()) throw new Error('private flake evidence root is symbolic');
    for (const part of parts) {
      current = join(current, part);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || (current === path ? !stat.isFile() : !stat.isDirectory())) {
        throw new Error('private flake evidence is not a contained regular file');
      }
    }
    return readFileSync(path, encoding);
  };
}
