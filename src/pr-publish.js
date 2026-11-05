/** Publish proven GitHub proposal branches without pushing or merging the protected trunk [B3,R3]. */
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from './windows-child-process.js';
import * as store from './board.js';
import {
  git,
  repoInfo,
  tryGit,
  cleanGitEnvironment,
  refuseGrafts,
} from './git.js';
import { runGate } from './gate.js';
import {
  githubPullClient,
  githubRepository,
} from './pr-github.js';
import {
  publishVerificationStatuses,
  verificationPulls,
} from './pr-verification.js';
import { Refused } from './refused.js';
import { handledReferences } from './reference-lines.js';

/** Keep publisher-local transport state distinct from the shared board and legacy push state. */
function statePath(root) { return join(repoInfo(root).commonDir, 'pullboard', 'publish-pr.json'); }

/** Recover only bounded local state; source identity is checked again before any push. */
function readState(root) {
  try {
    const value = JSON.parse(readFileSync(statePath(root), 'utf8'));
    if (value.version !== 1 || !Array.isArray(value.proposals)) throw new Error('unsupported publication state');
    if (value.proposals.some(p => !p || !Number.isSafeInteger(p.number) || p.number < 1 ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(p.repository ?? '') ||
      !/^pullboard\/(?:release|item-[0-9]+)-[a-f0-9]{12}$/u.test(p.branch ?? '') ||
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(p.head ?? '') ||
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(p.source ?? '') || !Array.isArray(p.entries) ||
      p.entries.some(e => !Number.isSafeInteger(e.id) || e.id < 1 || !Array.isArray(e.files)))) throw new Error('invalid proposal identity');
    return value;
  } catch (error) { if (error.code !== 'ENOENT') throw new Refused('PUBLISH_STATE', 'restore readable publish-pr.json or preserve it and ask the coordinator to recover the publication'); }
  return { version: 1, proposals: [] };
}

/** Atomically save non-secret proposal identities after each acknowledged provider action. */
function saveState(root, value) {
  const file = statePath(root);
  const temporary = file + '.' + randomUUID();
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600 });
  // Git's private directory shares a filesystem with its temporary state file.
  renameSync(temporary, file);
}

/** Read exact accepted items in first-parent merge order, never infer a verdict from a local gate. */
function releaseEntries(root, board, base, head) {
  const range = git(root, ['rev-list', '--first-parent', '--reverse', `${base}..${head}`]).split('\n');
  const byMerge = new Map(store.listItems(board, { all: true }).filter(i => i.item_status === 'verified' && i.item_merged_commit)
    .map(i => [i.item_merged_commit, i]));
  return range.flatMap(merge => {
    const item = byMerge.get(merge);
    if (!item) return [];
    const verdict = store.acceptedVerdict(board, item);
    if (!verdict) throw new Refused('PUBLISH_UNPROVEN', `item #${item.item_id} has no acceptance at its submitted commit; restore its recorded review before publishing`);
    return [{ id: item.item_id, merge, commit: item.item_commit, verdict: verdict.verdict_decision,
      reviewer: verdict.verdict_by, environment: verdict.environment ?? null,
      imported: verdict.imported ?? null, references: handledReferences(item.item_brief),
      files: git(root, ['diff', '--name-only', `${merge}^1`, merge]).split('\n').filter(Boolean) }];
  });
}

/** Project only receipt fields intended for a repository's PR; no criteria, local paths or session data. */
function receiptBody(head, entries) {
  return [`Pullboard publication head: ${head}`, '', 'Accepted item receipts:', ...entries.map(entry => {
    const env = entry.environment;
    const where = env ? `${env.platform}/${env.arch}, Node ${env.node}` : 'execution environment unknown (historical receipt)';
    const accepted = entry.imported
      ? `- #${entry.id}: ${entry.commit}; imported source ${entry.verdict} from ${entry.imported.sourceHandle}; source reviewer ${entry.reviewer}; moved by ${entry.imported.attestedBy} (not a destination-board review)`
      : `- #${entry.id}: ${entry.commit}; ${entry.verdict}; reviewer ${entry.reviewer}; ${where}`;
    const references = (entry.references ?? []).map(reference =>
      `  Reference: ${reference.target} @${reference.handle}`);
    return [accepted, ...references].join('\n');
  }), '', 'The whole project gate passed at the publication head before this branch was pushed.',
  'Item receipts certify their recorded accepted commits; they do not invent a second-agent verdict on this publication composition.',
  'Changes outside those item receipts remain unverified by a second agent.'].join('\n');
}

/** Compose only an item's landed patch into an isolated index; neither the caller's index nor trunk moves. */
function itemComposition(root, base, entries) {
  const directory = join(repoInfo(root).commonDir, 'pullboard', 'publish-index', randomUUID());
  mkdirSync(directory, { recursive: true });
  const env = { ...cleanGitEnvironment(), GIT_INDEX_FILE: join(directory, 'index') };
  try {
    git(root, ['read-tree', base], { env });
    for (const entry of entries) {
      const patch = spawnSync('git', ['--no-replace-objects', 'diff', '--binary', `${entry.merge}^1`, entry.merge],
        { cwd: root, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      if (patch.status !== 0) throw new Refused('PUBLISH_COMPOSITION', 'the accepted item patch cannot be read exactly; restore its Git objects before publishing');
      const applied = spawnSync('git', ['--no-replace-objects', 'apply', '--cached', '--3way', '-'],
        { cwd: root, env, input: patch.stdout, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      if (applied.status !== 0) throw new Refused('PUBLISH_COMPOSITION', 'the per-item publication patch conflicts with its base; ask the coordinator to compose the accepted repair before publishing');
    }
    const tree = git(root, ['write-tree'], { env });
    return git(root, ['commit-tree', tree, '-p', base, '-m', `chore(publish): compose items ${entries.map(e => e.id).join(',')}`]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

/** Compose the release with the actual remote base without altering local trunk history. */
function releaseComposition(root, base, head) {
  if (tryGit(root, ['merge-base', '--is-ancestor', base, head]).status === 0) return head;
  const merged = tryGit(root, ['merge-tree', '--write-tree', base, head]);
  if (merged.status !== 0) throw new Refused('PUBLISH_COMPOSITION', 'the remote trunk conflicts with local accepted work; merge the actual remote base normally before publishing');
  const tree = merged.stdout.split('\n')[0];
  return git(root, ['commit-tree', tree, '-p', base, '-p', head, '-m', 'chore(publish): compose proven release']);
}

/** Prove this exact immutable commit before pushing only its proposal ref. */
async function proveProposal({ root, config, remote, candidate, branch, onWait, onFailure }) {
  const directory = join(repoInfo(root).commonDir, 'pullboard', 'publish', randomUUID());
  mkdirSync(join(directory, '..'), { recursive: true });
  git(root, ['worktree', 'add', '--detach', directory, candidate]);
  try {
    const gate = await runGate(directory, config, { trustStamp: false, landing: true, agent: 'coordinator', onWait, onFailure });
    if (!gate.isGreen) return gate;
    const pushed = tryGit(directory, ['push', remote, `HEAD:refs/heads/${branch}`]);
    if (pushed.status !== 0) throw new Refused('LAND_PUSH', 'the proven proposal branch could not be pushed; inspect its remote history before publishing again');
    return gate;
  } finally {
    tryGit(root, ['worktree', 'remove', '--force', directory]);
    if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
  }
}

/** Bind failed check annotations to the exact publication head and implicated item paths. */
async function observeCI(client, proposal, repository, write) {
  const failures = new Map();
  const unknown = [];
  for (const run of client.checks(proposal.head)) {
    if (run.head_sha !== proposal.head || run.status !== 'completed' || !['failure', 'timed_out', 'action_required'].includes(run.conclusion)) continue;
    if (!Number.isSafeInteger(run.id) || run.id < 1 || typeof run.name !== 'string' || !run.name || /[\r\n\0]/u.test(run.name)) {
      throw new Refused('PUBLISH_GITHUB', 'the failing CI job lacks a valid provider run identity; inspect the provider response');
    }
    const files = [...new Set(client.annotations(run.id).filter(a => a.annotation_level === 'failure').map(a => a.path)
      .filter(p => typeof p === 'string' && !p.startsWith('/') && !p.includes('\\') && !p.split('/').includes('..')))];
    const affected = proposal.entries.filter(entry => entry.files.some(file => files.includes(file)));
    if (!affected.length) { unknown.push({ job: run.name, run: run.id }); continue; }
    for (const entry of affected) {
      const list = failures.get(entry.id) ?? [];
      list.push({ id: run.id, name: run.name, url: run.html_url ?? run.details_url ?? `https://github.com/${repository}/actions`,
        files: files.filter(file => entry.files.includes(file)) });
      failures.set(entry.id, list);
    }
  }
  const findings = [];
  for (const [item, jobs] of failures) findings.push(await write('recordPublishFinding', [{ agentId: 'coordinator',
    item, repository, pull: proposal.number, head: proposal.head, failures: jobs }]));
  return { findings, unattributed: unknown };
}

/** Record observed external facts; a recognized person label never becomes native person approval. */
async function observeMerge(root, board, proposal, pull, config, repository, write) {
  if (!pull.merged || pull.head?.sha !== proposal.head || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(pull.merge_commit_sha ?? '')) return null;
  const actor = pull.merged_by?.login;
  if (typeof actor !== 'string' || !/^[A-Za-z0-9-]{1,39}$/u.test(actor)) throw new Refused('PUBLISH_GITHUB', 'the merged PR lacks a valid provider actor; inspect it before recording a release');
  const recognizedPerson = pull.merged_by.type === 'User' && (config.approvers ?? []).some(login => login.toLowerCase() === actor.toLowerCase());
  const release = { type: 'github-release', repository, pull: proposal.number, url: `https://github.com/${repository}/pull/${proposal.number}`,
    head: proposal.head, merge: pull.merge_commit_sha, actor, recognizedPerson, personApproval: false };
  for (const entry of proposal.entries) {
    const exists = store.itemThread(board, entry.id).some(fact => fact.type === 'fact' && fact.text === JSON.stringify(release));
    if (!exists) await write('appendFact', [entry.id, { agentId: 'coordinator', kind: 'capture', text: JSON.stringify(release) }]);
  }
  return release;
}

/** Propose and reconcile one release PR or isolated per-item PRs; no path calls GitHub's merge endpoint. */
export async function publishPullRequests({ root, board, config, branch, remote, head, published, say, onWait, onFailure, write }) {
  if (typeof write !== 'function') throw new Refused('PUBLISH_STATE', 'PR publishing must run through the coordinator CLI so its findings and releases use ordered board moves');
  if (!published) throw new Refused('PUBLISH_GITHUB', 'create the remote base branch before enabling pull-request publishing');
  const fetched = tryGit(root, ['fetch', '--no-tags', remote, branch]);
  if (fetched.status !== 0 || git(root, ['rev-parse', 'FETCH_HEAD']) !== published) throw new Refused('PUBLISH_COMPOSITION', 'the remote base changed while preparing publication; inspect it and run publish again');
  const repository = githubRepository(root, remote);
  const client = githubPullClient(root, repository);
  const state = readState(root);
  // Validate graft and provider identities before any new publication side effect.
  refuseGrafts(root);
  verificationPulls(client, state, repository);
  const verification = [];
  let failed = false;
  try {
    const releases = [];
    const findings = [];
    const unattributed = [];
    for (const proposal of state.proposals.filter(p => p.repository === repository)) {
      const pull = client.read(proposal.number);
      if (pull.head?.sha !== proposal.head) throw new Refused('PUBLISH_STATE', 'a proposal branch changed outside its recorded publication; inspect the PR before publishing');
      if (pull.state === 'closed' && !pull.merged) throw new Refused('PUBLISH_STATE', 'the proposal was closed without merging; ask the coordinator whether to reopen it before publishing');
      const ci = await observeCI(client, proposal, repository, write);
      findings.push(...ci.findings); unattributed.push(...ci.unattributed);
      const released = proposal.released ? null : await observeMerge(root, board, proposal, pull, config, repository, write);
      if (released) {
        proposal.released = true; releases.push(released);
        say(`recorded PR #${proposal.number} merge by ${released.actor} (${released.recognizedPerson ? 'recognized person' : 'not a recognized person'}); no native person approval recorded`);
      }
    }
    await saveState(root, state);
    const releasedItems = new Set(state.proposals.filter(p => p.released).flatMap(p => p.entries.map(e => `${e.id}:${e.commit}`)));
    const entries = releaseEntries(root, board, published, head).filter(e => !releasedItems.has(`${e.id}:${e.commit}`));
    if (tryGit(root, ['merge-base', '--is-ancestor', head, published]).status === 0) return { head, published: true, red: [], releases, findings, unattributed, verification };
    const digest = createHash('sha256').update(branch).digest('hex').slice(0, 12);
    const repairRoots = new Map(store.events(board).filter(e => e.event_kind === 'pr-ci-finding').map(e => {
      const detail = JSON.parse(e.event_detail); return [detail.repair, detail.item];
    }));
    const groups = config.publish.pullRequest === 'item' ? [...new Set(entries.map(e => repairRoots.get(e.id) ?? e.id))]
      .map(id => ({ key: `item-${id}`, entries: entries.filter(e => (repairRoots.get(e.id) ?? e.id) === id) })) : [{ key: 'release', entries }];
    const proposed = [];
    if (!groups.length) return { head, published: false, waiting: true, red: [], releases, findings, unattributed, verification,
      reason: 'No unpublished accepted item remains; per-item mode does not certify unrelated local commits.' };
    for (const group of groups) {
      const name = `pullboard/${group.key}-${digest}`;
      const old = state.proposals.findLast(p => p.repository === repository && p.branch === name && !p.released);
      if (old?.source === head) { proposed.push(old); continue; }
      const added = group.entries.filter(entry => !old?.entries.some(e => e.merge === entry.merge));
      if (old && config.publish.pullRequest === 'item' && !added.length) { proposed.push(old); continue; }
      const candidate = config.publish.pullRequest === 'item'
        ? itemComposition(root, old?.head ?? published, added) : releaseComposition(root, published, head);
      const gate = await proveProposal({ root, config, remote, candidate, branch: name, onWait, onFailure });
      if (!gate.isGreen) return { head, published: false, red: [{ file: null, name: 'publication whole gate failed', items: group.entries.map(e => e.id) }], findings, unattributed };
      const body = receiptBody(candidate, group.entries);
      const title = `Pullboard ${group.key === 'release' ? 'release' : group.key}`;
      const existing = old ?? client.list(name)[0];
      const pull = existing ? client.update(existing.number, { title, body }) : client.create({ title, body, head: name, base: branch });
      if (!Number.isSafeInteger(pull.number) || pull.number < 1 || pull.head?.sha !== candidate) throw new Refused('PUBLISH_GITHUB', 'the PR response does not name the exact proven publication head; inspect it before continuing');
      const proposal = { repository, branch: name, source: head, head: candidate, number: pull.number,
        url: `https://github.com/${repository}/pull/${pull.number}`, entries: group.entries, released: false };
      if (old) state.proposals.splice(state.proposals.indexOf(old), 1, proposal); else state.proposals.push(proposal);
      await saveState(root, state); proposed.push(proposal);
    }
    say(`proposed ${proposed.length} pull request(s); only a person can merge them`);
    return { head, published: false, waiting: true, proposed: true, pullRequests: proposed.map(p => ({ number: p.number, url: p.url, head: p.head, items: p.entries.map(e => e.id) })), red: [], releases, findings, unattributed, verification };
  } catch (error) { failed = true; throw error; }
  finally {
    // One final pass sees every proposed PR. Returned objects retain this same result array.
    if (!failed) verification.push(...publishVerificationStatuses({ root, board, client, state, repository, trustedHead: head }));
    else {
      try { publishVerificationStatuses({ root, board, client, state, repository, trustedHead: head }); }
      catch { /* Preserve the publication failure, rather than hide it behind a later provider error. */ }
    }
  }
}
