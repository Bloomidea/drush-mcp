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
});

describe('mergeConfig', () => {
  const fileConfig = {
    sites: {
      atrium: { name: 'atrium', transport: 'docker' as const, host: 'example.com', file_upload: { allowed_extensions: ['html'] } },
      local:  { name: 'local',  transport: 'local'  as const, command: 'ddev drush' },
    },
    defaults: { timeout: 45 },
  };

  it('uses the config file sites when the CLI defines no site', () => {
    const merged = mergeConfig(null, fileConfig, {});
    expect(Object.keys(merged.sites)).toEqual(['atrium', 'local']);
    expect(merged.sites.atrium.file_upload?.allowed_extensions).toEqual(['html']);
  });

  it('lets CLI flags win over the config file sites but keeps its defaults', () => {
    const merged = mergeConfig(parseCliArgs(['--local', '--command', 'drush']), fileConfig, {});
    expect(Object.keys(merged.sites)).toEqual(['default']);
    expect(merged.defaults?.timeout).toBe(45);
  });
});
