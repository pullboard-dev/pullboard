/** The hosted sidebar's machine groups as markup, from plain data [N26,H5]. */
/**
 * The hosted sidebar's boards, one group per machine name: each group is its label over its boards, so local and relay
 * boards sit together without a board claiming a machine it is not on [N26,H5]. Takes the groups mergeBoards returns.
 *
 * @param {{machine: string, label?: string, boards: {id: string, name?: string}[]}[]} groups - The merged groups, local first.
 * @returns {string} The sidebar's markup, empty when there are no boards.
 */
export function hostedSidebarHtml(groups) {
  const escape = (value) => String(value ?? '').replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  return (groups || []).filter((group) => group && group.machine && (group.boards || []).length).map((group) => `<section class="side-machine" data-machine="${escape(group.machine)}"><h3>${escape(group.label || group.machine)}</h3><ul>`
    + group.boards.map((board) => `<li data-board="${escape(board.id)}">${escape(board.name || board.id)}</li>`).join('') + '</ul></section>').join('');
}
