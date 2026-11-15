/** Reads of git's hook stdin, in a module of their own so the thin hook entry loads nothing else [H24]. */
/**
 * Read everything git writes on a hook's stdin, or nothing when run by hand.
 *
 * @param {any} stdin
 * @returns {Promise<string>}
 */
export async function readStdin(stdin) {
  if (!stdin || stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8');
}
