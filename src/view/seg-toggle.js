/** Render every segmented choice through one escaped, accessible component [N26].
 * Standalone so the served and exported pages embed the same implementation.
 */
export function segmentedToggle({ label, attribute, value, options }) {
  if (!['data-items-view', 'data-rows', 'data-activity-filter'].includes(attribute)) throw new Error('Unsupported segmented control action');
  const esc = text => String(text).replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  return '<div class="seg" role="group" aria-label="' + esc(label) + '" data-segmented-control="' + attribute + '">'
    + options.map(option => '<button type="button" ' + attribute + '="' + esc(option.value) + '" aria-pressed="' + (option.value === value) + '" class="' + (option.value === value ? 'on' : '') + '">'
      + esc(option.label) + (option.count === undefined ? '' : '<b>' + esc(option.count) + '</b>') + '<span class="seg-hit seg-hit-top" aria-hidden="true"></span><span class="seg-hit seg-hit-bottom" aria-hidden="true"></span></button>').join('') + '</div>';
}

/** Keep the selected choice visible after replacing a narrow track, without scrolling the page [N26]. */
export function revealSegmentedChoices(root) {
  for (const track of root.querySelectorAll('[data-segmented-control]')) {
    if (!track.clientWidth || track.scrollWidth <= track.clientWidth) continue;
    const choice = track.querySelector('button[aria-pressed="true"]');
    if (!choice) continue;
    const box = track.getBoundingClientRect();
    const selected = choice.getBoundingClientRect();
    const padding = Number.parseFloat(getComputedStyle(track).paddingLeft);
    if (selected.left < box.left + padding) track.scrollLeft += selected.left - box.left - padding;
    else if (selected.right > box.right - padding) track.scrollLeft += selected.right - box.right + padding;
  }
}
