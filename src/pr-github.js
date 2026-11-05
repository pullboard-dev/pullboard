/** Use GitHub CLI's credential store without copying credentials into config or receipts [B3,R3]. */
import { spawnSync } from './windows-child-process.js';
import { tryGit } from './git.js';
import { Refused } from './refused.js';

/** Resolve only a GitHub repository, reading the raw URL before private Git URL rewrites. */
export function githubRepository(root, remote) {
  const raw = tryGit(root, ['config', '--get', `remote.${remote}.url`]).stdout.trim();
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u.exec(raw);
  if (!match || ['.', '..'].includes(match[1]) || ['.', '..'].includes(match[2])) {
    throw new Refused('PUBLISH_GITHUB', 'PR publishing needs a github.com remote; configure the repository remote or turn publish.pullRequest off.');
  }
  return `${match[1]}/${match[2]}`;
}

/** Make one bounded JSON request; this client exposes no merge operation. */
export function githubPullClient(root, repository) {
  /** Authenticate through gh itself, keeping provider credentials out of the application. */
  function api(method, suffix, body) {
    const args = ['api', '--method', method, `repos/${repository}/${suffix}`,
      '--header', 'Accept: application/vnd.github+json', '--header', 'X-GitHub-Api-Version: 2022-11-28'];
    if (body !== undefined) args.push('--input', '-');
    const result = spawnSync('gh', args, { cwd: root, encoding: 'utf8',
      input: body === undefined ? undefined : JSON.stringify(body), maxBuffer: 4 * 1024 * 1024, timeout: 30_000 });
    if (result.status !== 0 || result.error) throw new Refused('PUBLISH_GITHUB', 'GitHub request failed; inspect gh auth status and repository access, then run publish again.');
    try { return JSON.parse(result.stdout); }
    catch { throw new Refused('PUBLISH_GITHUB', 'GitHub returned invalid JSON; inspect gh api connectivity before publishing again.'); }
  }
  /** Read complete provider pages, refusing truncation instead of silently dropping evidence. */
  function pages(suffix, field = null) {
    const rows = [];
    for (let page = 1; page <= 100; page++) {
      const result = api('GET', `${suffix}${suffix.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const values = field ? result?.[field] : result;
      if (!Array.isArray(values)) throw new Refused('PUBLISH_GITHUB', 'GitHub returned an invalid list; inspect the provider response before publishing.');
      rows.push(...values);
      if (values.length < 100) return rows;
    }
    throw new Refused('PUBLISH_GITHUB', 'GitHub evidence exceeds the bounded page limit; narrow this release before publishing.');
  }
  return {
    open: () => pages('pulls?state=open'),
    commits: number => pages(`pulls/${number}/commits`),
    statuses: head => api('GET', `commits/${head}/status`).statuses ?? [],
    setStatus: (head, body) => api('POST', `statuses/${head}`, body),
    list: head => pages(`pulls?state=open&head=${encodeURIComponent(repository.split('/')[0] + ':' + head)}`),
    read: number => api('GET', `pulls/${number}`),
    readIssue: number => api('GET', `issues/${number}`),
    comments: number => pages(`issues/${number}/comments`),
    reviews: number => pages(`pulls/${number}/reviews`),
    files: number => pages(`pulls/${number}/files`),
    create: body => api('POST', 'pulls', body),
    update: (number, body) => api('PATCH', `pulls/${number}`, body),
    checks: head => pages(`commits/${head}/check-runs`, 'check_runs'),
    annotations: id => pages(`check-runs/${id}/annotations`),
  };
}
