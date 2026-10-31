#!/usr/bin/env node
// Collects every OPEN issue and PR of the configured repo into site/data.json.
// One run serves everyone: the dashboard and the digest personalise from this file.
//
// Usage: GITHUB_TOKEN=... node src/collect.mjs [--out site/data.json]
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadConfig } from './config.mjs';
import { extractMentions } from './mentions.mjs';

const config = await loadConfig();
const [owner, name] = config.repo.split('/');
const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'site/data.json';
const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error('GITHUB_TOKEN is required');
  process.exit(1);
}

const ACTOR = `author { login }`;
// Who reacted to a comment. A reaction from the person it pings means "seen, no reply needed".
const REACTORS = `reactionGroups { reactors(first: 10) { nodes { ... on User { login } } } }`;
const COMMON = `
  number title url createdAt updatedAt body
  author { login }
  ${REACTORS}
  labels(first: 30) { nodes { name } }
  comments(last: ${config.limits.comments}) { nodes { ${ACTOR} createdAt body ${REACTORS} } }
`;

const ISSUES = `query($owner: String!, $name: String!, $cursor: String) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    issues(states: OPEN, first: ${config.limits.issuesPage}, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes { ${COMMON} }
    }
  }
}`;

const PULLS = `query($owner: String!, $name: String!, $cursor: String) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: ${config.limits.pullsPage}, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        ${COMMON}
        isDraft
        reviews(last: ${config.limits.reviews}) {
          nodes { ${ACTOR} submittedAt body ${REACTORS} comments(first: 20) { nodes { ${ACTOR} createdAt body } } }
        }
        commits(last: 10) { nodes { commit { committedDate authors(first: 1) { nodes { user { login } } } } } }
        reviewRequests(first: 15) {
          nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } } }
        }
        timelineItems(last: 15, itemTypes: [REVIEW_REQUESTED_EVENT]) {
          nodes { ... on ReviewRequestedEvent {
            createdAt actor { login }
            requestedReviewer { __typename ... on User { login } ... on Team { slug } }
          } }
        }
      }
    }
  }
}`;

async function gql(query, variables, attempt = 1) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { authorization: `bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'backstage-radar' },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  const retryable = res.status >= 500 || res.status === 403 || res.status === 429 || !json;
  if ((retryable || json?.errors) && attempt < 5) {
    const wait = 2000 * 2 ** attempt;
    console.warn(`GraphQL ${res.status} (attempt ${attempt}), retrying in ${wait / 1000}s`, json?.errors?.[0]?.message || '');
    await new Promise((r) => setTimeout(r, wait));
    return gql(query, variables, attempt + 1);
  }
  if (!res.ok || json?.errors) throw new Error(`GraphQL failed: ${res.status} ${text.slice(0, 500)}`);
  return json.data;
}

async function fetchAll(query, field) {
  const nodes = [];
  let cursor = null;
  for (;;) {
    const data = await gql(query, { owner, name, cursor });
    const conn = data.repository[field];
    nodes.push(...conn.nodes);
    process.stdout.write(`\r${field}: ${nodes.length} (rate limit left ${data.rateLimit.remaining})`);
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  process.stdout.write('\n');
  return nodes;
}

const bots = config.bots.map((b) => b.toLowerCase());
const isBot = (login) => !login || login.endsWith('[bot]') || bots.includes(login.toLowerCase());

function event(at, actor, kind, body, reactionGroups) {
  if (!at || isBot(actor)) return null;
  const { users, teams } = extractMentions(body || '', owner);
  // Keep only reactions from people this comment pings: that is all the dashboard needs.
  const reactors = new Set((reactionGroups || []).flatMap((g) => g.reactors?.nodes || []).map((u) => u?.login?.toLowerCase()).filter(Boolean));
  const acks = users.filter((u) => reactors.has(u));
  return [at, actor, kind, users, teams, acks];
}

function reviewer(r) {
  if (!r) return {};
  return r.__typename === 'Team' ? { team: r.slug?.toLowerCase() } : { user: r.login?.toLowerCase() };
}

function toItem(node, t) {
  const author = node.author?.login || 'ghost';
  const ev = [event(node.createdAt, author, 'open', node.body, node.reactionGroups)];
  for (const c of node.comments.nodes) ev.push(event(c.createdAt, c.author?.login, 'c', c.body, c.reactionGroups));

  const item = {
    n: node.number,
    t,
    title: node.title,
    url: node.url,
    author,
    draft: !!node.isDraft,
    labels: node.labels.nodes.map((l) => l.name),
    created: node.createdAt,
    updated: node.updatedAt,
    reviewers: [],
    teams: [],
  };

  if (t === 'pr') {
    for (const r of node.reviews.nodes) {
      ev.push(event(r.submittedAt, r.author?.login, 'r', r.body, r.reactionGroups));
      for (const c of r.comments.nodes) ev.push(event(c.createdAt, c.author?.login, 'rc', c.body));
    }
    for (const { commit } of node.commits.nodes) {
      const login = commit.authors.nodes[0]?.user?.login;
      if (login) ev.push(event(commit.committedDate, login, 'p', ''));
    }
    for (const rr of node.reviewRequests.nodes) {
      const { user, team } = reviewer(rr.requestedReviewer);
      if (user) item.reviewers.push(user);
      if (team) item.teams.push(team);
    }
    for (const e of node.timelineItems.nodes) {
      if (!e?.createdAt) continue;
      const { user, team } = reviewer(e.requestedReviewer);
      const actor = e.actor?.login || 'github';
      ev.push([e.createdAt, actor, 'rr', user ? [user] : [], team ? [team] : []]);
    }
  }

  item.ev = ev
    .filter(Boolean)
    .map((e) => trimEvent(e))
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return item;
}

// Keep the file small: drop empty trailing arrays.
// Shape: [at, actor, kind, mentionedUsers?, mentionedTeams?, usersWhoReacted?]
function trimEvent(e) {
  const [at, actor, kind, users, teams, acks] = e;
  if (acks?.length) return [at, actor, kind, users, teams || [], acks];
  if (teams?.length) return [at, actor, kind, users, teams];
  if (users?.length) return [at, actor, kind, users];
  return [at, actor, kind];
}

const started = Date.now();
const issues = await fetchAll(ISSUES, 'issues');
const pulls = await fetchAll(PULLS, 'pullRequests');

const items = [...issues.map((n) => toItem(n, 'issue')), ...pulls.map((n) => toItem(n, 'pr'))];
const areas = [...new Set(items.flatMap((i) => i.labels).filter((l) => l.startsWith('area:')).map((l) => l.slice(5)))].sort();

const data = {
  repo: config.repo,
  generatedAt: new Date().toISOString(),
  areas,
  items,
};

await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(data));
console.log(
  `Wrote ${out}: ${issues.length} issues, ${pulls.length} PRs, ${areas.length} areas in ${Math.round((Date.now() - started) / 1000)}s`,
);
