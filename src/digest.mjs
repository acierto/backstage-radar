#!/usr/bin/env node
// Sends one daily email per subscriber, built from site/data.json.
//
// Env:
//   SMTP_URL            e.g. smtps://user:app-password@smtp.gmail.com:465
//   MAIL_FROM           e.g. "Backstage Radar <radar@example.com>"
//   SUBSCRIBER_EMAILS   JSON {"acierto": "me@example.com", ...} (kept as a secret, never committed)
//   GITHUB_TOKEN        optional; used to look up a public profile email when a login has no entry above
//
// Usage: node src/digest.mjs [--data site/data.json] [--dry-run] [--only acierto]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { loadConfig, loadSubscribers } from './config.mjs';
import { buildInbox, BUCKETS, humanAge, DAY } from '../site/logic.js';

const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const dryRun = process.argv.includes('--dry-run');
const only = arg('--only')?.toLowerCase();

const config = await loadConfig();
const data = JSON.parse(await readFile(arg('--data') || 'site/data.json', 'utf8'));
const subscribers = (await loadSubscribers()).filter((s) => s.digest && (!only || s.user === only));
const emails = JSON.parse(process.env.SUBSCRIBER_EMAILS || '{}');
const lowerEmails = Object.fromEntries(Object.entries(emails).map(([k, v]) => [k.toLowerCase(), v]));
const now = Date.now();
const cutoff = new Date(now - config.digest.lookbackHours * 60 * 60 * 1000).toISOString();

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function dashboardLink(s) {
  if (!config.dashboardUrl) return '';
  const q = new URLSearchParams({ user: s.user, areas: s.areas.join(',') });
  if (s.teams.length) q.set('teams', s.teams.join(','));
  return `${config.dashboardUrl}?${q}`;
}

function compose(s) {
  const rows = buildInbox(data, s);
  const sections = [];
  const pick = (bucket, recentOnly) =>
    rows.filter((r) => r.bucket === bucket && (!recentOnly || r.since >= cutoff));

  const plan = [
    ['reply', pick('reply', false)],
    ['mine', pick('mine', false)],
    ['untouched', pick('untouched', true)],
    ['activity', pick('activity', true)],
  ];
  const hasNews = plan.some(([, list]) => list.length);
  const fresh = plan.reduce((n, [, list]) => n + list.filter((r) => r.since >= cutoff).length, 0);
  if (!hasNews) return null;

  for (const [bucket, list] of plan) {
    if (!list.length) continue;
    const shown = list.slice(0, config.digest.maxItemsPerBucket);
    const recentNote = bucket === 'untouched' || bucket === 'activity' ? ' (last 24h)' : '';
    sections.push(`
      <h3 style="margin:24px 0 8px;font-size:15px">${esc(BUCKETS[bucket].title)}${recentNote} · ${list.length}</h3>
      <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:14px">
      ${shown
        .map(
          (r) => `<tr>
            <td style="padding:6px 0;border-top:1px solid #e1e0d9;vertical-align:top;width:56px;color:#52514e">${r.item.t === 'pr' ? 'PR' : 'Issue'}</td>
            <td style="padding:6px 0;border-top:1px solid #e1e0d9">
              <a href="${esc(r.item.url)}" style="color:#1c5cab;text-decoration:none">#${r.item.n} ${esc(r.item.title)}</a>
              <div style="color:#52514e;font-size:12px">${esc(r.reason)} · ${humanAge(r.since, now)} ago${r.since >= cutoff ? ' · <b>new</b>' : ''}</div>
            </td></tr>`,
        )
        .join('')}
      </table>
      ${list.length > shown.length ? `<p style="color:#52514e;font-size:12px">…and ${list.length - shown.length} more on the dashboard.</p>` : ''}`);
  }

  const link = dashboardLink(s);
  const replyCount = plan[0][1].length;
  const subject =
    replyCount > 0
      ? `[${data.repo}] ${replyCount} waiting for your reply${fresh ? `, ${fresh} new` : ''}`
      : `[${data.repo}] ${fresh} new in your areas`;
  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#0b0b0b;max-width:680px;margin:0 auto;padding:16px">
    <h2 style="margin:0 0 4px;font-size:18px">Your ${esc(data.repo)} digest</h2>
    <p style="margin:0;color:#52514e;font-size:13px">@${esc(s.user)} · areas: ${esc(s.areas.join(', ') || 'none')} · data from ${esc(new Date(data.generatedAt).toUTCString())}</p>
    ${link ? `<p><a href="${esc(link)}" style="color:#1c5cab">Open your dashboard →</a></p>` : ''}
    ${sections.join('')}
    <p style="margin-top:32px;color:#898781;font-size:12px">You get this because you are listed in subscribers.yml. Remove yourself there to stop it.</p>
  </body></html>`;
  return { subject, html };
}

async function publicEmail(login) {
  if (!process.env.GITHUB_TOKEN) return null;
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { authorization: `bearer ${process.env.GITHUB_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'query($l:String!){user(login:$l){email}}', variables: { l: login } }),
  });
  const json = await res.json().catch(() => null);
  return json?.data?.user?.email || null;
}

let transport = null;
if (!dryRun) {
  if (!process.env.SMTP_URL || !process.env.MAIL_FROM) {
    console.error('SMTP_URL and MAIL_FROM are required (or use --dry-run)');
    process.exit(1);
  }
  const nodemailer = (await import('nodemailer')).default;
  transport = nodemailer.createTransport(process.env.SMTP_URL);
}

let sent = 0;
for (const s of subscribers) {
  const mail = compose(s);
  if (!mail) {
    console.log(`@${s.user}: nothing to report, skipped`);
    continue;
  }
  if (dryRun) {
    await mkdir('out/digests', { recursive: true });
    await writeFile(`out/digests/${s.user}.html`, mail.html);
    console.log(`@${s.user}: "${mail.subject}" -> out/digests/${s.user}.html`);
    continue;
  }
  const to = lowerEmails[s.user] || (await publicEmail(s.user));
  if (!to) {
    console.warn(`@${s.user}: no email (add to SUBSCRIBER_EMAILS secret or make profile email public), skipped`);
    continue;
  }
  await transport.sendMail({ from: process.env.MAIL_FROM, to, subject: mail.subject, html: mail.html });
  sent++;
  console.log(`@${s.user}: sent "${mail.subject}"`);
}
console.log(`Done. ${sent} sent.`);
