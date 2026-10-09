/** Build truthful device notices from authorized boards and their decrypted pending requests. */
export function noticeLines({ available, paired, warnings = [], failure = '' }) {
  const lines = [];
  const waiting = [...paired.values()].flatMap(entry => entry.state?.personRequests ?? [])
    .filter(request => request.status === 'waiting').length;
  if (waiting) lines.push(`${waiting} request${waiting === 1 ? '' : 's'} from this device ${waiting === 1 ? 'is' : 'are'} waiting for a linked machine to run Pullboard.`);
  const pairedRepositories = new Set(available.filter(board => paired.has(board.id)).map(board => board.repository));
  for (const board of available.filter(value => !paired.has(value.id))) {
    if (!pairedRepositories.has(board.repository)) {
      lines.push(board.repository + ': pair this browser using a link or QR from a linked machine.');
      continue;
    }
    const date = Number.isSafeInteger(board.linkedAt) && board.linkedAt >= 0 && board.linkedAt <= 8640000000000000
      ? new Date(board.linkedAt).toISOString().slice(0, 10) : 'date unavailable';
    const warning = warnings.find(value => value?.board === board.id && value.code === 'BOARD_INACTIVE' && Number.isInteger(value.daysLeft));
    const removal = warning
      ? `To remove it, run pullboard relay off from the machine that linked it, or wait ${warning.daysLeft} days for automatic removal.`
      : 'To remove it, run pullboard relay off from the machine that linked it, or wait until 90 days without activity for automatic removal.';
    lines.push(`${board.repository} · linked ${date} · board ${board.id.slice(0, 8)}. ${removal}`);
  }
  for (const warning of warnings) if (warning?.code === 'BOARD_INACTIVE' && Number.isInteger(warning.daysLeft)) {
    lines.push('BOARD_INACTIVE: ' + warning.daysLeft + ' days left before this relay board is deleted. Make a board move from a linked machine to keep it.');
  }
  if (failure) lines.push(failure);
  if (!available.length) lines.push('No linked boards are available for this account.');
  return lines;
}
