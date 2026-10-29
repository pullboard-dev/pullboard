import { COORDINATOR } from './config.js';
import { Refused } from './refused.js';
import { ACTIVITY_NEWS_ENGINE } from './activity-news-engine.js';

/** Validate explicitly marked board-wide news without weakening any existing message audience. */
export function activityNewsFlag(message, engine) {
  const { news, from, to, item, decision, request, answers, detail } = message;
  if (engine >= ACTIVITY_NEWS_ENGINE && detail && ['news', 'newsFormat'].some(key => Object.hasOwn(detail, key))) {
    throw new Refused('BAD_NEWS', 'mark news explicitly on the message, not inside internal event detail; send an ordinary message for coordination');
  }
  if (news === undefined || news === false) return false;
  if (news !== true || ![COORDINATOR, 'person'].includes(from) || to !== 'all'
    || item !== undefined || decision || request || (answers !== null && answers !== undefined)) {
    throw new Refused('BAD_NEWS', 'news is a coordinator or person announcement to all, without an item, decision, request or answer; send an ordinary message for coordination');
  }
  if (engine < ACTIVITY_NEWS_ENGINE) throw new Refused('ENGINE_VERSION', `news requires engine ${ACTIVITY_NEWS_ENGINE}; upgrade linked devices before sending it`);
  return true;
}
