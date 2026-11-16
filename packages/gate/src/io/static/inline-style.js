/**
 * The inline-style rule for the view: no `style=` attribute and no element `.style` write in view source [C7].
 *
 * What: one problem per `style="..."` attribute in markup, `.style.<prop> =` assignment, `.style.setProperty`,
 * `.style.removeProperty`, `.style.cssText` or `setAttribute('style'` in a non-test `apps/view` JavaScript file.
 * Why: inline CSS hides a design decision inside script; the rule keeps new ones out. The check is a ratchet: the
 * registry judges each file against accepted main, so a file may keep the sites it has and never gain one.
 */

const SITE = /(?<![\w$.])style\s*=\s*["'\\]|\.style\.(?:setProperty|removeProperty|cssText)\b|\.style\.[\w$]+\s*=(?!=)|\.style\s*=(?!=)|setAttribute\(\s*['"]style['"]/gu;

/** Whether a path is view source the rule judges: apps/view JavaScript outside its tests and journeys. */
export function isViewSource(path) {
  return /^apps\/view\/.*\.[cm]?js$/u.test(path) && !/(?:^|\/)(?:tests?|journeys)\//u.test(path);
}

/**
 * Every inline-style site in the given view files, by file and line.
 *
 * @param {string} root - Checkout root, kept for the registry's check signature.
 * @param {string[]} files - Root-relative paths; files that are not view source are skipped.
 * @param {(path: string) => string} read - Reads one path's text.
 * @returns {{ path: string, line: number, text: string }[]}
 */
export function inlineStyleProblems(root, files, read) {
  const problems = [];
  for (const path of files.filter(isViewSource)) {
    read(path).split('\n').forEach((text, index) => {
      if (/^\s*(?:\/\/|\/?\*)/u.test(text)) return;
      for (const _site of text.matchAll(SITE)) {
        problems.push({ path, line: index + 1, text: 'inline style in the view: move it to a CSS class or custom property' });
      }
    });
  }
  return problems;
}
