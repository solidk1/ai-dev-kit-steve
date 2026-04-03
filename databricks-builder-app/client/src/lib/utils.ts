import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { formatDistanceToNow } from 'date-fns';
import type { TodoItem } from './types';

/**
 * Merge Tailwind CSS classes with clsx and tailwind-merge.
 * Standard shadcn/ui utility.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Format a date string or Date as relative time (e.g. "5 minutes ago").
 */
export function formatRelativeTime(date: string | Date): string {
  return formatDistanceToNow(new Date(date), { addSuffix: true });
}

/**
 * Normalize raw tool identifiers into a user-friendly display name.
 */
export function formatToolDisplayName(toolName: string | null | undefined): string {
  if (!toolName) return '';

  return toolName
    .replace(/^mcp__databricks__/, '')
    .replace(/^tool:/, '')
    .replace(/^tool_/, '')
    .replace(/_+$/, '')
    .replace(/@+$/, '');
}

/**
 * Extract structured todo items from a TodoWrite tool payload.
 */
export function getTodoItemsFromToolInput(
  toolName: string | null | undefined,
  toolInput: Record<string, unknown> | undefined,
): TodoItem[] | null {
  if (formatToolDisplayName(toolName) !== 'TodoWrite' || !toolInput) return null;
  const rawTodos = toolInput.todos;
  if (!Array.isArray(rawTodos)) return null;

  const todos = rawTodos.flatMap((rawTodo) => {
    if (!rawTodo || typeof rawTodo !== 'object') return [];
    const todo = rawTodo as Record<string, unknown>;
    const content = typeof todo.content === 'string' ? todo.content.trim() : '';
    const status = todo.status;
    if (
      !content ||
      (status !== 'pending' && status !== 'in_progress' && status !== 'completed')
    ) {
      return [];
    }
    return [{
      id: typeof todo.id === 'string' ? todo.id : undefined,
      content,
      status,
    }];
  });

  return todos.length > 0 ? todos : null;
}

/**
 * Extract the latest persisted todo list from execution events.
 */
export function getLatestTodosFromExecutionEvents(events: unknown[] | null | undefined): TodoItem[] {
  if (!Array.isArray(events)) return [];

  for (let idx = events.length - 1; idx >= 0; idx -= 1) {
    const rawEvent = events[idx];
    if (!rawEvent || typeof rawEvent !== 'object') continue;
    const event = rawEvent as Record<string, unknown>;
    if (event.type !== 'todos' || !Array.isArray(event.todos)) continue;

    const todos = event.todos.flatMap((rawTodo) => {
      if (!rawTodo || typeof rawTodo !== 'object') return [];
      const todo = rawTodo as Record<string, unknown>;
      const content = typeof todo.content === 'string' ? todo.content.trim() : '';
      const status = todo.status;
      if (
        !content ||
        (status !== 'pending' && status !== 'in_progress' && status !== 'completed')
      ) {
        return [];
      }
      return [{
        id: typeof todo.id === 'string' ? todo.id : undefined,
        content,
        status,
      }];
    });

    if (todos.length > 0) return todos;
  }

  return [];
}

/**
 * Returns true when the viewport is already close enough to the bottom that
 * new content should keep the scroll anchored there.
 */
export function shouldAutoScroll(
  metrics: { scrollTop: number; clientHeight: number; scrollHeight: number },
  threshold = 96
): boolean {
  const distanceFromBottom = metrics.scrollHeight - (metrics.scrollTop + metrics.clientHeight);
  return distanceFromBottom <= threshold;
}

export interface TraceHistoryEntry<T> {
  executionId: string;
  items: T[];
}

/**
 * Convert executions into trace history slots while preserving runs that did not
 * emit visible thinking or tool activity.
 */
export function buildTraceHistoryEntries<T>(
  executions: Array<{ id: string; events?: unknown[] | null }>,
  mapEvents: (events: unknown[]) => T[]
): TraceHistoryEntry<T>[] {
  return [...executions]
    .reverse()
    .map((execution) => ({
      executionId: execution.id,
      items: mapEvents(execution.events ?? []),
    }));
}

/**
 * Merge persisted and client-side trace history by execution id so multiple
 * "empty" traces remain distinct placeholders for message alignment.
 */
export function mergeTraceHistoryEntries<T>(
  persisted: TraceHistoryEntry<T>[],
  cached: TraceHistoryEntry<T>[]
): TraceHistoryEntry<T>[] {
  if (persisted.length === 0) return cached;
  if (cached.length === 0) return persisted;

  const merged = [...persisted];
  for (const entry of cached) {
    const existingIdx = merged.findIndex((candidate) => candidate.executionId === entry.executionId);
    if (existingIdx >= 0) {
      merged[existingIdx] = entry;
    } else {
      merged.push(entry);
    }
  }
  return merged;
}

export function alignTraceHistoryToMessages<T>(
  messages: Array<{ id: string; role: 'user' | 'assistant' }>,
  traces: TraceHistoryEntry<T>[]
): Record<string, TraceHistoryEntry<T> | null> {
  const assistantMessages = messages.filter((message) => message.role === 'assistant');
  const assistantOffset = Math.max(assistantMessages.length - traces.length, 0);
  const traceOffset = Math.max(traces.length - assistantMessages.length, 0);
  const aligned: Record<string, TraceHistoryEntry<T> | null> = {};

  assistantMessages.forEach((message, index) => {
    const traceIndex = index - assistantOffset + traceOffset;
    aligned[message.id] = traceIndex >= 0 && traceIndex < traces.length
      ? traces[traceIndex]
      : null;
  });

  return aligned;
}
