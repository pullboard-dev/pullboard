/** Reuse only exact immutable-source controller checks, never board authority [C7,H16]. */
import { fileURLToPath } from 'node:url';
import { checkReceiptKey } from '../packages/git/index.js';
import { readCheckReceipt } from '../packages/git/index.js';
import { writeCheckReceipt } from '../packages/git/index.js';
import { tryGit } from '../packages/git/index.js';

/** A green check may be reused only for the same clean tree, base and complete checker closure. */
export async function cachedSubmitSourceStep(root, { kind, base, source, code }, check) {
  const head = tryGit(root, ['rev-parse', 'HEAD']);
  // Node preloads can change the check without changing source; conservatively never cache them.
  const eligible = !process.env.NODE_OPTIONS && head.status === 0 && head.stdout.trim() === source;
  const key = eligible ? checkReceiptKey(root, { kind, definition: `submit ${kind}`, config: { base, source }, code: [...code, fileURLToPath(import.meta.url)], commands: [] }) : null;
  const receipt = readCheckReceipt(root, key);
  if (receipt) return { reused: true, receipt };
  await check();
  const after = tryGit(root, ['rev-parse', 'HEAD']);
  if (!process.env.NODE_OPTIONS && after.status === 0 && after.stdout.trim() === source) writeCheckReceipt(root, key);
  return { reused: false };
}
