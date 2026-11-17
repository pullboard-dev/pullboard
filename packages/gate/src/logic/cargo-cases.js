/** Read plain `cargo test` (libtest) output into {name, outcome, message?} cases in the junitCases shape, with no extra tool [C7]. */
export function cargoTestCases(output) {
  if (typeof output !== 'string') return { cases: [], reason: 'CARGO_UNREADABLE' };
  const lines = output.split(/\r?\n/u);
  const cases = [];
  for (const line of lines) {
    const match = /^test (\S+) \.\.\. (ok|FAILED|ignored)\b/u.exec(line);
    if (match) cases.push({ name: match[1], outcome: match[2] === 'ok' ? 'pass' : match[2] === 'FAILED' ? 'fail' : 'skip' });
  }
  if (cases.length === 0) return { cases: [], reason: 'CARGO_UNREADABLE' };
  for (let at = 0; at < lines.length; at += 1) {
    const head = /^---- (\S+) stdout ----$/u.exec(lines[at]);
    if (!head) continue;
    const failing = cases.find(found => found.name === head[1] && found.outcome === 'fail' && found.message === undefined);
    if (!failing) continue;
    for (let next = at + 1; next < lines.length && !/^---- /u.test(lines[next]); next += 1) {
      if (/panicked at /u.test(lines[next])) { failing.message = lines[next].trim(); break; }
    }
  }
  return { cases, reason: null };
}
