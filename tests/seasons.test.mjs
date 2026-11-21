import assert from 'node:assert/strict';
import test from 'node:test';
import { createSeasons, parseDate, seasonOf, sydneyDate, today, untilSydneyMidnight } from '../js/seasons.js';

const day = (text) => parseDate(text);

test('each season starts and ends on its days, and not the day either side', () => {
  const cases = [
    ['2026-10-31', null], ['2026-11-01', 'november'], ['2026-11-30', 'november'],
    ['2026-12-01', 'december'], ['2026-12-26', 'december'], ['2026-12-27', 'new-year'],
    ['2027-01-15', 'new-year'], ['2027-01-16', null], ['2026-06-15', null]
  ];
  for (const [text, season] of cases) assert.equal(seasonOf(day(text)), season, text);
});

test('New Year runs across the end of the year', () => {
  for (const text of ['2026-12-27', '2026-12-31', '2027-01-01', '2027-01-15', '2028-01-01']) assert.equal(seasonOf(day(text)), 'new-year', text);
  assert.equal(seasonOf(day('2027-02-01')), null);
});

test("the date is Sydney's, whatever the player's own time zone", () => {
  // 21 November 2026, 14:30 UTC: 1:30 on the 22nd in Sydney (AEDT, UTC+11), 14:30 on the 21st in London, 6:30 in Los Angeles
  const now = new Date(Date.UTC(2026, 10, 21, 14, 30));
  assert.deepEqual(sydneyDate(now), { y: 2026, m: 11, d: 22 });
  for (const zone of ['Europe/London', 'America/Los_Angeles']) {
    const there = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    assert.equal(there, '2026-11-21', zone);
    assert.deepEqual(sydneyDate(now), { y: 2026, m: 11, d: 22 }, `a player in ${zone}`);
  }
  // The evening of 30 November in London is already December in Sydney
  const evening = new Date(Date.UTC(2026, 10, 30, 20, 0));
  assert.equal(today({ search: '', now: evening }).season, 'december');
  // New Year's Eve in Los Angeles, morning: New Year's Day in Sydney
  assert.deepEqual(sydneyDate(new Date(Date.UTC(2026, 11, 31, 18, 0))), { y: 2027, m: 1, d: 1 });
  // In winter Sydney is UTC+10: 14:30 UTC on 15 July is half past midnight on the 16th
  assert.deepEqual(sydneyDate(new Date(Date.UTC(2026, 6, 15, 14, 30))), { y: 2026, m: 7, d: 16 });
});

test('?date= sets the date, and ?season=off turns the seasons off', () => {
  const now = new Date(Date.UTC(2026, 5, 1, 2, 0)); // June: no season
  assert.equal(today({ search: '', now }).season, null);
  assert.deepEqual(today({ search: '?date=2026-12-10', now }), { date: { y: 2026, m: 12, d: 10 }, season: 'december', fixed: true, off: false });
  assert.equal(today({ search: '?date=2026-11-20', now }).season, 'november');
  assert.equal(today({ search: '?date=2026-11-20&season=off', now }).season, null);
  assert.equal(today({ search: '?season=off', now: new Date(Date.UTC(2026, 10, 10)) }).season, null);
  // A date that isn't one is ignored: today's is used
  for (const bad of ['2026-13-01', '2026-02-30', 'tomorrow', '2026/12/10']) {
    assert.equal(parseDate(bad), null, bad);
    assert.equal(today({ search: `?date=${bad}`, now }).fixed, false, bad);
  }
});

test('midnight in Sydney is found from any moment', () => {
  // 23:59:30 in Sydney (AEDT): 30 s to go
  assert.equal(untilSydneyMidnight(new Date(Date.UTC(2026, 10, 21, 12, 59, 30))), 30000);
  // Noon in Sydney: 12 hours
  assert.equal(untilSydneyMidnight(new Date(Date.UTC(2026, 10, 21, 1, 0, 0))), 12 * 3600000);
});

test("a season's module is started in its season only, stopped when the day moves on, and given the game's things", async () => {
  let clock = new Date(Date.UTC(2026, 10, 30, 12, 0, 0)); // 23:00 on 30 November in Sydney
  const started = [], stopped = [];
  let fire = null;
  const timers = { setTimeout: (f) => { fire = f; return 1; }, clearTimeout: () => { fire = null; } };
  const load = (id) => Promise.resolve({
    start(ctx) {
      started.push([id, ctx.season, ctx.marker, ctx.date.d]);
      let frames = 0;
      return {
        update() { frames++; },
        *work() { yield; return true; },
        state: () => ({ frames }),
        stop() { stopped.push(id); }
      };
    }
  });
  const seasons = createSeasons({ marker: 'game' }, { search: '', now: () => clock, load, timers });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(started, [['november', 'november', 'game', 30]]);
  seasons.update(0.016, 1);
  assert.equal(seasons.state().frames, 1);
  const job = seasons.work(0, 0);
  job.next();
  assert.deepEqual(job.next(), { value: true, done: true });
  // Midnight: December
  clock = new Date(Date.UTC(2026, 10, 30, 13, 0, 1));
  fire();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(stopped, ['november']);
  assert.deepEqual(started.map((s) => s[0]), ['november', 'december']);
  seasons.stop();
  assert.deepEqual(stopped, ['november', 'december']);

  // Out of season nothing is loaded; with ?season=off neither
  for (const [search, at] of [['', new Date(Date.UTC(2026, 5, 1))], ['?season=off', new Date(Date.UTC(2026, 10, 10))]]) {
    let asked = 0;
    const s = createSeasons({}, { search, now: () => at, load: () => { asked++; return null; }, timers });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(asked, 0, search || 'June');
    assert.equal(s.state().running, false);
    s.stop();
  }
});
