# Backstage Radar

A shared dashboard plus a daily digest that answers one question for everyone who works on
[backstage/backstage](https://github.com/backstage/backstage):

> **Where am I needed, and where haven't I replied yet?**

It replaces hundreds of GitHub notification emails with one page and at most one digest email per day.

## What it shows

Open the dashboard, type your GitHub login, and pick your areas (or **All areas** if you're a core maintainer).
Every open issue and PR is sorted into one of five buckets:

| Bucket | Meaning |
|---|---|
| **Needs your reply** | Someone @mentioned you (or your team) or requested your review, and you haven't commented, reviewed or pushed since. |
| **Activity on your items** | Your own issue/PR where someone else spoke last. |
| **New in your areas** | Open items with your `area:*` labels that you have never touched. |
| **New activity in your areas** | You took part earlier, and others posted after your last reply. |
| **Waiting on others** | In your areas, and the last word is yours. |

Three charts sit on top: how long things have been waiting on you, a per-area breakdown, and the last 30 days of activity (others vs you).
**Done** hides an item until something new happens on it. It's stored in your browser only.

Your settings live in the URL (`?user=acierto&areas=scaffolder,catalog&teams=scaffolder-maintainers`), so you can bookmark them or share them.

## How it works

```
GitHub Action (every 30 min)            GitHub Pages
  src/collect.mjs  ──►  data.json  ──►  site/index.html  (personalised in the browser)
                                         site/logic.js   (shared rules)
GitHub Action (weekdays 07:23)
  src/collect.mjs + src/digest.mjs ──►  a comment on each subscriber's digest issue
                                         (GitHub emails it to them)
```

* **One collection for everyone.** The job reads all open issues and PRs once through the GraphQL API: comments, reviews, review comments, pushes, review requests and labels. It keeps only *who did what, when, and whom they mentioned*, not the text.
* **Personalisation happens in the browser**, using the same `site/logic.js` that the daily digest uses. The page and the digest always agree.
* Mentions inside code blocks and quoted replies (`> @someone said…`) don't count as pings.
* Bot accounts (`*[bot]` plus the list in `config.yml`) never count as "someone replied".

## Setup (once, by whoever hosts it)

1. Create a repo (for example `backstage-radar`) and push this folder to `main`.
2. **Settings → Pages → Source: GitHub Actions.**
3. Run **Actions → Collect & publish dashboard → Run workflow**. After 2–3 minutes the dashboard is live at `https://<owner>.github.io/backstage-radar/`.
4. Put that URL in `config.yml → dashboardUrl` so digests link to it.
5. *(Recommended)* Add a `RADAR_TOKEN` secret: a fine-grained PAT with **public repositories, read-only** access. The built-in token works, but has a lower rate limit.

### Daily digest

Nothing to configure. Each weekday the **Daily digest** workflow posts a comment on a per-person
issue in this repo ("Daily digest for @login") that @mentions the subscriber, so **GitHub emails it to
their own address** under their own notification settings. No addresses or SMTP are stored anywhere.

* Links in the digest go through `redirect.github.com` (as Dependabot does), so backstage issues and PRs
  don't get "mentioned this" backlinks.
* Test it with **Actions → Daily digest → Run workflow → only: `your-login`**.

**Optional direct email.** For subscribers who set `email: true`, the digest is *also* sent by SMTP if
the host adds these secrets: `SMTP_URL` (e.g. `smtps://user:app-password@smtp.gmail.com:465`),
`MAIL_FROM`, and optionally `SUBSCRIBER_EMAILS` (`{"login": "address"}`; otherwise the public profile
email is used).

## Joining (for everyone else)

* **Dashboard only:** just open the URL. Nothing to sign up for.
* **Daily digest:** open a PR that adds yourself to `subscribers.yml`:

  ```yaml
  - user: your-login
    areas: [catalog, techdocs]   # or [all]
    teams: [catalog-maintainers] # optional: team pings count as yours
  ```

  Your issue appears with the first digest. **Close it to pause, reopen to resume.** A day with
  nothing to report gets no comment. The digest lists everything still waiting on you, plus new area
  items from the last 24h.

## Cut the email noise from GitHub itself

Once this is running you can safely set **Watch → Custom → (nothing) / Participating and @mentions** on backstage/backstage. The radar covers your areas, so you no longer need to watch the whole repo.

## Local development

```bash
npm install
npm test                        # classification + mention parsing tests
npm run demo-data               # fake data in site/data.json
npm run serve                   # http://localhost:8080/?user=acierto&areas=scaffolder

GITHUB_TOKEN=$(gh auth token) npm run collect   # real data (2–4 min)
npm run digest:dry              # writes out/digests/<user>.md instead of posting
```

## Limits worth knowing

* It reads the latest 40 comments and 20 reviews per item (configurable in `config.yml`). A mention buried earlier in a very long thread, with no later activity, can be missed.
* "Replied" means any comment, review, review comment, or pushed commit by you. A 👍 reaction does not count.
* Only **open** items are tracked. A closed issue is never "waiting on you".
* Team pings only count for teams you list in your settings.
