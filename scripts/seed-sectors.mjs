#!/usr/bin/env node

// Sector summary seeder (self-host). Upstream, market:sectors:v2 is written only
// by seedSectorSummary() in ais-relay.cjs when the relay has Upstash credentials —
// which the self-hosted relay never has, so the Sector Heatmap panel starved.
// Mirrors the relay's payload shape: { sectors, valuations }. The client requires
// the `valuations` FIELD to exist (empty {} is fine) — see shouldCache in
// src/services/market/index.ts.

import { loadEnvFile, loadSharedConfig, runSeed, sleep, CHROME_UA } from './_seed-utils.mjs';
import { fetchYahooJson } from './_yahoo-fetch.mjs';

const sectorConfig = loadSharedConfig('sectors.json');

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'market:sectors:v2';
const CACHE_TTL = 7200; // match relay MARKET_SEED_TTL — survives a missed 30-min run
const YAHOO_DELAY_MS = 200;

const SECTOR_SYMBOLS = sectorConfig.sectors.map((s) => s.symbol);
const SECTOR_NAMES = new Map(sectorConfig.sectors.map((s) => [s.symbol, s.name]));

async function fetchFinnhubQuote(symbol, apiKey) {
  try {
    const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA, 'X-Finnhub-Token': apiKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data.c === 0 && data.h === 0 && data.l === 0) return null;
    if (typeof data.dp !== 'number' || !Number.isFinite(data.dp)) return null;
    return data.dp;
  } catch (err) {
    console.warn(`  [Finnhub] ${symbol} error: ${err.message}`);
    return null;
  }
}

async function fetchYahooChange(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
    const chart = await fetchYahooJson(url, { label: symbol });
    const result = chart?.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta) return null;
    const price = meta.regularMarketPrice;
    const prevClose = meta.chartPreviousClose || meta.previousClose;
    if (typeof price !== 'number' || !prevClose) return null;
    return +(((price - prevClose) / prevClose) * 100).toFixed(2);
  } catch (err) {
    console.warn(`  [Yahoo] ${symbol} error: ${err.message}`);
    return null;
  }
}

// Same field extraction as ais-relay.cjs parseSectorValuation — requires at
// least one PE figure, otherwise the valuation row is dropped.
function parseSectorValuation(sd, ks) {
  const raw = (obj) => (typeof obj === 'object' && obj !== null ? (obj.raw ?? obj.fmt ?? null) : (typeof obj === 'number' ? obj : null));
  const num = (v) => {
    const n = typeof v === 'string' ? parseFloat(v) : v;
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
  };
  const tpe = num(raw(sd.trailingPE));
  const fpe = num(raw(sd.forwardPE));
  const beta = num(raw(sd.beta)) ?? num(raw(ks.beta3Year));
  const ytd = num(raw(ks.ytdReturn));
  const y3 = num(raw(ks.threeYearAverageReturn));
  const y5 = num(raw(ks.fiveYearAverageReturn));
  if (tpe === null && fpe === null) return null;
  return { trailingPE: tpe, forwardPE: fpe, beta, ytdReturn: ytd, threeYearReturn: y3, fiveYearReturn: y5 };
}

// quoteSummary (unlike the chart API) rejects anonymous requests with 401 —
// it needs Yahoo's A3 cookie + matching crumb, fetched once per run.
let _yahooAuth = null; // { cookie, crumb } | false once the handshake has failed

async function getYahooAuth() {
  if (_yahooAuth !== null) return _yahooAuth || null;
  try {
    // fc.yahoo.com 404s but still sets the A3 cookie — don't check resp.ok.
    const resp = await fetch('https://fc.yahoo.com', {
      headers: { 'User-Agent': CHROME_UA },
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    const cookie = (resp.headers.get('set-cookie') || '').split(';')[0];
    if (!cookie) throw new Error('no A3 cookie in response');
    const crumbResp = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': CHROME_UA, Cookie: cookie },
      signal: AbortSignal.timeout(10_000),
    });
    const crumb = (await crumbResp.text()).trim();
    if (!crumbResp.ok || !crumb || crumb.includes('<')) throw new Error(`crumb fetch failed (HTTP ${crumbResp.status})`);
    _yahooAuth = { cookie, crumb };
  } catch (err) {
    console.warn(`  [Yahoo:auth] cookie/crumb unavailable: ${err.message}`);
    _yahooAuth = false;
  }
  return _yahooAuth || null;
}

async function fetchYahooValuation(symbol) {
  try {
    const auth = await getYahooAuth();
    if (!auth) return null;
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=summaryDetail,defaultKeyStatistics&crumb=${encodeURIComponent(auth.crumb)}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json', Cookie: auth.cookie },
      signal: AbortSignal.timeout(12_000),
    });
    if (!resp.ok) {
      console.warn(`  [Yahoo:valuation] ${symbol} HTTP ${resp.status}`);
      return null;
    }
    const data = await resp.json();
    const result = data?.quoteSummary?.result?.[0];
    if (!result) return null;
    return parseSectorValuation(result.summaryDetail || {}, result.defaultKeyStatistics || {});
  } catch (err) {
    console.warn(`  [Yahoo:valuation] ${symbol} error: ${err.message}`);
    return null;
  }
}

async function fetchSectorSummary() {
  const sectors = [];
  const finnhubKey = process.env.FINNHUB_API_KEY;

  if (finnhubKey) {
    const results = await Promise.all(SECTOR_SYMBOLS.map((s) => fetchFinnhubQuote(s, finnhubKey)));
    for (let i = 0; i < SECTOR_SYMBOLS.length; i++) {
      const change = results[i];
      if (change !== null) {
        const symbol = SECTOR_SYMBOLS[i];
        sectors.push({ symbol, name: SECTOR_NAMES.get(symbol) ?? symbol, change });
        console.log(`  [Finnhub] ${symbol}: ${change > 0 ? '+' : ''}${change}%`);
      }
    }
  }

  const covered = new Set(sectors.map((s) => s.symbol));
  for (const symbol of SECTOR_SYMBOLS) {
    if (covered.has(symbol)) continue;
    const change = await fetchYahooChange(symbol);
    if (change !== null) {
      sectors.push({ symbol, name: SECTOR_NAMES.get(symbol) ?? symbol, change });
      console.log(`  [Yahoo] ${symbol}: ${change > 0 ? '+' : ''}${change}%`);
    }
    await sleep(YAHOO_DELAY_MS);
  }

  if (sectors.length === 0) {
    throw new Error(`All ${SECTOR_SYMBOLS.length} sector quote fetches failed`);
  }

  const valuations = {};
  let valCount = 0;
  for (const symbol of SECTOR_SYMBOLS) {
    const parsed = await fetchYahooValuation(symbol);
    if (parsed) {
      valuations[symbol] = parsed;
      valCount++;
    }
    await sleep(YAHOO_DELAY_MS);
  }
  console.log(`  Sectors: ${sectors.length}/${SECTOR_SYMBOLS.length}, valuations: ${valCount}/${SECTOR_SYMBOLS.length}`);

  return { sectors, valuations };
}

function validate(data) {
  return Array.isArray(data?.sectors) && data.sectors.length >= 1
    && typeof data?.valuations === 'object' && data.valuations !== null;
}

export function declareRecords(data) {
  return Array.isArray(data?.sectors) ? data.sectors.length : 0;
}

runSeed('market', 'sectors', CANONICAL_KEY, fetchSectorSummary, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'finnhub+yahoo-chart',

  declareRecords,
  schemaVersion: 1,
  maxStaleMin: 30,
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
