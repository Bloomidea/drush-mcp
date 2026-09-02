import { createHash } from 'crypto';
import { readFileSync, statSync } from 'fs';
import { isAbsolute, resolve } from 'path';
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

function readBufferFromPath(rawPath: string, maxSize: number): Buffer {
  if (!isAbsolute(rawPath)) {
    throw new FilePreflightError('PATH_NOT_ABSOLUTE', 'content_path must be an absolute path');
  }
  const resolved = resolve(rawPath);

  let stat;
  try {
    stat = statSync(resolved);
  } catch (err) {
    throw new FilePreflightError('PATH_NOT_FOUND', `content_path not readable: ${(err as Error).message}`);
  }
  if (!stat.isFile()) {
    throw new FilePreflightError('PATH_NOT_FILE', 'content_path is not a regular file');
  }
  if (stat.size > maxSize) {
    throw new FilePreflightError(
      'SIZE_EXCEEDED',
      `file is ${stat.size} bytes, max_size is ${maxSize} bytes`,
    );
  }
  return readFileSync(resolved);
}

function readContentBuffer(input: FileUploadInput, maxSize: number): Buffer {
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
    return readBufferFromPath(input.content_path!, maxSize);
  }
  return decodeBase64(input.content_base64!, maxSize);
}

export function preflight(input: FileUploadInput, fileConfig: Required<FileUploadConfig>): { buf: Buffer; sha256: string } {
  if (!input.filename || input.filename.trim() === '') {
    throw new FilePreflightError('VALIDATION_ERROR', 'filename is required');
  }
  if (input.filename.includes('/') || input.filename.includes('\\')) {
    throw new FilePreflightError('VALIDATION_ERROR', 'filename must not contain path separators');
  }
  const buf = readContentBuffer(input, fileConfig.max_size);
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
