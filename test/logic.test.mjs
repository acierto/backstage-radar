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
