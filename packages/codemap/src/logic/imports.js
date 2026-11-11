/** Resolve repository-local Node package imports without executing candidate modules [C7]. */
import { posix } from 'node:path';

/** Resolve a literal specifier; unsupported maps remain explicitly unresolved rather than losing an edge. */
export function repositoryImport(importer, specifier, imports = {}) {
  if (specifier.startsWith('.')) {
    const path = posix.normalize(posix.join(posix.dirname(importer), specifier.split(/[?#]/u)[0]));
    return path.startsWith('../') || posix.isAbsolute(path) ? null : path;
  }
  if (!specifier.startsWith('#') || specifier === '#' || specifier.startsWith('#/')) return null;
  if (!imports || typeof imports !== 'object' || Array.isArray(imports)) return null;
  const keys = Object.keys(imports).filter(key => {
    if (!key.includes('*')) return key === specifier;
    const [prefix, suffix, extra] = key.split('*');
    return extra === undefined && specifier.startsWith(prefix) && specifier.endsWith(suffix)
      && specifier.length >= prefix.length + suffix.length;
  }).sort((a, b) => {
    if (!a.includes('*')) return -1;
    if (!b.includes('*')) return 1;
    return b.indexOf('*') - a.indexOf('*') || b.length - a.length;
  });
  const key = keys[0];
  if (!key || typeof imports[key] !== 'string') return null;
  const capture = key.includes('*') ? specifier.slice(key.indexOf('*'), specifier.length - key.split('*')[1].length || undefined) : '';
  const target = imports[key].replaceAll('*', capture);
  if (!target.startsWith('./') || /[?#%\\]/u.test(target)) return null;
  const parts = target.slice(2).split('/');
  if (parts.some(part => part === '..' || part === '.' || part === 'node_modules')) return null;
  return parts.join('/');
}
