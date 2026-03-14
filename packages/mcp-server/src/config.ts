import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { parse as parseYaml } from 'yaml';
import type { DrushMcpConfig, SiteConfig } from './types.js';

export function resolveTransportType(flags: Record<string, unknown>): SiteConfig['transport'] {
  if (flags.local) return 'local';
  if (flags.container || flags['container-filter'] || flags.containerFilter) return 'docker';
  if (flags.host) return 'ssh';
  return 'local';
}

export function parseCliArgs(args: string[]): DrushMcpConfig {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }

  const transport = resolveTransportType(flags);

  const site: SiteConfig = {
    name: 'default',
    transport,
    host: flags.host as string,
    user: flags.user as string,
    root: flags.root as string,
    container:       flags.container as string,
    containerFilter: flags['container-filter'] as string,
    command: (flags.command as string) ?? (transport === 'local' ? 'drush' : undefined),
    drush: flags.drush as string,
    uri: flags.uri as string,
    timeout: flags.timeout ? parseInt(flags.timeout as string, 10) : undefined,
  };

  return { sites: { default: site } };
}

export function loadConfigFile(path?: string): DrushMcpConfig | null {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '~';
  const candidates = path
    ? [path]
    : [resolve(process.cwd(), 'drush-mcp.yml'), resolve(home, '.drush-mcp.yml')];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const raw = readFileSync(candidate, 'utf-8');
      const parsed = parseYaml(raw) as DrushMcpConfig;
      for (const [name, site] of Object.entries(parsed.sites)) {
        site.name = name;
      }
      return parsed;
    }
  }
  return null;
}

export function loadConfigFromEnv(): Partial<SiteConfig> {
  return {
    host: process.env.DRUSH_MCP_HOST,
    user: process.env.DRUSH_MCP_USER,
    transport: process.env.DRUSH_MCP_TRANSPORT as SiteConfig['transport'],
    container:       process.env.DRUSH_MCP_CONTAINER,
    containerFilter: process.env.DRUSH_MCP_CONTAINER_FILTER,
    drush:           process.env.DRUSH_MCP_DRUSH,
  };
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function mergeConfig(
  cliConfig: DrushMcpConfig | null,
  fileConfig: DrushMcpConfig | null,
  envConfig: Partial<SiteConfig>,
): DrushMcpConfig {
  if (cliConfig && Object.keys(cliConfig.sites).length > 0) {
    const site = Object.values(cliConfig.sites)[0];
    return {
      sites: {
        [site.name]: { ...site, ...stripUndefined(envConfig), ...stripUndefined(site) },
      },
      defaults: fileConfig?.defaults,
    };
  }

  if (fileConfig) return fileConfig;

  if (envConfig.host || envConfig.transport) {
    const transport = resolveTransportType(envConfig);
    return {
      sites: {
        default: { name: 'default', transport, ...envConfig } as SiteConfig,
      },
    };
  }

  throw new Error('No site configuration found. Use CLI flags, a config file, or environment variables.');
}
