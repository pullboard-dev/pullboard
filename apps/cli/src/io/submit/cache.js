/** Reuse only exact immutable-source controller checks, never board authority [C7,H16]. */
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checkReceiptKey } from '../../../../../packages/git/index.js';
import { readCheckReceipt } from '../../../../../packages/git/index.js';
import { writeCheckReceipt } from '../../../../../packages/git/index.js';
import { tryGit } from '../../../../../packages/git/index.js';
import { foreignNodeOptions } from '../../../../../packages/gate/index.js';
import { fileSystemAdapter } from '../../../../../packages/fs/index.js';

const fs = fileSystemAdapter();

/** Bind recognized preloads to their actual bytes; unknown options can never reuse a receipt. */
function preloadState() {
  if (foreignNodeOptions(process.env.NODE_OPTIONS)) return null;
  try {
    return String(process.env.NODE_OPTIONS ?? '').split(/\s+/u).filter(Boolean).map(token => {
      const match = /^--(?:import|require)=(.+)$/u.exec(token);
      if (!match) throw new Error('unrecognized preload');
      const value = match[1].startsWith('"') ? JSON.parse(match[1]) : match[1];
      const file = value.startsWith('file:') ? fileURLToPath(value) : value;
      return { token, digest: createHash('sha256').update(fs.readFile(file, null)).digest('hex') };
    });
  } catch { return null; }
}

/** A green check may be reused only for the same clean tree, base, preload and checker closure. */
export async function cachedSubmitSourceStep(root, { kind, base, source, code }, check) {
  const head = tryGit(root, ['rev-parse', 'HEAD']);
  const preloads = preloadState();
  const samePreloads = () => preloads !== null && JSON.stringify(preloadState()) === JSON.stringify(preloads);
  const eligible = samePreloads() && head.status === 0 && head.stdout.trim() === source;
  const key = eligible ? checkReceiptKey(root, { kind, definition: `submit ${kind}`,
    config: { base, source, preloads }, code: [...code, fileURLToPath(import.meta.url), fileURLToPath(new URL('../commands/submit.js', import.meta.url))], commands: [] }) : null;
  const receipt = readCheckReceipt(root, key);
  if (receipt && samePreloads()) return { reused: true, receipt };
  await check();
  const after = tryGit(root, ['rev-parse', 'HEAD']);
  if (samePreloads() && after.status === 0 && after.stdout.trim() === source) writeCheckReceipt(root, key);
  return { reused: false };
}
