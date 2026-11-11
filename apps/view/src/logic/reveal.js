import { segmentedToggle } from "./segmented.js";
export { segmentedToggle };

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
