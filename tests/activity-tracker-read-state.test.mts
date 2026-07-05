// #4923 (a): persistent read-state — a returning user must see NEW tags
// for stories that arrived while away, instead of the first render
// blanket-marking everything seen.

import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Stub localStorage BEFORE the module under test reads it at import time.
const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};

const { activityTracker, READ_STATE_KEY } = await import('../src/services/activity-tracker.ts');

describe('persisted read-state (#4923)', () => {
  beforeEach(() => {
    store.clear();
    activityTracker.clear();
    activityTracker.reloadReadStateForTests();
  });

  it('reads the previous visit timestamp from localStorage', () => {
    store.set(READ_STATE_KEY, JSON.stringify({ v: 1, lastVisitAt: 1_751_000_000_000 }));
    activityTracker.reloadReadStateForTests();
    assert.equal(activityTracker.getPreviousVisitTime(), 1_751_000_000_000);
  });

  it('returns 0 (old behavior) when no state or corrupt state exists', () => {
    assert.equal(activityTracker.getPreviousVisitTime(), 0);
    store.set(READ_STATE_KEY, '{not json');
    activityTracker.reloadReadStateForTests();
    assert.equal(activityTracker.getPreviousVisitTime(), 0);
  });

  it('markAsSeen persists lastVisitAt so the NEXT session knows this one happened', () => {
    activityTracker.register('panel');
    activityTracker.updateItems('panel', ['a']);
    const before = Date.now();
    activityTracker.markAsSeen('panel');
    const raw = store.get(READ_STATE_KEY);
    assert.ok(raw, 'read-state must be written');
    const parsed = JSON.parse(raw!);
    assert.equal(parsed.v, 1);
    assert.ok(parsed.lastVisitAt >= before, 'lastVisitAt must be fresh');
  });

  it('markItemsSeen marks a subset and leaves the rest counted as new', () => {
    let reported = -1;
    activityTracker.register('panel');
    activityTracker.onChange('panel', (n) => { reported = n; });
    activityTracker.updateItems('panel', ['old1', 'old2', 'fresh']);
    activityTracker.markItemsSeen('panel', ['old1', 'old2']);
    assert.equal(activityTracker.getNewCount('panel'), 1, 'the unseen item stays new');
    assert.equal(reported, 1, 'onChange reports the remaining count');
    assert.equal(activityTracker.shouldHighlight('panel', 'fresh'), true);
    assert.equal(activityTracker.shouldHighlight('panel', 'old1'), false);
  });

  it('a second updateItems keeps subset-seen state intact', () => {
    activityTracker.register('panel');
    activityTracker.updateItems('panel', ['old1', 'fresh']);
    activityTracker.markItemsSeen('panel', ['old1']);
    const newIds = activityTracker.updateItems('panel', ['old1', 'fresh']);
    assert.deepEqual(newIds, ['fresh'], 'only the never-seen item reports as new');
  });
});

describe('NewsPanel first-render wiring (source-textual)', () => {
  const src = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../src/components/NewsPanel.ts'),
    'utf-8',
  );

  it('first render consults the previous visit instead of blanket-marking seen', () => {
    assert.match(src, /getPreviousVisitTime\(\)/, 'must read the persisted previous visit');
    assert.match(src, /markItemsSeen\(/, 'must use subset-seen, not markAsSeen(all)');
    assert.doesNotMatch(src, /First render: mark all items as seen/, 'old blanket branch must be gone');
  });

  it('read-state key is cloud-synced', () => {
    const syncSrc = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../src/utils/sync-keys.ts'),
      'utf-8',
    );
    assert.match(syncSrc, /'wm-read-state-v1'/);
  });
});
