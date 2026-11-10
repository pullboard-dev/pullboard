import { mainPolicy } from '../../../sandbox/index.js';
import { outsideSensitivity } from '../../../items/index.js';
/** Read GitHub public source metadata; never post, execute PR programs or use its executable settings. */
import { githubPullClient } from './pr.js';
import { Refused } from '../../../kernel/index.js';
import { git } from '../../../git/index.js';

/** Recognize one public GitHub issue or pull URL without allowing arbitrary API/fetch endpoints. */
export function outsideURL(value) {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(pull|issues)\/([1-9][0-9]*)\/?$/u.exec(value ?? '');
  if (!match || !Number.isSafeInteger(Number(match[3]))) throw new Refused('OUTSIDE_URL', 'use a GitHub pull request or issue URL: pullboard intake https://github.com/owner/repo/pull/123');
  return { repository: match[1], kind: match[2] === 'pull' ? 'pull-request' : 'issue', number: Number(match[3]) };
}

/** Fetch exact PR objects using Git only; preserve author and sign-off by never rewriting its commit. */
export function githubSource(root, url) {
  const source = outsideURL(url);
  const client = githubPullClient(root, source.repository);
  const data = source.kind === 'pull-request' ? client.read(source.number) : client.readIssue(source.number);
  const comments = client.comments(source.number);
  const reviews = source.kind === 'pull-request' ? client.reviews(source.number) : [];
  const replies = [...(Array.isArray(comments) ? comments : []), ...(Array.isArray(reviews) ? reviews : [])];
  const common = { ...source, url, title: String(data.title ?? ''), author: data.user?.login, state: data.state,
    maintainerReplied: replies.some(comment => ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(comment.author_association)), updatedAt: data.updated_at };
  if (source.kind === 'issue') return common;
  if (!/^[a-f0-9]{40}$/u.test(data.head?.sha ?? '') || !/^[a-f0-9]{40}$/u.test(data.base?.sha ?? '')) throw new Refused('OUTSIDE_FETCH', 'GitHub did not return exact commit IDs; read the pull request again');
  const files = client.files(source.number);
  if (!Array.isArray(files) || files.length >= 100) throw new Refused('OUTSIDE_FETCH', 'this pull request needs a complete bounded changed-file list; split it below 100 files before intake');
  // The server-owned pull ref, rather than the contributor-controlled clone URL, supplies objects.
  git(root, ['fetch', '--no-tags', '--no-recurse-submodules', `https://github.com/${source.repository}.git`, `refs/pull/${source.number}/head`]);
  const fetched = git(root, ['rev-parse', 'FETCH_HEAD^{commit}']).trim();
  if (fetched !== data.head.sha) throw new Refused('OUTSIDE_HEAD_CHANGED', 'the pull request moved while intake fetched it; read and intake its new exact head');
  const paths = [...new Set(files.flatMap(file => [file.filename, ...(file.previous_filename ? [file.previous_filename] : [])]))];
  if (paths.some(path => typeof path !== 'string' || path.includes('\n') || path.startsWith('/') || path.split('/').includes('..'))) throw new Refused('OUTSIDE_FETCH', 'GitHub returned an invalid changed path; restore its file metadata');
  const changed = git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', `${data.base.sha}...${fetched}`]).split('\0').filter(Boolean);
  if (changed.length !== paths.length || changed.some(path => !paths.includes(path))) throw new Refused('OUTSIDE_FETCH', 'the changed-file list differs from the fetched exact commit; refresh GitHub metadata');
  const sensitivity = outsideSensitivity(root, data.base.sha, fetched, paths, { mainPolicy });
  return { ...common, commit: fetched, tree: git(root, ['rev-parse', `${fetched}^{tree}`]).trim(), base: data.base.sha, files: paths, sensitivity, sensitive: sensitivity.length > 0 };
}
