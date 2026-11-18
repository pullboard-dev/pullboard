/** A contract fingerprint covers an export's file and every relative helper it imports, so a helper edit moves it [C7]. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  dirname,
  resolve,
} from 'node:path';
import { Refused } from '../../../../kernel/light.js';
import { readContractFile } from './file.js';

const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/gu;

/**
 * List a file plus every relative file it imports, transitively, in sorted path order.
 * @param {string} entry absolute path of the export's file
 * @returns {string[]} the entry and its helpers
 */
function closureOf(entry) {
  const seen = new Set();
  const pending = [resolve(entry)];
  while (pending.length > 0) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    let text;
    try { text = readFileSync(file, 'utf8'); } catch {
      throw new Refused('FINGERPRINT_UNREADABLE', `${file} cannot be read; point the contract at an existing source file and retry`);
    }
    seen.add(file);
    for (const [, spec] of text.matchAll(RELATIVE_IMPORT)) pending.push(resolve(dirname(file), spec));
  }
  return [...seen].sort();
}

/**
 * Fingerprint one export: its name and the bytes of its file and every helper it imports.
 * Why: hashing only the export's own file let a helper change slip past the manifest.
 * @param {string} entry absolute path of the file that exports it
 * @param {string} exportName the export's name
 * @returns {string} sha256 hex
 */
export function fingerprintExport(entry, exportName) {
  const hash = createHash('sha256').update(`export:${exportName}\n`);
  for (const file of closureOf(entry)) hash.update(`file:${file}\n`).update(readFileSync(file));
  return hash.digest('hex');
}

/**
 * List each consumer contract with the fingerprint of every export it relies on, sorted so two runs on one tree match.
 * @param {{ contract: string, entry: string }[]} sources contract file paths and the provider file each reads from
 * @returns {{ consumer: string, provider: string, exports: { name: string, fingerprint: string }[] }[]} the manifest
 */
export function contractManifest(sources) {
  return sources.map(({ contract, entry }) => {
    const { consumer, provider, exports } = readContractFile(contract);
    return {
      consumer,
      provider,
      exports: exports.map(({ name }) => ({ name, fingerprint: fingerprintExport(entry, name) })).sort((a, b) => a.name.localeCompare(b.name)),
    };
  }).sort((a, b) => `${a.consumer}|${a.provider}`.localeCompare(`${b.consumer}|${b.provider}`));
}
