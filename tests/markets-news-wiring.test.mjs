// #4922: markets↔news wiring — macro-print actuals, earnings into the
// daily market brief, and the finance-demotion seam.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EVENT_SERIES, computePrintValues, fillEventActuals } from '../scripts/_econ-actuals.mjs';
import { scoreImportance } from '../scripts/_clustering.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readSrc = (rel) => readFileSync(resolve(root, rel), 'utf-8');

describe('computePrintValues (#4922b)', () => {
  it('pct_mom: index levels become MoM % change with a previous period', () => {
    const obs = [
      { date: '2026-06-01', value: '321.5' },
      { date: '2026-05-01', value: '320.2' },
      { date: '2026-04-01', value: '319.9' },
    ];
    const out = computePrintValues(obs, 'pct_mom');
    assert.equal(out.actual, '+0.4%');
    assert.equal(out.previous, '+0.1%');
    assert.equal(out.obsDate, '2026-06-01');
  });

  it('diff_k: payroll levels become monthly change in K', () => {
    const obs = [
      { date: '2026-06-01', value: '159412' },
      { date: '2026-05-01', value: '159190' },
      { date: '2026-04-01', value: '159305' },
    ];
    const out = computePrintValues(obs, 'diff_k');
    assert.equal(out.actual, '+222K');
    assert.equal(out.previous, '-115K');
  });

  it('direct: headline % series passes through', () => {
    const out = computePrintValues([
      { date: '2026-04-01', value: '2.8' },
      { date: '2026-01-01', value: '3.1' },
    ], 'direct');
    assert.equal(out.actual, '2.8');
    assert.equal(out.previous, '3.1');
  });

  it("FRED '.' missing markers and short series degrade to empty strings", () => {
    assert.equal(computePrintValues([{ date: '2026-06-01', value: '.' }], 'pct_mom').actual, '');
    assert.equal(computePrintValues([{ date: '2026-06-01', value: '321.5' }], 'pct_mom').actual, '');
    assert.equal(computePrintValues([], 'direct').actual, '');
  });

  it('every mapped event has a series and transform', () => {
    for (const [event, mapping] of Object.entries(EVENT_SERIES)) {
      assert.ok(mapping.series.length > 2, `${event} series`);
      assert.ok(['pct_mom', 'diff_k', 'direct'].includes(mapping.transform), `${event} transform`);
    }
  });
});

describe('fillEventActuals (#4922b)', () => {
  const TODAY = '2026-07-06';

  it('fills print-day events and counts them; leaves future events empty', () => {
    const events = [
      { event: 'CPI', date: '2026-07-06', actual: '', previous: '' },
      { event: 'CPI', date: '2026-07-20', actual: '', previous: '' },
      { event: 'FOMC Rate Decision', date: '2026-07-06', actual: '', previous: '' },
    ];
    const filled = fillEventActuals(events, { CPI: { actual: '+0.3%', previous: '+0.2%' } }, TODAY);
    assert.equal(filled, 1);
    assert.equal(events[0].actual, '+0.3%');
    assert.equal(events[0].previous, '+0.2%');
    assert.equal(events[1].actual, '', 'future release stays empty');
    assert.equal(events[2].actual, '', 'unmapped event untouched');
  });

  it('never overwrites an existing actual', () => {
    const events = [{ event: 'CPI', date: '2026-07-06', actual: '+0.9%', previous: '' }];
    const filled = fillEventActuals(events, { CPI: { actual: '+0.3%', previous: '+0.2%' } }, TODAY);
    assert.equal(filled, 0);
    assert.equal(events[0].actual, '+0.9%');
  });
});

describe('finance demotion seam (#4922f)', () => {
  const financeCluster = {
    primaryTitle: 'Startup CEO announces record quarterly revenue and IPO plans',
    primarySource: 'TechCrunch',
    primaryLink: 'https://t/1',
    pubDate: new Date().toISOString(),
    sources: ['TechCrunch'],
    isAlert: false,
    tier: 3,
  };

  it('demotes finance-keyword clusters by default, ranks neutrally when disabled', () => {
    const demoted = scoreImportance({ ...financeCluster });
    const neutral = scoreImportance({ ...financeCluster }, { demoteFinance: false });
    assert.ok(neutral > demoted, `neutral (${neutral}) must exceed demoted (${demoted})`);
    assert.ok(Math.abs(demoted / neutral - 0.35) < 0.01, 'default demotion is the documented ×0.35');
  });
});

describe('wiring (source-textual)', () => {
  it('economic calendar publishes recentPrints and fills actuals', () => {
    const src = readSrc('scripts/seed-economic-calendar.mjs');
    assert.match(src, /fred\/series\/observations\?series_id=/);
    assert.match(src, /fillEventActuals\(events, printsByEvent, today\)/);
    assert.match(src, /recentPrints/);
  });

  it('daily market brief consumes earnings context in prompt and options', () => {
    const src = readSrc('src/services/daily-market-brief.ts');
    assert.match(src, /earningsContext\?: EarningsBriefContext/);
    assert.match(src, /Upcoming earnings \(14d\)/);
    const loader = readSrc('src/app/data-loader.ts');
    assert.match(loader, /_collectEarningsContext/);
    assert.match(loader, /listEarningsCalendar\(\{/);
  });
});
