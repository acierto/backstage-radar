#!/usr/bin/env node
// Daily digest for everyone in subscribers.yml, built from site/data.json.
//
// Default delivery: a comment on a per-person issue in THIS repo ("Daily digest for @login") that
// @mentions them, so GitHub emails it to their own address. No addresses or SMTP needed.
// Closing your digest issue pauses it; reopening resumes it.
//
// Optional direct email for subscribers with `email: true`:
//   SMTP_URL, MAIL_FROM, SUBSCRIBER_EMAILS (JSON {"login": "address"}) — falls back to public profile email.
//
// Env:   POST_TOKEN (or GITHUB_TOKEN) with issues:write on this repo; GITHUB_REPOSITORY=owner/name
// Usage: node src/digest.mjs [--data site/data.json] [--dry-run] [--only acierto]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { loadConfig, loadSubscribers } from './config.mjs';
import { buildInbox, BUCKETS, humanAge, withoutBots } from '../site/logic.js';

const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const dryRun = process.argv.includes('--dry-run');
const only = arg('--only')?.toLowerCase().replace(/^@/, '');

const config = await loadConfig();
// The digest never counts bot activity (Copilot reviews, Dependabot, …) as replies or pings.
const data = withoutBots(JSON.parse(await readFile(arg('--data') || 'site/data.json', 'utf8')));
const subscribers = (await loadSubscribers()).filter((s) => (only ? s.user === only : s.digest));
const now = Date.now();
const cutoff = new Date(now - config.digest.lookbackHours * 60 * 60 * 1000).toISOString();
const token = process.env.POST_TOKEN || process.env.GITHUB_TOKEN;
const selfRepo = process.env.GITHUB_REPOSITORY || config.selfRepo;
const LABEL = 'radar-digest';

// ---------- content ----------
function dashboardLink(s) {
  if (!config.dashboardUrl) return '';
  const q = new URLSearchParams({ user: s.user, areas: s.areas.join(',') });
  if (s.teams.length) q.set('teams', s.teams.join(','));
  return `${config.dashboardUrl}?${q}`;
}

/** Returns null when there is nothing to report. */
function compose(s) {
  const rows = buildInbox(data, s);
  const pick = (bucket, recentOnly) => rows.filter((r) => r.bucket === bucket && (!recentOnly || r.since >= cutoff));
  const sections = [
    { bucket: 'reply', rows: pick('reply', false), note: '' },
    { bucket: 'mine', rows: pick('mine', false), note: '' },
    { bucket: 'untouched', rows: pick('untouched', true), note: ` (last ${config.digest.lookbackHours}h)` },
    { bucket: 'activity', rows: pick('activity', true), note: ` (last ${config.digest.lookbackHours}h)` },
  ].filter((x) => x.rows.length);
  if (!sections.length) return null;
  const fresh = sections.reduce((n, x) => n + x.rows.filter((r) => r.since >= cutoff).length, 0);
  const replyCount = sections.find((x) => x.bucket === 'reply')?.rows.length || 0;
  const subject = replyCount
    ? `${replyCount} waiting for your reply${fresh ? `, ${fresh} new` : ''}`
    : `${fresh} new in your areas`;
  return { sections, subject, link: dashboardLink(s) };
}

const max = () => config.digest.maxItemsPerBucket;

// Posting github.com issue URLs in another repo adds "mentioned this" backlinks to the original
// backstage issue/PR. redirect.github.com links (what Dependabot uses) open the same page without that.
const noBacklink = (url) => url.replace('https://github.com/', 'https://redirect.github.com/');
// Keep titles from pinging people/teams (@x) or linking issues in this repo (#123).
const ZW = '​';
const ZW_HASH = `#${ZW}`;
const quiet = (text) => text.replace(/[[\]]/g, '').replace(/@/g, `@${ZW}`).replace(/#(?=\d)/g, ZW_HASH);

function toMarkdown(s, d) {
  const date = new Date(now).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  const out = [`@${s.user} — **${d.subject}** · ${date}`, ''];
  if (d.link) out.push(`[Open your dashboard →](${d.link})`, '');
  for (const sec of d.sections) {
    out.push(`#### ${BUCKETS[sec.bucket].title}${sec.note} · ${sec.rows.length}`);
    for (const r of sec.rows.slice(0, max())) {
      const kind = r.item.t === 'pr' ? 'PR' : 'Issue';
      const isNew = r.since >= cutoff ? ' · **new**' : '';
      out.push(`- ${kind} [${ZW_HASH}${r.item.n} ${quiet(r.item.title)}](${noBacklink(r.item.url)}) — ${quiet(r.reason.replace(/@/g, ''))} · ${humanAge(r.since, now)} ago${isNew}`);
    }
    if (sec.rows.length > max()) out.push(`- …and ${sec.rows.length - max()} more on the dashboard`);
    out.push('');
  }
  out.push('<sub>Close this issue to pause your digest, reopen to resume. Change areas in subscribers.yml.</sub>');
  return out.join('\n');
}

const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function toHtml(s, d) {
  const body = d.sections
    .map(
      (sec) => `<h3 style="margin:24px 0 8px;font-size:15px">${esc(BUCKETS[sec.bucket].title)}${esc(sec.note)} · ${sec.rows.length}</h3>
      <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:14px">${sec.rows
        .slice(0, max())
        .map(
          (r) => `<tr><td style="padding:6px 0;border-top:1px solid #e1e0d9;width:56px;color:#52514e;vertical-align:top">${r.item.t === 'pr' ? 'PR' : 'Issue'}</td>
          <td style="padding:6px 0;border-top:1px solid #e1e0d9"><a href="${esc(r.item.url)}" style="color:#1c5cab;text-decoration:none">#${r.item.n} ${esc(r.item.title)}</a>
          <div style="color:#52514e;font-size:12px">${esc(r.reason)} · ${humanAge(r.since, now)} ago${r.since >= cutoff ? ' · <b>new</b>' : ''}</div></td></tr>`,
        )
        .join('')}</table>${sec.rows.length > max() ? `<p style="color:#52514e;font-size:12px">…and ${sec.rows.length - max()} more on the dashboard.</p>` : ''}`,
    )
    .join('');
  return `<!doctype html><html><body style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#0b0b0b;max-width:680px;margin:0 auto;padding:16px">
    <h2 style="margin:0 0 4px;font-size:18px">Your ${esc(data.repo)} digest</h2>
    <p style="margin:0;color:#52514e;font-size:13px">@${esc(s.user)} · areas: ${esc(s.areas.join(', ') || 'none')}</p>
    ${d.link ? `<p><a href="${esc(d.link)}" style="color:#1c5cab">Open your dashboard →</a></p>` : ''}${body}</body></html>`;
}

// ---------- GitHub issue delivery ----------
async function gh(method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'backstage-radar',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok && !(method === 'POST' && path.endsWith('/labels') && res.status === 422)) {
    throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
}

let issueIndex = null;
async function digestIssues() {
  if (issueIndex) return issueIndex;
  issueIndex = new Map();
  for (let page = 1; ; page++) {
    const list = await gh('GET', `/repos/${selfRepo}/issues?labels=${LABEL}&state=all&per_page=100&page=${page}`);
    for (const i of list) {
      const m = /Daily digest for @([\w-]+)/i.exec(i.title);
      if (m && !i.pull_request) issueIndex.set(m[1].toLowerCase(), i);
    }
    if (list.length < 100) break;
  }
  return issueIndex;
}

async function postToIssue(s, markdown) {
  await gh('POST', `/repos/${selfRepo}/labels`, { name: LABEL, color: '2a78d6', description: 'Personal Backstage Radar digest' });
  const issues = await digestIssues();
  let issue = issues.get(s.user);
  if (issue?.state === 'closed') return 'paused (issue closed)';
  if (!issue) {
    issue = await gh('POST', `/repos/${selfRepo}/issues`, {
      title: `Daily digest for @${s.user}`,
      labels: [LABEL],
      body: [
        `Personal ${data.repo} digest for @${s.user}. Each weekday a comment lands here and GitHub emails it to you.`,
        '',
        `* Areas: ${s.areas.join(', ') || 'none'}${s.teams.length ? ` · teams: ${s.teams.join(', ')}` : ''} (edit in \`subscribers.yml\`)`,
        config.dashboardUrl ? `* Dashboard: ${dashboardLink(s)}` : '',
        '* **Close this issue to pause** the digest; reopen to resume.',
      ].filter(Boolean).join('\n'),
    });
    issues.set(s.user, issue);
  }
  await gh('POST', `/repos/${selfRepo}/issues/${issue.number}/comments`, { body: markdown });
  return `commented on #${issue.number}`;
}

// ---------- optional SMTP ----------
let transport;
async function sendEmail(s, d) {
  if (!process.env.SMTP_URL || !process.env.MAIL_FROM) return 'email skipped (SMTP not configured)';
  const emails = Object.fromEntries(Object.entries(JSON.parse(process.env.SUBSCRIBER_EMAILS || '{}')).map(([k, v]) => [k.toLowerCase(), v]));
  let to = emails[s.user];
  if (!to && token) {
    const r = await gh('GET', `/users/${s.user}`).catch(() => null);
    to = r?.email;
  }
  if (!to) return 'email skipped (no address)';
  if (!transport) transport = (await import('nodemailer')).default.createTransport(process.env.SMTP_URL);
  await transport.sendMail({ from: process.env.MAIL_FROM, to, subject: `[${data.repo}] ${d.subject}`, html: toHtml(s, d) });
  return 'emailed';
}

// ---------- run ----------
if (!dryRun && (!token || !selfRepo)) {
  console.error('POST_TOKEN/GITHUB_TOKEN and GITHUB_REPOSITORY are required (or use --dry-run)');
  process.exit(1);
}
let failures = 0;
for (const s of subscribers) {
  const d = compose(s);
  if (!d) {
    console.log(`@${s.user}: nothing to report`);
    continue;
  }
  const md = toMarkdown(s, d);
  if (dryRun) {
    await mkdir('out/digests', { recursive: true });
    await writeFile(`out/digests/${s.user}.md`, md);
    if (s.email) await writeFile(`out/digests/${s.user}.html`, toHtml(s, d));
    console.log(`@${s.user}: "${d.subject}" -> out/digests/${s.user}.md`);
    continue;
  }
  try {
    const results = [await postToIssue(s, md)];
    if (s.email) results.push(await sendEmail(s, d));
    console.log(`@${s.user}: ${d.subject} — ${results.join(', ')}`);
  } catch (err) {
    failures++;
    console.error(`@${s.user}: failed — ${err.message}`);
  }
}
if (failures) process.exit(1);
