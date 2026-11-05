/** Check outside contributors' author-matching DCO trailers against committed policy [C1,C7]. */
import { spawnSync } from './windows-child-process.js';
import {
  existsSync,
  readFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import {
  cleanGitEnvironment,
  refuseGrafts,
} from './git.js';
import { Refused } from './refused.js';

/** Read exact Git objects without inherited repository selectors or replacement objects. */
function gitResult(root, args) {
  return spawnSync('git', ['--no-replace-objects', ...args], {
    cwd: root, env: cleanGitEnvironment(), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
}

/** Refuse incomplete history rather than silently omitting a contributor's commit. */
function gitText(root, args) {
  const result = gitResult(root, args);
  if (result.status !== 0) throw new Refused('BAD_CONFIG', 'Restore the complete Git history and committed maintainer policy, then retry the sign-off check.');
  return result.stdout;
}

/** Local hooks use HEAD; CI supplies its trusted base object, never the contribution's policy. */
function maintainersAt(root, commit) {
  let config;
  try { config = JSON.parse(gitText(root, ['show', commit + ':pullboard.json'])); }
  catch (error) {
    if (error instanceof Refused) throw error;
    throw new Refused('BAD_CONFIG', 'Restore valid JSON in the committed pullboard.json before checking sign-offs.');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Refused('BAD_CONFIG', 'Restore an object in the trusted pullboard.json before checking sign-offs.');
  }
  if (config.maintainers === undefined) return null;
  if (!Array.isArray(config.maintainers) || config.maintainers.some(email =>
    typeof email !== 'string' || !email || email.trim() !== email || /[<>\u0000-\u001f\u007f]/u.test(email))) {
    throw new Refused('BAD_CONFIG', 'The trusted pullboard.json must contain maintainers as a list of exact author emails; ask the maintainer to correct the base branch.');
  }
  return config.maintainers;
}

/** A committer's trailer cannot certify a different author; email matching is exact. */
function signedByAuthor(message, author) {
  return message.split(/\r?\n/u).some(line => {
    const match = /^Signed-off-by:[\t ]+(.+?) <([^<>]+)>[\t ]*$/iu.exec(line);
    return match?.[1] === author.name && match?.[2] === author.email;
  });
}

/** Keep the missing-sign-off refusal to one line with the concrete fix [C1]. */
function signoffProblem(message, author, maintainers, commit = null) {
  if (maintainers.includes(author.email) || signedByAuthor(message, author)) return null;
  return 'pullboard sign-off: ' + (commit ? 'commit ' + commit.slice(0, 12) : 'this outside commit')
    + ' needs Signed-off-by matching its author; git commit --amend -s';
}

/** Check every new non-merge commit; a merge wrapper does not substitute for its parents. */
function rangeProblem(root, heads, base, maintainers) {
  refuseGrafts(root);
  const commits = gitText(root, ['rev-list', '--reverse', '--no-merges', ...heads, ...(base ? ['--not', base] : [])])
    .trim().split('\n').filter(Boolean);
  for (const commit of commits) {
    const [name, email, message] = gitText(root, ['show', '-s', '--format=%an%x00%ae%x00%B', commit]).split('\0');
    const problem = signoffProblem(message, { name, email }, maintainers, commit);
    if (problem) return { checked: commits.length, problem };
  }
  return { checked: commits.length, problem: null };
}

/** Apply this repository's opt-in policy before the ordinary message-format hook diagnostics. */
export function pendingCommitSignoffProblem(root, message) {
  const head = gitResult(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (head.status !== 0) return null; // The first commit has no committed policy yet.
  const commit = head.stdout.trim();
  const policyPath = gitText(root, ['ls-tree', '-z', commit, '--', 'pullboard.json']);
  if (!policyPath) return null;
  const maintainers = maintainersAt(root, commit);
  if (maintainers === null) return null; // Other repositories have no contribution policy enabled.
  const mergePath = resolve(root, gitText(root, ['rev-parse', '--git-path', 'MERGE_HEAD']).trim());
  if (existsSync(mergePath)) {
    const heads = readFileSync(mergePath, 'utf8').trim().split(/\s+/u);
    if (!heads.length || heads.some(head => !/^[0-9a-f]{40,64}$/u.test(head))) {
      throw new Refused('BAD_CONFIG', 'Restore the merge parents before checking contributor sign-offs.');
    }
    return rangeProblem(root, heads, commit, maintainers).problem;
  }
  const ident = gitText(root, ['var', 'GIT_AUTHOR_IDENT']).trim();
  const author = /^(.*) <([^<>]+)> \d+ [+-]\d{4}$/u.exec(ident);
  if (!author) throw new Refused('BAD_CONFIG', 'Set a valid Git author name and email before committing.');
  return signoffProblem(message, { name: author[1], email: author[2] }, maintainers);
}

/** Check a CI event's complete contribution range with the independently selected base policy. */
export function contributionSignoffProblem(root, { base, head }) {
  if (!/^[0-9a-f]{40,64}$/u.test(head ?? '') || /^0+$/u.test(head)
      || (base !== null && (!/^[0-9a-f]{40,64}$/u.test(base ?? '') || /^0+$/u.test(base)))) {
    throw new Refused('BAD_CONFIG', 'The sign-off check needs exact base and head commit ids from the CI event.');
  }
  const maintainers = base === null ? null : maintainersAt(root, base);
  if (maintainers === null) return { checked: 0, problem: null, policyInactive: true };
  return rangeProblem(root, [head], base, maintainers);
}
