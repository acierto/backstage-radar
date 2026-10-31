import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

const DEFAULTS = {
  repo: 'backstage/backstage',
  dashboardUrl: '',
  bots: [],
  limits: { comments: 40, reviews: 20, issuesPage: 50, pullsPage: 20 },
  digest: { lookbackHours: 24, maxItemsPerBucket: 15 },
};

export async function loadConfig(path = 'config.yml') {
  const raw = parse(await readFile(path, 'utf8')) || {};
  return {
    ...DEFAULTS,
    ...raw,
    limits: { ...DEFAULTS.limits, ...raw.limits },
    digest: { ...DEFAULTS.digest, ...raw.digest },
  };
}

export async function loadSubscribers(path = 'subscribers.yml') {
  const raw = parse(await readFile(path, 'utf8')) || {};
  return (raw.subscribers || []).map((s) => ({
    user: String(s.user).toLowerCase(),
    areas: (s.areas || []).map((a) => String(a).toLowerCase()),
    teams: (s.teams || []).map((t) => String(t).toLowerCase()),
    digest: s.digest !== false,
  }));
}
