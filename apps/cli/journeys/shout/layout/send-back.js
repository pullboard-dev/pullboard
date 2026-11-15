/** Send a fixture back using the exact frozen clause, keeping native rejection guards active. */
export function sendBackWithClause(box, project, id, note, clause) {
  box.git(project.repo, 'switch', '-q', '--detach', project.itemBranches.get(`${project.baseBranch}:${id}`) ?? project.branch);
  box.run(project.repo, 'verify', String(id), 'reject', '--reason', 'BEHAVIOR_MISMATCH', '--note', note, '--clause', clause, '--as', 'coordinator');
  box.git(project.repo, 'switch', '-q', 'main');
}
