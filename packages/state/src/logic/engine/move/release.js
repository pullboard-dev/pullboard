/** A review release needs its one-line reason before it is sealed [V1,R1]. */
export function prepareAfter(board, values, { store }) {
  const problem = store.reviewReleaseNoteProblem(board, values[0], values[1], values[2]);
  if (problem) throw problem;
}
