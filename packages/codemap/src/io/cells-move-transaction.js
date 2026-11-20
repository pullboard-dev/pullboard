/** Move one leaf with exact reversible byte custody; never evaluate the moved module [C7]. */
import { Refused } from '../../../kernel/index.js';
import { createHash } from 'node:crypto';
import { fileSystemAdapter } from '../../../fs/index.js';
import {
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
} from 'node:path';
import { storeName } from './store-names.js';

const fs = fileSystemAdapter();

/** Refuse unknown input without changing the checkout. */
function requireThat(condition, message) { if (!condition) throw new Refused('CELLS_MOVE', message, 'Restore the clean recorded checkout or resolve the named unsupported input before retrying.'); }
/** Keep the custody envelope content addressed. */
function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
/** Permit complete relative POSIX file identities, never escape or path aliases. */
function filePath(path) {
  requireThat(typeof path === 'string' && path && !/[\\:\x00-\x1f\x7f]/u.test(path)
    && !posix.isAbsolute(path) && path.split('/').every(part => part && part !== '.' && part !== '..'), `invalid file path ${path}`);
  return path;
}
/** Read regular bytes only; absence is explicit custody, never a swallowed I/O failure. */
function image(root, file) {
  const path = join(root, file);
  if (!fs.exists(path)) {
    try { fs.lstat(path); throw new Error('dangling symlink'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return null;
  }
  const stat = fs.lstat(path);
  requireThat(stat.isFile() && !stat.isSymbolicLink(), `${file} must be regular`);
  return { bytes: fs.readFile(path, null).toString('base64'), mode: stat.mode & 0o111 ? 0o755 : 0o644 }; // Git records only the executable bit, so a group-writable umask (0o664) is the same file as 0o644.
}
/** Compare exact content and executable bits; do not reinterpret text as an image. */
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
/** All ancestors belong inside this checkout, without traversing directory symlinks. */
function parents(root, file) {
  let path = root;
  for (const part of file.split('/').slice(0, -1)) {
    path = join(path, part);
    if (fs.exists(path)) requireThat(fs.lstat(path).isDirectory() && !fs.lstat(path).isSymbolicLink(), `unsafe parent ${path}`);
    else {
      try { fs.lstat(path); throw new Error(`dangling parent ${path}`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}
/** Construct the narrowly supported transaction using controller-loaded accepted tools, never candidate evaluation. */
export function createMoveTool({ lex, importsIn, commonJsIn, engineFolderViolations, readPathMap, cleanGitEnvironment, fixtureSourceEdits, runProcess }) {
  /** Run immutable Git selectors with ambient selectors removed, or ordinary scoped mutations. */
  function git(root, args, encoding = 'utf8', input = undefined) {
    const result = runProcess('git', ['--no-replace-objects', '--literal-pathspecs', ...args], {
      cwd: root, env: cleanGitEnvironment(), encoding, input, maxBuffer: 64 * 1024 * 1024,
    });
    requireThat(result.status === 0, `git ${args[0]} failed: ${String(result.stderr ?? result.error ?? '')}`);
    return result.stdout;
  }
  /** Confirm source bytes and imported targets are regular committed objects. */
  function tracked(root, commit, file) {
    const row = git(root, ['ls-tree', '-z', commit, '--', file]);
    requireThat(/^100(?:644|755) blob [a-f0-9]+\t/u.test(row) && row.endsWith(`\t${file}\0`), `${file} is not a regular committed file`);
  }
  /** Read immutable test blobs in one bounded Git batch; fixture edits belong to the same reversible custody. */
  function fixtureImages(root, head, from, to) {
    const rows = git(root, ['ls-tree', '-rz', head, '--', 'test', 'docs']).split('\0').filter(Boolean)
      .map(row => /^(100(?:644|755)) blob ([a-f0-9]+)\t(.+)$/u.exec(row))
      .filter(row => row && /\.[cm]?js$/u.test(row[3]));
    if (!rows.length) return [];
    const batch = git(root, ['cat-file', '--batch'], null, rows.map(row => row[2]).join('\n') + '\n');
    const result = [];
    let offset = 0;
    for (const row of rows) {
      const end = batch.indexOf(10, offset);
      const header = new RegExp(`^${row[2]} blob (\\d+)$`, 'u').exec(batch.subarray(offset, end).toString());
      requireThat(end >= offset && header, `invalid immutable test blob ${row[3]}`);
      const size = Number(header[1]), bytes = batch.subarray(end + 1, end + 1 + size);
      requireThat(bytes.length === size && batch[end + 1 + size] === 10, `truncated immutable test blob ${row[3]}`);
      offset = end + size + 2;
      const source = bytes.toString('utf8');
      if (!source.includes(posix.basename(from))) continue;
      requireThat(Buffer.from(source).equals(bytes), `${row[3]} is not exact UTF-8`);
      filePath(row[3]); parents(root, row[3]);
      const { edits, problems } = fixtureSourceEdits(source, { file: row[3], moves: [[from, to]], mentionsOnly: true, readSource: file => {
        filePath(file); tracked(root, head, file);
        const record = git(root, ['ls-tree', '-z', head, '--', file]);
        return { source: git(root, ['show', `${head}:${file}`]), object: /^100(?:644|755) blob ([a-f0-9]+)\t/u.exec(record)[1] };
      } });
      requireThat(!problems.length, problems.join('\n'));
      if (!edits.length) continue;
      let next = source, boundary = source.length;
      for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
        requireThat(Number.isSafeInteger(edit.start) && Number.isSafeInteger(edit.end)
          && edit.start >= 0 && edit.start < edit.end && edit.end <= boundary && typeof edit.text === 'string',
        `invalid fixture rewrite at ${row[3]}`);
        next = next.slice(0, edit.start) + edit.text + next.slice(edit.end); boundary = edit.start;
      }
      importsIn([next]); // Compile changed test bytes without linking or evaluating them.
      const mode = row[1] === '100755' ? 0o755 : 0o644;
      result.push({ file: row[3], before: { bytes: bytes.toString('base64'), mode },
        after: { bytes: Buffer.from(next).toString('base64'), mode } });
    }
    requireThat(offset === batch.length, 'unexpected immutable test batch bytes');
    return result;
  }
  /** Relocate only plain static module literals; V8 verifies the complete recognized import set. */
  function relocate(root, commit, from, to, source, keepExports) {
    const { code, strings } = lex(source);
    for (const declaration of code.matchAll(/\bexport\s+([^;\n]*)/gu)) {
      requireThat(/^(?:const|let|var|function|class|async\s+function)\b/u.test(declaration[1]),
        'only named declaration exports are supported; default and re-export syntax needs owner review');
    }
    requireThat(!commonJsIn([source])[0], 'CommonJS or unknown module syntax is unsupported');
    requireThat(!/\bimport\s*(?:\(|\.)|\b(?:__dirname|__filename)\b|\bexport\s+default\b/u.test(code),
      'dynamic loads, module-relative assets and default exports require an explicit owner design');
    const expected = new Set(importsIn([source])[0]);
    const seen = new Set();
    const edits = [];
    if (keepExports !== null) {
      requireThat(Array.isArray(keepExports) && keepExports.length > 0
        && new Set(keepExports).size === keepExports.length
        && keepExports.every(name => /^[A-Za-z_$][\w$]*$/u.test(name)), 'keepExports must name distinct declaration exports');
      const declarations = [...code.matchAll(/\bexport\s+(?:(?:async\s+)?function\s*\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gu)];
      requireThat(keepExports.every(name => declarations.some(match => match[1] === name)), 'requested export is absent');
      for (const match of declarations) {
        if (/^export\s+(?:const|let|var)\b/u.test(match[0])) {
          let depth = 0;
          for (let at = match.index + match[0].length; at < code.length; at++) {
            const char = code[at];
            if ('({['.includes(char)) depth++;
            if (')}]'.includes(char)) depth--;
            requireThat(!(depth === 0 && char === ','), 'export pruning requires one variable per declaration');
            if (depth === 0 && char === ';') break;
          }
        }
        if (!keepExports.includes(match[1])) edits.push({ start: match.index, end: match.index + 'export'.length, text: '' });
      }
    }
    for (const literal of strings) {
      const prefix = code.slice(0, literal.start);
      const moduleSite = /\b(?:from|import)\s*$/u.test(prefix);
      const raw = source.slice(literal.start, literal.end);
      if (!moduleSite) {
        requireThat(!/^\.{1,2}\//u.test(literal.text), `non-import relative literal needs review: ${literal.text}`);
        continue;
      }
      requireThat(raw[0] === '"' || raw[0] === "'", 'template module specifiers are unsupported');
      requireThat(!literal.text.includes('\\') && !/[?#]/u.test(literal.text), 'escaped/URL module specifiers are unsupported');
      requireThat(expected.has(literal.text), `lexer/V8 disagree at module literal ${literal.text}`);
      seen.add(literal.text);
      if (!/^\.{1,2}\//u.test(literal.text)) continue;
      const target = posix.normalize(posix.join(posix.dirname(from), literal.text));
      filePath(target); tracked(root, commit, target); parents(root, target);
      let next = posix.relative(posix.dirname(to), target);
      if (!next.startsWith('.')) next = './' + next;
      edits.push({ start: literal.start, end: literal.end, text: JSON.stringify(next) });
    }
    requireThat(expected.size === seen.size && [...expected].every(value => seen.has(value)), 'some imports have no supported literal site');
    let next = source;
    for (const edit of edits.sort((a, b) => b.start - a.start)) next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
    importsIn([next]); // Compile, never link/evaluate.
    return next;
  }
  /** Capture closed source and fixture preimages before mutation; historical v2 custody keeps its original scope. */
  function derive({ root, from, to, frontDoor, purpose, keepExports = null }, recordedHead = null, version = 3) {
    root = fs.realpath(root);
    [from, to, frontDoor].forEach(filePath);
    requireThat(/^packages\/[a-z][a-z0-9-]*\/index\.js$/u.test(frontDoor), 'front door must be one package index');
    requireThat(to.startsWith(posix.dirname(frontDoor) + '/src/') && /\.(?:m?js)$/u.test(to), 'body must live under the package src tree');
    const mapFile = `packages/codemap/data/plan/path-map/${storeName(frontDoor.split('/')[1])}`;
    requireThat(new Set([from, to, frontDoor, mapFile]).size === 4, 'transaction paths overlap');
    requireThat(typeof purpose === 'string' && purpose.trim() && !/[\r\n]|\*\//u.test(purpose), 'give one plain front-door purpose sentence');
    if (recordedHead === null) requireThat(git(root, ['status', '--porcelain=v1', '-z']) === '', 'start from a clean checkout');
    const head = recordedHead ?? git(root, ['rev-parse', '--verify', 'HEAD^{commit}']).trim();
    requireThat(/^[a-f0-9]{40}$/u.test(head), 'recorded HEAD must be an immutable commit');
    const policy = JSON.parse(git(root, ['show', `${head}:package.json`]));
    requireThat(policy.type === 'module', 'one root ESM package is required');
    requireThat(/^src\/[^/]+\.(?:m?js)$/u.test(from), 'this bounded first-leaf tool accepts one top-level legacy source file');
    [from, to, frontDoor, mapFile].forEach(file => {
      parents(root, file);
      let scope = posix.dirname(file);
      while (scope !== '.') {
        requireThat(!fs.exists(join(root, scope, 'package.json')), `nested package scope ${scope} is unsupported`);
        scope = posix.dirname(scope);
      }
    });
    tracked(root, head, from);
    const before = Object.fromEntries([from, to, frontDoor, mapFile].map(file => {
      if (recordedHead === null) return [file, image(root, file)];
      const row = git(root, ['ls-tree', '-z', head, '--', file]);
      if (!row) return [file, null];
      tracked(root, head, file);
      return [file, { bytes: git(root, ['show', `${head}:${file}`], null).toString('base64'), mode: row.startsWith('100755 ') ? 0o755 : 0o644 }];
    }));
    requireThat(before[from] && !before[to] && !before[frontDoor], 'source must exist and destinations must be absent');
    const sourceBytes = Buffer.from(before[from].bytes, 'base64');
    const source = sourceBytes.toString('utf8');
    requireThat(Buffer.from(source).equals(sourceBytes), 'source is not exact UTF-8');
    requireThat(engineFolderViolations([{ file: to, source }]).length === 0, 'canonical engines must remain in src/');
    const acceptedMap = readPathMap(root, { commit: head });
    requireThat(!acceptedMap.has(from) && !acceptedMap.has(to)
      && ![...acceptedMap.values()].some(path => path === from || path === to), 'existing rename chains need explicit owner handling');
    const mapping = before[mapFile] ? JSON.parse(Buffer.from(before[mapFile].bytes, 'base64')) : {};
    requireThat(mapping && typeof mapping === 'object' && !Array.isArray(mapping), 'map shard must be an old-to-new object');
    for (const [oldPath, newPath] of Object.entries(mapping)) { filePath(oldPath); filePath(newPath); }
    requireThat(!Object.hasOwn(mapping, from), 'do not overwrite an existing move');
    mapping[from] = to; // The history identity targets the body, never the index or shim.
    const body = relocate(root, head, from, to, source, keepExports);
    let shimTarget = posix.relative(posix.dirname(from), frontDoor);
    if (!shimTarget.startsWith('.')) shimTarget = './' + shimTarget;
    let bodyTarget = posix.relative(posix.dirname(frontDoor), to);
    if (!bodyTarget.startsWith('.')) bodyTarget = './' + bodyTarget;
    const textImage = (text, mode = 0o644) => ({ bytes: Buffer.from(text).toString('base64'), mode });
    const after = {
      [from]: textImage(`export * from ${JSON.stringify(shimTarget)};\n`, before[from].mode),
      [to]: textImage(body, before[from].mode),
      [frontDoor]: textImage(`/** ${purpose.trim()} */\nexport * from ${JSON.stringify(bodyTarget)};\n`),
      [mapFile]: textImage(JSON.stringify(mapping, null, 2) + '\n', before[mapFile]?.mode),
    };
    const fixtures = version === 3 ? fixtureImages(root, head, from, to) : [];
    for (const row of fixtures) { before[row.file] = row.before; after[row.file] = row.after; }
    const directories = [...new Set([to, frontDoor, mapFile].flatMap(file => {
      const result = []; let directory = posix.dirname(file);
      while (directory !== '.' && !fs.exists(join(root, directory))) { result.unshift(directory); directory = posix.dirname(directory); }
      return result;
    }))].sort((a, b) => a.split('/').length - b.split('/').length);
    const value = { version, directories, root, head, from, to, frontDoor, mapFile, purpose, keepExports, before, after,
      ...(version === 3 ? { testFiles: fixtures.map(row => row.file) } : {}) };
    return Object.freeze({ ...value, digest: digest(value) });
  }
  /** Plan only from a clean current checkout; inverse validation derives from immutable Git instead. */
  function plan(input) { return derive(input); }
  /** Validate a serialized envelope's digest; this is custody, not executable or board authority. */
  function validate(value) {
    const { digest: claimed, ...payload } = value;
    requireThat([2, 3].includes(payload.version) && digest(payload) === claimed, 'transaction custody digest changed');
    requireThat(fs.realpath(payload.root) === payload.root
      && git(payload.root, ['rev-parse', '--show-toplevel']).trim() === payload.root, 'custody root must be the actual Git root');
    [payload.from, payload.to, payload.frontDoor].forEach(filePath);
    requireThat(/^src\/[^/]+\.(?:m?js)$/u.test(payload.from)
      && /^packages\/[a-z][a-z0-9-]*\/index\.js$/u.test(payload.frontDoor)
      && payload.to.startsWith(posix.dirname(payload.frontDoor) + '/src/'), 'custody paths leave the supported one-leaf shape');
    requireThat(payload.mapFile === `packages/codemap/data/plan/path-map/${storeName(payload.frontDoor.split('/')[1])}`, 'map shard must match its cell');
    requireThat(Array.isArray(payload.directories) && payload.directories.every(directory => {
      filePath(directory);
      return [payload.to, payload.frontDoor, payload.mapFile].some(file => file.startsWith(directory + '/'));
    }), 'invalid directory custody');
    const canonical = derive(payload, payload.head, payload.version);
    const expected = Object.keys(canonical.before).sort();
    requireThat(JSON.stringify(Object.keys(payload.before).sort()) === JSON.stringify(expected)
      && JSON.stringify(Object.keys(payload.after).sort()) === JSON.stringify(expected), 'custody scope changed');
    requireThat(same(canonical.testFiles, payload.testFiles), 'fixture custody list changed');
    requireThat(payload.before[payload.from] && !payload.before[payload.to] && !payload.before[payload.frontDoor], 'invalid source preimage');
    for (const file of expected) {
      for (const state of [payload.before[file], payload.after[file]]) {
        if (state === null) continue;
        requireThat(state && [0o644, 0o755].includes(state.mode) && typeof state.bytes === 'string'
          && Buffer.from(state.bytes, 'base64').toString('base64') === state.bytes, 'invalid byte/mode image');
      }
      requireThat(payload.after[file] !== null, 'missing postimage');
      const row = git(payload.root, ['ls-tree', '-z', payload.head, '--', file]);
      if (!payload.before[file]) requireThat(!row, `preimage incorrectly claims ${file} was absent`);
      else {
        tracked(payload.root, payload.head, file);
        requireThat(git(payload.root, ['show', `${payload.head}:${file}`], null).toString('base64') === payload.before[file].bytes,
          `preimage does not bind immutable Git bytes for ${file}`);
        requireThat(row.startsWith(payload.before[file].mode === 0o755 ? '100755 ' : '100644 '), `preimage mode differs for ${file}`);
      }
    }
    requireThat(same(canonical.before, payload.before) && same(canonical.after, payload.after),
      'custody postimages differ from immutable canonical derivation');
    return payload;
  }
  /** Make only recorded empty ancestors, refusing every symlink. */
  function makeParents(root, file, created) {
    parents(root, file);
    let path = root;
    for (const part of file.split('/').slice(0, -1)) {
      path = join(path, part);
      if (!fs.exists(path)) { fs.mkdir(path); created.push(relative(root, path)); }
    }
  }
  /** Write a known owned image; no recursive deletion and no outside paths. */
  function put(root, file, value, created) {
    if (value === null) { if (fs.exists(join(root, file))) fs.unlink(join(root, file)); return; }
    makeParents(root, file, created);
    fs.writeFile(join(root, file), Buffer.from(value.bytes, 'base64'));
    fs.chmod(join(root, file), value.mode);
  }
  /** Restore only known transaction images; preserve unexpected concurrent edits for manual recovery. */
  function restore(value, created = []) {
    validate(value);
    for (const file of Object.keys(value.before)) {
      parents(value.root, file);
      const actual = image(value.root, file);
      const movedOriginal = file === value.to ? value.before[value.from] : null;
      requireThat((actual === null && (value.before[file] === null || file === value.from)) || same(actual, value.before[file]) || same(actual, value.after[file]) || (movedOriginal !== null && same(actual, movedOriginal)),
        `unexpected concurrent bytes at ${file}; retain custody and resolve manually`);
    }
    for (const [file, preimage] of Object.entries(value.before)) put(value.root, file, preimage, created);
    const absent = Object.keys(value.before).filter(file => value.before[file] === null);
    if (absent.length) git(value.root, ['update-index', '--force-remove', '--', ...absent]);
    git(value.root, ['add', '--', ...Object.keys(value.before).filter(file => value.before[file] !== null)]);
    for (const directory of [...new Set(created)].reverse()) {
      try { fs.rmdir(join(value.root, directory)); }
      catch (error) { if (!['ENOTEMPTY', 'ENOENT'].includes(error.code)) throw error; }
    }
  }
  /** Apply one prevalidated git-mv transaction, preserving custody before the first mutation. */
  function apply(value, custodyDirectory) {
    validate(value);
    const rebuilt = plan(value);
    requireThat(same(rebuilt, value), 'transaction differs from canonical derived plan');
    const custodyRelative = relative(value.root, resolve(custodyDirectory));
    requireThat(isAbsolute(custodyDirectory) && (custodyRelative === '..' || custodyRelative.startsWith('../')),
      'custody must be outside the checkout');
    requireThat(git(value.root, ['rev-parse', 'HEAD']).trim() === value.head && git(value.root, ['status', '--porcelain=v1', '-z']) === '',
      'HEAD or workspace changed since planning');
    for (const [file, expected] of Object.entries(value.before)) {
      parents(value.root, file);
      requireThat(same(image(value.root, file), expected), `${file} changed since planning`);
    }
    requireThat(fs.exists(custodyDirectory) && fs.realpath(custodyDirectory) === resolve(custodyDirectory),
      'custody must be an existing canonical directory without symlink aliases');
    const record = join(custodyDirectory, value.digest + '.json');
    fs.writeFile(record, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const created = [];
    try {
      makeParents(value.root, value.to, created);
      git(value.root, ['mv', '--', value.from, value.to]);
      for (const [file, postimage] of Object.entries(value.after)) put(value.root, file, postimage, created);
      git(value.root, ['add', '--', ...Object.keys(value.after)]);
      return { record, digest: value.digest, created, rewrittenTests: value.testFiles ?? [] };
    } catch (error) {
      try { restore(value, created); }
      catch (recovery) { throw new AggregateError([error, recovery], `retain exact custody ${record}; partial transaction needs manual recovery`); }
      throw error;
    }
  }
  /** Reverse only this exact postimage; no reset, candidate execution, or collateral overwrite. */
  function undo(record) {
    const value = JSON.parse(fs.readFile(record, 'utf8'));
    validate(value);
    requireThat(git(value.root, ['rev-parse', 'HEAD']).trim() === value.head, 'this bounded draft reverses before commit; use an ordinary reviewed revert afterward');
    const changed = [...git(value.root, ['diff', '--name-only', '-z']).split('\0'),
      ...git(value.root, ['diff', '--cached', '--name-only', '-z']).split('\0'),
      ...git(value.root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0')].filter(Boolean);
    requireThat(changed.every(file => Object.hasOwn(value.after, file)), 'unrelated workspace edits appeared; preserve them and stop');
    for (const [file, expected] of Object.entries(value.after)) requireThat(same(image(value.root, file), expected), `${file} changed after apply`);
    restore(value, value.directories);
    requireThat(git(value.root, ['status', '--porcelain=v1', '-z']) === '', 'inverse did not restore the exact clean preimage');
  }
  return { plan, apply, undo };
}
