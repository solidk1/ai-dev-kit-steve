import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { formatDistanceToNow } from 'date-fns';

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
