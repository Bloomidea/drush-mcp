import { describe, it, expect } from 'vitest';
import { buildConfigGetArgs, buildConfigSetArgs } from '../../src/tools/system.js';
import { buildUserCreateArgs, buildUserBlockArgs } from '../../src/tools/user.js';
import { buildEntityDeleteArgs } from '../../src/tools/entity.js';

// Drush reads a leading dash as an option anywhere on the line, and global
// options such as --include load code from a directory.
describe('positional arguments from the agent', () => {
  it('refuse a value that Drush would read as an option', () => {
    expect(() => buildConfigGetArgs({ name: '--include=/tmp/x' })).toThrow(/must not start with "-"/);
    expect(() => buildConfigGetArgs({ name: 'system.site', key: '--root=/other' })).toThrow(/key must not start/);
    expect(() => buildConfigSetArgs({ name: '--uri=evil', key: 'k', value: 'v' })).toThrow(/name must not start/);
    expect(() => buildUserCreateArgs({ name: '--include=/tmp/x' })).toThrow(/name must not start/);
    expect(() => buildUserBlockArgs({ name: '-v' })).toThrow(/name must not start/);
    expect(() => buildEntityDeleteArgs({ entity_type: '--root=/x', id: 1 })).toThrow(/entity_type must not start/);
  });

  it('leave ordinary values, and a negative config value, alone', () => {
    expect(buildConfigGetArgs({ name: 'system.site', key: 'name' }).args).toEqual(['system.site', 'name']);
    expect(buildConfigSetArgs({ name: 'x.settings', key: 'offset', value: '-1' }).args).toEqual(['x.settings', 'offset', '-1', '-y']);
  });
});
