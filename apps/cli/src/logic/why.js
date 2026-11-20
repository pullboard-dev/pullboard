/**
 * The shared --why flag: any pullboard command takes `--why "<text>"` (or PULLBOARD_WHY), ignores it for behaviour
 * and keeps it in that call's trace line. One definition feeds the parser strip and every command's help [C7].
 */
import { environmentAdapter } from '../../../../packages/env/index.js';

/** The flag as help shows it, the same for every command. */
export const WHY_FLAG = '--why "<text>"';
/** What help says the flag does. */
export const WHY_EXPLANATION = 'your stated intent for this call; ignored for behaviour, kept in the trace (or set PULLBOARD_WHY)';
/** The longest intent kept, so one trace line stays small. */
const WHY_MAX = 500;

/**
 * Split the stated intent out of argv. It returns the argv without `--why`, and the intent text (the flag first,
 * else PULLBOARD_WHY, else null). `land --why` is its own boolean flag, so for `land` only a flag with a value is taken.
 */
export function extractWhy(argv, env = environmentAdapter().all()) {
  const out = [];
  let why = null;
  const landBoolean = argv[0] === 'land';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i]);
    if (i > 0 && arg.startsWith('--why=')) { why = arg.slice(6); continue; }
    if (i > 0 && arg === '--why') {
      const next = argv[i + 1];
      const hasValue = next !== undefined && !(landBoolean && String(next).startsWith('-'));
      if (landBoolean && !hasValue) { out.push(arg); continue; }
      if (hasValue) { why = String(next); i += 1; }
      continue;
    }
    out.push(argv[i]);
  }
  const text = (why ?? env.PULLBOARD_WHY ?? '').trim();
  return { argv: out, why: text ? text.slice(0, WHY_MAX) : null };
}
