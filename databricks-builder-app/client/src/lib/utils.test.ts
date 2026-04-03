import { describe, expect, it } from 'vitest';

import { buildTraceHistoryEntries, mergeTraceHistoryEntries, shouldAutoScroll } from './utils';

describe('shouldAutoScroll', () => {
  it('returns true when already near the bottom', () => {
    expect(
      shouldAutoScroll({
        scrollTop: 620,
        clientHeight: 300,
        scrollHeight: 960,
      })
    ).toBe(true);
  });

  it('returns false when the user has scrolled away from the bottom', () => {
    expect(
      shouldAutoScroll({
        scrollTop: 200,
        clientHeight: 300,
        scrollHeight: 960,
      })
    ).toBe(false);
  });
});

describe('buildTraceHistoryEntries', () => {
  it('preserves executions that have no visible trace items', () => {
    const entries = buildTraceHistoryEntries(
      [
        { id: 'older', events: [{ type: 'thinking', thinking: 'first trace' }] },
        { id: 'newer', events: [] },
      ],
      (events) => events.map((event) => String((event as { type: string }).type))
    );

    expect(entries).toEqual([
      { executionId: 'newer', items: [] },
      { executionId: 'older', items: ['thinking'] },
    ]);
  });
});

describe('mergeTraceHistoryEntries', () => {
  it('keeps distinct empty trace slots when execution ids differ', () => {
    expect(
      mergeTraceHistoryEntries(
        [{ executionId: 'persisted-empty', items: [] }],
        [{ executionId: 'cached-empty', items: [] }]
      )
    ).toEqual([
      { executionId: 'persisted-empty', items: [] },
      { executionId: 'cached-empty', items: [] },
    ]);
  });

  it('updates an existing execution slot instead of appending a duplicate', () => {
    expect(
      mergeTraceHistoryEntries(
        [{ executionId: 'exec-1', items: [] }],
        [{ executionId: 'exec-1', items: ['thinking'] }]
      )
    ).toEqual([
      { executionId: 'exec-1', items: ['thinking'] },
    ]);
  });
});
