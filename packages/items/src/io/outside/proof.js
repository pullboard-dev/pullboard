/** Native outside receipts bind the ordered accept to bytes written by its container executor. */
import { fileSystemAdapter } from '../../../../fs/index.js';
import { createHash } from 'node:crypto';
import {
  dirname,
  join,
} from 'node:path';
import { Refused } from "../../../../kernel/index.js";

const fs = fileSystemAdapter();

/** Check the receipt beside this exact board, never a caller-selected host path. Replay retains its sealed facts. */
export function requireOutsideReceipt(board, receipt) {
  const refuse = () => new Refused('OUTSIDE_SANDBOX_REQUIRED', 'the sandbox accept needs its own locally stored executor receipt; run normal verify --sandbox');
  if (!/^[a-f0-9-]{36}$/u.test(receipt?.id ?? '') || !Number.isSafeInteger(receipt?.item) || receipt.item < 1) throw refuse();
  const file = board.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
  if (!file) throw refuse();
  const directory = join(dirname(file), 'outside-check-output', String(receipt.item), receipt.id);
  try {
    if (fs.readFile(join(directory, 'receipt.json'), 'utf8') !== JSON.stringify(receipt) + '\n') throw refuse();
    for (const log of receipt.logs) {
      if (!['minimum', 'current'].includes(log.role) || !['environment', 'baseline', 'gate', 'criterion'].includes(log.stage)) throw refuse();
      const text = fs.readFile(join(directory, `${log.role}-${log.stage}.log`), null);
      if (createHash('sha256').update(text).digest('hex') !== log.sha256) throw refuse();
    }
  } catch { throw refuse(); }
}
