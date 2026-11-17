/** Stateful in-memory Git reads for logic tests; unsupported commands fail instead of using Git [C7]. */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

/** Explicitly reject unmodelled behavior; the fake never falls back to a process or filesystem. */
function unsupported(message) {
  const error = new Error(`In-memory Git does not support ${message}; extend the shared contract first`);
  error.code = 'GIT_ADAPTER_UNSUPPORTED';
  throw error;
}

/** Compute an actual SHA-1 blob identity from bytes, rather than treating content as an arbitrary label. */
function blobId(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** Git folds section and variable case but preserves subsection case, such as remote.Upstream.url. */
function configKey(key) {
  const parts = key.split('.');
  parts[0] = parts[0].toLowerCase();
  parts[parts.length - 1] = parts.at(-1).toLowerCase();
  return parts.join('.');
}

/** Read command-scope config without mutating local settings; this includes the ordinary test runner. */
function environmentConfig(env = {}) {
  const values = new Map();
  if (env.GIT_CONFIG_COUNT === undefined) return values;
  if (!/^(?:0|[1-9]\d*)$/u.test(env.GIT_CONFIG_COUNT)) unsupported('invalid GIT_CONFIG_COUNT');
  const count = Number(env.GIT_CONFIG_COUNT);
  if (!Number.isSafeInteger(count) || count > Object.keys(env).length) unsupported('incomplete command config');
  for (let index = 0; index < count; index += 1) {
    const key = env[`GIT_CONFIG_KEY_${index}`];
    const value = env[`GIT_CONFIG_VALUE_${index}`];
    if (typeof key !== 'string' || typeof value !== 'string') unsupported('incomplete command config');
    if (!/^(?:user|gc|maintenance|pullboard|remote)\./iu.test(key)) unsupported(`command config ${key}`);
    values.set(configKey(key), value);
  }
  return values;
}

/** Copy a seeded commit and its files so callers cannot mutate repository state behind the adapter. */
function copyCommit(commit) {
  if (!/^[a-f\d]{40}$/u.test(commit.oid) || !/^[a-f\d]{40}$/u.test(commit.tree)) {
    throw new TypeError('In-memory Git commits need full SHA-1 commit and tree identities');
  }
  return { ...commit, parents: [...(commit.parents ?? [])], files: new Map(Object.entries(commit.files ?? {})
    .map(([path, bytes]) => [path, Buffer.from(bytes)])) };
}

/** Resolve a seeded ref, full object identity, parent suffix or commit/tree peel without real Git. */
function revision(repo, value) {
  const peeled = /\^\{(commit|tree)\}$/u.exec(value);
  const name = peeled ? value.slice(0, -peeled[0].length) : value;
  const parent = /\^[1-9]?$/u.exec(name);
  const plain = parent ? name.slice(0, -parent[0].length) : name;
  let oid = plain === 'HEAD' ? (repo.branch ? repo.refs.get(repo.branch) : repo.head)
    : repo.refs.get(plain) ?? repo.refs.get(`refs/heads/${plain}`) ?? (repo.commits.has(plain) ? plain : null);
  if (parent) oid = repo.commits.get(oid)?.parents[Number(parent[0].slice(1) || 1) - 1] ?? null;
  const commit = repo.commits.get(oid);
  return commit ? { oid: peeled?.[1] === 'tree' ? commit.tree : oid, commit, type: peeled?.[1] === 'tree' ? 'tree' : 'commit' } : null;
}

/** Resolve committed files and blob objects from the same state as revision lookups. */
function object(repo, value) {
  const colon = value.indexOf(':');
  if (colon !== -1) {
    const commit = revision(repo, value.slice(0, colon))?.commit;
    const bytes = commit?.files.get(value.slice(colon + 1));
    return bytes ? { oid: blobId(bytes), type: 'blob', bytes } : null;
  }
  const ref = revision(repo, value);
  if (ref) return ref;
  for (const commit of repo.commits.values()) {
    if (commit.tree === value) return { oid: value, type: 'tree' };
    for (const bytes of commit.files.values()) if (blobId(bytes) === value) return { oid: value, type: 'blob', bytes };
  }
  return null;
}

/** Compare Git path names by bytes, matching Git's ordinary tree ordering for flat fixture paths. */
function pathOrder(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

/** Walk a seeded commit graph, including the tip itself. */
function ancestors(repo, tip) {
  const seen = new Set();
  const pending = [tip];
  while (pending.length) {
    const next = pending.pop();
    if (!next || seen.has(next)) continue;
    seen.add(next);
    pending.push(...(repo.commits.get(next)?.parents ?? []));
  }
  return seen;
}


/** Hash a git object the way git does, so a stand-in commit has the same id real git gives it. */
function objectId(type, body) {
  return createHash('sha1').update(`${type} ${body.length}\0`).update(body).digest('hex');
}

/** Build the tree id for committed files (all mode 100644), nesting directories as git does. */
function treeId(files) {
  const build = entries => {
    const dirs = new Map();
    const items = [];
    for (const [parts, bytes] of entries) {
      if (parts.length === 1) items.push({ name: parts[0], mode: '100644', id: blobId(bytes), sort: parts[0] });
      else dirs.set(parts[0], [...dirs.get(parts[0]) ?? [], [parts.slice(1), bytes]]);
    }
    for (const [name, inner] of dirs) items.push({ name, mode: '40000', id: build(inner), sort: `${name}/` });
    items.sort((a, b) => pathOrder(a.sort, b.sort));
    return objectId('tree', Buffer.concat(items.map(i => Buffer.concat([Buffer.from(`${i.mode} ${i.name}\0`), Buffer.from(i.id, 'hex')]))));
  };
  return build([...files].map(([path, bytes]) => [path.split('/'), bytes]));
}

/** True when two path-to-bytes maps hold the same files. */
function sameFiles(left, right) {
  return left.size === right.size && [...left].every(([path, bytes]) => right.get(path)?.equals(bytes));
}

/** The files at HEAD, or none on an unborn branch. */
function headFiles(repo) {
  return revision(repo, 'HEAD')?.commit.files ?? new Map();
}

/** Identity and pinned date for a commit: environment first, then user.* config; a clock is never guessed. */
function signature(repo, env, commandConfig, who) {
  const name = env[`GIT_${who}_NAME`] ?? commandConfig.get('user.name') ?? repo.config.get('user.name');
  const email = env[`GIT_${who}_EMAIL`] ?? commandConfig.get('user.email') ?? repo.config.get('user.email');
  const date = env[`GIT_${who}_DATE`];
  if (!name || !email) unsupported('a commit without an identity');
  if (!/^\d+ [+-]\d{4}$/u.test(date ?? '')) unsupported(`a commit without GIT_${who}_DATE in "<seconds> <zone>" form`);
  return `${name} <${email}> ${date}`;
}

/** Record a commit on the current branch (or detached HEAD) and make index and worktree match it. */
function recordCommit(repo, env, commandConfig, files, parents, message) {
  const tree = treeId(files);
  const body = `tree ${tree}\n${parents.map(parent => `parent ${parent}\n`).join('')}author ${signature(repo, env, commandConfig, 'AUTHOR')}\ncommitter ${signature(repo, env, commandConfig, 'COMMITTER')}\n\n${message}\n`;
  const oid = objectId('commit', Buffer.from(body));
  repo.commits.set(oid, copyCommit({ oid, tree, parents, files: Object.fromEntries(files) }));
  if (repo.branch) repo.refs.set(repo.branch, oid); else repo.head = oid;
  repo.index = new Map(files);
  repo.work = new Map(files);
  return oid;
}

/** Point the index and worktree at a commit; only a clean tree may move, so no dirty-file rule is modelled. */
function checkOut(repo, oid) {
  const files = repo.commits.get(oid).files;
  repo.index = new Map(files);
  repo.work = new Map(files);
}

/** Refuse to move or merge over local changes; real git sometimes allows it, the stand-in never guesses. */
function requireClean(repo, what) {
  const files = headFiles(repo);
  if (!sameFiles(repo.index, files) || !sameFiles(repo.work, files)) unsupported(`${what} with uncommitted changes`);
}

/** The single best common ancestor of two commits; criss-cross histories are not modelled. */
function mergeBase(repo, left, right) {
  const common = [...ancestors(repo, left)].filter(oid => ancestors(repo, right).has(oid));
  const best = common.filter(oid => !common.some(other => other !== oid && ancestors(repo, other).has(oid)));
  if (best.length !== 1) unsupported('merging histories without exactly one merge base');
  return best[0];
}

/** Apply the write commands journeys script, spelled exactly as the fixtures spell them; undefined when not one. */
function mutate(repo, command, rest, env, commandConfig) {
  if (command === 'config' && rest.length === 2 && !rest[0].startsWith('-')) { repo.config.set(configKey(rest[0]), rest[1]); return outcome(); }
  if (command === 'add') {
    if (rest.length !== 1 || rest[0] !== '-A') unsupported(`add ${rest.join(' ')}`);
    repo.index = new Map(repo.work);
    return outcome();
  }
  if (command === 'commit') {
    if (rest.length !== 3 || rest[0] !== '-q' || rest[1] !== '-m') unsupported(`commit ${rest.join(' ')}`);
    if (sameFiles(repo.index, headFiles(repo))) return outcome(1, 'nothing to commit\n');
    const parent = revision(repo, 'HEAD')?.oid;
    recordCommit(repo, env, commandConfig, repo.index, parent ? [parent] : [], rest[2]);
    return outcome();
  }
  if (command === 'branch') {
    if (rest.length === 1 && rest[0] === '--show-current') return outcome(0, repo.branch ? `${repo.branch.replace(/^refs\/heads\//u, '')}\n` : '');
    if (rest.length !== 1 || rest[0].startsWith('-')) unsupported(`branch ${rest.join(' ')}`);
    const tip = revision(repo, 'HEAD');
    if (!tip) return outcome(128, '', 'fatal: not a valid object name\n');
    if (repo.refs.has(`refs/heads/${rest[0]}`)) return outcome(128, '', 'fatal: a branch with that name already exists\n');
    repo.refs.set(`refs/heads/${rest[0]}`, tip.oid);
    return outcome();
  }
  if (command === 'switch') {
    const words = rest.filter(word => word !== '-q');
    requireClean(repo, 'switch');
    if (words.length === 2 && words[0] === '--detach') {
      const found = revision(repo, words[1]);
      if (!found || found.type !== 'commit') return outcome(128, '', 'fatal: invalid reference\n');
      repo.branch = null; repo.head = found.oid; checkOut(repo, found.oid);
      return outcome();
    }
    if (words.length === 2 && words[0] === '-c') {
      const tip = revision(repo, 'HEAD');
      if (!tip || repo.refs.has(`refs/heads/${words[1]}`)) return outcome(128, '', 'fatal: cannot create branch\n');
      repo.refs.set(`refs/heads/${words[1]}`, tip.oid); repo.branch = `refs/heads/${words[1]}`;
      return outcome();
    }
    if (words.length !== 1 || words[0].startsWith('-')) unsupported(`switch ${rest.join(' ')}`);
    const oid = repo.refs.get(`refs/heads/${words[0]}`);
    if (!oid) return outcome(128, '', 'fatal: invalid reference\n');
    repo.branch = `refs/heads/${words[0]}`; checkOut(repo, oid);
    return outcome();
  }
  if (command === 'merge') {
    const fastForwardOnly = rest.includes('--ff-only');
    const words = rest.filter(word => !['-q', '--ff-only', '--no-edit'].includes(word));
    if (words.length !== 1 || words[0].startsWith('-') || !fastForwardOnly && !rest.includes('--no-edit')) unsupported(`merge ${rest.join(' ')}`);
    requireClean(repo, 'merge');
    const ours = revision(repo, 'HEAD');
    const theirs = revision(repo, words[0]);
    if (!ours || !theirs || theirs.type !== 'commit') return outcome(128, '', 'fatal: not something we can merge\n');
    if (ancestors(repo, ours.oid).has(theirs.oid)) return outcome();
    if (ancestors(repo, theirs.oid).has(ours.oid)) {
      if (repo.branch) repo.refs.set(repo.branch, theirs.oid); else repo.head = theirs.oid;
      checkOut(repo, theirs.oid);
      return outcome();
    }
    if (fastForwardOnly) return outcome(128, '', 'fatal: Not possible to fast-forward, aborting.\n');
    const base = repo.commits.get(mergeBase(repo, ours.oid, theirs.oid)).files;
    const merged = new Map();
    const same = (a, b) => a === undefined ? b === undefined : b !== undefined && a.equals(b);
    for (const path of new Set([...base.keys(), ...ours.commit.files.keys(), ...theirs.commit.files.keys()])) {
      const [was, mine, yours] = [base.get(path), ours.commit.files.get(path), theirs.commit.files.get(path)];
      const pick = same(mine, yours) || same(was, yours) ? mine : same(was, mine) ? yours : unsupported(`a merge that changes ${path} on both sides`);
      if (pick) merged.set(path, pick);
    }
    const current = repo.branch?.replace(/^refs\/heads\//u, '');
    const named = words[0].replace(/^refs\/heads\//u, '');
    recordCommit(repo, env, commandConfig, merged, [ours.oid, theirs.oid],
      `Merge branch '${named}'${current && current !== 'main' && current !== 'master' ? ` into ${current}` : ''}`);
    return outcome();
  }
  return undefined;
}

/** The checkout whose `.git` folder holds the shared objects and refs: the repository itself, or the one a linked worktree hangs off. */
function mainOf(repo) {
  return repo.common ?? repo;
}

/** The common git folder as `rev-parse --git-common-dir` prints it: relative at the top of the main checkout, absolute in a linked worktree. */
function commonDir(repo, absolute) {
  const main = mainOf(repo);
  return repo.common || absolute ? `${main.root}/.git` : '.git';
}

/** Every checkout of one repository, the main one first, then linked worktrees by folder name, the order real Git reads its admin folders in. */
function checkouts(repo) {
  const main = mainOf(repo);
  const name = tree => tree.root.slice(tree.root.lastIndexOf('/') + 1);
  return [main, ...[...main.linked].sort((a, b) => (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0))];
}

/** `git worktree add [-q] [--detach] [-b <branch>] <path> [<commit-ish>]` and `list --porcelain [-z]`; anything else is refused. */
function worktree(repositories, repo, rest, cwd) {
  const [verb, ...words] = rest;
  if (verb === 'list') {
    const flags = words.filter(word => word === '--porcelain' || word === '-z');
    if (!words.includes('--porcelain') || flags.length !== words.length) unsupported(`worktree list ${words.join(' ')}`);
    const end = words.includes('-z') ? '\0' : '\n';
    return outcome(0, checkouts(repo).map(one => {
      const head = revision(one, 'HEAD')?.oid ?? '0'.repeat(40);
      return [`worktree ${one.root}`, `HEAD ${head}`, one.branch ? `branch ${one.branch}` : 'detached'].map(line => line + end).join('') + end;
    }).join(''));
  }
  if (verb !== 'add') unsupported(`worktree ${rest.join(' ')}`);
  let detach = false;
  let branch = null;
  const names = [];
  for (let index = 0; index < words.length; index += 1) {
    if (words[index] === '-q') continue;
    if (words[index] === '--detach') detach = true;
    else if (words[index] === '-b' && words[index + 1] && !words[index + 1].startsWith('-')) { index += 1; branch = words[index]; }
    else if (words[index].startsWith('-')) unsupported(`worktree add ${words[index]}`);
    else names.push(words[index]);
  }
  if (!names.length || names.length > 2 || detach && branch) unsupported(`worktree add ${words.join(' ')}`);
  const path = resolve(cwd, names[0]);
  if (repositories.has(path)) return outcome(128, '', `fatal: '${path}' already exists\n`);
  const found = revision(repo, names[1] ?? 'HEAD');
  if (!found || found.type !== 'commit') return outcome(128, '', 'fatal: invalid reference\n');
  const main = mainOf(repo);
  if (branch && main.refs.has(`refs/heads/${branch}`)) return outcome(255, '', `fatal: a branch named '${branch}' already exists\n`);
  if (!branch && !detach) unsupported('worktree add without --detach or -b');
  if (branch) main.refs.set(`refs/heads/${branch}`, found.oid);
  const files = found.commit.files;
  const added = { root: path, branch: branch ? `refs/heads/${branch}` : null, head: found.oid, commits: main.commits, refs: main.refs,
    config: main.config, common: main, linked: [], index: new Map(files), work: new Map(files) };
  main.linked.push(added);
  repositories.set(path, added);
  return outcome();
}

/** `git remote add <name> <url>` and `get-url <name>`, kept as the remote.<name>.url settings real Git writes. */
function remote(repo, rest) {
  const [verb, name, url] = rest;
  const key = `remote.${name}.url`;
  if (verb === 'add' && rest.length === 3 && !name.startsWith('-')) {
    if (repo.config.has(configKey(key))) return outcome(3, '', `error: remote ${name} already exists.\n`);
    repo.config.set(configKey(key), url);
    repo.config.set(configKey(`remote.${name}.fetch`), `+refs/heads/*:refs/remotes/${name}/*`);
    return outcome();
  }
  if (verb === 'get-url' && rest.length === 2 && !name.startsWith('-')) {
    const saved = repo.config.get(configKey(key));
    return saved === undefined ? outcome(2, '', `error: No such remote '${name}'\n`) : outcome(0, `${saved}\n`);
  }
  unsupported(`remote ${rest.join(' ')}`);
}

/** Parse only the explicitly contracted global flags; unknown flags cannot silently change semantics. */
function commandArgs(args, options) {
  const words = [...args];
  let cwd = options.cwd;
  while (words[0]?.startsWith('-')) {
    if (['--no-replace-objects', '--no-optional-locks'].includes(words[0])) words.shift();
    else if (words[0] === '-C') { words.shift(); cwd = resolve(cwd ?? '.', words.shift()); }
    else if (words[0] === '-c' && ['core.quotepath=false', 'gc.auto=0'].includes(words[1])) words.splice(0, 2); // gc.auto=0 is in the shared GIT_FLAGS; it has no effect on an in-memory repo
    else unsupported(`global option ${words[0]}`);
  }
  return { words, cwd: resolve(cwd ?? '.') };
}

/** Return a Git-like command outcome with bytes; Node transport shaping happens in one place below. */
function outcome(status = 0, stdout = '', stderr = '') {
  return { status, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
}

/** Apply the supported read and config/ref mutation commands to the in-memory repository. */
function execute(repositories, repo, args, commandConfig, env = {}) {
  const [command, ...rest] = args;
  const written = mutate(repo, command, rest, env, commandConfig);
  if (written) return written;
  if (command === 'rev-parse') {
    if (rest.length === 1 && rest[0] === '--show-toplevel') return outcome(0, `${repo.root}\n`);
    if (rest.length === 1 && rest[0] === '--is-shallow-repository') return outcome(0, 'false\n');
    if (rest.some(word => word === '--git-common-dir' || word.startsWith('--path-format='))) {
      let absolute = false;
      const lines = [];
      for (const word of rest) {
        if (word === '--path-format=absolute') absolute = true;
        else if (word === '--path-format=relative') absolute = false;
        else if (word === '--git-common-dir') lines.push(commonDir(repo, absolute));
        else if (word === '--show-toplevel') lines.push(repo.root);
        else if (word.startsWith('-')) unsupported(`rev-parse ${rest.join(' ')}`);
        else {
          const found = revision(repo, word);
          if (!found) return outcome(128, '', 'fatal: revision not found\n');
          lines.push(found.oid);
        }
      }
      return outcome(0, lines.map(line => `${line}\n`).join(''));
    }
    const names = rest.filter(word => !['--verify', '--quiet'].includes(word));
    if (!names.length || names.some(word => word.startsWith('-')) || rest.includes('--verify') && names.length > 1) unsupported(`rev-parse ${rest.join(' ')}`);
    const found = names.map(name => revision(repo, name)); // several names print one line each, as `git rev-parse a b` does (#6486)
    return found.every(Boolean) ? outcome(0, found.map(one => `${one.oid}\n`).join('')) : outcome(rest.includes('--quiet') ? 1 : 128, '', 'fatal: revision not found\n');
  }
  if (command === 'worktree') return worktree(repositories, repo, rest, repo.root);
  if (command === 'remote') return remote(repo, rest);
  if (command === 'symbolic-ref') {
    if (rest.at(-1) !== 'HEAD' || rest.slice(0, -1).some(word => !['--quiet', '-q', '--short'].includes(word))) unsupported(`symbolic-ref ${rest.join(' ')}`);
    if (!repo.branch) return outcome(1);
    return outcome(0, `${rest.includes('--short') ? repo.branch.replace(/^refs\/heads\//u, '') : repo.branch}\n`);
  }
  if (command === 'config') {
    const words = rest[0] === '--local' ? rest.slice(1) : rest;
    const [verb, key, value] = words;
    if (verb === '--get' && words.length === 2) {
      const saved = (rest[0] === '--local' ? undefined : commandConfig.get(configKey(key))) ?? repo.config.get(configKey(key));
      return saved === undefined ? outcome(1) : outcome(0, `${saved}\n`);
    }
    if (verb === '--replace-all' && words.length === 3) { repo.config.set(configKey(key), value); return outcome(); }
    unsupported(`config ${rest.join(' ')}`);
  }
  if (command === 'show') {
    if (rest.length !== 1 || !rest[0].includes(':')) unsupported(`show ${rest.join(' ')}`);
    const found = object(repo, rest[0]);
    return found?.type === 'blob' ? outcome(0, found.bytes) : outcome(128, '', 'fatal: path not found\n');
  }
  if (command === 'cat-file') {
    const [verb, name] = rest;
    if (rest.length !== 2 || !['-e', '-t', '-s', 'blob'].includes(verb)) unsupported(`cat-file ${rest.join(' ')}`);
    const found = object(repo, name);
    if (!found) return outcome(128, '', 'fatal: object not found\n');
    if (verb === '-e') return outcome();
    if (verb === '-t') return outcome(0, `${found.type}\n`);
    if (!found.bytes) unsupported(`cat-file ${verb} on ${found.type}`);
    return verb === '-s' ? outcome(0, `${found.bytes.length}\n`) : outcome(0, found.bytes);
  }
  if (command === 'ls-tree') {
    if (rest.length !== 4 || rest[0] !== '-r' || rest[1] !== '-z' || rest[2] !== '--name-only') unsupported(`ls-tree ${rest.join(' ')}`);
    const found = revision(repo, rest[3]);
    return found ? outcome(0, [...found.commit.files.keys()].sort(pathOrder).map(path => `${path}\0`).join('')) : outcome(128, '', 'fatal: revision not found\n');
  }
  if (command === 'merge-base') {
    if (rest.length !== 3 || rest[0] !== '--is-ancestor') unsupported(`merge-base ${rest.join(' ')}`);
    const base = revision(repo, rest[1]);
    const tip = revision(repo, rest[2]);
    if (!base || !tip) return outcome(128, '', 'fatal: revision not found\n');
    return outcome(ancestors(repo, tip.commit.oid).has(base.commit.oid) ? 0 : 1);
  }
  if (command === 'update-ref') {
    if (rest.length !== 2 || !rest[0].startsWith('refs/heads/')) unsupported(`update-ref ${rest.join(' ')}`);
    const found = revision(repo, rest[1]);
    if (!found || found.type !== 'commit') return outcome(128, '', 'fatal: revision not found\n');
    repo.refs.set(rest[0], found.oid);
    return outcome();
  }
  if (command === 'diff') {
    if (rest.length !== 5 || rest[0] !== '--no-renames' || rest[1] !== '--name-only' || rest[2] !== '-z') unsupported(`diff ${rest.join(' ')}`);
    const base = revision(repo, rest[3]);
    const tip = revision(repo, rest[4]);
    if (!base || !tip) return outcome(128, '', 'fatal: revision not found\n');
    const paths = new Set([...base.commit.files.keys(), ...tip.commit.files.keys()]);
    return outcome(0, [...paths].filter(path => {
      const before = base.commit.files.get(path);
      const after = tip.commit.files.get(path);
      return !before || !after || !before.equals(after);
    }).sort(pathOrder).map(path => `${path}\0`).join(''));
  }
  unsupported(`command ${command}`);
}

/** Shape captured bytes like Node for the options this fake contracts; reject unsupported transport options. */
function capture(result, options) {
  for (const key of Object.keys(options)) {
    if (!['cwd', 'env', 'encoding', 'stdio', 'input', 'maxBuffer', 'timeout'].includes(key)) unsupported(`process option ${key}`);
  }
  if (options.input && Buffer.byteLength(options.input)) unsupported('nonempty process stdin');
  if (options.encoding && !['utf8', 'utf-8', 'buffer'].includes(options.encoding)) unsupported(`encoding ${options.encoding}`);
  if (options.maxBuffer !== undefined && (result.stdout.length > options.maxBuffer || result.stderr.length > options.maxBuffer)) unsupported('maxBuffer overflow');
  const stdio = options.stdio ?? 'pipe';
  if (stdio !== 'pipe' && stdio !== 'ignore' && (!Array.isArray(stdio) || stdio.some(value => !['pipe', 'ignore'].includes(value)))) unsupported('inherited or file-descriptor stdio');
  /** Decode only captured pipes, preserving ignored descriptors as null. */
  const output = (bytes, descriptor) => stdio === 'ignore' || (Array.isArray(stdio) && stdio[descriptor] === 'ignore')
    ? null : options.encoding && options.encoding !== 'buffer' ? bytes.toString(options.encoding) : bytes;
  const stdout = output(result.stdout, 1);
  const stderr = output(result.stderr, 2);
  return { status: result.status, signal: null, stdout, stderr, output: [null, stdout, stderr] };
}

/** Create isolated repository state; seeds use immutable real commit identities and explicit file bytes.
 * Supports the exact rev-parse, symbolic-ref, config, show, cat-file, ls-tree, ancestry, update-ref
 * and committed name-only diff forms exercised by the shared contract, plus the scripted writes of
 * packages/git/tests/io/journey-contract.test.js: init, add -A, commit, branch, switch and merge on a
 * clean flat-or-nested tree, with real object ids. Also: worktree add and list --porcelain, remote add and get-url, and rev-parse --git-common-dir (with --path-format). `timeout` is accepted and ignored, as nothing here can run long. It models no conflicts, dirty-tree moves, worktree discovery from a subfolder, branch-checked-out-elsewhere refusals, streaming protocol, environment-selected repository, or arbitrary Git argv.
 */
export function createMemoryGitAdapter(seeds) {
  const repositories = new Map(seeds.map(seed => {
    const root = resolve(seed.root);
    const branch = seed.branch === null ? null : `refs/heads/${seed.branch ?? 'main'}`;
    const commits = new Map((seed.commits ?? []).map(commit => [commit.oid, copyCommit(commit)]));
    const refs = new Map(Object.entries(seed.refs ?? {}));
    if (branch && seed.head) refs.set(branch, seed.head);
    const tipFiles = commits.get(seed.head)?.files ?? new Map();
    return [root, { root, branch, head: seed.head, commits, refs, index: new Map(tipFiles), work: new Map(tipFiles), linked: [],
      config: new Map(Object.entries(seed.config ?? {}).map(([key, value]) => [configKey(key), value])) }];
  }));
  const adapter = {
    /** Run against seeded state only; absent repositories produce an ordinary Git failure. */
    spawnSync(args, options = {}) {
      capture(outcome(), options);
      for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_SHALLOW_FILE']) {
        if (options.env?.[key]) unsupported(`environment selector ${key}`);
      }
      const { words, cwd } = commandArgs(args, options);
      if (words[0] === 'init') {
        if (words.join(' ') !== 'init -q -b main') unsupported(`init ${words.slice(1).join(' ')}`);
        repositories.set(cwd, { root: cwd, branch: 'refs/heads/main', head: undefined, commits: new Map(),
          refs: new Map(), index: new Map(), work: new Map(), config: new Map(), linked: [] });
        return capture(outcome(), options);
      }
      const repo = repositories.get(cwd);
      return capture(repo ? execute(repositories, repo, words, environmentConfig(options.env), options.env) : outcome(128, '', 'fatal: not a git repository\n'), options);
    },
    /** Write or delete (bytes null) a file in a repository's working tree, standing in for a test's file write. */
    write(root, path, bytes) {
      const repo = repositories.get(resolve(root));
      if (!repo) unsupported(`writing into an unknown repository ${root}`);
      if (bytes === null) repo.work.delete(path); else repo.work.set(path, Buffer.from(bytes));
    },
    /** Preserve success bytes and failure status/output used by the shared synchronous helpers. */
    execFileSync(args, options = {}) {
      const result = adapter.spawnSync(args, options);
      if (result.status === 0) return result.stdout;
      const error = new Error(`Command failed: git ${args.join(' ')}`);
      Object.assign(error, result);
      throw error;
    },
    /** Streaming is deliberately outside this first slice and must never start a real process. */
    spawn() { unsupported('streaming processes'); },
  };
  return adapter;
}

/*
 * Package test files that keep `real: true` because the stand-in still cannot serve them [C7, #8098].
 * Gaps: disk-written fixtures (the test writes files with writeFileSync, which the stand-in cannot see), killSignal
 * (the code under test passes a process option the contract lacks), child process (a spawned node process cannot reach
 * the in-process Git), board busy (the test needs an on-disk board shared between connections).
 * packages/activity/tests/io/next-wait-shout-scope.test.js: killSignal
 * packages/activity/tests/io/worktrees.test.js: disk-written fixtures
 * packages/api/tests/io/gate/detached.test.js: killSignal
 * packages/api/tests/io/gate/ordered.test.js: killSignal
 * packages/api/tests/io/gate/overtaken.test.js: killSignal
 * packages/api/tests/io/handoff.test.js: child process
 * packages/api/tests/io/main.test.js: disk-written fixtures
 * packages/api/tests/io/pool.test.js: child process
 * packages/api/tests/io/pool/reads.test.js: child process
 * packages/api/tests/io/relink-alias.test.js: board busy
 * packages/api/tests/io/remote-join.test.js: killSignal
 * packages/flakes/tests/logic/ratchet.test.js: board busy
 * packages/flakes/tests/verdict.test.js: disk-written fixtures
 * packages/gate/tests/io/changed/scripts/static.test.js: disk-written fixtures
 * packages/gate/tests/io/requeue/retry.test.js: child process
 * packages/gate/tests/io/test/shards.test.js: child process
 * packages/gate/tests/runner/probe.test.js: child process
 * packages/landing/tests/io/deferred/notices.test.js: killSignal
 * packages/landing/tests/io/main/nearby.test.js: disk-written fixtures
 * packages/landing/tests/io/main/red/refresh/single.test.js: killSignal
 * packages/landing/tests/io/reuse/refresh.test.js: disk-written fixtures
 * packages/landing/tests/io/step/gate/affected.test.js: disk-written fixtures
 * packages/moves/tests/logic/moves/holdItem.test.js: disk-written fixtures
 * packages/moves/tests/reopen.test.js: disk-written fixtures
 * packages/runners/tests/io/pack/flight.test.js: disk-written fixtures
 * packages/runners/tests/machine-home.test.js: board busy
 * packages/runners/tests/run-updates-main-reds.test.js: disk-written fixtures
 * packages/seats/tests/io/checkout.test.js: killSignal
 * packages/shouts/tests/main.test.js: board busy
 * packages/board/tests/from-store/any.test.js: disk-written fixtures
 * packages/board/tests/from-store/cli.test.js: killSignal
 * packages/board/tests/from-store/corrections.test.js: disk-written fixtures
 * packages/board/tests/from-store/fixtures-stand-ins.test.js: disk-written fixtures
 * packages/board/tests/from-store/implies.test.js: disk-written fixtures
 * packages/board/tests/from-store/io/board/blobs.test.js: board busy
 */
