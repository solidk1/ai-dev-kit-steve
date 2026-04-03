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
