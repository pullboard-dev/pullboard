/** Released headline summaries shared by resume and the view [N19]. */
import { readFileSync } from 'node:fs';

/** Return the first headline paragraph for each release after `previous` through `current`. */
export function releaseHeadlinesBetween(previous, current) {
  if (!/^\d+\.\d+\.\d+$/u.test(previous) || !/^\d+\.\d+\.\d+$/u.test(current)) return [];
  const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  /** Split a numeric release into components for version comparison. */
  const parts = (version) => version.split('.').map(Number);
  /** Compare numeric version components without treating 0.8.10 as older than 0.8.9. */
  const compare = (left, right) => {
    const a = parts(left), b = parts(right);
    for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
    return 0;
  };
  const releases = [];
  const sections = changelog.split(/^## \[(\d+\.\d+\.\d+)\][^\n]*\n/gmu);
  for (let index = 1; index < sections.length; index += 2) {
    const version = sections[index];
    if (compare(version, previous) <= 0 || compare(version, current) > 0) continue;
    const section = sections[index + 1] ?? '';
    const categories = new Set(['added', 'changed', 'fixed', 'removed', 'security', 'deprecated']);
    const headings = [...section.matchAll(/^### (.+)\s*$/gmu)];
    const headline = headings.find(entry => !categories.has(entry[1].trim().toLowerCase()));
    if (!headline) continue;
    const nextHeading = headings.find(entry => entry.index > headline.index);
    const afterHeadline = section.slice(headline.index + headline[0].length, nextHeading?.index);
    const paragraph = afterHeadline.trim().split(/\n\s*\n/u)[0]
      .split('\n').filter(line => line.trim() && !/^[-*] /u.test(line)).join(' ').trim();
    if (paragraph) releases.push({ version, headline: headline[1].trim(), paragraph });
  }
  /** Sort matching release summaries newest first. */
  const newestFirst = (a, b) => compare(b.version, a.version);
  return releases.sort(newestFirst);
}
