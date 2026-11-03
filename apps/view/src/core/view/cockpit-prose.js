/** Return the original prose section of the self-contained cockpit document. */
export function cockpitProse(sections) {
  const { releaseNotice, snapshot, pageRenderScript, settingsPageScript, agentApprovalScript, pageScriptPart4, pageScope, historyLoadingScript } = sections;
  return `/** Tags that flow inside a line of text, so a reference's line belongs to the nearest block around it. */
const INLINE_TAGS = new Set(['SPAN', 'B', 'I', 'EM', 'STRONG', 'CODE', 'S', 'SMALL', 'TIME', 'MARK', 'U', 'SUB', 'SUP', 'ABBR', 'KBD', 'Q', 'LABEL']);
const CONTROLS = 'button, a[href], select, input, textarea, [role=button]';

/**
 * Whether a reference sits in running text: words that are not another control's share its line, between line breaks,
 * in the nearest block around it. A reference standing alone is a target like any button.
 */
function inText(ref) {
  let block = ref.parentElement;
  while (block.parentElement && INLINE_TAGS.has(block.tagName)) block = block.parentElement;
  const worded = [];
  let line = 0, at = 0;
  const walk = document.createTreeWalker(block, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (n === ref) at = line;
    else if (n.nodeName === 'BR') line += 1;
    else if (n.nodeType === 3 && n.data.trim()) {
      const owner = n.parentElement.closest(CONTROLS);
      if (!owner || owner === block || !block.contains(owner)) worded[line] = true;
    }
  }
  return Boolean(worded[at]);
}

// Wherever the page draws a reference, one standing alone is marked, and takes a 44px target where a finger taps. The
// tests' stand-in document, which is not a browser, has no observer, and there nothing is marked.
if (typeof MutationObserver === 'function') new MutationObserver((changes) => {
  for (const root of new Set(changes.map((change) => change.target))) {
    if (root.nodeType === 1) for (const ref of root.querySelectorAll('button.ref, a.ref[data-go]')) ref.classList.toggle('alone', !inText(ref));
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
${settingsPageScript()}${agentApprovalScript()}${pageScriptPart4(pageScope)}${historyLoadingScript()}</script>
</body>
</html>`;
}
