/** Refuse direct network calls in production outside the audited transport boundaries [C7]. */
import { lex } from '../../../kernel/index.js';

// These paths use fetch for GitHub or this machine's local cockpit, not relay network requests.
const NON_RELAY = new Map([
  ['packages/link/src/io/relay/handover.js', ["fetch(new URL('users/'"]],
  ['apps/relay/src/io/github.js', ['fetch(url, { method: form || json']],
  ['apps/view/src/io/page/connect.js', ["fetch(base + '/local/protocol'", 'fetch(path, { method: body']],
  ['apps/view/src/logic/cockpit/live.js', ['fetch(path, {']],
  // The CLA check calls the GitHub API from CI; it sat in bin/, outside this check, until the layout freeze [V32].
  // A pull runner calls its own board's job queue API; it is the runner side of that API, not a relay request [P7].
  ['packages/drive/src/io/pull.js', ['fetchImpl = fetch']],
  ['packages/gate/src/io/check/cla.js', ['send = fetch']],
]);
const ADAPTERS = new Set([
  'packages/person/src/io/adapter.js',
  'apps/relay/src/io/browser-adapter.js',
]);

/** Return direct fetch calls in production source outside the approved adapters and non-relay paths. */
export function relayBoundaryProblems(sources) {
  const problems = [];
  for (const { file, source } of sources) {
    if (ADAPTERS.has(file) || /(?:^|\/)(?:test|tests)\//u.test(file) || /(?:^|[.-])test\.[cm]?js$/u.test(file)) continue;
    const code = lex(source).code;
    const allowed = [...(NON_RELAY.get(file) ?? [])];
    const calls = [...code.matchAll(/\b(?:globalThis\s*\.\s*)?fetch\s*\(/gu)];
    calls.push(...code.matchAll(/(?:=\s*(?:(?:globalThis|window)\s*\.\s*)?fetch\b(?!\s*\()|\{\s*fetch\s*\}\s*=\s*(?:globalThis|window)\b)/gu));
    for (const match of source.matchAll(/\b(?:globalThis|window)\s*\[\s*['"]fetch['"]\s*\]\s*\(/gu)) {
      if (code.slice(match.index, match.index + 6).trim()) calls.push(match);
    }
    for (const match of calls) {
      const line = code.slice(0, match.index).split('\n').length;
      const original = source.split('\n')[line - 1];
      const exception = allowed.findIndex(text => original.includes(text));
      if (exception >= 0) { allowed.splice(exception, 1); continue; }
      problems.push({ file, line, text: 'direct network fetch must use the relay adapter or an audited non-relay boundary' });
    }
  }
  return problems;
}
