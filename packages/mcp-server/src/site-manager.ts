import type { DrushMcpConfig, FileUploadConfig, SiteConfig } from './types.js';
import { resolveFileUploadConfig } from './types.js';
import type { BaseTransport } from './transport/base.js';
import { LocalTransport } from './transport/local.js';
import { SshTransport } from './transport/ssh.js';
import { DockerTransport } from './transport/docker.js';

export class SiteManager {
  private sites: Map<string, SiteConfig>;
  private transports: Map<string, BaseTransport> = new Map();

  constructor(private config: DrushMcpConfig) {
    this.sites = new Map(Object.entries(config.sites));
  }

  resolve(siteName: string | undefined): SiteConfig {
    if (siteName) {
      const site = this.sites.get(siteName);
      if (!site) {
        throw new Error(`Site '${siteName}' not found. Available sites: ${this.listNames().join(', ')}`);
      }
      return site;
    }

    if (this.sites.size === 0) {
      throw new Error('No sites configured.');
    }

    if (this.sites.size === 1) {
      return this.sites.values().next().value!;
    }

    throw new Error(
      `Multiple sites configured. Specify a site. Available sites: ${this.listNames().join(', ')}`
    );
  }

  getTransport(siteName: string): BaseTransport {
    if (this.transports.has(siteName)) {
      return this.transports.get(siteName)!;
    }

    const site = this.sites.get(siteName);
    if (!site) throw new Error(`Site '${siteName}' not found.`);

    const timeout = site.timeout ?? this.config.defaults?.timeout ?? 30;
    const drush   = site.drush ?? this.config.defaults?.drush ?? 'vendor/bin/drush';
    let transport: BaseTransport;

    switch (site.transport) {
      case 'local':
        transport = new LocalTransport({ command: site.command ?? 'drush', timeout, uri: site.uri });
        break;
      case 'ssh':
        if (!site.host || !site.user || !site.root) {
          throw new Error(`Site '${siteName}' (ssh) requires host, user, and root.`);
        }
        transport = new SshTransport({ host: site.host, user: site.user, root: site.root, drush, timeout, uri: site.uri });
        break;
      case 'docker':
        if (!site.host || !site.user || (!site.container && !site.containerFilter)) {
          throw new Error(`Site '${siteName}' (docker) requires host, user, and either container or containerFilter.`);
        }
        transport = new DockerTransport({ host: site.host, user: site.user, container: site.container, containerFilter: site.containerFilter, drush, timeout, uri: site.uri });
        break;
      default:
        throw new Error(`Unknown transport type '${(site as SiteConfig).transport}' for site '${siteName}'.`);
    }

    this.transports.set(siteName, transport);
    return transport;
  }

  listNames(): string[] {
    return Array.from(this.sites.keys());
  }

  getSite(siteName: string): SiteConfig {
    const site = this.sites.get(siteName);
    if (!site) throw new Error(`Site '${siteName}' not found.`);
    return site;
  }

  /**
   * The upload policy in force for one site, defaults folded in.
   *
   * Lives here and not at the call site for the same reason `timeout` and
   * `drush` do in getTransport(): this class is the only thing holding both a
   * site and the config's `defaults`, and a fallback rule written twice drifts.
   */
  getFileUploadConfig(siteName: string): Required<FileUploadConfig> {
    return resolveFileUploadConfig(this.getSite(siteName), this.config.defaults?.file_upload);
  }
}
