import { createHash } from 'crypto';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from 'fs';
import { homedir } from 'os';
import { basename, isAbsolute, join, resolve, sep } from 'path';
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
 * Each configured content_root in both spellings: as written, with `~`
 * expanded, and as the real directory it resolves to. A root that does not
 * exist keeps only the first, which matches nothing that can be opened.
 *
 * Both are needed because the agent may name a file either way: on macOS
 * `/tmp/x` and `/private/tmp/x` are the same file, and only the second is real.
 */
function rootSpellings(roots: unknown): string[] {
  if (!Array.isArray(roots)) {
    throw new FilePreflightError('CONFIG_ERROR', 'file_upload.content_roots must be a list of directories');
  }
  const spellings: string[] = [];
  for (const root of roots) {
    if (typeof root !== 'string') {
      throw new FilePreflightError('CONFIG_ERROR', `content_roots entry ${JSON.stringify(root)} must be a path (a bare ~ in YAML is null; write "~/")`);
    }
    const expanded = root === '~' ? homedir() : root.startsWith('~/') ? join(homedir(), root.slice(2)) : root;
    if (!isAbsolute(expanded)) {
      throw new FilePreflightError('CONFIG_ERROR', `content_roots entry "${root}" must be an absolute path or start with ~/`);
    }
    spellings.push(resolve(expanded));
    try {
      spellings.push(realpathSync.native(expanded));
    } catch {
      // Missing root: nothing under it can be opened anyway.
    }
  }
  return spellings;
}

function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

function outsideRoots(fileConfig: Required<FileUploadConfig>): FilePreflightError {
  const allowed = fileConfig.content_roots.length > 0 ? fileConfig.content_roots.join(', ') : 'none, content_path is disabled';
  return new FilePreflightError(
    'PATH_OUTSIDE_ROOTS',
    `content_path is outside the content_roots this site allows (${allowed}). Copy the file into one of them, or add a root under file_upload.content_roots in drush-mcp.yml.`,
  );
}

/**
 * Reads a file named by the agent from the machine running this server.
 *
 * Before 0.5.1 any absolute path was read, and the extension allowlist looked
 * at `filename` alone, so `content_path: ~/.ssh/id_rsa, filename: key.txt`
 * shipped a private key to the site. Now:
 *
 * 1. The path as given must sit inside a root, before anything touches the
 *    disk, so a path elsewhere tells the agent nothing about what exists there.
 * 2. The file is opened, and its real path (symlinks and `..` resolved) must
 *    sit inside a root too, and name the very inode the descriptor holds. A
 *    directory swapped for a symlink between the two steps fails that check.
 * 3. The real file must carry an allowed extension of its own.
 * 4. At most max_size bytes are read, whatever the file grows to meanwhile.
 */
function readBufferFromPath(rawPath: string, fileConfig: Required<FileUploadConfig>): Buffer {
  if (!isAbsolute(rawPath)) {
    throw new FilePreflightError('PATH_NOT_ABSOLUTE', 'content_path must be an absolute path');
  }
  // resolve() collapses `link/..` lexically while the kernel walks through
  // the link first, so the lexical check below would vouch for a path the
  // open() then follows elsewhere. Nobody needs these segments; refuse them.
  if (rawPath.split(/[\\/]/).some((segment) => segment === '.' || segment === '..')) {
    throw new FilePreflightError('PATH_NOT_ABSOLUTE', 'content_path must not contain . or .. segments');
  }
  const roots = rootSpellings(fileConfig.content_roots);
  if (!roots.some((root) => isInside(resolve(rawPath), root))) {
    throw outsideRoots(fileConfig);
  }

  // O_NONBLOCK keeps a FIFO from hanging the open; fstat then turns it away.
  let fd: number;
  try {
    fd = openSync(rawPath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (err) {
    throw new FilePreflightError('PATH_NOT_FOUND', `content_path not readable: ${(err as Error).message}`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new FilePreflightError('PATH_NOT_FILE', 'content_path is not a regular file');
    }

    let real: string;
    let again;
    try {
      real  = realpathSync.native(rawPath);
      again = statSync(real);
    } catch (err) {
      throw new FilePreflightError('PATH_NOT_FOUND', `content_path not readable: ${(err as Error).message}`);
    }
    if (!roots.some((root) => isInside(real, root))) {
      throw outsideRoots(fileConfig);
    }
    if (again.dev !== stat.dev || again.ino !== stat.ino) {
      throw new FilePreflightError('PATH_NOT_FOUND', 'content_path changed while it was being checked');
    }

    const ext = extensionOf(basename(real));
    if (!ext || !fileConfig.allowed_extensions.includes(ext)) {
      throw new FilePreflightError(
        'EXTENSION_FORBIDDEN',
        `content_path resolves to a file with extension "${ext}", which is not in the configured allowlist`,
      );
    }
    if (stat.size > fileConfig.max_size) {
      throw new FilePreflightError(
        'SIZE_EXCEEDED',
        `file is ${stat.size} bytes, max_size is ${fileConfig.max_size} bytes`,
      );
    }

    const buf  = Buffer.alloc(fileConfig.max_size + 1);
    let length = 0;
    let read: number;
    while (length < buf.length && (read = readSync(fd, buf, length, buf.length - length, null)) > 0) {
      length += read;
    }
    if (length > fileConfig.max_size) {
      throw new FilePreflightError('SIZE_EXCEEDED', `file grew past max_size (${fileConfig.max_size} bytes) while it was being read`);
    }
    return buf.subarray(0, length);
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
  // A YAML scalar here would turn `includes` into a substring match.
  if (!Array.isArray(fileConfig.allowed_extensions)) {
    throw new FilePreflightError('CONFIG_ERROR', 'file_upload.allowed_extensions must be a list of extensions');
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
