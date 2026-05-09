import { describe, it, expect } from 'vitest';
import {
  buildFileUploadArgs,
  buildFileAttachArgs,
  FilePreflightError,
} from '../../src/tools/file.js';
import { FILE_UPLOAD_DEFAULTS } from '../../src/types.js';

const cfg = FILE_UPLOAD_DEFAULTS;
const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('buildFileUploadArgs', () => {
  it('produces mcp:file-upload command with required args + stdin buffer', () => {
    const args = buildFileUploadArgs({
      content_base64: b64('hello world'),
      filename:       'note.txt',
    }, cfg);
    expect(args.command).toBe('mcp:file-upload');
    expect(args.stdin).toBeInstanceOf(Buffer);
    expect(args.stdin.toString()).toBe('hello world');
    expect(args.args).toContain('--filename=note.txt');
    expect(args.args).toContain('--scheme=public');
    expect(args.args).toContain('--uid=0');
    expect(args.args).toContain('--size=11');
    expect(args.args.some(a => a.startsWith('--sha256='))).toBe(true);
  });

  it('defaults destination to mcp-uploads/<UTC YYYY-MM>', () => {
    const args = buildFileUploadArgs({
      content_base64: b64('x'), filename: 'a.md',
    }, cfg);
    const now   = new Date();
    const year  = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    expect(args.args).toContain(`--destination=mcp-uploads/${year}-${month}`);
  });

  it('honours explicit scheme, destination, uid', () => {
    const args = buildFileUploadArgs({
      content_base64: b64('x'),
      filename:       'a.md',
      scheme:         'private',
      destination:    'reports/q1',
      uid:            42,
    }, cfg);
    expect(args.args).toContain('--scheme=private');
    expect(args.args).toContain('--destination=reports/q1');
    expect(args.args).toContain('--uid=42');
  });

  it('rejects invalid base64', () => {
    expect(() => buildFileUploadArgs({
      content_base64: 'not~valid~base64',
      filename:       'a.txt',
    }, cfg)).toThrowError(FilePreflightError);
  });

  it('rejects payload over max_size', () => {
    const tiny = { ...cfg, max_size: 4 };
    expect(() => buildFileUploadArgs({
      content_base64: b64('hello world'),
      filename:       'a.txt',
    }, tiny)).toThrowError(/SIZE_EXCEEDED|max_size/);
  });

  it('rejects extension not in allowlist', () => {
    expect(() => buildFileUploadArgs({
      content_base64: b64('x'),
      filename:       'evil.exe',
    }, cfg)).toThrowError(/EXTENSION_FORBIDDEN|allowlist/);
  });

  it('rejects filename without extension', () => {
    expect(() => buildFileUploadArgs({
      content_base64: b64('x'),
      filename:       'noext',
    }, cfg)).toThrowError(/EXTENSION_FORBIDDEN|extension/);
  });

  it('rejects filenames with path separators', () => {
    expect(() => buildFileUploadArgs({
      content_base64: b64('x'),
      filename:       '../etc/passwd.txt',
    }, cfg)).toThrowError(/path separators/);
  });

  it('attaches a stable SHA-256 of the bytes', () => {
    const args = buildFileUploadArgs({
      content_base64: b64('hello'),
      filename:       'a.txt',
    }, cfg);
    const flag = args.args.find(a => a.startsWith('--sha256='));
    // sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    expect(flag).toBe('--sha256=2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });
});

describe('buildFileAttachArgs', () => {
  it('produces mcp:file-attach command with target entity flags', () => {
    const args = buildFileAttachArgs({
      content_base64: b64('hello'),
      filename:       'note.md',
      entity_type:    'comment',
      entity_id:      190281,
      field_name:     'field_shared_files',
    }, cfg);
    expect(args.command).toBe('mcp:file-attach');
    expect(args.args).toContain('--entity-type=comment');
    expect(args.args).toContain('--entity-id=190281');
    expect(args.args).toContain('--field-name=field_shared_files');
    expect(args.args).toContain('--mode=append');
  });

  it('flows alt/title to argv when provided', () => {
    const args = buildFileAttachArgs({
      content_base64: b64('x'),
      filename:       'a.png',
      entity_type:    'node',
      entity_id:      1,
      field_name:     'field_image',
      mode:           'replace',
      alt:            'a cat',
      title:          'cat photo',
    }, cfg);
    expect(args.args).toContain('--mode=replace');
    expect(args.args).toContain('--alt=a cat');
    expect(args.args).toContain('--title=cat photo');
  });

  it('rejects non-positive entity_id', () => {
    expect(() => buildFileAttachArgs({
      content_base64: b64('x'),
      filename:       'a.txt',
      entity_type:    'node',
      entity_id:      0,
      field_name:     'field_files',
    }, cfg)).toThrowError(/entity_id/);
  });
});
