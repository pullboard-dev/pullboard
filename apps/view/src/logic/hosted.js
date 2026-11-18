/** DOM adapter for the pure hosted presentation; public exports stay stable [N26,H5]. */
export { hostedMarkup, hostedBrowser, hostedState } from "./hosted/render.js";

/**
 * Draw one state into the page, or clear it with null. A state stands alone: the page's body takes the open-board
 * class, which hides the sidebar, the tabs and the status line until there is a board to list. The relay's own banner
 * steps aside while a state speaks for it, and comes back when the state goes.
 *
 * @param {Document} doc - The page.
 * @param {ReturnType<typeof hostedState>} model - What to show.
 * @param {{view: string, signIn: string|null, session: boolean}} place - The local view's address, the sign-in path and whether the person is signed in.
 */
export function drawHosted(doc, model, place) {
  const $ = (id) => doc.getElementById(id);
  const full = Boolean(model && model.kind === 'state');
  const note = $('local-note');
  /** Show an element with these words, or hide it with none. */
  const say = (id, text) => { $(id).hidden = !text; $(id).textContent = text || ''; };
  note.hidden = !model;
  note.dataset.state = model ? model.state : '';
  note.dataset.kind = model ? model.kind : '';
  note.classList.toggle('wide', Boolean(model?.wide));
  note.title = model?.detail || '';
  doc.body.classList.toggle('open-board', full);
  $('local-note-title').textContent = model ? model.heading : '';
  say('local-note-text', model?.text);
  for (const part of note.querySelectorAll('[data-part]')) part.hidden = !(model?.parts || []).includes(part.dataset.part);
  $('local-note-code').textContent = model?.command || '';
  $('local-note-copy').dataset.copy = model?.command || '';
  $('local-note-ask').textContent = model?.ask ? '“' + model.ask + '”' : '';
  $('local-note-agent').dataset.copy = model?.ask || '';
  say('local-note-small', model?.small);
  $('local-note-live').hidden = !model?.live;
  $('local-note-live').lastElementChild.textContent = model?.live || '';
  $('local-note-help').hidden = !model?.help;
  $('local-note-lead').textContent = model?.lead || '';
  $('local-note-said').textContent = model?.help ? '“' + model.help + '”' : '';
  $('local-note-help-copy').dataset.copy = model?.help || '';
  for (const button of note.querySelectorAll('button[data-copy]')) button.textContent = 'Copy';
  $('local-note-view').href = place.view + '/local/view';
  $('local-note-direct').href = place.view + '/local/view';
  for (const link of note.querySelectorAll('.ob-gh')) if (place.signIn) link.href = place.signIn;
  // A person already signed in is never asked to sign in: Where are your projects? keeps only this computer's card.
  note.querySelector('.ob-two').classList.toggle('signed-in', Boolean(place.session));
  // The relay's banner says what the state now says; it comes back when the state goes.
  const banner = $('relay-notice');
  if (banner && full && ['signed-out', 'no-linked', 'unpaired'].includes(model.state)) { banner.hidden = true; banner.dataset.hostedHid = '1'; }
  else if (banner && banner.dataset.hostedHid && !full) { banner.hidden = false; delete banner.dataset.hostedHid; }
}

/**
 * List the boards the page can reach in one grouped list: the local view's, then every relay machine's. Groups are keyed by
 * machine name, and a board reachable both ways (same machine, same id) is listed once, in the group first seen. Only the
 * local view's own group, when it says it is on this computer, is labeled "this computer"; a board served from another
 * machine carries that machine's name, so a forwarded port never claims another machine's boards as this one's [N26,H5].
 *
 * @param {{machine: string, here?: boolean, boards: {id: string, name?: string}[]}} local - What the local view answers with.
 * @param {{machine: string, boards: {id: string, name?: string}[]}[]} relay - The boards reached through the relay, per machine.
 * @returns {{machine: string, label: string, boards: {id: string, name?: string}[]}[]} The groups, local first.
 */
export function mergeBoards(local, relay) {
  const groups = new Map();
  const add = (machine, boards, label) => {
    if (!groups.has(machine)) groups.set(machine, { machine, label: label || machine, boards: [] });
    const group = groups.get(machine);
    if (label) group.label = label;
    for (const board of boards || []) if (!group.boards.some((have) => have.id === board.id)) group.boards.push({ ...board });
  };
  if (local && local.machine) add(local.machine, local.boards, local.here === true ? 'this computer' : null);
  for (const entry of relay || []) if (entry && entry.machine) add(entry.machine, entry.boards, null);
  return [...groups.values()];
}
