import { Refused } from '../../../kernel/light.js';

/** Shared bounded answer grammar used by blueprint questions and signed row decisions. */
export const CHOICES = '. Choices: ';
export const MOST_CHOICE_PARTS = 12;

/** Every index where a separator starts in the text. */
export function positions(text, separator) {
  const found = [];
  for (let at = text.indexOf(separator); at !== -1; at = text.indexOf(separator, at + 1)) found.push(at);
  return found;
}

/**
 * A question row's text once the person answers it: "<ask>: <answer>. Choices: <choices>.". The
 * choices stay exactly as written. A listed choice (any run of the comma-separated parts, so a
 * choice holding ", " counts) matches in any case and keeps its listed spelling; any other answer
 * joins the choices last. The ask ends at the one ": " whose remainder is a listed choice, or at
 * the last ": " when the default is none of them; readQuestion's single reading is not required,
 * because three or more choices always read more than one way there [S1].
 *
 * @param {string} text - The pending row's text, as questionText wrote it.
 * @param {string} given - The person's answer: one of the choices, or their own one-line text.
 * @param {string} id - The row id, for the refusal's next step.
 * @returns {{ text: string, answer: string, listed: boolean }}
 */
export function answerQuestion(text, given, id) {
  const at = text.lastIndexOf(CHOICES);
  const approve = `the person approves its exact new text instead: pullboard spec approve ${id} --text "<the answered row>"`;
  if (at < 0 || !text.endsWith('.')) throw new Refused('SPEC_ANSWER', `${id} does not read as a question with its choices: it has no ". Choices: " list`, approve);
  const head = text.slice(0, at);
  const choicesText = text.slice(at + CHOICES.length, -1);
  const parts = choicesText.split(', ');
  // The same bound readQuestion keeps, so the runs of parts below stay a small, fixed amount of work.
  if (parts.length > MOST_CHOICE_PARTS) {
    throw new Refused('SPEC_ANSWER_CHOICES', `${id} lists ${parts.length} choice parts, more than the ${MOST_CHOICE_PARTS} an answer can read`,
      `the person approves its exact answered text instead: pullboard spec approve ${id} --text "<ask>: <answer>. Choices: <choices>."`);
  }
  const runs = parts.flatMap((_, from) => parts.slice(from).map((__, length) => parts.slice(from, from + length + 1).join(', ')));
  const colons = positions(head, ': ');
  const listedSplits = colons.filter((colon) => runs.includes(head.slice(colon + 2)));
  if (!colons.length || listedSplits.length > 1) throw new Refused('SPEC_ANSWER', `${id}'s question and its current answer cannot be told apart`, approve);
  const ask = head.slice(0, listedSplits[0] ?? colons.at(-1));
  const answer = given.trim();
  if (answer.includes(CHOICES.trim())) throw new Refused('SPEC_ANSWER', `the answer to ${id} cannot hold "Choices:"`, `give the answer alone: pullboard spec answer ${id} "<answer>"`);
  const listed = runs.find((choice) => choice.toLowerCase() === answer.toLowerCase());
  const chosen = listed ?? answer;
  return { text: `${ask}: ${chosen}${CHOICES}${listed ? choicesText : `${choicesText}, ${answer}`}.`, answer: chosen, listed: Boolean(listed) };
}

/**
 * The answer an answered row's text carries, read back from the text alone: the one answer that
 * answerQuestion turns the pending row's text into exactly this answered text, or null when there
 * is none. Spec show and the view display this, because the source and the answered text are what
 * a row decision signs; nothing else a record carries is trusted for display [S1,S19].
 *
 * @param {string} pending - The pending row's text before the answer.
 * @param {string} answered - The decision's signed text.
 * @returns {string | null}
 */
export function answerFromText(pending, answered) {
  const at = answered.lastIndexOf(CHOICES);
  if (at < 0) return null;
  const head = answered.slice(0, at);
  for (const colon of positions(head, ': ')) {
    try {
      const read = answerQuestion(pending, head.slice(colon + 2), 'row');
      if (read.text === answered) return read.answer;
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      // This split of the answered text is no answer to the pending row; try the next one.
    }
  }
  return null;
}
