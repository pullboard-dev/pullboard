/**
 * The hosted page's release facts for its update note (N26): which releases have shipped, and
 * how far a local install trails the release the page was built from. Kept out of apps/cli/src/io/cockpit.js
 * so the page module stays under its line cap; the page embeds hostedReleaseDistance as source.
 */
import { readFileSync } from 'node:fs';
import { VERSION } from "../../../../packages/config/index.js";

/** The release this hosted page was built from: the package's own version, so learning it fetches nothing. */
export const HOSTED_RELEASE = VERSION;

let shipped;

/**
 * Compare two dotted numeric versions.
 *
 * @param {string} left
 * @param {string} right
 * @returns {number} Negative, zero or positive, as for Array.prototype.sort.
 */
function compareVersions(left, right) {
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

/**
 * Return every shipped numeric release heading through the package version, including releases
 * without headlines, so a count of releases behind matches the changelog a person reads.
 *
 * @param {string} changelog - Shipped changelog contents.
 * @param {string} [currentVersion] - Highest package release to include.
 * @returns {string[]} Numeric release versions in ascending order, without duplicates.
 */
export function releaseVersionsThrough(changelog, currentVersion = VERSION) {
  return [...new Set([...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\](?:\s|$)/gmu)].map((match) => match[1]))]
    .filter((version) => compareVersions(version, currentVersion) <= 0)
    .sort(compareVersions);
}

/**
 * Read and cache the shipped release ledger. Why read the packaged CHANGELOG: the hosted page's
 * current release is the one it was built from, so nothing is fetched to learn it.
 *
 * @returns {readonly string[]}
 */
export function shippedReleaseVersions() {
  if (!shipped) shipped = Object.freeze(releaseVersionsThrough(readFileSync(new URL("../../../../CHANGELOG.md", import.meta.url), 'utf8')));
  return shipped;
}

/**
 * Count known, shipped release entries between the installed and hosted versions. An unknown
 * version gets 0, so the page shows no guessed count. Runs in the page as embedded source.
 *
 * @param {unknown} installed
 * @param {unknown} current
 * @param {unknown} releases
 * @returns {number}
 */
export function hostedReleaseDistance(installed, current, releases) {
  if (typeof installed !== 'string' || typeof current !== 'string' || !Array.isArray(releases)) return 0;
  const installedAt = releases.indexOf(installed), currentAt = releases.indexOf(current);
  return installedAt >= 0 && currentAt > installedAt ? currentAt - installedAt : 0;
}

/**
 * The page's embedded release facts, as script-safe JSON: the release it was built from and the
 * shipped releases to count against. Only the hosted page reads the changelog; others count nothing.
 *
 * @param {string} [version] - The page's release; defaults to the package's own.
 * @param {string[]|null} [versions] - Shipped releases to use instead of the packaged changelog.
 * @param {boolean} [hostedPage] - Whether this is the hosted page that reads this machine's view.
 * @returns {string}
 */
export function hostedReleaseInfo(version = HOSTED_RELEASE, versions = null, hostedPage = false) {
  const releases = versions ?? (hostedPage ? shippedReleaseVersions() : []);
  return JSON.stringify({ version, versions: releases }).replace(/</g, '\\u003c');
}

/**
 * Put the hosted page's one-line update note before the board and return the function that draws it.
 * Why here: apps/cli/src/io/cockpit.js stays inside its line budget, and the page embeds this source, so the
 * function reads nothing outside itself; the page hands in what it knows through `page`.
 *
 * @param {{version: string, versions: string[]}} release - The page's release and the shipped releases.
 * @param {{$: (id: string) => HTMLElement, keep: (name: string, value?: string) => string|null,
 *   distance: (installed: unknown, current: unknown, releases: unknown) => number,
 *   readable: () => boolean, project: (project?: object) => {releaseNotes?: {version?: string}}|undefined}} page
 * @returns {(project?: object) => void} Shows the note for an older local install, or hides it.
 */
export function hostedReleaseNote(release, page) {
  const region = document.createElement('section');
  Object.assign(region, { className: 'release-note', id: 'hosted-release-note', hidden: true });
  region.setAttribute('role', 'status');
  region.setAttribute('aria-label', 'Pullboard update');
  region.innerHTML = '<p><span id="hosted-release-text"></span> <code>npm i -g pullboard@latest</code> <a id="hosted-release-link" target="_blank" rel="noopener noreferrer">What changed</a> <button class="ghost" id="hosted-release-dismiss" type="button">Dismiss</button></p>';
  page.$('group-view').before(region);
  const dismissed = 'pb.hosted-release-dismissed.' + release.version;
  let gone = false;
  /** Show the line only after this hosted page has read a known older release from this machine's view. */
  const draw = (project) => {
    region.hidden = true;
    const source = page.project(project);
    if (!page.readable() || !source?.releaseNotes) return;
    const installed = source.releaseNotes.version;
    const distance = page.distance(installed, release.version, release.versions);
    if (!distance || gone || page.keep(dismissed) === '1') return;
    region.querySelector('#hosted-release-text').textContent = 'Pullboard ' + installed + ' is installed; ' + release.version + ' is current, '
      + distance + ' ' + (distance === 1 ? 'release' : 'releases') + ' behind. Update with';
    region.querySelector('#hosted-release-link').href = 'https://github.com/pullboard-dev/pullboard/blob/main/CHANGELOG.md';
    region.hidden = false;
  };
  // Dismissed for this release only: the next release has its own key, so its note comes back.
  region.querySelector('#hosted-release-dismiss').addEventListener('click', () => { gone = true; page.keep(dismissed, '1'); draw(); });
  return draw;
}
