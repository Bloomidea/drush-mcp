import { describe, it, expect } from 'vitest';
import { SiteManager } from '../src/site-manager.js';
import { FILE_UPLOAD_DEFAULTS } from '../src/types.js';

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

describe('SiteManager.getFileUploadConfig', () => {
  const site = { name: 'atrium', transport: 'docker' as const, host: 'x.com', user: 'root', container: 'web' };

  it('falls back to the built-in defaults when nothing is configured', () => {
    const manager = new SiteManager({ sites: { atrium: site } });
    expect(manager.getFileUploadConfig('atrium')).toEqual(FILE_UPLOAD_DEFAULTS);
  });

  // The case this exists for: CLI flags define the site, so mergeConfig throws
  // the config file's sites away and `defaults` is the only place a per-machine
  // upload policy can land.
  it('applies defaults.file_upload to a site that declares none', () => {
    const manager = new SiteManager({
      sites: { atrium: site },
      defaults: { file_upload: { allowed_extensions: ['md', 'html'] } },
    });
    const resolved = manager.getFileUploadConfig('atrium');
    expect(resolved.allowed_extensions).toEqual(['md', 'html']);
    // Untouched keys keep the built-in value.
    expect(resolved.max_size).toBe(FILE_UPLOAD_DEFAULTS.max_size);
  });

  it('lets a site override the shared defaults key by key', () => {
    const manager = new SiteManager({
      sites: {
        atrium: { ...site, file_upload: { max_size: 42 } },
      },
      defaults: { file_upload: { allowed_extensions: ['md', 'html'], max_size: 99 } },
    });
    const resolved = manager.getFileUploadConfig('atrium');
    expect(resolved.max_size).toBe(42);
    expect(resolved.allowed_extensions).toEqual(['md', 'html']);
  });

  it('throws for an unknown site, like every other lookup here', () => {
    const manager = new SiteManager({ sites: { atrium: site } });
    expect(() => manager.getFileUploadConfig('nope')).toThrow(/not found/);
  });
});
