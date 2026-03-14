import { describe, it, expect } from 'vitest';
import { parseCliArgs, resolveTransportType } from '../src/config.js';

describe('parseCliArgs', () => {
  it('parses --local --command into local transport config', () => {
    const args = ['--local', '--command', 'ddev drush'];
    const result = parseCliArgs(args);
    expect(result.sites.default.transport).toBe('local');
    expect(result.sites.default.command).toBe('ddev drush');
  });

  it('parses --host --user --container into docker transport config', () => {
    const args = ['--host', '176.9.125.8', '--user', 'root', '--container', 'atrium-web'];
    const result = parseCliArgs(args);
    expect(result.sites.default.transport).toBe('docker');
    expect(result.sites.default.host).toBe('176.9.125.8');
    expect(result.sites.default.container).toBe('atrium-web');
  });

  it('parses --host --user without --container as ssh transport', () => {
    const args = ['--host', 'example.com', '--user', 'deploy', '--root', '/var/www/html'];
    const result = parseCliArgs(args);
    expect(result.sites.default.transport).toBe('ssh');
  });
});

describe('resolveTransportType', () => {
  it('returns local when --local flag is set', () => {
    expect(resolveTransportType({ local: true })).toBe('local');
  });

  it('returns docker when container is specified', () => {
    expect(resolveTransportType({ host: 'x', container: 'y' })).toBe('docker');
  });

  it('returns ssh when host is specified without container', () => {
    expect(resolveTransportType({ host: 'x' })).toBe('ssh');
  });
});
