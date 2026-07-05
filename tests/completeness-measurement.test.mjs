// #4920: completeness measurement — feed-health payload/silent-zeros,
// recall benchmark math, selection-gate drop stats, coverage-ledger and
// provenance wiring.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildFeedHealthPayload,
  isGoogleNewsWrapper,
  SILENT_ZERO_THRESHOLD,
} from '../scripts/_feed-health.mjs';
import { computeRecall } from '../scripts/_recall-benchmark-core.mjs';
import { selectTopStories } from '../scripts/_clustering.mjs';
import { extractServerFeeds } from '../scripts/validate-rss-feeds.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readSrc = (rel) => readFileSync(resolve(root, rel), 'utf-8');

const GN = 'https://news.google.com/rss/search?q=site%3Areuters.com&hl=en-US&gl=US&ceid=US:en';

describe('feed-health payload (#4920a)', () => {
  it('classifies wrappers and counts statuses', () => {
    const payload = buildFeedHealthPayload([
      { name: 'BBC', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', status: 'OK', catalog: 'both' },
      { name: 'Reuters GN', url: GN, status: 'EMPTY', catalog: 'server' },
      { name: 'Dead Feed', url: 'https://example.com/rss', status: 'DEAD', detail: 'Timeout (15s)' },
    ], null, 1_000);
    assert.equal(payload.summary.ok, 1);
    assert.equal(payload.summary.empty, 1);
    assert.equal(payload.summary.dead, 1);
    assert.equal(payload.feeds[GN].wrapper, true);
    assert.equal(payload.feeds[GN].consecutiveEmpty, 1);
    assert.deepEqual(payload.silentZeros, [], 'one empty run is not yet a silent zero');
  });

  it('silent zero fires for a wrapper after consecutive empty runs, and resets on recovery', () => {
    const run1 = buildFeedHealthPayload([{ name: 'R', url: GN, status: 'EMPTY' }], null, 1);
    const run2 = buildFeedHealthPayload([{ name: 'R', url: GN, status: 'EMPTY' }], run1, 2);
    assert.equal(run2.feeds[GN].consecutiveEmpty, SILENT_ZERO_THRESHOLD);
    assert.equal(run2.silentZeros.length, 1, 'wrapper empty across runs = silent zero');

    const run3 = buildFeedHealthPayload([{ name: 'R', url: GN, status: 'OK' }], run2, 3);
    assert.equal(run3.feeds[GN].consecutiveEmpty, 0, 'recovery resets the streak');
    assert.deepEqual(run3.silentZeros, []);
  });

  it('non-wrapper feeds never appear in silentZeros regardless of streak', () => {
    const url = 'https://example.com/rss';
    let prev = null;
    for (let i = 0; i < 4; i++) {
      prev = buildFeedHealthPayload([{ name: 'X', url, status: 'EMPTY' }], prev, i);
    }
    assert.equal(prev.feeds[url].consecutiveEmpty, 4);
    assert.deepEqual(prev.silentZeros, [], 'silent-zero is a wrapper-specific signal');
  });

  it('isGoogleNewsWrapper matches search wrappers only', () => {
    assert.equal(isGoogleNewsWrapper(GN), true);
    assert.equal(isGoogleNewsWrapper('https://feeds.bbci.co.uk/news/world/rss.xml'), false);
  });
});

describe('recall benchmark math (#4920c)', () => {
  const digest = [
    'Iran threatens to close Strait of Hormuz if US blockade continues',
    'Turkey hikes interest rates to 50% in surprise move',
    'Magnitude 6.8 earthquake strikes northern Chile',
  ];

  it('matches edit-variants of carried stories and reports misses with evidence', () => {
    const external = [
      { title: 'Iran threatens to close Strait of Hormuz — live updates', url: 'https://a' },
      { title: 'Turkey hikes rates to 50% in surprise move', url: 'https://b' },
      { title: 'Nigeria fuel subsidy protests spread to Lagos', url: 'https://c' },
    ];
    const result = computeRecall(external, digest);
    assert.equal(result.matched, 2);
    assert.equal(result.total, 3);
    assert.equal(result.recallPct, 66.7);
    assert.equal(result.missed.length, 1);
    assert.match(result.missed[0].title, /Nigeria/);
    assert.ok(result.missed[0].bestScore < result.threshold);
  });

  it('excludes unvectorizable external titles from the denominator', () => {
    const result = computeRecall(
      [{ title: '!!!' }, { title: 'Turkey hikes rates to 50% in surprise move' }],
      digest,
    );
    assert.equal(result.total, 1);
    assert.equal(result.unvectorizable, 1);
    assert.equal(result.recallPct, 100);
  });

  it('empty external set yields null recall, never NaN', () => {
    const result = computeRecall([], digest);
    assert.equal(result.recallPct, null);
  });
});

describe('selectTopStories drop stats (#4920b)', () => {
  const mkCluster = (title, source, sources = 1, score = 150) => ({
    primaryTitle: title,
    primarySource: source,
    primaryLink: 'https://x',
    pubDate: new Date().toISOString(),
    sources: Array.from({ length: sources }, (_, i) => `${source}-${i}`),
    // High tier + alert to clear admissibility deterministically
    isAlert: score > 100,
    tier: 1,
  });

  it('populates considered/admissibility/sourceCap counters', () => {
    const clusters = [
      mkCluster('Iran threatens Hormuz closure blockade', 'Reuters', 3),
      mkCluster('Turkey hikes interest rates surprise move', 'Reuters', 2),
      mkCluster('Chile earthquake magnitude strikes north', 'Reuters', 2),
      mkCluster('Kenya protests spread across Nairobi city', 'Reuters', 2),
      mkCluster('Totally inadmissible single-source story here', 'BlogX', 1, 10),
    ];
    // Make the last one inadmissible: single source, no alert, low score
    clusters[4].isAlert = false;
    const stats = {};
    const selected = selectTopStories(clusters, 8, stats);
    assert.equal(stats.considered, 5);
    assert.ok(stats.admissibilityDropped >= 1, 'single-source low-score cluster dropped');
    assert.ok(stats.sourceCapDropped >= 1, 'fourth same-source cluster hits MAX_PER_SOURCE=3');
    assert.ok(selected.length <= 8);
  });

  it('stats argument is optional (call sites without it keep working)', () => {
    assert.doesNotThrow(() => selectTopStories([], 8));
  });
});

describe('server catalog extraction (#4920a)', () => {
  it('extracts the digest feed catalog with rebuilt Google News URLs', () => {
    const feeds = extractServerFeeds();
    assert.ok(feeds.length > 250, `expected 250+ server feeds, got ${feeds.length}`);
    const wrapper = feeds.find((f) => f.url.includes('news.google.com'));
    assert.ok(wrapper, 'gn() URLs must be rebuilt');
    assert.match(wrapper.url, /^https:\/\/news\.google\.com\/rss\/search\?q=.+&hl=/);
    assert.ok(feeds.every((f) => f.catalog === 'server'));
  });
});

describe('coverage-ledger and provenance wiring (source-textual)', () => {
  it('digest counts every drop gate and publishes the ledger', () => {
    const src = readSrc('server/worldmonitor/news/v1/list-feed-digest.ts');
    assert.match(src, /droppedFeedCap = Math\.max\(0, matches\.length - ITEMS_PER_FEED\)/);
    assert.match(src, /ledgerDrops\.perCategoryCap \+= Math\.max\(0, items\.length - MAX_ITEMS_PER_CATEGORY\)/);
    assert.match(src, /ledgerDrops\.freshnessFloor = droppedStaleTotal/);
    assert.match(src, /news:coverage-ledger:v1/);
  });

  it('insights payload carries provenance and the panel renders it', () => {
    const seedSrc = readSrc('scripts/seed-insights.mjs');
    assert.match(seedSrc, /storiesConsidered: normalizedItems\.length/);
    assert.match(seedSrc, /selectTopStories\(clusters, 8, selectionStats\)/);
    const panelSrc = readSrc('src/components/InsightsPanel.ts');
    assert.match(panelSrc, /components\.insights\.compiledFrom/);
    const en = JSON.parse(readSrc('src/locales/en.json'));
    assert.match(en.components.insights.compiledFrom, /\{\{stories\}\}.*\{\{sources\}\}/);
  });

  it('both completeness keys are registered in health surfaces', () => {
    const seedHealth = readSrc('api/seed-health.js');
    assert.match(seedHealth, /'news:feed-health'/);
    assert.match(seedHealth, /'news:recall-benchmark'/);
    const health = readSrc('api/health.js');
    assert.match(health, /news:feed-health:v1/);
    assert.match(health, /seed-meta:news:recall-benchmark/);
  });

  it('workflow passes Upstash secrets to both publishers', () => {
    const wf = readSrc('.github/workflows/feed-validation.yml');
    assert.match(wf, /UPSTASH_REDIS_REST_URL/);
    assert.match(wf, /seed-recall-benchmark\.mjs/);
  });
});
