import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { configPathFromArgs, loadConfigFile, mergeConfig, parseCliArgs, resolveTransportType } from '../src/config.js';

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

describe('parseCliArgs without site flags', () => {
  it('returns null when no flag defines a site', () => {
    expect(parseCliArgs([])).toBeNull();
  });

  it('returns null when only --config is given', () => {
    expect(parseCliArgs(['--config', '/etc/drush-mcp.yml'])).toBeNull();
  });
});

describe('configPathFromArgs', () => {
  it('returns the --config value', () => {
    expect(configPathFromArgs(['--local', '--config', '/etc/drush-mcp.yml'])).toBe('/etc/drush-mcp.yml');
  });

  it('returns undefined when --config is absent', () => {
    expect(configPathFromArgs(['--local'])).toBeUndefined();
  });
});

describe('loadConfigFile', () => {
  it('loads sites with their names and file_upload block from an explicit path', () => {
    const dir  = mkdtempSync(join(tmpdir(), 'drush-mcp-'));
    const path = join(dir, 'drush-mcp.yml');
    writeFileSync(path, [
      'sites:',
      '  atrium:',
      '    transport: docker',
      '    host: example.com',
      '    file_upload:',
      '      allowed_extensions: [html, pdf]',
      '',
    ].join('\n'));
    const config = loadConfigFile(path);
    expect(config?.sites.atrium.name).toBe('atrium');
    expect(config?.sites.atrium.file_upload?.allowed_extensions).toEqual(['html', 'pdf']);
  });

  it('loads a defaults.file_upload block', () => {
    const dir  = mkdtempSync(join(tmpdir(), 'drush-mcp-'));
    const path = join(dir, 'drush-mcp.yml');
    writeFileSync(path, [
      'sites:',
      '  local:',
      '    transport: local',
      'defaults:',
      '  timeout: 45',
      '  file_upload:',
      '    allowed_extensions: [md, html]',
      '',
    ].join('\n'));
    const config = loadConfigFile(path);
    expect(config?.defaults?.file_upload?.allowed_extensions).toEqual(['md', 'html']);
  });

  // A file that only carries defaults is the normal shape once the sites come
  // from CLI flags, and Object.entries(undefined) throws.
  it('loads a file that has defaults and no sites at all', () => {
    const dir  = mkdtempSync(join(tmpdir(), 'drush-mcp-'));
    const path = join(dir, 'drush-mcp.yml');
    writeFileSync(path, [
      'defaults:',
      '  file_upload:',
      '    allowed_extensions: [md, html]',
      '',
    ].join('\n'));
    const config = loadConfigFile(path);
    expect(config?.defaults?.file_upload?.allowed_extensions).toEqual(['md', 'html']);
    expect(config?.sites).toEqual({});
  });

  it('returns null for an empty file rather than throwing', () => {
    const dir  = mkdtempSync(join(tmpdir(), 'drush-mcp-'));
    const path = join(dir, 'drush-mcp.yml');
    writeFileSync(path, '');
    expect(loadConfigFile(path)).toBeNull();
  });
});

describe('mergeConfig', () => {
  const fileConfig = {
    sites: {
      atrium: { name: 'atrium', transport: 'docker' as const, host: 'example.com', file_upload: { allowed_extensions: ['html'] } },
      local:  { name: 'local',  transport: 'local'  as const, command: 'ddev drush' },
    },
    defaults: { timeout: 45, file_upload: { allowed_extensions: ['md', 'html'] } },
  };

  it('uses the config file sites when the CLI defines no site', () => {
    const merged = mergeConfig(null, fileConfig, {});
    expect(Object.keys(merged.sites)).toEqual(['atrium', 'local']);
    expect(merged.sites.atrium.file_upload?.allowed_extensions).toEqual(['html']);
  });

  // A defaults-only file is the shape the README now recommends alongside CLI
  // flags. It must not shadow the environment-variable fallback for someone
  // who configures the site that way.
  it('falls through to env vars when the file carries defaults but no sites', () => {
    const defaultsOnly = { sites: {}, defaults: { file_upload: { allowed_extensions: ['md', 'html'] } } };
    const merged = mergeConfig(null, defaultsOnly, { host: 'example.com', transport: 'ssh' as const });
    expect(merged.sites.default.host).toBe('example.com');
    expect(merged.defaults?.file_upload?.allowed_extensions).toEqual(['md', 'html']);
  });

  it('still reports no configuration when a defaults-only file is all there is', () => {
    const defaultsOnly = { sites: {}, defaults: { timeout: 45 } };
    expect(() => mergeConfig(null, defaultsOnly, {})).toThrow(/No site configuration found/);
  });

  it('lets CLI flags win over the config file sites but keeps its defaults', () => {
    const merged = mergeConfig(parseCliArgs(['--local', '--command', 'drush']), fileConfig, {});
    expect(Object.keys(merged.sites)).toEqual(['default']);
    expect(merged.defaults?.timeout).toBe(45);
    // The site the flags built has no file_upload of its own, so defaults is
    // the only route an upload policy has into a flag-configured server.
    expect(merged.defaults?.file_upload?.allowed_extensions).toEqual(['md', 'html']);
  });
});
