import { describe, it, expect } from 'vitest';
import { normalizeError } from '../src/errors.js';

describe('normalizeError', () => {
  it('wraps transport errors', () => {
    const result = normalizeError('transport', 'Connection refused', { site: 'prod' });
    expect(result).toEqual({
      error: 'transport_error',
      message: 'Connection refused',
      site: 'prod',
    });
  });

  it('wraps drush errors with exit code', () => {
    const result = normalizeError('drush', "Entity type 'nope' does not exist", {
      exitCode: 1,
      command: 'mcp:entity-create',
    });
    expect(result).toEqual({
      error: 'drush_error',
      message: "Entity type 'nope' does not exist",
      exit_code: 1,
      command: 'mcp:entity-create',
    });
  });

  it('parses validation error JSON from stderr', () => {
    const stderr = JSON.stringify({
      error: 'validation_error',
      violations: [{ field: 'title', message: 'This value should not be null.' }],
    });
    const result = normalizeError('drush', stderr, { exitCode: 1, command: 'mcp:entity-create' });
    expect(result).toEqual({
      error: 'validation_error',
      violations: [{ field: 'title', message: 'This value should not be null.' }],
    });
  });

  it('handles non-JSON stderr as drush error', () => {
    const result = normalizeError('drush', 'Something went wrong\nMore details', {
      exitCode: 1,
      command: 'cache:rebuild',
    });
    expect(result.error).toBe('drush_error');
    expect(result.message).toBe('Something went wrong\nMore details');
  });
});
