import { describe, it, expect } from 'vitest';
import { SiteManager } from '../src/site-manager.js';

describe('SiteManager', () => {
  it('returns the only site when no site param is given (single site)', () => {
    const manager = new SiteManager({
      sites: {
        prod: { name: 'prod', transport: 'ssh', host: 'example.com', user: 'deploy', root: '/app', timeout: 30 },
      },
    });
    const site = manager.resolve(undefined);
    expect(site.name).toBe('prod');
  });

  it('throws when no site param is given with multiple sites', () => {
    const manager = new SiteManager({
      sites: {
        prod: { name: 'prod', transport: 'ssh', host: 'a.com', user: 'x', root: '/app', timeout: 30 },
        staging: { name: 'staging', transport: 'ssh', host: 'b.com', user: 'x', root: '/app', timeout: 30 },
      },
    });
    expect(() => manager.resolve(undefined)).toThrow(/Available sites: prod, staging/);
  });

  it('resolves by name', () => {
    const manager = new SiteManager({
      sites: {
        prod: { name: 'prod', transport: 'ssh', host: 'a.com', user: 'x', root: '/app', timeout: 30 },
        staging: { name: 'staging', transport: 'ssh', host: 'b.com', user: 'x', root: '/app', timeout: 30 },
      },
    });
    const site = manager.resolve('staging');
    expect(site.name).toBe('staging');
  });

  it('throws for unknown site name', () => {
    const manager = new SiteManager({
      sites: {
        prod: { name: 'prod', transport: 'ssh', host: 'a.com', user: 'x', root: '/app', timeout: 30 },
      },
    });
    expect(() => manager.resolve('nope')).toThrow(/Site 'nope' not found/);
  });

  it('creates correct transport for each site type', () => {
    const manager = new SiteManager({
      sites: {
        local: { name: 'local', transport: 'local', command: 'ddev drush', timeout: 30 },
        remote: { name: 'remote', transport: 'ssh', host: 'x.com', user: 'root', root: '/app', timeout: 30 },
        docker: { name: 'docker', transport: 'docker', host: 'x.com', user: 'root', container: 'web', timeout: 30 },
      },
    });
    expect(manager.getTransport('local')).toBeDefined();
    expect(manager.getTransport('remote')).toBeDefined();
    expect(manager.getTransport('docker')).toBeDefined();
  });

  it('creates docker transport with containerFilter', () => {
    const manager = new SiteManager({
      sites: {
        prod: { name: 'prod', transport: 'docker', host: 'x.com', user: 'root', containerFilter: 'label=coolify.serviceName=web', timeout: 30 },
      },
    });
    expect(manager.getTransport('prod')).toBeDefined();
  });
});
