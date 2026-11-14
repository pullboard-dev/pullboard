/** Return the original prose section of the self-contained cockpit document. */
export function cockpitProse(sections) {
  const { releaseNotice, snapshot, pageRenderScript, settingsPageScript, agentApprovalScript, pageScriptPart4, pageScope, historyLoadingScript, paletteScript, accountScript, shoutsScript, menuScript } = sections;
  return `/** Tags that flow inside a line of text, so a reference's line belongs to the nearest block around it. */
const INLINE_TAGS = new Set(['SPAN', 'B', 'I', 'EM', 'STRONG', 'CODE', 'S', 'SMALL', 'TIME', 'MARK', 'U', 'SUB', 'SUP', 'ABBR', 'KBD', 'Q', 'LABEL']);
const CONTROLS = 'button, a[href], select, input, textarea, [role=button]';

/**
 * Mark each reference that stands alone, and leave the rest unmarked: a reference sits in running text when words that
 * are not another control's share its line, between line breaks, in the nearest block around it. References that share
 * a block share one walk of it, so a block holding many of them is read once and not once per reference (#6676).
 */
function markAlone(refs) {
  const blocks = new Map();
  for (const ref of refs) {
    let block = ref.parentElement;
    // A span the page lays out as a block (a shout's text in its row, 154e174c55) is the block around its references.
    while (block.parentElement && INLINE_TAGS.has(block.tagName) && !(typeof getComputedStyle === 'function' && !getComputedStyle(block).display.startsWith('inline'))) block = block.parentElement;
    if (blocks.has(block)) blocks.get(block).push(ref); else blocks.set(block, [ref]);
  }
  for (const [block, inside] of blocks) {
    const mine = new Set(inside), at = new Map(), worded = [];
    let line = 0;
    const walk = document.createTreeWalker(block, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (mine.has(n)) at.set(n, line);
      else if (n.nodeName === 'BR') line += 1;
      else if (n.nodeType === 3 && n.data.trim()) {
        const owner = n.parentElement.closest(CONTROLS);
        if (!owner || owner === block || !block.contains(owner)) worded[line] = true;
      }
    }
    for (const ref of inside) ref.classList.toggle('alone', !worded[at.get(ref)]);
  }
}

// Wherever the page draws a reference, one standing alone is marked, and takes a 44px target where a finger taps. The
// tests' stand-in document, which is not a browser, has no observer, and there nothing is marked.
if (typeof MutationObserver === 'function') new MutationObserver((changes) => {
  for (const root of new Set(changes.map((change) => change.target))) {
    if (root.nodeType === 1) markAlone(root.querySelectorAll('button.ref, a.ref[data-go]'));
  }
}).observe(document.body, { childList: true, subtree: true });

const releaseNotices = new Map();

/** Compare already parsed release versions without treating 0.8.10 as older than 0.8.9. */
function newerRelease(version, previous) {
  if (!/^[0-9]+[.][0-9]+[.][0-9]+$/.test(previous)) return false;
  const left = version.split('.').map(Number), right = previous.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) if (left[index] !== right[index]) return left[index] > right[index];
  return false;
}

/** The existing upgrade card is kept outside the cockpit's page-size budget. */
function renderReleaseNotes(project) {
  return (${releaseNotice.toString()})(project, { $, snapshot, releaseNotices, keep, newerRelease, esc });
}

/** Draw the board shown: the sidebar, then every tab's panes from the project's board. */
${pageRenderScript(pageScope.privateCost)}

/**
 * Show or hide the lifecycle on Activity, and keep the choice: a person who closed it has learned
 * it, so it stays closed across reloads, and across restarts of the view, which serves from the
 * same address again, until they open it. While hidden it is not drawn.
 */
${settingsPageScript()}${agentApprovalScript()}${pageScriptPart4(pageScope)}${accountScript()}${shoutsScript()}${menuScript()}${historyLoadingScript()}${paletteScript()}</script>
</body>
</html>`;
}
