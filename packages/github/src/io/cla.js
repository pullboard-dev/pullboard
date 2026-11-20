/** The CLA check's network half: read a pull request and post the CLA status through the GitHub adapter; the rules are injected by the caller [C7]. */
import { fileSystemAdapter } from '../../../fs/index.js';
import { createGithubAdapter } from './adapter/request.js';

const fs = fileSystemAdapter();

/** Fetch every page of one GitHub API list, 100 at a time until a short page, refusing a page that is not ok. */
export async function pages(adapter, path, headers) {
  const all = [];
  for (let page = 1; page <= 10; page += 1) {
    const answer = await adapter.request(`${path}?per_page=100&page=${page}`, { headers });
    if (answer.status < 200 || answer.status > 299) throw new Error(`GitHub API ${answer.status} for ${path}`);
    all.push(...answer.body);
    if (answer.body.length < 100) break;
  }
  return all;
}

/** The adapter, repository path and request headers one run of the check uses, all read from the given environment. */
export function claContext(environment, adapter) {
  const base = environment.get('GITHUB_API_URL', 'https://api.github.com');
  return {
    adapter: adapter ?? createGithubAdapter(fetch, { base }),
    repo: `/repos/${environment.get('GITHUB_REPOSITORY')}`,
    headers: { authorization: `Bearer ${environment.get('GITHUB_TOKEN')}` },
  };
}

/** Load the pull request's commits and comments through the adapter, or from the CLA_PR_FILE fixture with no request (live false). */
export async function loadPullRequest(adapter, environment) {
  if (environment.get('CLA_PR_FILE')) return { ...JSON.parse(fs.readFile(environment.get('CLA_PR_FILE'), 'utf8')), live: false };
  const event = JSON.parse(fs.readFile(environment.get('GITHUB_EVENT_PATH'), 'utf8'));
  const number = event.pull_request?.number ?? event.issue?.number;
  const { repo, headers } = claContext(environment, adapter);
  const commits = (await pages(adapter, `${repo}/pulls/${number}/commits`, headers)).map((c) => ({ sha: c.sha, login: c.author?.login ?? null, id: c.author?.id ?? null, message: c.commit?.message ?? '', parents: c.parents ?? [] }));
  const comments = (await pages(adapter, `${repo}/issues/${number}/comments`, headers)).map((c) => ({ id: c.id, user_id: c.user?.id, login: c.user?.login, body: c.body, url: c.html_url, created_at: c.created_at }));
  let head = event.pull_request?.head?.sha;
  if (!head) head = (await adapter.request(`${repo}/pulls/${number}`, { headers })).body.head.sha;
  return { commits, comments, head, live: true };
}

/** Post the CLA commit status on the PR head; a refused or failed post (a fork's read-only token) never throws, so the exit code still reports. */
export async function postStatus(adapter, pr, ok, description, environment) {
  if (!pr.live) return;
  const { repo, headers } = claContext(environment, adapter);
  try {
    await adapter.request(`${repo}/statuses/${pr.head}`, {
      method: 'POST', headers,
      body: JSON.stringify({ state: ok ? 'success' : 'failure', context: 'CLA', description: description.slice(0, 140) }),
    });
  } catch { /* the job result still reports */ }
}

/** Run the check with the caller's pure half, print every problem, post the status, and set the exit code. */
export async function runCla({ adapter, environment, evaluate, readSignatures, signaturesPath }) {
  const api = adapter ?? claContext(environment).adapter;
  const pr = await loadPullRequest(api, environment);
  const result = evaluate(pr, readSignatures(environment.get('CLA_SIGNATURES_FILE') ?? signaturesPath));
  if (result.problems.length) {
    process.stderr.write(result.problems.join('\n') + '\n');
    process.exitCode = 1;
  } else process.stdout.write('CLA satisfied for every commit author.\n');
  if (pr.live) await postStatus(api, pr, !result.problems.length, result.problems.length ? result.problems[0] : 'CLA satisfied', environment);
}
