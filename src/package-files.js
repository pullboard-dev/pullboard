/** Derive private source copies from the package's explicit shipped-file boundary [C7,P3]. */
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from 'node:path';

/** Reject ambiguous or escaping package paths rather than widening a source copy; a leading ! excludes earlier matches, as npm does. */
function packagePattern(value) {
  const exclude = typeof value === 'string' && value.startsWith('!');
  const body = exclude ? value.slice(1) : value;
  if (typeof body !== 'string' || !body || body.startsWith('!') || isAbsolute(body)
    || /[\\\u0000-\u001f\u007f{}[\]()]/u.test(body)) throw new Error(`unsupported package files entry: ${JSON.stringify(value)}`);
  const path = body.replace(/^\.\//u, '').replace(/\/$/u, '');
  if (!path || path.split('/').some(part => !part || part === '..' || part === '.')) throw new Error(`unsafe package files entry: ${JSON.stringify(value)}`);
  let pattern = '';
  for (let i = 0; i < path.length; i++) {
    const char = path[i];
    if (char === '*' && path[i + 1] === '*') {
      i++;
      if (path[i + 1] === '/') { pattern += '(?:.*/)?'; i++; }
      else pattern += '.*';
    } else if (char === '*') pattern += '[^/]*';
    else if (char === '?') pattern += '[^/]';
    else pattern += char.replace(/[.+^$|]/gu, '\\$&');
  }
  const firstWildcard = path.search(/[?*]/u);
  const prefix = firstWildcard < 0 ? path : path.slice(0, Math.max(0, path.lastIndexOf('/', firstWildcard)));
  return { expression: new RegExp(`^${pattern}(?:/.*)?$`, 'u'), prefix: firstWildcard === 0 ? '' : prefix, exclude };
}

/** The last entry that matches a path decides it, so a later ! entry removes earlier matches and nothing else. */
function selectedBy(patterns, path) {
  let selected = false;
  for (const { expression, exclude } of patterns) if (expression.test(path)) selected = !exclude;
  return selected;
}

/** Return stable regular-file paths; package.json is the mandatory manifest needed to interpret shipped code. */
export function packageFiles(root) {
  const source = resolve(root);
  const manifestFile = join(source, 'package.json');
  if (!lstatSync(manifestFile).isFile() || lstatSync(manifestFile).isSymbolicLink()) throw new Error('package.json must be a regular file');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error('package files must be an explicit nonempty list');
  const patterns = manifest.files.map(packagePattern);
  if (!patterns.some(({ exclude }) => !exclude)) throw new Error('package files needs at least one inclusion entry before any ! exclusion');
  const files = ['package.json'];
  /** Enumerate declared bytes only, never following a symlink or copying repository/account state. */
  function visit(directory, prefix = '') {
    for (const name of readdirSync(directory).sort()) {
      if (name === '.git' || name === 'node_modules') continue;
      const path = prefix ? `${prefix}/${name}` : name;
      if (path === 'package.json') continue;
      const stat = lstatSync(join(directory, name));
      if (stat.isDirectory()) {
        if (patterns.some(({ prefix }) => !prefix || path === prefix || path.startsWith(prefix + '/') || prefix.startsWith(path + '/'))) {
          visit(join(directory, name), path);
        }
      } else if (selectedBy(patterns, path)) {
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`package source is not a regular file: ${path}`);
        files.push(path);
        if (files.length > 100_000) throw new Error('package file list exceeds its copy bound');
      }
    }
  }
  visit(source);
  return files.sort();
}

/** Validate one exact manifest identity or explicit private-fixture destination, never a glob or parent escape. */
function copyPath(value) {
  const pattern = packagePattern(value);
  if (pattern.exclude || /[?*]/u.test(value) || value.split('/').some(part => part === '.git' || part === 'node_modules')) {
    throw new Error('package copy paths must name exact regular files');
  }
  return value.replace(/^\.\//u, '');
}

/** The relative modules a pure re-export shim forwards to, or null when the text holds code. */
export function shimTargets(text) {
  const bare = text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, '').replace(/\s/gu, '');
  if (!/^(?:export(?:\*|\{[^}]*\})from(?:'[^']*'|"[^"]*");)+$/u.test(bare)) return null;
  return [...new Set([...bare.matchAll(/from(?:'([^']*)'|"([^"]*)");/gu)].map(match => match[1] ?? match[2]))];
}

/** Every module a shim forwards to, transitively, as root-relative paths; a file holding code has none. */
function shimBodies(read, path, seen = new Set()) {
  if (seen.has(path) || seen.size > 64) throw new Error(`cyclic or oversized shim chain at ${path}`);
  seen.add(path);
  let text;
  try { text = read(path); } catch { return []; }
  const targets = /\.[cm]?js$/u.test(path) ? shimTargets(text) : null;
  if (!targets) return [];
  const found = [];
  for (const specifier of targets) {
    if (!/^\.\.?\//u.test(specifier)) throw new Error(`shim ${path} forwards to a non-relative module: ${specifier}`);
    const target = normalize(join(dirname(path), specifier)).split(sep).join('/');
    if (target.startsWith('../') || isAbsolute(target)) throw new Error(`shim ${path} forwards outside the package: ${specifier}`);
    found.push(target, ...shimBodies(read, target, seen));
  }
  return [...new Set(found)];
}

/**
 * The file that holds the body of a tool source: the path itself when it holds code, otherwise the module its
 * re-export shim chain ends at. Fixtures that read or edit a shipped tool source resolve it here, so the same
 * test line is correct before and after a cells move.
 * @param {string} root - The package or fixture directory.
 * @param {string} path - A root-relative tool source path such as src/resources.js.
 * @param {{followShims?:boolean}} [options] - False returns the exact regular entry without following its exports.
 * @returns {string} The absolute path of the implementation, or the exact entry when following is disabled.
 */
export function toolSourcePath(root, path, { followShims = true } = {}) {
  if (typeof followShims !== 'boolean') throw new Error('followShims must be a Boolean');
  const base = resolve(root);
  /** Resolve a literal package entry without following symbolic path components or escaping the private root. */
  function entry(file) {
    const identity = copyPath(file), target = resolve(base, identity), part = relative(base, target);
    if (!part || part === '..' || part.startsWith('..' + sep) || isAbsolute(part)) throw new Error('tool source path escapes its package');
    let current = base;
    const components = identity.split('/');
    for (let at = 0; at < components.length; at++) {
      current = join(current, components[at]);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || (at === components.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
        throw new Error('tool source path must contain regular files and directories');
      }
    }
    return target;
  }
  let current = copyPath(path);
  for (let hop = 0; hop < 16; hop++) {
    const selected = entry(current);
    if (!followShims) return selected;
    const text = /\.[cm]?js$/u.test(current) ? readFileSync(selected, 'utf8') : '';
    const targets = shimTargets(text);
    if (!targets) return selected;
    if (targets.length !== 1) throw new Error(`${current} is a shim over ${targets.length} modules; name the module that holds the code`);
    if (!/^\.\.?\//u.test(targets[0])) throw new Error(`${current} forwards to a non-relative module`);
    current = normalize(join(dirname(current), targets[0])).split(sep).join('/');
  }
  throw new Error(`shim chain from ${path} is too long`);
}

/** Resolve every requested file before copying, so invalid subsets never leave a partly copied fixture. */
function copySelection(available, files, pathMap) {
  if (files === undefined) return available.map(path => ({ source: path, destination: path }));
  if (!Array.isArray(files) || files.length > 100_000 || !(pathMap instanceof Map)) throw new Error('invalid package copy subset');
  const shipped = new Set(available), destinations = new Set();
  return files.map(value => {
    const request = typeof value === 'string' ? { path: value } : value;
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || Object.keys(request).some(key => !['path', 'as'].includes(key))) throw new Error('invalid package copy file');
    let source = copyPath(request.path);
    const visited = new Set();
    while (pathMap.has(source)) {
      if (visited.has(source)) throw new Error('cyclic package copy path map');
      visited.add(source);
      source = copyPath(pathMap.get(source));
    }
    if (!shipped.has(source)) throw new Error(`package copy source is not shipped: ${source}`);
    const destination = request.as === undefined ? source : copyPath(request.as);
    if (destinations.has(destination)) throw new Error(`duplicate package copy destination: ${destination}`);
    destinations.add(destination);
    return { source, destination, follow: request.as === undefined };
  });
}

/** An explicit subset also carries the bodies behind any shim it names, so a moved source is never copied as a bare re-export. */
function withShimBodies(source, available, selection) {
  const shipped = new Set(available), have = new Set(selection.map(file => file.destination)), added = [];
  const read = file => readFileSync(join(source, file), 'utf8');
  for (const file of selection) {
    if (!file.follow) continue;
    for (const body of shimBodies(read, file.source)) {
      if (!shipped.has(body)) throw new Error(`package copy shim body is not shipped: ${body} (from ${file.source})`);
      if (have.has(body)) continue;
      have.add(body);
      added.push({ source: body, destination: body });
    }
  }
  return [...selection, ...added];
}

/**
 * Copy the manifest, or an explicit manifest-validated subset, into an independent private directory.
 * A caller-owned path map resolves moved sources; `as` retains an intentional synthetic fixture layout.
 * @param {string} root - The package source directory.
 * @param {string} destination - A private directory outside the source.
 * @param {{files?: Array<string|{path:string,as?:string}>,pathMap?: Map<string,string>}} [options] - Exact subset identities and a captured path map.
 * @returns {string[]} The copied paths relative to the destination.
 */
export function copyPackageFiles(root, destination, { files, pathMap = new Map() } = {}) {
  const source = resolve(root);
  const target = resolve(destination);
  const nested = relative(source, target);
  if (!nested || !nested.startsWith(`..${sep}`) && nested !== '..' && !isAbsolute(nested)) {
    throw new Error('package copy destination must be outside its source');
  }
  const available = packageFiles(source);
  const requested = copySelection(available, files, pathMap);
  const selection = files === undefined ? requested : withShimBodies(source, available, requested);
  for (const file of selection) {
    const output = join(target, file.destination);
    mkdirSync(dirname(output), { recursive: true });
    copyFileSync(join(source, file.source), output);
  }
  return selection.map(file => file.destination);
}
