/** Secret recognition on added lines, apart from the hooks and their git and sqlite loads so a reader of an item never pays for them [C7]. */
/**
 * Secrets by kind, most specific first, so a line is named once by what it most likely is.
 */
const SECRETS = [
  ['Anthropic key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI key', /sk-proj-[A-Za-z0-9_-]{32,}/],
  ['OpenAI key', /(?<![A-Za-z0-9-])sk-(?:None-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/],
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['GitHub token', /gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}/],
  ['Slack token or webhook', /xox[abprs]-[A-Za-z0-9-]{10,}|hooks\.slack\.com\/services\/[A-Za-z0-9/]+/],
  ['Stripe live key', /(sk|rk)_live_[A-Za-z0-9]{20,}/],
  ['Cloudflare token', /cfut_[A-Za-z0-9_-]{20,}/],
  ['npm token', /npm_[A-Za-z0-9]{36}/],
  ['assigned secret', /(api[_-]?key|secret|token|password)['"]?\s*[:=]\s*['"]([A-Za-z0-9/+_=-]{20,})['"]/i],
  ['env-style secret', /^\s*(export\s+)?[A-Z][A-Z0-9_]*(SECRET|KEY|TOKEN|PASSWORD)[A-Z0-9_]*\s*=\s*[A-Za-z0-9/+_=-]{20,}\s*$/],
];

/** Recognize only the complete public negative-auth object property, never a literal prefix or continuation. */
function publicFixtureAssignment(match, text) {
  return /^secret[ \t]*:[ \t]*(['"])not-the-listener-secret\1$/u.test(match[0])
    && /[{,][ \t]*$/u.test(text.slice(0, match.index))
    && /^[ \t]*\}/u.test(text.slice(match.index + match[0].length));
}

/**
 * Added lines that look like secrets, named by kind and place. Values are never echoed back.
 *
 * @param {{ path: string, line: number, text: string }[]} added
 * @returns {string[]}
 */
export function secretsIn(added) {
  return added.flatMap((entry) => {
    const found = SECRETS.find(([kind, pattern]) => kind === 'assigned secret'
      // This public negative-auth fixture predates history transfer; it is never a credential.
      // Inspect every assignment so the sentinel cannot conceal a second value on the same line.
      ? [...entry.text.matchAll(new RegExp(pattern.source, 'gi'))]
        .some(match => !publicFixtureAssignment(match, entry.text))
      : pattern.test(entry.text));
    return found ? [`${found[0]} at ${entry.path}:${entry.line}`] : [];
  });
}
