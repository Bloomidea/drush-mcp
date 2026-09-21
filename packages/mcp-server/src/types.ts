export interface TransportResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface FileUploadConfig {
  max_size?: number;
  allowed_extensions?: string[];
  default_uid?: number;
  destination_prefix?: string;
}

export interface SiteConfig {
  name: string;
  transport: 'local' | 'ssh' | 'docker';
  host?: string;
  user?: string;
  root?: string;
  container?: string;
  containerFilter?: string;  // Docker filter for dynamic container resolution
  command?: string;
  drush?: string;
  uri?: string;
  timeout?: number;
  file_upload?: FileUploadConfig;
}

export const FILE_UPLOAD_DEFAULTS: Required<FileUploadConfig> = {
  max_size:           10 * 1024 * 1024,
  allowed_extensions: ['txt', 'md', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'log', 'sql', 'json', 'yaml', 'yml', 'zip', 'tar', 'gz'],
  default_uid:        0,
  destination_prefix: 'mcp-uploads',
};

/**
 * Resolves the upload policy for one site.
 *
 * Three layers, each overriding the one before it key by key: the built-in
 * FILE_UPLOAD_DEFAULTS, then the config file's `defaults.file_upload`, then the
 * site's own block. The middle layer is what a server started from CLI flags
 * gets, because mergeConfig() keeps only `defaults` from the config file in
 * that case: a site built out of flags has no `file_upload` of its own and no
 * way to grow one.
 *
 * `allowed_extensions` replaces, it does not extend. Widening the list is a
 * decision about what an agent may write to a site, and an accidental union
 * with the built-in list is not that decision.
 */
export function resolveFileUploadConfig(
  site: SiteConfig,
  defaults?: FileUploadConfig,
): Required<FileUploadConfig> {
  return { ...FILE_UPLOAD_DEFAULTS, ...(defaults ?? {}), ...(site.file_upload ?? {}) };
}

export interface DrushMcpConfig {
  sites: Record<string, SiteConfig>;
  defaults?: {
    timeout?: number;
    drush?: string;
    file_upload?: FileUploadConfig;
  };
}

export interface DrushArgs {
  command: string;
  args: string[];
  jsonFormat?: boolean;
}

export interface DrushError {
  error: string;
  message?: string;
  exit_code?: number;
  command?: string;
  site?: string;
  violations?: Array<{ field: string; message: string }>;
}
