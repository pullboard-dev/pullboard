/** Render every segmented choice through one escaped, accessible component [N26].
 * Standalone so the served and exported pages embed the same implementation.
 */
export function segmentedToggle({ label, attribute, value, options }) {
  if (!['data-items-view', 'data-rows', 'data-activity-filter'].includes(attribute)) throw new Error('Unsupported segmented control action');
  const esc = text => String(text).replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  return '<div class="seg" role="group" aria-label="' + esc(label) + '" data-segmented-control="' + attribute + '">'
    + options.map(option => '<button type="button" ' + attribute + '="' + esc(option.value) + '" aria-pressed="' + (option.value === value) + '" class="' + (option.value === value ? 'on' : '') + '">'
      + esc(option.label) + (option.count === undefined ? '' : '<b>' + esc(option.count) + '</b>') + '</button>').join('') + '</div>';
}
