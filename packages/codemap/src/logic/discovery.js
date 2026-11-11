/** Select repository test entry files while keeping imported helpers out of direct discovery. */
export function isDefaultTestFile(path) {
  const normalized = path.replaceAll('\\', '/');
  if (normalized.split('/').some(part => part === 'node_modules' || part.startsWith('.'))) return false;
  return /(?:^|\/)[^/]+\.test\.(?:js|mjs)$/u.test(normalized);
}

