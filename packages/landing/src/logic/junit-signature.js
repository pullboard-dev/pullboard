/** Sign a failing JUnit case so it reads the same on every runner [C7]. */
import { createHash } from 'node:crypto';
import { normalizedFailureDiagnostics } from '../../../kernel/index.js';

/**
 * The 64-hex sha256 of a failing case's name, file and message after the checkout-path normalisation failureSignatures
 * uses, or null when the row names no file. Why: a signature that holds a checkout path differs on every runner, so main-red
 * excusal could never match a rerun [C7].
 */
export function junitFailureSignature(row, root) {
  if (!row || typeof row.file !== 'string' || !row.file) return null;
  const lines = normalizedFailureDiagnostics([`name: ${row.name ?? ''}`, `file: ${row.file}`, `message: ${row.assertion ?? ''}`], root);
  return createHash('sha256').update(JSON.stringify(lines)).digest('hex');
}
