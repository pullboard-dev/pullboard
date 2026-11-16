#!/usr/bin/env node
/** Check that every commit author on a pull request agreed to CLA.md by listing or by one PR comment [C7]. */
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export const SENTENCE = 'I have read CLA.md and I agree to it.';
const SIGNATURES = '.github/cla-signatures.json';
// The one HTTP client of this check, named once so every GitHub call below reads as a plain call [P5].
const send = fetch;

/**
 * Read the signatures file: `{exempt: [login], signatures: [{login, id, comment_url, agreed_at, cla_sha256}]}`.
 * A missing file means nobody has signed and nobody is exempt, so the check fails closed.
 */
export function readSignatures(path = resolve(SIGNATURES)) {
  const data = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  return { exempt: data.exempt ?? [], signatures: data.signatures ?? [] };
}

/**
 * Read `Co-authored-by` trailers from a commit message as `{name, email, id, login}`.
 * A GitHub noreply address (`12345+login@users.noreply.github.com`) carries the numeric user id and login;
 * any other address leaves them null [C7].
 */
export function coAuthors(message) {
  const found = [];
  for (const line of String(message ?? '').split(/\r?\n/u)) {
    const match = /^\s*co-authored-by:\s*(.*?)\s*<([^<>\s]+)>\s*$/iu.exec(line);
    if (!match) continue;
    const noreply = /^(?:(\d+)\+)?([^@+\s]+)@users\.noreply\.github\.com$/iu.exec(match[2]);
    found.push({ name: match[1], email: match[2], id: noreply?.[1] ?? null, login: noreply?.[2] ?? null });
  }
  return found;
}

/**
 * Decide the check for one pull request from plain data, so tests need no network.
 * `pr` is `{commits: [{sha, login, id, message, parents}], comments: [{login, user_id, body, url, created_at, id}]}`.
 * A person is the numeric user id when both sides carry one, so a renamed login still matches and a reused login does not;
 * the lowercased login decides only when an id is missing. Co-authors on a commit are checked like authors.
 * Returns the problems (empty when passing) and the new signers a landing must record.
 */
export function evaluate(pr, signatureFile) {
  const lower = (value) => String(value ?? '').toLowerCase();
  const exempt = new Set(signatureFile.exempt.map(lower));
  const same = (person, other) => (person.id != null && other.id != null ? String(person.id) === String(other.id) : lower(person.login) === lower(other.login));
  const problems = [];
  const newSigners = [];
  const missing = [];
  const seen = [];
  /** Check one person once; `where` names them in a refusal that cannot resolve a login. */
  const check = (person, where) => {
    if (!person.login) {
      problems.push(`${where} has no GitHub login. Use an email linked to your GitHub account (a noreply address works), then push again.`);
      return;
    }
    if (exempt.has(lower(person.login)) || signatureFile.signatures.some((entry) => same(person, entry))) return;
    if (seen.some((other) => same(person, other))) return;
    seen.push(person);
    const comment = pr.comments.find((entry) => same(person, { id: entry.user_id, login: entry.login }) && String(entry.body ?? '').trim() === SENTENCE);
    if (comment) newSigners.push({ login: person.login, comment });
    else missing.push(person.login);
  };
  for (const commit of pr.commits) {
    if ((commit.parents ?? []).length > 1) continue;
    check({ login: commit.login, id: commit.id }, `The author of commit ${String(commit.sha).slice(0, 8)}`);
    for (const co of coAuthors(commit.message)) check(co, `Co-author ${co.name} <${co.email}> on commit ${String(commit.sha).slice(0, 8)}`);
  }
  for (const login of missing) problems.push(`${login} has not agreed to CLA.md. ${login}: post this sentence as a comment on this pull request: ${SENTENCE}`);
  return { problems, newSigners };
}

/**
 * Append one entry per new signer to the signatures file at a landing; `claText` is CLA.md at the PR base.
 * Existing logins are skipped so a later PR never duplicates an entry.
 */
export function appendSignatures(path, newSigners, claText, now = new Date().toISOString()) {
  const file = readSignatures(path);
  const have = new Set(file.signatures.map((entry) => entry.login.toLowerCase()));
  const sha = createHash('sha256').update(claText).digest('hex');
  for (const { login, comment } of newSigners) {
    if (have.has(login.toLowerCase())) continue;
    file.signatures.push({ login, id: comment.user_id ?? null, comment_url: comment.url, agreed_at: comment.created_at ?? now, cla_sha256: sha });
  }
  writeFileSync(path, JSON.stringify(file, null, 2) + '\n');
  return file;
}

/** Fetch every page of one GitHub API list with the workflow token. */
async function pages(url, headers) {
  const all = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await send(`${url}${url.includes('?') ? '&' : '?'}per_page=100&page=${page}`, { headers });
    if (!response.ok) throw new Error(`GitHub API ${response.status} for ${url}`);
    const batch = await response.json();
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

/** Load the pull request's commits and comments from the event, or from a fixture file for tests. */
async function loadPullRequest() {
  if (process.env.CLA_PR_FILE) return { ...JSON.parse(readFileSync(process.env.CLA_PR_FILE, 'utf8')), live: false };
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const number = event.pull_request?.number ?? event.issue?.number;
  const api = `${process.env.GITHUB_API_URL ?? 'https://api.github.com'}/repos/${process.env.GITHUB_REPOSITORY}`;
  const headers = { accept: 'application/vnd.github+json', authorization: `Bearer ${process.env.GITHUB_TOKEN}` };
  const commits = (await pages(`${api}/pulls/${number}/commits`, headers)).map((c) => ({ sha: c.sha, login: c.author?.login ?? null, id: c.author?.id ?? null, message: c.commit?.message ?? '', parents: c.parents ?? [] }));
  const comments = (await pages(`${api}/issues/${number}/comments`, headers)).map((c) => ({ id: c.id, user_id: c.user?.id, login: c.user?.login, body: c.body, url: c.html_url, created_at: c.created_at }));
  let head = event.pull_request?.head?.sha;
  if (!head) head = (await (await send(`${api}/pulls/${number}`, { headers })).json()).head.sha;
  return { commits, comments, live: true, api, headers, head };
}

/** Post the CLA commit status on the PR head; failing to post (a fork's read-only token) never hides the exit code. */
async function postStatus(pr, ok, description) {
  if (!pr.live) return;
  try {
    await send(`${pr.api}/statuses/${pr.head}`, {
      method: 'POST', headers: pr.headers,
      body: JSON.stringify({ state: ok ? 'success' : 'failure', context: 'CLA', description: description.slice(0, 140) }),
    });
  } catch { /* the job result still reports */ }
}

/** Run the check, print every problem, and set the exit code. */
async function main() {
  const pr = await loadPullRequest();
  const result = evaluate(pr, readSignatures(process.env.CLA_SIGNATURES_FILE ?? resolve(SIGNATURES)));
  if (result.problems.length) {
    process.stderr.write(result.problems.join('\n') + '\n');
    process.exitCode = 1;
  } else process.stdout.write('CLA satisfied for every commit author.\n');
  await postStatus(pr, !result.problems.length, result.problems.length ? result.problems[0] : 'CLA satisfied');
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  main().catch((error) => {
    process.stderr.write('pullboard CLA: ' + String(error.message).replace(/[\r\n]+/gu, ' ') + '\n');
    process.exitCode = 1;
  });
}
