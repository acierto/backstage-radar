import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractMentions } from '../src/mentions.mjs';
import { classify } from '../site/logic.js';

test('mentions: users and org teams, ignoring code, quotes and emails', () => {
  const md = [
    'Hey @Acierto can you look? cc @backstage/scaffolder-maintainers',
    '> @someone-quoted said this earlier',
    '`@in-code` and ```\n@in-block\n```',
    'mail me at foo@example.com, also @other/team-x',
    'thanks @bob.',
  ].join('\n');
  const { users, teams } = extractMentions(md, 'backstage');
  assert.deepEqual(users.sort(), ['acierto', 'bob']);
  assert.deepEqual(teams, ['scaffolder-maintainers']);
});

const base = { n: 1, t: 'issue', title: 'x', url: '', author: 'alice', draft: false, labels: [], created: '2026-10-01T00:00:00Z', updated: '', reviewers: [], teams: [] };
const prefs = { user: 'acierto', areas: ['scaffolder'], teams: ['scaffolder-maintainers'] };

test('mention without follow-up -> reply', () => {
  const item = { ...base, ev: [['2026-10-01T00:00:00Z', 'alice', 'open'], ['2026-10-02T00:00:00Z', 'bob', 'c', ['acierto']]] };
  assert.equal(classify(item, prefs).bucket, 'reply');
});

test('mention answered -> not reply (and not relevant outside areas)', () => {
  const item = { ...base, ev: [['2026-10-02T00:00:00Z', 'bob', 'c', ['acierto']], ['2026-10-03T00:00:00Z', 'acierto', 'c']] };
  assert.equal(classify(item, prefs), null);
});

test('team review request counts as a ping', () => {
  const item = { ...base, t: 'pr', teams: ['scaffolder-maintainers'], ev: [['2026-10-02T00:00:00Z', 'alice', 'rr', [], ['scaffolder-maintainers']]] };
  assert.equal(classify(item, prefs).bucket, 'reply');
});

test('area items: untouched / activity / waiting', () => {
  const labels = ['area:scaffolder'];
  assert.equal(classify({ ...base, labels, ev: [['2026-10-01T00:00:00Z', 'alice', 'open']] }, prefs).bucket, 'untouched');
  assert.equal(
    classify({ ...base, labels, ev: [['2026-10-01T00:00:00Z', 'acierto', 'c'], ['2026-10-02T00:00:00Z', 'alice', 'c']] }, prefs).bucket,
    'activity',
  );
  assert.equal(
    classify({ ...base, labels, ev: [['2026-10-01T00:00:00Z', 'alice', 'c'], ['2026-10-02T00:00:00Z', 'acierto', 'c']] }, prefs).bucket,
    'waiting',
  );
});

test('areas: all matches any item; other areas do not', () => {
  const item = { ...base, labels: ['area:catalog'], ev: [['2026-10-01T00:00:00Z', 'alice', 'open']] };
  assert.equal(classify(item, prefs), null);
  assert.equal(classify(item, { ...prefs, areas: ['all'] }).bucket, 'untouched');
});

test('own item with reply from someone else -> mine', () => {
  const item = { ...base, author: 'acierto', ev: [['2026-10-01T00:00:00Z', 'acierto', 'open'], ['2026-10-02T00:00:00Z', 'bob', 'c']] };
  assert.equal(classify(item, prefs).bucket, 'mine');
});

test('mentions: a comment addressed to someone else only references you', () => {
  const r = extractMentions("Hi @djanickova, can you run with what @acierto shared here? I'm going to assign this issue to you 👍", 'backstage');
  assert.deepEqual(r.users, ['djanickova']);
  assert.deepEqual(r.refs, ['acierto']);
});

test('mentions: direct asks still count', () => {
  assert.deepEqual(extractMentions('@acierto what do you think?').users, ['acierto']);
  assert.deepEqual(extractMentions('Thanks @bob! @acierto can you review?').users.sort(), ['acierto', 'bob']);
  assert.deepEqual(extractMentions('Looks good to me, maybe @acierto has an opinion on the API?').users, ['acierto']);
  assert.deepEqual(extractMentions('Hey @bob,\nsee below.\n@acierto could you check the docs part?').users.sort(), ['acierto', 'bob']);
});

test('mentions: cc / fyi lines are references', () => {
  const r = extractMentions('Fixed the flaky test.\n\ncc @acierto @kim');
  assert.deepEqual(r.users, []);
  assert.deepEqual(r.refs.sort(), ['acierto', 'kim']);
});

test('a reaction from you on the pinging comment clears the ping', () => {
  const ev = [['2026-10-02T00:00:00Z', 'bob', 'c', ['acierto'], [], ['acierto']]];
  assert.equal(classify({ ...base, ev }, { user: 'acierto', areas: [] }), null);
  const evNoAck = [['2026-10-02T00:00:00Z', 'bob', 'c', ['acierto'], [], ['kim']]];
  assert.equal(classify({ ...base, ev: evNoAck }, { user: 'acierto', areas: [] }).bucket, 'reply');
});
