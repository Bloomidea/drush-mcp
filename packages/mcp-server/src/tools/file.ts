import { createHash } from 'crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'fs';
import { homedir } from 'os';
import { basename, isAbsolute, join, sep } from 'path';
import type { DrushArgs, FileUploadConfig } from '../types.js';

export interface FileUploadInput {
  content_base64?: string;
  content_path?:   string;
  filename:        string;
  scheme?:         'public' | 'private' | 'temporary';
  destination?:    string;
  uid?:            number;
}

export interface FileAttachInput extends FileUploadInput {
  entity_type: string;
  entity_id:   number;
  field_name:  string;
  mode?:       'append' | 'replace';
  alt?:        string;
  title?:      string;
}

export interface FileDrushArgs extends DrushArgs {
  stdin: Buffer;
}

export class FilePreflightError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'FilePreflightError';
  }
}

function defaultDestination(prefix: string): string {
  const now    = new Date();
  const year   = now.getUTCFullYear();
  const month  = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${prefix}/${year}-${month}`;
}

function extensionOf(filename: string): string {
  const idx = filename.lastIndexOf('.');
  return idx >= 0 ? filename.slice(idx + 1).toLowerCase() : '';
}

function decodeBase64(content: string, maxSize: number): Buffer {
  // Reject non-base64 characters (Buffer.from with 'base64' silently ignores).
  if (!/^[A-Za-z0-9+/=\s]*$/.test(content)) {
    throw new FilePreflightError('INVALID_BASE64', 'content_base64 contains non-base64 characters');
  }
  const buf = Buffer.from(content, 'base64');
  // Round-trip check: re-encoding should match (modulo whitespace).
  const reencoded = buf.toString('base64');
  const stripped  = content.replace(/\s+/g, '');
  if (reencoded.replace(/=+$/, '') !== stripped.replace(/=+$/, '')) {
    throw new FilePreflightError('INVALID_BASE64', 'content_base64 is not valid base64 (round-trip mismatch)');
  }
  if (buf.byteLength > maxSize) {
    throw new FilePreflightError(
      'SIZE_EXCEEDED',
      `payload is ${buf.byteLength} bytes, max_size is ${maxSize} bytes`,
    );
  }
  return buf;
}

/**
 * The configured content_roots as real directories: `~` expanded, symlinks
 * resolved, missing ones dropped. Both sides of the containment check have to
 * be real paths, or `/tmp/x` would fail against a root that resolved to
 * `/private/tmp` on macOS.
 */
function realRoots(roots: string[]): string[] {
  const real: string[] = [];
  for (const root of roots) {
    const expanded = root === '~' ? homedir() : root.startsWith('~/') ? join(homedir(), root.slice(2)) : root;
    if (!isAbsolute(expanded)) {
      throw new FilePreflightError('CONFIG_ERROR', `content_roots entry "${root}" must be an absolute path or start with ~/`);
    }
    try {
      real.push(realpathSync.native(expanded));
    } catch {
      // A root that does not exist admits nothing.
    }
  }
  return real;
}

function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Reads a file named by the agent from the machine running this server.
 *
 * Before 0.5.1 any absolute path was read, and the extension allowlist looked
 * at `filename` alone, so `content_path: ~/.ssh/id_rsa, filename: key.txt`
 * shipped a private key to the site. The path now has to resolve, symlinks
 * followed, inside one of `content_roots`, and the file it resolves to has to
 * carry an allowed extension of its own.
 */
function readBufferFromPath(rawPath: string, fileConfig: Required<FileUploadConfig>): Buffer {
  if (!isAbsolute(rawPath)) {
    throw new FilePreflightError('PATH_NOT_ABSOLUTE', 'content_path must be an absolute path');
  }

  let real: string;
  try {
    real = realpathSync.native(rawPath);
  } catch (err) {
    throw new FilePreflightError('PATH_NOT_FOUND', `content_path not readable: ${(err as Error).message}`);
  }

  const roots = realRoots(fileConfig.content_roots);
  if (!roots.some((root) => isInside(real, root))) {
    const allowed = fileConfig.content_roots.length > 0 ? fileConfig.content_roots.join(', ') : 'none, content_path is disabled';
    throw new FilePreflightError(
      'PATH_OUTSIDE_ROOTS',
      `content_path resolves to ${real}, outside the content_roots this site allows (${allowed}). Copy the file into one of them, or add a root under file_upload.content_roots in drush-mcp.yml.`,
    );
  }

  // Read through a descriptor opened on the checked path without following a
  // final symlink, so a link swapped in after the check is refused rather
  // than read. O_NONBLOCK keeps a FIFO from hanging the open; fstat then
  // turns it away as not a regular file.
  let fd: number;
  try {
    fd = openSync(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (err) {
    throw new FilePreflightError('PATH_NOT_FOUND', `content_path not readable: ${(err as Error).message}`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new FilePreflightError('PATH_NOT_FILE', 'content_path is not a regular file');
    }
    const ext = extensionOf(basename(real));
    if (!ext || !fileConfig.allowed_extensions.includes(ext)) {
      throw new FilePreflightError(
        'EXTENSION_FORBIDDEN',
        `content_path resolves to ${real}, whose extension "${ext}" is not in the configured allowlist`,
      );
    }
    if (stat.size > fileConfig.max_size) {
      throw new FilePreflightError(
        'SIZE_EXCEEDED',
        `file is ${stat.size} bytes, max_size is ${fileConfig.max_size} bytes`,
      );
    }
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readContentBuffer(input: FileUploadInput, fileConfig: Required<FileUploadConfig>): Buffer {
  const hasB64  = typeof input.content_base64 === 'string' && input.content_base64.length > 0;
  const hasPath = typeof input.content_path   === 'string' && input.content_path.length   > 0;

  if (hasB64 && hasPath) {
    throw new FilePreflightError(
      'VALIDATION_ERROR',
      'provide either content_base64 or content_path, not both',
    );
  }
  if (!hasB64 && !hasPath) {
    throw new FilePreflightError(
      'VALIDATION_ERROR',
      'either content_base64 or content_path is required',
    );
  }
  if (hasPath) {
    return readBufferFromPath(input.content_path!, fileConfig);
  }
  return decodeBase64(input.content_base64!, fileConfig.max_size);
}

export function preflight(input: FileUploadInput, fileConfig: Required<FileUploadConfig>): { buf: Buffer; sha256: string } {
  if (!input.filename || input.filename.trim() === '') {
    throw new FilePreflightError('VALIDATION_ERROR', 'filename is required');
  }
  if (input.filename.includes('/') || input.filename.includes('\\')) {
    throw new FilePreflightError('VALIDATION_ERROR', 'filename must not contain path separators');
  }
  const buf = readContentBuffer(input, fileConfig);
  const ext = extensionOf(input.filename);
  if (!ext) {
    throw new FilePreflightError('EXTENSION_FORBIDDEN', 'filename has no extension');
  }
  if (!fileConfig.allowed_extensions.includes(ext)) {
    throw new FilePreflightError(
      'EXTENSION_FORBIDDEN',
      `extension "${ext}" is not in the configured allowlist`,
    );
  }
  const sha256 = createHash('sha256').update(buf).digest('hex');
  return { buf, sha256 };
}

function commonArgs(input: FileUploadInput, fileConfig: Required<FileUploadConfig>, buf: Buffer, sha256: string): string[] {
  const destination  = input.destination ?? defaultDestination(fileConfig.destination_prefix);
  const uid          = input.uid ?? fileConfig.default_uid;
  const args = [
    `--filename=${input.filename}`,
    `--destination=${destination}`,
    `--uid=${uid}`,
    `--size=${buf.byteLength}`,
    `--sha256=${sha256}`,
  ];
  // Only forward an explicit scheme. Left out, the bridge falls back to the
  // target field's uri_scheme (attach) or the site's default scheme (upload),
  // which is what Drupal's own upload widget would do.
  if (input.scheme !== undefined) args.push(`--scheme=${input.scheme}`);
  return args;
}

export function buildFileUploadArgs(input: FileUploadInput, fileConfig: Required<FileUploadConfig>): FileDrushArgs {
  const { buf, sha256 } = preflight(input, fileConfig);
  return {
    command: 'mcp:file-upload',
    args:    commonArgs(input, fileConfig, buf, sha256),
    stdin:   buf,
  };
}

export function buildFileAttachArgs(input: FileAttachInput, fileConfig: Required<FileUploadConfig>): FileDrushArgs {
  const { buf, sha256 } = preflight(input, fileConfig);
  if (!input.entity_type || !input.field_name) {
    throw new FilePreflightError('VALIDATION_ERROR', 'entity_type and field_name are required');
  }
  if (!Number.isInteger(input.entity_id) || input.entity_id <= 0) {
    throw new FilePreflightError('VALIDATION_ERROR', 'entity_id must be a positive integer');
  }
  const args = [
    ...commonArgs(input, fileConfig, buf, sha256),
    `--entity-type=${input.entity_type}`,
    `--entity-id=${input.entity_id}`,
    `--field-name=${input.field_name}`,
    `--mode=${input.mode ?? 'append'}`,
  ];
  if (input.alt   !== undefined) args.push(`--alt=${input.alt}`);
  if (input.title !== undefined) args.push(`--title=${input.title}`);
  return {
    command: 'mcp:file-attach',
    args,
    stdin:   buf,
  };
}
