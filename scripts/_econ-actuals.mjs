/**
 * #4922 (b): macro-print actuals — pure helpers.
 *
 * The economic calendar previously shipped every event with
 * actual:'', estimate:'', previous:'' forever — the print itself (the
 * single most market-moving datum) was never captured. FRED publishes
 * the values same-day in series observations; these helpers turn the
 * latest observations into event-ready actual/previous strings.
 *
 * Series/transform map (release calendars use RELEASE ids; values need
 * SERIES ids — they are different namespaces):
 *   - CPI / PCE / Retail Sales: index levels → month-over-month % change
 *   - Nonfarm Payrolls: level in thousands → monthly change in K
 *   - GDP: A191RL1Q225SBEA is already the headline annualized % change
 */

export const EVENT_SERIES = {
  CPI: { series: 'CPIAUCSL', transform: 'pct_mom' },
  'Nonfarm Payrolls': { series: 'PAYEMS', transform: 'diff_k' },
  GDP: { series: 'A191RL1Q225SBEA', transform: 'direct' },
  PCE: { series: 'PCEPI', transform: 'pct_mom' },
  'Retail Sales': { series: 'RSAFS', transform: 'pct_mom' },
};

/** FRED marks missing observations with the string '.'. */
function parseObs(observation) {
  const value = Number.parseFloat(observation?.value);
  return Number.isFinite(value) ? { date: observation.date, value } : null;
}

/**
 * @param {Array<{ date: string; value: string }>} observations DESC-sorted
 *   FRED observations (newest first).
 * @param {'pct_mom'|'diff_k'|'direct'} transform
 * @returns {{ actual: string; previous: string; obsDate: string }}
 *   Empty strings when there is not enough usable data.
 */
export function computePrintValues(observations, transform) {
  const usable = (Array.isArray(observations) ? observations : [])
    .map(parseObs)
    .filter(Boolean);
  const empty = { actual: '', previous: '', obsDate: '' };
  if (usable.length === 0) return empty;

  if (transform === 'direct') {
    return {
      actual: usable[0].value.toFixed(1),
      previous: usable.length > 1 ? usable[1].value.toFixed(1) : '',
      obsDate: usable[0].date,
    };
  }
  if (transform === 'diff_k') {
    if (usable.length < 2) return empty;
    const actual = usable[0].value - usable[1].value;
    const previous = usable.length > 2 ? usable[1].value - usable[2].value : null;
    return {
      actual: `${actual >= 0 ? '+' : ''}${Math.round(actual)}K`,
      previous: previous === null ? '' : `${previous >= 0 ? '+' : ''}${Math.round(previous)}K`,
      obsDate: usable[0].date,
    };
  }
  // pct_mom
  if (usable.length < 2 || usable[1].value === 0) return empty;
  const actual = (usable[0].value / usable[1].value - 1) * 100;
  const previous = usable.length > 2 && usable[2].value !== 0
    ? (usable[1].value / usable[2].value - 1) * 100
    : null;
  return {
    actual: `${actual >= 0 ? '+' : ''}${actual.toFixed(1)}%`,
    previous: previous === null ? '' : `${previous >= 0 ? '+' : ''}${previous.toFixed(1)}%`,
    obsDate: usable[0].date,
  };
}

/**
 * Fill actual/previous on calendar events whose print is available:
 * an event matches when its `event` name has a series mapping and its
 * date is today or earlier (the calendar window starts at today, so in
 * practice this fills print-day rows on the runs after the release).
 *
 * @returns {number} count of events filled.
 */
export function fillEventActuals(events, printsByEvent, todayISO) {
  let filled = 0;
  for (const event of Array.isArray(events) ? events : []) {
    if (event.actual) continue;
    const print = printsByEvent[event.event];
    if (!print || !print.actual) continue;
    if (typeof event.date === 'string' && event.date <= todayISO) {
      event.actual = print.actual;
      if (!event.previous && print.previous) event.previous = print.previous;
      filled++;
    }
  }
  return filled;
}
