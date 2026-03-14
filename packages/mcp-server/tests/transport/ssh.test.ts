import { describe, it, expect } from 'vitest';
import { SshTransport } from '../../src/transport/ssh.js';

describe('SshTransport', () => {
  it('builds ssh command parts with host and user', () => {
    const transport = new SshTransport({
      host: 'example.com',
      user: 'deploy',
      drush: 'vendor/bin/drush',
      root: '/var/www/html',
      timeout: 30,
    });
    const parts = transport.buildCommandParts('cache:rebuild', []);
    expect(parts.file).toBe('ssh');
    expect(parts.args[0]).toBe('deploy@example.com');
    expect(parts.args[1]).toContain('cd /var/www/html');
    expect(parts.args[1]).toContain('vendor/bin/drush cache:rebuild');
  });

  it('uses default drush path when not specified', () => {
    const transport = new SshTransport({
      host: 'example.com',
      user: 'root',
      root: '/app',
      timeout: 30,
    });
    const parts = transport.buildCommandParts('core:status', []);
    expect(parts.args[1]).toContain('vendor/bin/drush core:status');
  });
});
