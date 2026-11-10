/** The pullboard import command, in its own module so an item adding another command never edits these lines. */
import {
  importBoard,
} from '../../../../../packages/store/index.js';
import {
  Refused,
} from '../../../../../packages/kernel/index.js';
import {
  existsSync,
  readFileSync,
} from 'node:fs';
import {
  resolve,
} from 'node:path';
import {
  context,
  withBoard,
} from '../entry.js';

/** Run `pullboard import` and return its exit code. */
export function run(io, { first, second, rest }) {
  if (!first || second || rest.length) throw new Refused('USAGE', 'pullboard import <file>');
  const file = resolve(io.cwd, first);
  if (!existsSync(file)) throw new Refused('NO_FILE', `no export file ${first}`);
  let document;
  try {
    document = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Refused('IMPORT_FORMAT', `file ${first} is not a JSON export; use pullboard export to make one`);
  }
  const ctx = context(io);
  const imported = withBoard(ctx, (board) => importBoard(board, document));
  io.result?.({ tables: imported.tables });
  io.say(`imported version ${document.version} board tables: ${imported.tables.join(', ')}`);
  return 0;
}
