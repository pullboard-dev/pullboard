import { relayNoticeView } from './relay-cause.js';

/** Render the existing per-board upgrade notice without changing its retained version or dismiss behavior. */
export function releaseNotice(project, { $, snapshot, releaseNotices, keep, newerRelease, esc }) {
  const region = $('upgrade-note');
  region.hidden = true;
  if (snapshot || !project?.releaseNotes) return;
  const info = project.releaseNotes;
  let notice = releaseNotices.get(project.root);
  if (notice?.version !== info.version) {
    const key = 'pb.release.' + project.root;
    const previous = keep(key);
    const releases = previous ? info.releases.filter((release) => newerRelease(release.version, previous)) : [];
    notice = { version: info.version, releases, notes: info.notes };
    releaseNotices.set(project.root, notice);
    keep(key, info.version);
  }
  if (!notice.releases.length) return;
  region.innerHTML = '<header><h2>New in ' + esc(notice.version) + '</h2><button class="ghost" type="button" data-upgrade-dismiss>Dismiss</button></header>'
    + notice.releases.slice(0, 3).map((release) => '<article><h3>' + esc(release.version) + ' · ' + esc(release.headline) + '</h3><p>' + esc(release.paragraph) + '</p></article>').join('')
    + '<footer>' + (notice.releases.length > 3 ? '<span>+' + (notice.releases.length - 3) + ' more</span> · ' : '')
    + '<a href="' + esc(notice.notes) + '" target="_blank" rel="noopener noreferrer">Full release notes</a></footer>';
  region.hidden = false;
}

/**
 * The phone's relay note as markup: a calm "asleep" line with the machine's name, or the trouble line, or nothing once the machine is back.
 * The asleep tone carries no error role, so a sleeping computer does not look like a failure.
 */
export function relayNoticeMarkup(status, esc) {
  const view = relayNoticeView(status);
  if (!view) return '';
  const role = view.tone === 'trouble' ? ' role="alert"' : '';
  return '<p class="relay-note" data-tone="' + view.tone + '"' + role + '>' + esc(view.message) + (view.command ? ' Run <code>' + esc(view.command) + '</code>.' : '') + '</p>';
}
