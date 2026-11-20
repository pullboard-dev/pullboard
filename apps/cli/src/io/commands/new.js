/** The pullboard new command: new package writes a cell's anatomy files under packages/<name> of the project root [C7,#11426]. */
import { dirname } from 'node:path';
import { join } from 'node:path';
import { fileSystemAdapter } from '../../../../../packages/fs/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { context } from '../entry.js';
import { newPackageFiles } from '../../logic/new-package.js';

const fs = fileSystemAdapter();
const USAGE = 'pullboard new package <name> --purpose "<one line>"';

/**
 * Run `pullboard new package <name> --purpose "<line>"`: write the files newPackageFiles returns and print each path written.
 * Why refuse an existing folder: a cell that is already there is never overwritten, so nothing is written at all.
 */
export function run(io, { first, second, rest, values }) {
  if (first !== 'package' || !second || rest.length) throw new Refused('USAGE', USAGE);
  const files = newPackageFiles(second, values.purpose);
  const root = context(io).info.root;
  if (fs.exists(join(root, 'packages', second))) throw new Refused('NEW_PACKAGE_EXISTS', `packages/${second} already exists; nothing was written`, 'choose another name, or edit the existing package');
  for (const [path, text] of Object.entries(files)) {
    const target = join(root, path);
    fs.mkdir(dirname(target), { recursive: true });
    fs.writeFile(target, text);
    io.say(path);
  }
  io.result?.({ package: second, written: Object.keys(files) });
  return 0;
}
