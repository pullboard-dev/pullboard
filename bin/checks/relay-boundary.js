/** Refuse direct network calls in production outside the audited transport boundaries [C7]. */
import { lex } from '../../packages/kernel/index.js';

// These paths use fetch for GitHub or this machine's local cockpit, not relay network requests.
const NON_RELAY = new Map([
  ['packages/link/src/shell/relay-handover.js', ["fetch(new URL('users/'"]],
  ['relay/github.js', ['fetch(url, { method: form || json']],
  ['src/view/page-script-2.js', ["fetch(base + '/local/protocol'", 'fetch(path, { method: body']],
  ['src/view/cockpit-live.js', ['fetch(path, {']],
]);
const ADAPTERS = new Set([
  'packages/person/src/shell/relay-adapter.js',
  'relay/browser-adapter.js',
]);

/** Return direct fetch calls in production source outside the approved adapters and non-relay paths. */
export function relayBoundaryProblems(sources) {
  const problems = [];
  for (const { file, source } of sources) {
    if (ADAPTERS.has(file) || /(?:^|\/)(?:test|tests)\//u.test(file) || /(?:^|[.-])test\.[cm]?js$/u.test(file)) continue;
    const code = lex(source).code;
    const allowed = [...(NON_RELAY.get(file) ?? [])];
    for (const match of code.matchAll(/\b(?:globalThis\s*\.\s*)?fetch\s*\(/gu)) {
      const line = code.slice(0, match.index).split('\n').length;
      const original = source.split('\n')[line - 1];
      const exception = allowed.findIndex(text => original.includes(text));
      if (exception >= 0) { allowed.splice(exception, 1); continue; }
      problems.push({ file, line, text: 'direct network fetch must use the relay adapter or an audited non-relay boundary' });
    }
  }
  return problems;
}
