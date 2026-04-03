import { describe, expect, it } from 'vitest';

import {
  alignTraceHistoryToMessages,
  buildTraceHistoryEntries,
  getTodoItemsFromToolInput,
  getLatestTodosFromExecutionEvents,
  mergeTraceHistoryEntries,
  shouldAutoScroll,
} from './utils';

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

describe('alignTraceHistoryToMessages', () => {
  it('aligns traces from the end so earlier assistant messages without traces do not shift later ones', () => {
    const aligned = alignTraceHistoryToMessages(
      [
        { id: 'u1', role: 'user' as const },
        { id: 'a1', role: 'assistant' as const },
        { id: 'u2', role: 'user' as const },
        { id: 'a2', role: 'assistant' as const },
      ],
      [{ executionId: 'exec-2', items: ['thinking'] }]
    );

    expect(aligned).toEqual({
      a1: null,
      a2: { executionId: 'exec-2', items: ['thinking'] },
    });
  });

  it('preserves one-to-one ordering when trace count matches assistant message count', () => {
    const aligned = alignTraceHistoryToMessages(
      [
        { id: 'a1', role: 'assistant' as const },
        { id: 'a2', role: 'assistant' as const },
      ],
      [
        { executionId: 'exec-1', items: [] },
        { executionId: 'exec-2', items: ['thinking'] },
      ]
    );

    expect(aligned).toEqual({
      a1: { executionId: 'exec-1', items: [] },
      a2: { executionId: 'exec-2', items: ['thinking'] },
    });
  });
});

describe('getTodoItemsFromToolInput', () => {
  it('extracts structured todo items from TodoWrite input', () => {
    expect(
      getTodoItemsFromToolInput('tool:TodoWrite@', {
        todos: [
          { id: '1', content: 'Test dashboard SQL queries', status: 'pending' },
          { id: '2', content: 'Build and deploy Hisense dashboard', status: 'in_progress' },
        ],
      })
    ).toEqual([
      { id: '1', content: 'Test dashboard SQL queries', status: 'pending' },
      { id: '2', content: 'Build and deploy Hisense dashboard', status: 'in_progress' },
    ]);
  });

  it('ignores invalid payloads and non-todo tools', () => {
    expect(getTodoItemsFromToolInput('execute_sql', { todos: [] })).toBeNull();
    expect(getTodoItemsFromToolInput('TodoWrite', { todos: [{ content: '', status: 'pending' }] })).toBeNull();
  });
});

describe('getLatestTodosFromExecutionEvents', () => {
  it('returns the latest valid todos event from stored execution events', () => {
    expect(
      getLatestTodosFromExecutionEvents([
        { type: 'todos', todos: [{ content: 'older', status: 'pending' }] },
        { type: 'text', text: 'hello' },
        { type: 'todos', todos: [{ content: 'newer', status: 'completed' }] },
      ])
    ).toEqual([
      { content: 'newer', status: 'completed' },
    ]);
  });

  it('returns an empty array when no valid todos event exists', () => {
    expect(getLatestTodosFromExecutionEvents([{ type: 'text', text: 'hello' }])).toEqual([]);
  });
});
