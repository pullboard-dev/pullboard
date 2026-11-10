import { tabTitle } from "../tab.js";

/** Shorten a displayed project path; keep the original root for tooltips and native actions. */
export function compactProjectPath(root) {
  const path = String(root).replace(/^(?:\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:[\\/]Users[\\/][^\\/]+)(?=[\\/]|$)/u, '~');
  return path.length > 44 ? path.slice(0, 16) + '…' + path.slice(-27) : path;
}

/** Return the original sidebar section of the self-contained cockpit document. */
export function cockpitSidebar(sections) {
  const { COMMAND_SOURCE, groupActivityModel, groupNeedsHtml, groupEventHtml } = sections;
  return `const compactProjectPath = ${compactProjectPath.toString()};
const tabTitle = (${tabTitle.toString()});
/**
 * The sidebar: every project, the one shown, and what needs the person elsewhere. A switch draws only
 * this until the new board arrives, so the main column never mixes the old board with the new pick.
 */
function renderSide() {
  /** Render a repo button or a transient board-read error line. Registered unreadable boards are disclosed below. */
  const repoButton = (x) => {
    if (!x.ok) return '<p class="repo-error" role="status"><b>' + esc(x.name) + ':</b> ' + esc(x.error) + '</p>';
    const on = x.root === view.root;
    const specHint = on && data.project ? ruleListModel(data.project.spec || [], { kind: 'spec', filter: 'decide', approvalIds: personNeeds(data.project).filter(row => row.kind === 'agent-approved').map(row => row.id) }).decisionTitle : '';
    const parts = doing(x).split(' · '), asks = [x.decisions, x.pending, x.drafts, x.holds].filter(Boolean).length;
    const line = x.loading ? 'Loading…' : (asks ? '<span class="asks">' + esc(parts.slice(0, asks).join(' · ')) + '</span>' + (parts.length > asks ? ' · ' : '') : '') + esc(parts.slice(asks).join(' · '));
    return '<button class="proj repo' + (on ? ' on' : '') + '"' + (on ? ' aria-current="true"' : '') + ' data-root="' + esc(x.root) + '" title="' + esc(x.root + (specHint ? ' · Spec: ' + specHint : '')) + '" type="button"><span class="pname">' + (x.owner ? '<span class="owner">' + esc(x.owner) + '/</span>' : '') + esc(x.name) + '</span><small>' + (hosted.local && x.source ? '<span class="src">' + (x.source === 'relay' ? 'shared' : 'this computer') + '</span> · ' : '') + line + '</small></button>';
  };
  const readableProjects = data.projects.filter((repo) => repo.ok);
  const unreadableProjects = data.projects.filter((repo) => !repo.ok && repo.warningCode === 'BOARD_UNAVAILABLE');
  const otherErrors = data.projects.filter((repo) => !repo.ok && repo.warningCode !== 'BOARD_UNAVAILABLE').map(repoButton).join('');
  const groups = projectGroups(readableProjects);
  const groupedRoots = new Set(groups.flatMap((group) => group.repos.map((repo) => repo.root)));
  const grouped = groups.map((group) => {
    const on = group.key === view.root;
    const needs = group.repos.reduce((total, repo) => total + needCount(repo), 0);
    const count = group.repos.length;
    return '<section class="repo-group"><button class="proj project-pick' + (on ? ' on' : '') + '"' + (on ? ' aria-current="true"' : '') + ' data-root="' + esc(group.key) + '" type="button"><span class="pname">' + esc(group.name) + '</span><small>' + (needs ? '<span class="asks">' + needs + ' need you</span> · ' : '') + count + ' ' + (count === 1 ? 'repo' : 'repos') + '</small></button><div class="repos">' + group.repos.map(repoButton).join('') + '</div></section>';
  }).join('');
  const loose = readableProjects.filter((repo) => !groupedRoots.has(repo.root)).map(repoButton).join('');
  const canForget = !snapshot && !readOnly;
  const unreadable = unreadableProjects.length ? '<details class="unreadable-projects"><summary>' + unreadableProjects.length + ' ' + (unreadableProjects.length === 1 ? 'board can' : 'boards can') + ' no longer be found</summary>'
    + (canForget ? '<button type="button" class="ghost" data-forget-unreadable>Forget all</button>' : '') + '<ul>'
    + unreadableProjects.map((repo) => '<li><span class="unreadable-copy" title="' + esc(repo.root) + '"><b>' + esc(repo.name) + '</b> <code>' + esc(compactProjectPath(repo.root)) + '</code></span>'
      + (canForget ? '<button type="button" class="ghost" data-forget-unreadable="' + esc(repo.root) + '" aria-label="Forget ' + esc(repo.name) + '">Forget</button>' : '') + '</li>').join('') + '</ul></details>' : '';
  $('proj-list').innerHTML = grouped || loose || otherErrors || unreadable ? grouped + loose + otherErrors + unreadable : '<div class="empty">None yet.</div>';
  const p = data.project;
  const selectedGroup = data.groups.find((group) => group.key === view.root);
  const selectedRepo = data.projects.find((x) => x.root === view.root);
  $('proj-name').textContent = selectedGroup?.name || selectedRepo?.name || (p ? p.root.split('/').pop() : 'No project');
  writeTabTitle(p, selectedGroup);
}

/**
 * Build the tab title once for this draw and write it only when it differs, so a refresh that changes nothing
 * leaves the tab alone (#3200). Roadmap counts the releases it shows; other tabs keep the machine-wide call count.
 */
function writeTabTitle(p = data.project, selectedGroup = data.groups.find((group) => group.key === view.root)) {
  const roadmap = view.tab === 'roadmap' && p && !selectedGroup;
  const next = tabTitle({ shown: Boolean(p || selectedGroup), name: $('proj-name').textContent, tab: view.tab, group: Boolean(selectedGroup),
    needs: data.projects.reduce((n, x) => n + needCount(x), 0), remaining: roadmap ? roadmapRemainingCount(roadmapReads(p)) : null,
    cost: privateCost && !snapshot && !hosted.local && !readOnly && !data.group });
  if (document.title !== next) document.title = next;
}

  /** Escape plain text while preserving safe item and code-preview links.
   * @param {string} text
   * @param {Map<string, string>} titles
   * @param {boolean|'in-place'} allowLinks
   * @param {string} root Repository owning any linked references.
   * @param {boolean} machineCodes Chip unquoted native codes only in Shouts.
   * @returns {string}
   */
  function linked(text, titles, allowLinks = true, root = view.root) { return String(text ?? '').split(/(#\\d+|\\b[0-9a-fA-F]{40}\\b|(?<![^\\s([{"'\`])[^\\s:@()[\\]{}"'\`]+:\\d+(?:-\\d+)?@[0-9a-f]{7,40}(?![^\\s)\\]}"'\`.,;:!?]))/).map((part, n, parts) => {
    if (/^[0-9a-fA-F]{40}$/.test(part)) return codeChip(part, 'sha');
    if (n % 2 && part[0] !== '#') return allowLinks === true ? codeRef(part, parts.slice(0, n).join('').split('\\n').pop().slice(-2000)) : codeChip(part);
    const id = /^#\\d+$/.test(part) ? String(Number(part.slice(1))) : '';
    if (id && allowLinks === 'in-place') return '<span class="ref"' + (titles.has(id) ? ' title="' + esc(titles.get(id)) + '"' : '') + '>' + esc(part) + '</span>';
    return id && allowLinks ? '<a class="ref" href="' + esc(itemAddress(id, root)) + '" data-go="item:' + id + '"' + (root === view.root ? '' : ' data-board="' + esc(root) + '"') + (titles.has(id) ? ' title="' + esc(titles.get(id)) + '"' : '') + '>' + esc(part) + '</a>' : esc(part);
  }).join(''); }
  /** Format inline code and recognized command tokens without interpreting markup.
   * @param {string} text
   * @param {Map<string, string>} titles
   * @param {boolean|'in-place'} allowLinks
   * @param {string} root Repository owning any linked references.
   * @param {boolean} machineCodes Chip unquoted native codes only in Shouts.
   * @returns {string}
   */
  function inline(text, titles, allowLinks = true, root = view.root, machineCodes = false) { return String(text ?? '').split(/(\`[^\`]*\`|(?:[^\\s:@()[\\]{}"'\`]+)?:\\d+(?:-\\d+)?@[0-9a-f]{0,40}|${COMMAND_SOURCE}|--[\\w-]+|(?:\\/|\\.\\.?\\/|[\\w.-]+\\/)\\w[\\w./-]*\\.[A-Za-z0-9]+|\\b[0-9a-fA-F]{7,40}\\b|\\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\\b|#\\d+)/g).map((part, n, parts) => {
    if (part.startsWith('\`') && part.endsWith('\`')) return codeChip(part.slice(1, -1));
    if (part.includes('@') && part.includes(':')) {
      const textBefore = parts.slice(0, n).join('');
      const fullText = parts.join('');
      const after = fullText[textBefore.length + part.length] || '';
      const leftBoundary = !textBefore || [9, 10, 32, 40, 91, 123, 34, 39, 96].includes(textBefore.at(-1).charCodeAt(0));
      const rightBoundary = !after || [9, 10, 32, 41, 93, 125, 34, 39, 96, 46, 44, 59, 58, 33, 63].includes(after.charCodeAt(0));
      const validRef = leftBoundary && rightBoundary;
      const partial = /^(?:([^:@()[\\]{}"'\`]+))?:(\\d+)(?:-(\\d+))?@([0-9a-f]*)$/.exec(part);
      if (validRef && partial && (!partial[1] || partial[4].length < 7)) {
        const reason = !partial[1] ? 'missing the repository path' : 'missing a usable commit SHA';
        return '<span class="code no ref-missing" role="status">Code reference unavailable: ' + reason + '.</span>';
      }
      if (allowLinks === true && validRef) return codeRef(part, textBefore.slice(-2000));
      return codeChip(part);
    }
    if (/^(?:${COMMAND_SOURCE}|--[\\w-]+)$/.test(part)) return codeChip(part, 'cmd');
    if (/^(?:\\/|\\.\\.?\\/|[\\w.-]+\\/)\\w[\\w./-]*\\.[A-Za-z0-9]+$/.test(part)) return codeChip(part, 'path');
    if (/^[0-9a-fA-F]{7,40}$/.test(part)) return codeChip(part, 'sha');
    if (machineCodes && /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(part)) return codeChip(part, 'code');
    return linked(part, titles, allowLinks, root);
  }).join(''); }
  /** Render inline text and fenced or shell command blocks with escaped contents.
   * @param {string} text
   * @param {Map<string, string>} titles
   * @param {boolean} allowLinks
   * @returns {string}
   */
  /**
   * A run of '- ' lines as one bulleted list, indented lines nested under the bullet above them. A bullet
   * that is a whole command (npm, npx, pnpm, yarn, bun, git, node, python, pytest, pullboard) is one code
   * chip; any other bullet is prose, with its paths, flags and backticks as chips. A whole command is the
   * command alone: no sentence end, no comma outside quotes, and at most two plain words after it (spec
   * check, merge main); everything else in it is a path, flag, number or quoted string. A bullet that only
   * starts with a command is a sentence (#232: all nine such bullets on the board were).
   */
  function wholeCommand(text) {
    if (!/^(?:npm|npx|pnpm|yarn|bun|git|node|python(?:\\d+(?:\\.\\d+)?)?|pytest|pullboard)\\s+\\S/.test(text) || /[.!?:;,]$/.test(text.trim())) return false;
    const bare = text.replace(/"[^"]*"|'[^']*'|\`[^\`]*\`/g, ' ');
    return !/[,;]\\s/.test(bare) && bare.trim().split(/\\s+/).slice(1).filter((word) => /^[A-Za-z]+$/.test(word)).length <= 2;
  }

  /** Preserve repo scope while linking references inside a prose list. */
  function bullets(lines, titles, allowLinks, root = view.root, machineCodes = false) {
    const roots = [], open = [];
    for (const line of lines) {
      const [, indent, text] = /^(\\s*)- (.*)$/.exec(line);
      const node = { text, children: [] };
      while (open.length && indent.length <= open.at(-1).indent) open.pop();
      (open.length ? open.at(-1).node.children : roots).push(node);
      open.push({ indent: indent.length, node });
    }
    const list = (nodes) => '<ul class="text-list">' + nodes.map((node) => '<li>'
      + (wholeCommand(node.text) ? codeChip(node.text, 'cmd') : inline(node.text, titles, allowLinks, root, machineCodes))
      + (node.children.length ? list(node.children) : '') + '</li>').join('') + '</ul>';
    return list(roots);
  }

  // A line that is nothing but one path:lines@commit reference.
  const WHOLE_REF = /^\\s*[^\\s:@()[\\]{}"'\`]+:\\d+(?:-\\d+)?@[0-9a-f]{7,40}\\s*$/;
  /** Draw optional message-only machine-code chips without changing ordinary authored notes or item prose. */
  function rich(text, titles, allowLinks = true, root = view.root, machineCodes = false) {
    const lines = String(text ?? '').split('\\n');
    const output = [];
    for (let i = 0; i < lines.length;) {
      if (lines[i].startsWith('\`\`\`')) {
        const block = [];
        i++;
        while (i < lines.length && !lines[i].startsWith('\`\`\`')) block.push(lines[i++]);
        if (i < lines.length) i++;
        output.push('<code class="code block">' + esc(block.join('\\n')) + '</code>');
      } else if (lines[i].startsWith('$ ')) {
        const block = [];
        while (i < lines.length && lines[i].startsWith('$ ')) block.push(lines[i++]);
        output.push('<code class="code block">' + esc(block.join('\\n')) + '</code>');
      } else if (allowLinks && WHOLE_REF.test(lines[i])) {
        output.push({ block: codeRef(lines[i++].trim(), '', true) });
      } else if (/^\\s*- /.test(lines[i])) {
        const run = [];
        while (i < lines.length && /^\\s*- /.test(lines[i])) run.push(lines[i++]);
        output.push({ list: bullets(run, titles, allowLinks, root, machineCodes) });
      } else {
        const block = [];
        while (i < lines.length && !lines[i].startsWith('\`\`\`') && !lines[i].startsWith('$ ') && !/^\\s*- /.test(lines[i]) && !(allowLinks && WHOLE_REF.test(lines[i]))) block.push(inline(lines[i++], titles, allowLinks, root, machineCodes));
        output.push(block.join('<br>'));
      }
    }
    // A list ends its own line, so no break goes beside one: a blank line in the text stays one blank line.
    return output.map((part, n) => (n && typeof part === 'string' && typeof output[n - 1] === 'string' ? '<br>' : '') + (typeof part === 'string' ? part : part.list ?? part.block)).join('');
  }

const groupActivityModel = (${groupActivityModel.toString()});
const groupNeedsHtml = (${groupNeedsHtml.toString()});
const groupEventHtml = (${groupEventHtml.toString()});
/** Prepare cross-repository labels and links at the browser boundary, then draw pure HTML. */
function renderGroup(group) {
  const needs = group.repos.flatMap(repo => projectNeeds(repo.board).map(row => ({ ...row, repo })));
  $('group-needs').innerHTML = groupNeedsHtml(needs.map(row => {
    const titles = new Map(row.repo.board.items.map(item => [String(item.id), item.title]));
    return { repoName: row.repo.name, repoRoot: row.repo.root, ref: row.ref,
      textHtml: rich(row.text, titles, true, row.repo.root), actionLabel: row.kind === 'pending' ? 'answer ' + row.ref : row.what,
      ageHtml: row.at ? age(row.at) : '' };
  }));
  const events = groupActivityModel(group.repos);
  $('group-activity').innerHTML = events.length ? byDay(events, event => event.event_at, event => groupEventHtml({
    timeLabel: clock(event.event_at), repoName: event.repo.name, agentLabel: agentName(event.event_by, event.repo.board), kind: eventWords(event.event_kind),
    itemId: event.item_id, itemHref: event.item_id ? itemAddress(event.item_id, event.repo.root) : null,
    foreignRoot: event.repo.root === view.root ? null : event.repo.root,
    titleHtml: event.title ? rich(event.title, event.titles, true, event.repo.root) : '',
  })) : '<div class="empty">No activity yet.</div>';
}

/**
 * A milestone's item as the Items tab reads it (N26). This board's own come from its items, and
 * another repo's, written repo#id, from that repo's board when the view lists one by that name or
 * folder, as the roadmap resolves it: the same state, sent back included, and it opens there. An
 * item no listed board holds keeps the status the roadmap read for it, and opens nowhere.
 */
let renderIndexes = new WeakMap();
const roadmapDetails = new Map();
`;
}
