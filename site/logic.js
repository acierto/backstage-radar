// Shared classification logic — used by the dashboard (browser) and the digest (Node).
// Input: the compact data.json produced by src/collect.mjs.
//
// Item shape (ev entries: [at, actor, kind, mentionedUsers?, mentionedTeams?, pingedUsersWhoReacted?]):
//   { n, t: 'pr'|'issue', title, url, author, draft, labels: [...], created, updated,
//     reviewers: [logins], teams: [slugs],
//     ev: [[isoTime, actor, kind, [mentionedLogins], [mentionedTeams]], ...] }
// kind: 'open' (issue/PR body) | 'c' comment | 'r' review | 'rc' review comment |
//       'p' commit pushed | 'rr' review requested

export const DAY = 24 * 60 * 60 * 1000;

export const BUCKETS = {
  reply: { key: 'reply', title: 'Needs your reply', hint: 'You were @mentioned or asked to review and have not responded since.' },
  mine: { key: 'mine', title: 'Activity on your items', hint: 'Your own issues/PRs where someone else spoke last.' },
  untouched: { key: 'untouched', title: 'New in your areas', hint: 'Open items in your areas you have never commented on.' },
  activity: { key: 'activity', title: 'New activity in your areas', hint: 'You took part before; others posted after your last reply.' },
  waiting: { key: 'waiting', title: 'Waiting on others', hint: 'In your areas, and the last word is yours.' },
};
export const BUCKET_ORDER = ['reply', 'mine', 'untouched', 'activity', 'waiting'];

const lc = (s) => (s || '').toLowerCase();

export function areaOf(label) {
  return label.startsWith('area:') ? label.slice(5) : null;
}

export function itemAreas(item) {
  return item.labels.map(areaOf).filter(Boolean);
}

/**
 * Classify one item for one person.
 * @param item     item from data.json
 * @param prefs    { user: 'acierto', areas: ['scaffolder'] | ['all'], teams: ['scaffolder-maintainers'] }
 * @returns null (not relevant) or { bucket, since, reason }
 */
export function classify(item, prefs) {
  const user = lc(prefs.user);
  if (!user) return null;
  const teams = (prefs.teams || []).map(lc);
  const allAreas = (prefs.areas || []).includes('all');
  const wanted = new Set((prefs.areas || []).map(lc));

  const ev = item.ev; // already sorted ascending, bots removed
  let lastMine = null; // last time the user did anything
  let lastMention = null; // last time someone else pinged the user (or their team)
  let lastMentionBy = null;
  let lastOther = null; // last event by someone else
  let lastOtherBy = null;

  for (const [at, actor, kind, mentions = [], teamMentions = [], acks = []] of ev) {
    const a = lc(actor);
    if (a === user) {
      lastMine = at;
      continue;
    }
    lastOther = at;
    lastOtherBy = actor;
    // A reaction from you on the comment that pinged you means "seen, no reply needed".
    const pinged =
      (mentions.includes(user) && !acks.includes(user)) || (teams.length && teamMentions.some((t) => teams.includes(t)));
    if (pinged) {
      lastMention = at;
      lastMentionBy = kind === 'rr' ? `${actor} (review request)` : actor;
    }
  }

  const isAuthor = lc(item.author) === user;
  const pendingReview =
    item.t === 'pr' &&
    !isAuthor &&
    (item.reviewers.includes(user) || item.teams.some((t) => teams.includes(t)));

  // 1. Someone pinged you (mention or review request) after your last action.
  if (lastMention && (!lastMine || lastMine < lastMention)) {
    return { bucket: 'reply', since: lastMention, reason: `pinged by @${lastMentionBy}` };
  }
  // A still-pending review request you never acted on (request event may be older than the ev window).
  if (pendingReview && !lastMine) {
    return { bucket: 'reply', since: item.created, reason: 'review requested' };
  }

  // 2. Your own item and someone else spoke last.
  if (isAuthor) {
    if (lastOther && (!lastMine || lastMine < lastOther)) {
      return { bucket: 'mine', since: lastOther, reason: `reply from @${lastOtherBy}` };
    }
    return null;
  }

  // 3. Area watch.
  const areas = itemAreas(item);
  const inArea = allAreas || areas.some((a) => wanted.has(a));
  if (!inArea) return null;

  if (!lastMine) {
    return { bucket: 'untouched', since: lastOther || item.created, reason: 'not seen by you' };
  }
  if (lastOther && lastOther > lastMine) {
    return { bucket: 'activity', since: lastOther, reason: `@${lastOtherBy} replied after you` };
  }
  return { bucket: 'waiting', since: lastMine, reason: 'your reply was last' };
}

/** Classify all items. Returns rows sorted by priority, newest first within a bucket. */
export function buildInbox(data, prefs) {
  const rows = [];
  for (const item of data.items) {
    const c = classify(item, prefs);
    if (c) rows.push({ item, ...c });
  }
  rows.sort(
    (a, b) =>
      BUCKET_ORDER.indexOf(a.bucket) - BUCKET_ORDER.indexOf(b.bucket) ||
      (b.since > a.since ? 1 : b.since < a.since ? -1 : 0),
  );
  return rows;
}

export const AGE_BINS = [
  { label: '< 1d', long: 'less than a day', max: 1 },
  { label: '1–3d', long: '1–3 days', max: 3 },
  { label: '3–7d', long: '3–7 days', max: 7 },
  { label: '1–4w', long: '1–4 weeks', max: 28 },
  { label: '> 4w', long: 'more than 4 weeks', max: Infinity },
];

export function ageBin(since, now) {
  const days = (now - Date.parse(since)) / DAY;
  return AGE_BINS.findIndex((b) => days < b.max);
}

export function humanAge(since, now) {
  const mins = Math.max(0, (now - Date.parse(since)) / 60000);
  if (mins < 60) return `${Math.round(mins)}m`;
  const h = mins / 60;
  if (h < 24) return `${Math.round(h)}h`;
  const d = h / 24;
  if (d < 14) return `${Math.round(d)}d`;
  return `${Math.round(d / 7)}w`;
}

/** Per-day counts for the last `days` days: events by others in scope vs the user's own events. */
export function dailyActivity(data, prefs, rows, days, now) {
  const user = lc(prefs.user);
  const start = new Date(now - (days - 1) * DAY);
  start.setUTCHours(0, 0, 0, 0);
  const keys = [];
  for (let i = 0; i < days; i++) keys.push(new Date(start.getTime() + i * DAY).toISOString().slice(0, 10));
  const others = Object.fromEntries(keys.map((k) => [k, 0]));
  const mine = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const { item } of rows) {
    for (const [at, actor, kind] of item.ev) {
      if (kind === 'rr') continue;
      const k = at.slice(0, 10);
      if (!(k in others)) continue;
      if (lc(actor) === user) mine[k]++;
      else others[k]++;
    }
  }
  return { keys, others: keys.map((k) => others[k]), mine: keys.map((k) => mine[k]) };
}
