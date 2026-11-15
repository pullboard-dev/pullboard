import { localDependencyIds } from "../../../../../items/light.js";
import { itemFiles } from "../../../../../items/light.js";
/** Read item activity without duplicating a landing's immutable board-wide receipt [R2,N26]. */

/** Include a batch's main-moving receipt only for the exact item ids that receipt records. */
export function itemActivity(board, id) {
  return board.db.prepare(`
    SELECT * FROM event WHERE item_id = ? AND event_kind NOT IN ('usage','shared-usage')
    UNION ALL
    SELECT * FROM event WHERE item_id IS NULL AND event_kind = 'main-moved'
      AND EXISTS (
        SELECT 1 FROM json_each(CASE WHEN json_valid(event_detail) THEN event_detail ELSE '{}' END, '$.items')
        WHERE type = 'integer' AND value = ?
      )
    ORDER BY event_id
  `).all(id, id);
}


/** Unreadable legacy event detail stays unknown instead of blocking ordinary inbox messages. */
export function activityEventDetail(event) {
  try {
    const detail = JSON.parse(event.event_detail);
    return detail && typeof detail === 'object' && !Array.isArray(detail) ? detail : null;
  } catch { return null; }
}

/** Parse only recorded item dependency ids; a shared prerequisite does not make siblings dependents. */
function prerequisites(item) {
  return localDependencyIds(item);
}

/** Exact files and explicit directory plans overlap without matching a similarly spelled file. */
function sharedPaths(first, second) {
  return first.filter(path => second.some(other => path === other
    || (other.endsWith('/') && path.startsWith(other)) || (path.endsWith('/') && other.startsWith(path))));
}

/** Resolve each dependency direction independently before adding paths that overlap an active build. */
export function activityInterests(agent, items, { workingFiles = [], at }) {
  const byId = new Map(items.map(item => [item.item_id, item]));
  const builds = items.filter(item => item.item_status === 'claimed' && item.item_owner === agent.agent_id);
  const roots = new Set([...builds, ...items.filter(item => item.item_review_by === agent.agent_id
    && item.item_review_until > at && ['submitted', 'verified'].includes(item.item_status))].map(item => item.item_id));
  /** Traverse one directed relationship while retaining a separate visited set. */
  const closure = next => {
    const found = new Set(roots), pending = [...roots];
    while (pending.length) for (const id of next(pending.pop())) if (byId.has(id) && !found.has(id)) {
      found.add(id); pending.push(id);
    }
    return found;
  };
  const dependents = new Map();
  for (const item of items) for (const before of prerequisites(item)) {
    if (!dependents.has(before)) dependents.set(before, []);
    dependents.get(before).push(item.item_id);
  }
  const upstream = closure(id => prerequisites(byId.get(id)));
  const downstream = closure(id => dependents.get(id) ?? []);
  const related = new Set([...upstream, ...downstream]);
  const rows = new Set(items.filter(item => related.has(item.item_id)).flatMap(item => String(item.item_spec_ids ?? '').split(',').filter(Boolean)));
  const files = builds.length ? [...new Set([...builds.flatMap(itemFiles), ...workingFiles])] : [];
  for (const item of items) if (sharedPaths(itemFiles(item), files).length) related.add(item.item_id);
  return { related, rows, files, lane: agent.agent_lane, byId };
}

/** Turn an observed event into a compact stable reference; full evidence remains on its item. */
function activityEntry(event, text, extra = {}) {
  return { eventId: event.event_id, at: event.event_at, by: event.event_by, kind: event.event_kind,
    ...(event.item_id === null ? {} : { item: event.item_id }), text, ...extra };
}

/** Only the new native kind expresses news intent; arbitrary old shout metadata stays direct. */
export function isActivityNews(event, message) {
  return event.event_kind === 'shout_news'
    && event.item_id === null && ['coordinator', 'person'].includes(message?.shout_from)
    && event.event_by === message.shout_from && message.shout_to === 'all'
    && !message.shout_decision && !message.shout_request && message.shout_answers === null;
}

/** Select one read-only activity stream and compact digests without changing native history or audiences. */
export function projectAgentActivity({ agent, interests, events, shouts, changesForMain,
  sessionStart = false, after = 0, newsAfter = 0, cursor }) {
  const messages = new Map(shouts.map(shout => [shout.shout_id, shout]));
  const entries = [], laneItems = new Set(), announcements = [];
  let laneCount = 0;
  for (const event of events) {
    if (['usage', 'shared-usage', 'coordinator-usage'].includes(event.event_kind)) continue;
    const detail = activityEventDetail(event);
    if (!detail) {
      if (interests.related.has(event.item_id) || event.item_id === null) {
        entries.push(activityEntry(event, `activity ${event.event_id} has unreadable detail; inspect its item history`, { unknown: true }));
      } else if (interests.byId.get(event.item_id)?.item_lane === interests.lane) { laneCount++; laneItems.add(event.item_id); }
      continue;
    }
    if (isActivityNews(event, messages.get(detail.shout))) {
      if (sessionStart && event.event_id > newsAfter && messages.has(detail.shout)) announcements.push(messages.get(detail.shout));
      continue;
    }
    if (event.event_id <= after) continue;
    if (['shout', 'shout_news', 'pass', 'answer'].includes(event.event_kind)) {
      const shout = messages.get(detail.shout);
      if (shout) {
        entries.push(activityEntry(event, shout.shout_text, { shout: shout.shout_id }));
      }
      continue;
    }
    if (event.event_kind === 'typed-request' || event.event_kind === 'typed-request-answer') {
      const addressed = event.event_kind === 'typed-request' ? agent.agent_id === 'coordinator' : detail.requester === agent.agent_id;
      if (addressed) entries.push(activityEntry(event,
        event.event_kind === 'typed-request'
          ? `typed request #${event.event_id}: ${detail.request?.verb} #${event.item_id} [${detail.request?.cause}]; run pullboard request list`
          : `typed request #${detail.requestId} ${detail.outcome}; run pullboard request list --all`,
        { typedRequest: true }));
      continue;
    }
    if (event.event_kind === 'main-moved') {
      const changed = changesForMain?.(detail.sha, { ...detail, base: event.activityBase });
      if (changed === null || changed === undefined) {
        if (interests.files.length || interests.unknownWorkingFiles) entries.push(activityEntry(event, 'main changed; file overlap is unknown', { unknownFiles: true }));
      } else {
        const files = [...new Set(sharedPaths(Array.isArray(changed) ? changed : changed.files, interests.files))].toSorted();
        if (files.length) entries.push(activityEntry(event, `main changed ${files.length} ${files.length === 1 ? 'file' : 'files'} you are editing${interests.unknownWorkingFiles ? '; additional overlap is unknown' : ''}`,
          { files, ...(interests.unknownWorkingFiles ? { unknownAdditionalFiles: true } : {}) }));
        else if (interests.unknownWorkingFiles) entries.push(activityEntry(event, 'main changed; working-file overlap is unknown', { unknownFiles: true }));
        const rows = (changed.rows ?? []).filter(id => interests.rows.has(id)).toSorted();
        if (rows.length) {
          const existing = entries.find(entry => entry.eventId === event.event_id);
          const text = `main changed cited ${rows.length === 1 ? 'row' : 'rows'} ${rows.join(', ')}`;
          if (existing) { existing.rows = rows; existing.text += `; ${text}`; }
          else entries.push(activityEntry(event, text, { rows }));
        } else if (changed.unknownRows && interests.rows.size) {
          const existing = entries.find(entry => entry.eventId === event.event_id);
          if (existing) { existing.unknownRows = true; existing.text += '; cited-row changes are unknown'; }
          else entries.push(activityEntry(event, 'main changed; cited-row changes are unknown', { unknownRows: true }));
        }
      }
      continue;
    }
    if (['row_decision', 'row_draft', 'row_apply'].includes(event.event_kind)) {
      const rows = (event.event_kind === 'row_apply' ? event.activityRows ?? [] : [detail.record?.id ?? detail.row?.id])
        .filter(id => interests.rows.has(id)).toSorted();
      if (rows.length) entries.push(activityEntry(event, `cited ${rows.length === 1 ? 'row' : 'rows'} ${rows.join(', ')} changed`, { rows }));
      continue;
    }
    if (interests.related.has(event.item_id)) {
      const item = interests.byId.get(event.item_id);
      entries.push(activityEntry(event, `#${event.item_id} ${event.event_kind}: ${item.item_title}`));
    } else if (interests.byId.get(event.item_id)?.item_lane === interests.lane) {
      laneCount++; laneItems.add(event.item_id);
    }
  }
  const digests = [];
  if (laneCount) digests.push({ kind: 'lane', lane: interests.lane, count: laneCount, items: [...laneItems].toSorted((a, b) => a - b),
    text: `${interests.lane}: ${laneCount} other ${laneCount === 1 ? 'activity' : 'activities'} on ${laneItems.size} ${laneItems.size === 1 ? 'item' : 'items'}` });
  if (announcements.length) digests.push({ kind: 'news', shouts: announcements.map(shout => shout.shout_id), count: announcements.length,
    text: `News: ${announcements.map(shout => shout.shout_text.replace(/\s+/gu, ' ').trim()).join(' · ')}` });
  return { entries: entries.toSorted((a, b) => a.eventId - b.eventId), digests, cursor };
}
