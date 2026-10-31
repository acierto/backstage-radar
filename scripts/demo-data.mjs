#!/usr/bin/env node
// Generates fake data in the same shape as src/collect.mjs, for trying the dashboard locally.
// Usage: node scripts/demo-data.mjs [--user acierto] [--out site/data.json]
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const me = arg('--user', 'acierto');
const out = arg('--out', 'site/data.json');

let seed = 42;
const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const DAY = 864e5;
const now = Date.now();

const areas = ['scaffolder', 'catalog', 'techdocs', 'auth', 'search', 'permission', 'kubernetes', 'events', 'notifications', 'framework', 'home', 'documentation'];
const people = ['jdoe', 'mkim', 'priya-r', 'tvos', 'lena-k', 'oscar-dev', 'sam-w', 'yuki-t', 'nina-b', 'raj-p', 'eli-m', 'ana-s'];
const verbs = ['Fix', 'Add support for', 'Allow', 'Improve', 'Refactor', 'Deprecate', 'Handle', 'Document'];
const things = {
  scaffolder: ['template parameters in dry-run', 'fetch:template filters', 'task log streaming', 'custom field extensions', 'retrying failed tasks', 'step conditionals', 'template editor preview', 'secrets in actions'],
  catalog: ['entity processing errors', 'location refresh', 'relations in entity page', 'provider pagination'],
  techdocs: ['mkdocs plugin config', 'search indexing for docs', 'addon rendering'],
  auth: ['OIDC refresh tokens', 'sign-in resolvers', 'session expiry'],
  search: ['collator batching', 'result highlighting'],
  permission: ['conditional decisions', 'policy debugging'],
  kubernetes: ['cluster locator auth', 'pod logs view'],
  events: ['webhook signatures'], notifications: ['email processor'], framework: ['new frontend system routes', 'backend service lifecycle'],
  home: ['customizable widgets'], documentation: ['plugin migration guide', 'getting started typos'],
};

const items = [];
for (let n = 31000; n < 31420; n++) {
  const t = rnd() < 0.55 ? 'pr' : 'issue';
  const area = rnd() < 0.08 ? null : rnd() < 0.18 ? 'scaffolder' : pick(areas);
  const labels = area ? [`area:${area}`] : [];
  if (t === 'issue') labels.push(pick(['bug', 'enhancement', 'help wanted']));
  const created = now - rnd() ** 1.6 * 90 * DAY;
  const author = rnd() < 0.04 ? me : pick(people);
  const ev = [[new Date(created).toISOString(), author, 'open']];
  let at = created;
  const count = Math.floor(rnd() ** 1.5 * 9);
  const meInvolved = area === 'scaffolder' ? 0.55 : 0.08;
  for (let k = 0; k < count && at < now - 3600e3; k++) {
    at += rnd() ** 2 * 12 * DAY;
    if (at > now) break;
    const r = rnd();
    let actor = pick(people.concat(author));
    if (r < meInvolved * 0.45) actor = me;
    const kind = t === 'pr' ? pick(['c', 'r', 'rc', 'p']) : 'c';
    const mentions = actor !== me && rnd() < (area === 'scaffolder' ? 0.22 : 0.03) ? [me] : undefined;
    ev.push(mentions ? [new Date(at).toISOString(), actor, kind, mentions] : [new Date(at).toISOString(), actor, kind]);
  }
  const reviewers = t === 'pr' && area === 'scaffolder' && rnd() < 0.15 ? [me] : [];
  const teams = t === 'pr' && area === 'scaffolder' && rnd() < 0.3 ? ['scaffolder-maintainers'] : [];
  items.push({
    n, t, title: `${area ? `${area}: ` : ''}${pick(verbs)} ${pick(things[area || 'framework'])}`,
    url: `https://github.com/backstage/backstage/${t === 'pr' ? 'pull' : 'issues'}/${n}`,
    author, draft: t === 'pr' && rnd() < 0.12, labels,
    created: ev[0][0], updated: ev[ev.length - 1][0], reviewers, teams, ev,
  });
}

const data = { repo: 'backstage/backstage (demo data)', generatedAt: new Date(now - 7 * 60e3).toISOString(), areas: [...areas].sort(), items };
await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(data));
console.log(`Wrote ${out} with ${items.length} fake items`);
