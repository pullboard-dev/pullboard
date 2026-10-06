/**
 * The projects on this machine (I8): every repo `pullboard init` set up, so `pullboard view` can show
 * them all on one page. A plain JSON file in the person's home, or wherever PULLBOARD_HOME points,
 * which is how tests and the tour keep their throwaway repos out of it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

/**
 * The registry file.
 *
 * @returns {string}
 */
export function registryFile() {
  return join(process.env.PULLBOARD_HOME || join(homedir(), '.pullboard'), 'projects.json');
}

/**
 * Every registered project, oldest first. An unreadable registry reads as empty.
 *
 * @returns {{ root: string, name: string, added: string }[]}
 */
export function listProjects() {
  const file = registryFile();
  if (!existsSync(file)) return [];
  try {
    const projects = JSON.parse(readFileSync(file, 'utf8')).projects;
    return Array.isArray(projects) ? projects.filter((project) => typeof project?.root === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Add a project's main checkout to the registry, once.
 *
 * @param {string} root
 * @param {Date} [now]
 * @returns {boolean} Whether it was new.
 */
export function registerProject(root, now = new Date()) {
  const projects = listProjects();
  if (projects.some((project) => project.root === root)) return false;
  const file = registryFile();
  mkdirSync(join(file, '..'), { recursive: true });
  projects.push({ root, name: basename(root), added: now.toISOString() });
  writeFileSync(file, `${JSON.stringify({ projects }, null, 2)}\n`);
  return true;
}
