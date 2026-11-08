/** Frame one shell request on a shared runner channel and read its reply back out of the byte stream [C7]. */

/**
 * Quote a string as one POSIX shell word.
 *
 * Why: the channel's remote end is a plain `sh`, so nothing here may assume Node or any tool on the runner.
 *
 * @param {string} text
 * @returns {string}
 */
export function shellWord(text) {
  return `'${String(text).replaceAll("'", "'\\''")}'`;
}

/**
 * The bytes that ask the channel's shell to run one script and fence its output with the request's nonce.
 *
 * Why: the script runs in a subshell under eval, with stdin from /dev/null, so a syntax error or a reader can never
 * end the shared shell or swallow the next request on the channel.
 *
 * @param {string} nonce - A random token no output can guess.
 * @param {string} script - POSIX shell text to run on the runner.
 * @returns {string}
 */
export function requestFrame(nonce, script) {
  return `printf '%s\\n' '__PB_BEGIN ${nonce}'; ( eval ${shellWord(script)} ) </dev/null 2>&1; __pb_s=$?; printf '\\n__PB_END ${nonce} %s\\n' "$__pb_s"\n`;
}

/**
 * Read one complete reply for a nonce from the channel's buffered output, or null while it is still arriving.
 *
 * @param {Buffer} buffer - Everything the channel printed since the last reply was consumed.
 * @param {string} nonce
 * @returns {{ status: number, output: Buffer, rest: Buffer } | null}
 */
export function readReply(buffer, nonce) {
  const begin = Buffer.from(`__PB_BEGIN ${nonce}\n`);
  const start = buffer.indexOf(begin);
  if (start < 0) return null;
  const end = Buffer.from(`\n__PB_END ${nonce} `);
  const stop = buffer.indexOf(end, start + begin.length);
  if (stop < 0) return null;
  const newline = buffer.indexOf(0x0a, stop + end.length);
  if (newline < 0) return null;
  const status = Number(buffer.subarray(stop + end.length, newline).toString('utf8'));
  return { status: Number.isInteger(status) ? status : -1, output: buffer.subarray(start + begin.length, stop), rest: buffer.subarray(newline + 1) };
}

/**
 * The registry key for a runner: one channel per host.
 *
 * @param {{ host: string }} runner
 * @returns {string}
 */
export function channelKey(runner) {
  if (typeof runner?.host !== 'string' || !runner.host) throw new TypeError('a runner needs a host');
  return runner.host;
}
