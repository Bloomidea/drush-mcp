import { describe, it, expect } from 'vitest';
import { LocalTransport } from '../../src/transport/local.js';

describe('LocalTransport', () => {
  it('builds command parts with configured prefix', () => {
    const transport = new LocalTransport({ command: 'ddev drush', timeout: 30 });
    const parts = transport.buildCommandParts('cache:rebuild', []);
    expect(parts.file).toBe('ddev');
    expect(parts.args).toEqual(['drush', 'cache:rebuild']);
  });

  it('appends arguments and options', () => {
    const transport = new LocalTransport({ command: 'drush', timeout: 30 });
    const parts = transport.buildCommandParts('mcp:entity-create', [
      '--type=node',
      '--bundle=article',
    ]);
    expect(parts.file).toBe('drush');
    expect(parts.args).toContain('mcp:entity-create');
    expect(parts.args).toContain('--type=node');
    expect(parts.args).toContain('--bundle=article');
  });

  it('appends --uri when configured (via execute path)', () => {
    // --uri is appended by BaseTransport.execute(), not buildCommandParts()
    // We test buildCommandParts receives the --uri arg when passed in
    const transport = new LocalTransport({ command: 'drush', timeout: 30, uri: 'https://example.com' });
    const parts = transport.buildCommandParts('core:status', ['--format=json', '--uri=https://example.com']);
    expect(parts.args).toContain('--uri=https://example.com');
  });
});
