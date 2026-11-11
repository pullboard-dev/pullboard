/** The line's words: a plain sentence, never an instruction. */
export const STAR_TEXT = 'Like Pullboard? A GitHub star helps.';

/** The page storage key that remembers a dismissal, beside the page's other pb. preferences. */
export const STAR_KEY = 'pb.star';

/**
 * The line's markup, hidden until the page knows a signed-in person has a linked board.
 *
 * @returns {string}
 */
export function starHtml(repository) {
  const href = String(repository).replace(/[&<>"']/gu, (character) => `&#${character.charCodeAt(0)};`);
  return `<p class="star-line" id="star-line" hidden><a href="${href}" target="_blank" rel="noopener">${STAR_TEXT}</a>`
    + '<button class="star-dismiss" id="star-dismiss" type="button" aria-label="Dismiss the star line" title="Dismiss">×</button></p>';
}
