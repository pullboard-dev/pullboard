#!/usr/bin/env node
/** Move a split test file's rows in every per-file registry to its new siblings: `split.js <original> <new>... [--root dir] [--base commit] [--dry-run]` [C7]. */
import { resolve } from 'node:path';
import { splitRegistries } from '../split.js';

const args = process.argv.slice(2);
/** The value after a flag, or null. */
const option = flag => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] ?? null : null; };
const values = new Set(['--root', '--base'].map(flag => args.indexOf(flag) + 1).filter(index => index > 0));
const root = resolve(option('--root') ?? '.');
const paths = args.filter((arg, index) => !arg.startsWith('--') && !values.has(index));
try {
  const { rows, written } = await splitRegistries(root, paths[0], paths.slice(1), { write: !args.includes('--dry-run'), base: option('--base') });
  for (const row of rows) {
    const { registry, ...rest } = row;
    process.stdout.write(`${registry}: ${Object.entries(rest).map(([key, value]) => `${key} ${Array.isArray(value) ? value.join(',') || '-' : value}`).join(', ')}\n`);
  }
  process.stdout.write(`${args.includes('--dry-run') ? 'would write' : 'wrote'} ${written.length} file(s)${written.length ? ': ' + written.join(', ') : ''}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n${error.next ? `next: ${error.next}\n` : ''}`);
  process.exitCode = 1;
}
