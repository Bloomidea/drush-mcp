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

export function resolveFileUploadConfig(site: SiteConfig): Required<FileUploadConfig> {
  return { ...FILE_UPLOAD_DEFAULTS, ...(site.file_upload ?? {}) };
}

export interface DrushMcpConfig {
  sites: Record<string, SiteConfig>;
  defaults?: {
    timeout?: number;
    drush?: string;
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
