/** Explain owner-sensitive outside changes from trusted main policy and exact Git objects, never execution. */
import { git } from './git.js';
import { Refused } from './refused.js';

/** Fixed trust boundaries cannot be removed by a project's extensions or the contributed configuration. */
export const OUTSIDE_SENSITIVE_PATHS = Object.freeze([
  'relay/', '.githooks/', '.husky/', '.github/workflows/', 'bin/',
  'src/seal.js', 'src/sealed-pages.js', 'src/signature.js', 'src/relay-key.js', 'src/relay-device-keys.js',
  'src/person.js', 'src/person-request.js', 'src/relay-requests.js', 'src/relay-request-execution.js', 'src/relay-sender.js',
  'src/row-decisions.js', 'src/row-decision-state.js', 'src/spec-approval.js', 'src/spec-approval-baseline.js',
  'src/hooks.js', 'src/commands/hook.js', 'src/commands/hooks.js', 'pullboard.json',
]);

/** Read a committed text blob; unreadable, binary and invalid UTF-8 input fails closed as sensitive. */
function textAt(root, commit, path) {
  const text = git(root, ['show', `${commit}:${path}`], { maxBuffer: 1024 * 1024 });
  if (text.includes('\0') || text.includes('\ufffd')) throw new Error('not readable text');
  return text;
}

/** Match only declared relative exact paths or trailing-slash prefixes, like lane ownership paths. */
function declared(path, pattern) {
  return path === pattern || pattern.endsWith('/') && path.startsWith(pattern);
}

/** Record a reason for every rule/path match; a display can explain the hold without rerunning the classifier. */
export function outsideSensitivity(root, base, commit, paths, { mainPolicy }) {
  const configured = mainPolicy(root).config.intake?.sensitivePaths ?? [];
  if (!Array.isArray(configured) || configured.some(path => typeof path !== 'string' || !path || path.startsWith('/') || path.split('/').includes('..') || /[\r\n\0]/u.test(path))) {
    throw new Refused('BAD_CONFIG', 'intake.sensitivePaths in trusted main is a list of relative exact files or trailing-slash prefixes; correct it before intake');
  }
  const reasons = [];
  for (const path of paths) {
    for (const pattern of OUTSIDE_SENSITIVE_PATHS) if (declared(path, pattern)) reasons.push({ path, rule: 'declared-sensitive-path', detail: pattern });
    for (const pattern of configured) if (declared(path, pattern)) reasons.push({ path, rule: 'configured-sensitive-path', detail: pattern });
    if (/(^|\/)(?:\.?(?:huskyrc|lintstagedrc)(?:\..*)?|\.?lefthook(?:\..*)?|\.pre-commit-config\.(?:yaml|yml))$/iu.test(path)) reasons.push({ path, rule: 'hook-configuration', detail: 'hook tool configuration' });
    try {
      const content = textAt(root, commit, path);
      if (path === 'package.json') {
        const next = JSON.parse(content);
        let previous = {};
        try { previous = JSON.parse(textAt(root, base, path)); } catch { /* A new package has no earlier fields. */ }
        for (const field of ['scripts', 'engines', 'husky', 'lint-staged', 'simple-git-hooks']) {
          if (JSON.stringify(previous[field]) !== JSON.stringify(next[field])) reasons.push({ path, rule: 'package-execution-policy', detail: field });
        }
      }
      const diff = git(root, ['diff', '--no-ext-diff', '--no-textconv', '--unified=0', base, commit, '--', path], { maxBuffer: 2 * 1024 * 1024 });
      const added = diff.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).join('\n');
      if (/child_process|\b(?:spawn(?:Sync)?|exec(?:File)?(?:Sync)?|runProfiledShell(?:Async)?|runShell|runCommand|shell|runner)\s*\(/u.test(added)) {
        reasons.push({ path, rule: 'new-process-execution', detail: 'added child_process import, process-execution call or shell-runner call' });
      }
    } catch {
      reasons.push({ path, rule: 'unreadable-changed-file', detail: 'the classifier could not read and classify the exact committed file' });
    }
  }
  return reasons;
}
