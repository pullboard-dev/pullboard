/** Check release acknowledgements against committed changelog content before tagging [C7,N26]. */
import {
  contains,
  tryGit,
} from '../../../../git/index.js';
import {
  handledReferences,
  referenceAcknowledged,
} from './lines.js';
import { Refused } from '../../../../kernel/index.js';

/** Select exactly one named release section, excluding every neighbouring release. */
function releaseLines(text, name) {
  const sections = [];
  let current = null;
  for (const line of text.split(/\r?\n/u)) {
    const heading = /^##\s+(?:\[([^\]]+)\]|(\S+))(?:\s.*)?$/u.exec(line);
    if (heading) {
      current = (heading[1] ?? heading[2]) === name ? [] : null;
      if (current) sections.push(current);
    } else if (current) current.push(line);
  }
  return sections.length === 1 ? sections[0] : [];
}

/** Name every missing handled reference from local items actually landed in this release's main. */
export function checkReleaseReferences(root, board, name, commit, store) {
  const milestone = store.milestones(board).find(entry => entry.name === name);
  if (!milestone) return; // Preserve the milestone operation's own missing-name refusal.
  const references = new Map();
  for (const id of milestone.items) {
    if (typeof id !== 'number') continue;
    const item = store.getItem(board, id);
    if (item.item_status !== 'verified' || !item.item_merged_commit || !commit
      || !contains(root, item.item_merged_commit, commit)) continue;
    for (const reference of handledReferences(item.item_brief)) {
      references.set(JSON.stringify([reference.target, reference.handle.toLowerCase()]), reference);
    }
  }
  if (!references.size) return;
  const changelog = tryGit(root, ['show', `${commit}:CHANGELOG.md`]);
  const lines = changelog.status === 0 ? releaseLines(changelog.stdout, name) : [];
  const missing = [...references.values()].filter(reference => !referenceAcknowledged(reference, lines));
  if (missing.length) throw new Refused('REFERENCES_MISSING',
    `release ${name} is missing changelog acknowledgements: ${missing.map(reference => `${reference.target} @${reference.handle}`).join('; ')}. Add them to the single ${name} section of CHANGELOG.md, commit on main, and check again before tagging.`);
}
