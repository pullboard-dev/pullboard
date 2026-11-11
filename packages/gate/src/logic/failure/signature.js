/** A stable failure signature: error type plus the deepest repository frame, free of per-run spelling [C7]. */

const GENERIC_CODES = new Set(['ERR_TEST_FAILURE']);
const CHECKOUT_PREFIXES = [
  /^.*\/\.?pullboard-runner\/jobs\/[^/]+\/checkout\//u,
  /^.*\/\.claude\/worktrees\/[^/]+\//u,
];
const FRAME_WITH_FUNCTION = /^(?:at\s+)?(.*?)\s*\((.+?):\d+(?::\d+)?\)$/u;
const FRAME_BARE = /^(?:at\s+)?(.+?):\d+(?::\d+)?$/u;

/** Path of a stack location relative to the repository, or null when it is not the repository's own code. */
function repoPath(location, root) {
  let path = location.replace(/^file:\/\//u, '').replace(/[?#].*$/u, '');
  if (/^(?:node|data):/u.test(path) || path.split('/').includes('node_modules')) return null;
  if (root && path.startsWith(root.replace(/\/+$/u, '') + '/')) return path.slice(root.replace(/\/+$/u, '').length + 1);
  for (const prefix of CHECKOUT_PREFIXES) if (prefix.test(path)) return path.replace(prefix, '');
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(path) ? null : path.replace(/^\.\//u, '');
}

/** The function name without async, new or receiver prefixes, which vary by Node version and call style. */
function functionName(raw) {
  const name = raw.replace(/^(?:async|new)\s+/gu, '').replace(/\s+\[as [^\]]*\]$/u, '').replace(/^(?:Object|TestContext|Test|Function|Module)\./u, '').trim();
  return name || '<anonymous>';
}

/** The first stack frame that is repository code: frames print deepest first. */
function deepestFrame(stack, root) {
  for (const raw of String(stack ?? '').split('\n')) {
    const line = raw.trim();
    const match = FRAME_WITH_FUNCTION.exec(line) ?? FRAME_BARE.exec(line);
    if (!match) continue;
    const [name, location] = match.length === 3 && match[2] !== undefined ? [match[1], match[2]] : ['', match[1]];
    const file = repoPath(location, root);
    if (file) return { file, name: functionName(name) };
  }
  return null;
}

/** Error class, code or refusal rule, then the assertion operator: the kind of failure, never its message. */
function errorType({ name, code, operator, error }) {
  const text = String(error ?? '').trimStart();
  const refusal = /^\[([A-Z][A-Z0-9_]+)\]/u.exec(text);
  if (refusal) return `Refused[${refusal[1]}]`;
  const kind = name || /^([A-Z]\w*(?:Error|Exception))\b/u.exec(text)?.[1] || 'Error';
  const word = code || /^(E[A-Z0-9]{3,}|ERR_[A-Z0-9_]+):/u.exec(text)?.[1];
  return [kind, word && !GENERIC_CODES.has(word) ? word : '', operator || ''].filter(Boolean).join(':');
}

/**
 * Sign a failing case so the same root cause reads the same across runs: `Type[:code[:operator]] @ file#function`.
 * Why: raw error text and stacks carry job directories, temp names, hashes, ports and durations, so comparing them
 * called identical reds different. Null when no repository frame is on the stack, so callers fall back to the raw text.
 *
 * @param {{ error?: string, stack?: string, name?: string, code?: string, operator?: string, root?: string }} failure - Fields of one failing case.
 * @returns {string|null}
 */
export function failureSignature(failure) {
  const frame = deepestFrame(failure?.stack, failure?.root);
  return frame ? `${errorType(failure)} @ ${frame.file}#${frame.name}` : null;
}
