#!/usr/bin/env node
/** Show which packages a change would unseal, or each package's seal at a revision (RFC 0006 A1, A2) [C7,CD44]. */
import { resolve } from 'node:path';
import {
  sealStatus,
  unsealedPackages,
} from '../../../heavy.js';

const USAGE = 'usage: node packages/gate/src/io/scripts/seals.js unsealed <base> [head] [--root <dir>] | status [rev] [--root <dir>]\n';
const args = process.argv.slice(2);
const at = args.indexOf('--root');
const root = resolve(at >= 0 ? args[at + 1] ?? '.' : '.');
const [verb, ...revs] = args.filter((_, index) => at < 0 || (index !== at && index !== at + 1));
try {
  if (verb === 'unsealed' && revs.length >= 1 && revs.length <= 2) {
    const { unsealed, kept } = unsealedPackages(root, { base: revs[0], head: revs[1] });
    for (const row of unsealed) process.stdout.write(`${row.package}  ${row.reason}\n`);
    process.stdout.write(`${unsealed.length} unsealed, ${kept.length} keep their seal\n`);
  } else if (verb === 'status' && revs.length <= 1) {
    for (const row of sealStatus(root, { rev: revs[0] })) {
      process.stdout.write(`${row.package}  ${row.hash.slice(0, 12)}  ${row.seal ? `sealed by ${row.seal.receipts.join(', ')}` : 'unsealed'}\n`);
    }
  } else {
    process.stderr.write(USAGE);
    process.exitCode = 1;
  }
} catch (error) {
  if (!error.code) throw error;
  process.stderr.write(`seals: [${error.code}] ${error.message}\n`);
  process.exitCode = 1;
}
