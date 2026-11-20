import { tabTitle } from "../tab.js";
import { mergeBoards } from "../hosted.js";

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
const mergeBoards = (${mergeBoards.toString()});
/**
 * The sidebar: every project, the one shown, and what needs the person elsewhere. A switch draws only
 * this until the new board arrives, so the main column never mixes the old board with the new pick.
 */
function renderSide() {
  /** Render a repo button or a transient board-read error line. Registered unreadable boards are disclosed below. */
  const repoButton = (x) => {
    if (!x.ok) return '<p class="repo-error" role="status"><b>' + esc(x.name) + ':</b> ' + esc(x.error) + '</p>';
    const on = x.root === view.root;
    const specHint = on && data.project ? specDecisions(data.project).decisionTitle : '';
    const parts = doing(x).split(' · '), asks = [x.decisions, x.pending, x.drafts, x.holds].filter(Boolean).length;
    const line = x.loading ? 'Loading…' : (asks ? '<span class="asks">' + esc(parts.slice(0, asks).join(' · ')) + '</span>' + (parts.length > asks ? ' · ' : '') : '') + esc(parts.slice(asks).join(' · '));
    return '<button class="proj repo' + (on ? ' on' : '') + '"' + (on ? ' aria-current="true"' : '') + ' data-root="' + esc(x.root) + '" title="' + esc(x.root + (specHint ? ' · Spec: ' + specHint : '')) + '" type="button"><span class="pname">' + (x.owner ? '<span class="owner">' + esc(x.owner) + '/</span>' : '') + esc(x.name) + '</span><small>' + (hosted.local && x.source ? '<span class="src">' + (x.source === 'relay' ? 'shared' : 'this computer') + '</span> · ' : '') + line + '</small></button>';
  };
  const readableProjects = data.projects.filter((repo) => repo.ok);
  const unreadableProjects = data.projects.filter((repo) => !repo.ok && repo.warningCode === 'BOARD_UNAVAILABLE');
  const otherErrors = data.projects.filter((repo) => !repo.ok && repo.warningCode !== 'BOARD_UNAVAILABLE').map(repoButton).join('');
  /** One list of boards as project groups, then the loose boards that belong to none. */
  const listing = (boards) => {
    const groups = projectGroups(boards);
    const groupedRoots = new Set(groups.flatMap((group) => group.repos.map((repo) => repo.root)));
    const grouped = groups.map((group) => {
      const on = group.key === view.root;
      const needs = group.repos.reduce((total, repo) => total + needCount(repo), 0);
      const count = group.repos.length;
      return '<section class="repo-group"><button class="proj project-pick' + (on ? ' on' : '') + '"' + (on ? ' aria-current="true"' : '') + ' data-root="' + esc(group.key) + '" type="button"><span class="pname">' + esc(group.name) + '</span><small>' + (needs ? '<span class="asks">' + needs + ' need you</span> · ' : '') + count + ' ' + (count === 1 ? 'repo' : 'repos') + '</small></button><div class="repos">' + group.repos.map(repoButton).join('') + '</div></section>';
    }).join('');
    return grouped + boards.filter((repo) => !groupedRoots.has(repo.root)).map(repoButton).join('');
  };
  // With any relay board listed, boards sit under one heading per machine: this computer's own, then each relay machine.
  const boardList = readableProjects.some((repo) => repo.source === 'relay') ? (() => {
    const byId = new Map(readableProjects.map((repo) => [repo.id, repo]));
    const here = readableProjects.filter((repo) => repo.source !== 'relay');
    const relayed = new Map();
    for (const repo of readableProjects.filter((entry) => entry.source === 'relay')) {
      const machine = repo.machine || 'shared';
      if (!relayed.has(machine)) relayed.set(machine, []);
      relayed.get(machine).push({ id: repo.id, name: repo.name });
    }
    const merged = mergeBoards({ machine: here.find((repo) => repo.machine)?.machine || 'this computer', here: true, boards: here.map((repo) => ({ id: repo.id, name: repo.name })) },
      [...relayed].map(([machine, boards]) => ({ machine, boards })));
    return merged.filter((group) => group.boards.length).map((group) => '<section class="side-machine" data-machine="' + esc(group.machine) + '"><h3>' + esc(group.label) + '</h3>' + listing(group.boards.map((board) => byId.get(board.id))) + '</section>').join('');
  })() : listing(readableProjects);
  const canForget = !snapshot && !readOnly;
  const unreadable = unreadableProjects.length ? '<details class="unreadable-projects"><summary>' + unreadableProjects.length + ' ' + (unreadableProjects.length === 1 ? 'board can' : 'boards can') + ' no longer be found</summary>'
    + (canForget ? '<button type="button" class="ghost" data-forget-unreadable>Forget all</button>' : '') + '<ul>'
    + unreadableProjects.map((repo) => '<li><span class="unreadable-copy" title="' + esc(repo.root) + '"><b>' + esc(repo.name) + '</b> <code>' + esc(compactProjectPath(repo.root)) + '</code></span>'
      + (canForget ? '<button type="button" class="ghost" data-forget-unreadable="' + esc(repo.root) + '" aria-label="Forget ' + esc(repo.name) + '">Forget</button>' : '') + '</li>').join('') + '</ul></details>' : '';
  store.paint($('proj-list'), boardList || otherErrors || unreadable ? boardList + otherErrors + unreadable : '<div class="empty">None yet.</div>');
  const p = data.project;
  const selectedGroup = data.groups.find((group) => group.key === view.root);
  const selectedRepo = data.projects.find((x) => x.root === view.root);
  $('proj-name').textContent = selectedGroup?.name || selectedRepo?.name || (p ? p.root.split('/').pop() : 'No project');
  if ($('proj-title')) $('proj-title').textContent = $('proj-name').textContent;
  if ($('mdrawer-proj-name')) $('mdrawer-proj-name').textContent = $('proj-name').textContent;
}

/** The Spec rows that need the person, read once per board from the store (#6613). */
function specDecisions(p) {
  return store.select('spec-decisions', [p], (project) => ruleListModel(project.spec || [], { kind: 'spec', filter: 'decide',
    approvalIds: personNeeds(project).filter(row => row.kind === 'agent-approved').map(row => row.id) }));
}

/**
 * The agents at work: whoever holds a claim, reviews a submission or is fixing a sent-back item, and moved in the last hour
 * (or every one, when the agents panel shows all). The notch counts them.
 */
function workingAgents(p) {
  const items = p.items.filter((i) => i.status !== 'withdrawn');
  const workingActors = new Set(), recentActors = new Set();
  for (const item of items) {
    if (item.status === 'claimed') {
      const holder = holderOf(item); if (holder) { workingActors.add(holder); recentActors.add(holder); }
    } else {
      const reviewer = reviewerOf(item); if (reviewer) workingActors.add(reviewer);
      if (item.status === 'submitted' && reviewer) recentActors.add(reviewer);
      if (item.builtBy && (['back', 'verify'].includes(stateOf(item)) || staleChip(item))) workingActors.add(item.builtBy);
    }
  }
  const footerBusy = p.agents.filter(agent => workingActors.has(agent.agent_id)
    && (view.allAgents || recentActors.has(agent.agent_id) || agent.lastMoveAt && Date.now() - Date.parse(agent.lastMoveAt) < 36e5));
  return footerBusy;
}

/** The navigation's board numbers from one board: agents at work, the active items, and those building and in review. */
function navNumbers(p) {
  // The state's shared count is the notch's, the Dashboard's and Activity's one number (#7310); a state without it counts here.
  const shared = Array.isArray(p.counts?.agentIds) ? new Set(p.counts.agentIds) : null;
  const busy = shared ? p.agents.filter((agent) => shared.has(agent.agent_id)) : workingAgents(p), active = p.items.filter((i) => i.status !== 'withdrawn' && stateOf(i) !== 'verified');
  return { agents: busy.length, agentIds: busy.map((a) => a.agent_id), agentNames: busy.map((a) => agentName(a.agent_id)), active: active.length,
    building: active.filter((i) => stateOf(i) === 'building').length, review: active.filter((i) => stateOf(i) === 'verify').length };
}

/**
 * The status bar: what the board is doing, along the foot of the window. Each number is the length of the list its
 * click opens (the Active and To verify filters, the gated rows), and a part with none hides. Agents at work are in the
 * notch, which holds what matters now; the notch and this bar never repeat (#6614).
 * The unread shouts fill their slot from writeChrome.
 */
function statusBarHtml(p) {
  const items = p.items.filter((i) => i.status !== 'withdrawn');
  const active = items.filter((i) => stateOf(i) !== 'verified');
  const heldLanes = new Set(p.holds.map((hold) => hold.hold_lane));
  const gated = (item) => item.status === 'open' && (item.blockedBy.length > 0 || heldLanes.has(item.lane) || (p.itemHolds || []).some((hold) => hold.item === item.id));
  const release = nextMilestone(p), last = p.events[0];
  const part = (to, n, words, title) => n ? '<button type="button" data-status="' + to + '" title="' + esc(title) + '"><b>' + n + '</b> ' + words + '</button>' : '';
  return part('items', active.length, 'items', 'Show the active items') + '<button type="button" id="status-unread" data-status="unread" title="Show the shouts you have not read" hidden></button>'
    + part('verify', active.filter((i) => stateOf(i) === 'verify').length, 'to verify', 'Show the items waiting on a verdict')
    + part('gated', active.filter(gated).length, 'blocked', 'Show the open items blocked by another item or a held lane')
    + (release ? '<button type="button" data-status="release" title="' + esc('Show this release on the Roadmap: ' + (release.note || release.name)) + '">' + esc(release.name) + ' <b>' + release.done + '/' + release.total + '</b></button>' : '')
    + (last ? '<button type="button" class="end" data-status="' + (last.item_id ? 'item:' + last.item_id : 'activity') + '" title="' + esc(last.event_at) + '">' + esc(agentName(last.event_by)) + ' ' + esc(eventWords(last.event_kind)) + (last.item_id ? ' #' + last.item_id : '') + ' · ' + age(last.event_at) + '</button>' : '');
}

/**
 * The page's chrome has one writer (#3200, #6613): the tab title, the Spec tab's count, the status bar and its unread
 * shouts. Each is built from the store's board the same way on every tab and written only when it differs, so a
 * refresh that changes nothing leaves all of them alone. Roadmap's title counts the releases it shows; other tabs
 * keep the machine-wide call count. Called with paint false it only reads the counts into the store's memo and touches
 * no node, so a live update can read ahead of its draw without the title or status bar showing a board the lists do not (#7604).
 */
function writeChrome(paint = true) {
  if (!data) return;
  const p = data.project, selectedGroup = data.groups.find((group) => group.key === view.root);
  const roadmap = view.tab === 'roadmap' && p && !selectedGroup;
  const next = tabTitle({ shown: Boolean(p || selectedGroup), name: $('proj-name').textContent, tab: view.tab, group: Boolean(selectedGroup),
    needs: data.projects.reduce((n, x) => n + needCount(x), 0), remaining: roadmap ? store.select('roadmap-remaining', [p, data.projects, view.roadmapOnly], (project) => roadmapRemainingCount(roadmapReads(project))) : null,
    cost: privateCost && !snapshot && !hosted.local && !readOnly && !data.group });
  const shown = p && data.root === view.root ? p : null;
  if (!paint) {
    if (shown) { store.select('status-bar', [shown, view.allAgents, Math.floor(Date.now() / 60_000)], statusBarHtml); store.select('nav-numbers', [shown, view.allAgents, Math.floor(Date.now() / 60_000)], navNumbers); }
    return;
  }
  if (document.title !== next) document.title = next;
  // While a switch loads, the board on hand is the last project's: its counts are never shown as the new one's.
  store.paint($('status-board'), shown ? store.select('status-bar', [shown, view.allAgents, Math.floor(Date.now() / 60_000)], statusBarHtml) : '');
  if (!shown) return;
  // The navigation's numbers: the notch, the switcher's rulings, each page's one fact (#6614).
  drawNav(shown, store.select('nav-numbers', [shown, view.allAgents, Math.floor(Date.now() / 60_000)], navNumbers));
  const spec = $('tabs').querySelector?.('[data-tab=spec]');
  if (spec) {
    const rows = specDecisions(shown);
    if (spec.title !== rows.decisionTitle) spec.title = rows.decisionTitle;
  }
  const slot = $('status-unread');
  if (slot) {
    const unread = unseenShouts(shown), html = '<b>' + unread + '</b> unread';
    if (slot.innerHTML !== html) slot.innerHTML = html;
    if (slot.hidden !== !unread) slot.hidden = !unread;
    document.querySelectorAll?.('[data-nav-fact="shouts"]').forEach((node) => { const text = unread ? String(unread) : ''; if (node.textContent !== text) node.textContent = text; });
  }
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
