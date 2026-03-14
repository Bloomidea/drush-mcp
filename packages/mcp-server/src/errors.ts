import type { DrushError } from './types.js';

interface ErrorContext {
  exitCode?: number;
  command?: string;
  site?: string;
}

export function normalizeError(
  type: 'transport' | 'drush',
  message: string,
  context: ErrorContext = {},
): DrushError {
  if (type === 'transport') {
    return {
      error: 'transport_error',
      message,
      site: context.site,
    };
  }

  // Try to parse stderr as JSON (bridge commands return structured errors)
  try {
    const parsed = JSON.parse(message);
    if (parsed.error === 'validation_error' && Array.isArray(parsed.violations)) {
      return parsed as DrushError;
    }
  } catch {
    // Not JSON, treat as plain drush error
  }

  return {
    error: 'drush_error',
    message,
    exit_code: context.exitCode,
    command: context.command,
  };
}
