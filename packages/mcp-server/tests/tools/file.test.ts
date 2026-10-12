import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';

// Setting process.env.HOME inside a vitest worker thread does not reach the
// homedir() libuv computes, so the ~ test swaps the function instead.
const fakeHome = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => fakeHome.value ?? actual.homedir() };
});
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildFileUploadArgs,
  buildFileAttachArgs,
  FilePreflightError,
  type FileUploadInput,
} from '../../src/tools/file.js';
import { FILE_UPLOAD_DEFAULTS, type FileUploadConfig } from '../../src/types.js';

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
    expect(args.args.some((a) => a.startsWith('--scheme='))).toBe(false);
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

describe('content_path input', () => {
  let tmp: string;
  let helloPath:    string;
  let oversizePath: string;
  let dirPath:      string;
  let badExtPath:   string;

  beforeAll(() => {
    tmp          = mkdtempSync(join(tmpdir(), 'drush-mcp-content-path-'));
    helloPath    = join(tmp, 'hello.md');
    oversizePath = join(tmp, 'big.md');
    dirPath      = join(tmp, 'subdir');
    badExtPath   = join(tmp, 'evil.exe');

    writeFileSync(helloPath,    'hello world');
    writeFileSync(oversizePath, Buffer.alloc(100));
    mkdirSync(dirPath);
    writeFileSync(badExtPath,   'noop');
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('reads file from disk and matches base64 round-trip', () => {
    const args = buildFileUploadArgs({
      content_path: helloPath,
      filename:     'hello.md',
    }, cfg);
    expect(args.stdin.toString()).toBe('hello world');
    expect(args.args).toContain('--size=11');
    // sha256("hello world") = b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
    expect(args.args).toContain('--sha256=b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
  });

  it('rejects non-absolute content_path', () => {
    try {
      buildFileUploadArgs({ content_path: 'relative/path.md', filename: 'a.md' }, cfg);
      throw new Error('expected throw');
    }
    catch (err) {
      expect(err).toBeInstanceOf(FilePreflightError);
      expect((err as FilePreflightError).code).toBe('PATH_NOT_ABSOLUTE');
    }
  });

  it('rejects content_path to non-existent file', () => {
    try {
      buildFileUploadArgs({ content_path: join(tmp, 'does-not-exist.md'), filename: 'a.md' }, cfg);
      throw new Error('expected throw');
    }
    catch (err) {
      expect((err as FilePreflightError).code).toBe('PATH_NOT_FOUND');
    }
  });

  it('rejects content_path that points at a directory', () => {
    try {
      buildFileUploadArgs({ content_path: dirPath, filename: 'a.md' }, cfg);
      throw new Error('expected throw');
    }
    catch (err) {
      expect((err as FilePreflightError).code).toBe('PATH_NOT_FILE');
    }
  });

  it('rejects content_path to oversized file', () => {
    const tinyCfg = { ...cfg, max_size: 50 };
    try {
      buildFileUploadArgs({ content_path: oversizePath, filename: 'big.md' }, tinyCfg);
      throw new Error('expected throw');
    }
    catch (err) {
      expect((err as FilePreflightError).code).toBe('SIZE_EXCEEDED');
    }
  });

  it('rejects content_path to file with disallowed extension', () => {
    try {
      buildFileUploadArgs({ content_path: badExtPath, filename: 'evil.exe' }, cfg);
      throw new Error('expected throw');
    }
    catch (err) {
      expect((err as FilePreflightError).code).toBe('EXTENSION_FORBIDDEN');
    }
  });

  it('rejects when both content_base64 and content_path are provided', () => {
    try {
      buildFileUploadArgs({
        content_base64: b64('hi'),
        content_path:   helloPath,
        filename:       'a.md',
      }, cfg);
      throw new Error('expected throw');
    }
    catch (err) {
      expect((err as FilePreflightError).code).toBe('VALIDATION_ERROR');
      expect((err as FilePreflightError).message).toMatch(/not both/);
    }
  });

  it('rejects when neither is provided', () => {
    try {
      buildFileUploadArgs({ filename: 'a.md' } as never, cfg);
      throw new Error('expected throw');
    }
    catch (err) {
      expect((err as FilePreflightError).code).toBe('VALIDATION_ERROR');
      expect((err as FilePreflightError).message).toMatch(/required/);
    }
  });

  it('treats empty content_base64 + no content_path as "neither provided"', () => {
    try {
      buildFileUploadArgs({ content_base64: '', filename: 'a.md' }, cfg);
      throw new Error('expected throw');
    }
    catch (err) {
      expect((err as FilePreflightError).code).toBe('VALIDATION_ERROR');
      expect((err as FilePreflightError).message).toMatch(/required/);
    }
  });

  it('content_path flows through buildFileAttachArgs identically', () => {
    const args = buildFileAttachArgs({
      content_path: helloPath,
      filename:     'hello.md',
      entity_type:  'node',
      entity_id:    1,
      field_name:   'field_shared_files',
    }, cfg);
    expect(args.command).toBe('mcp:file-attach');
    expect(args.stdin.toString()).toBe('hello world');
  });
});

describe('content_path roots', () => {
  let tmp:     string;
  let allowed: string;
  let outside: string;

  /** The code a FilePreflightError carries, or 'none' when the call succeeds. */
  function codeOf(input: Partial<FileUploadInput>, config: Required<FileUploadConfig>): string {
    try {
      buildFileUploadArgs({ filename: 'a.md', ...input } as FileUploadInput, config);
      return 'none';
    }
    catch (err) {
      if (!(err instanceof FilePreflightError)) throw err;
      return err.code;
    }
  }

  beforeAll(() => {
    // realpath so the fixture paths match what the check resolves to (macOS
    // puts tmpdir() behind a symlink).
    tmp     = realpathSync(mkdtempSync(join(tmpdir(), 'drush-mcp-roots-')));
    allowed = join(tmp, 'allowed');
    outside = join(tmp, 'allowed-not');
    mkdirSync(allowed);
    mkdirSync(outside);
    writeFileSync(join(allowed, 'ok.md'), 'inside');
    writeFileSync(join(allowed, 'id_rsa'), 'secret, no extension');
    writeFileSync(join(outside, 'secret.md'), 'outside');
    symlinkSync(join(outside, 'secret.md'), join(allowed, 'escape.md'));
    symlinkSync(join(allowed, 'id_rsa'), join(allowed, 'key.md'));
    symlinkSync(allowed, join(tmp, 'link-to-allowed'));
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const roots = (...r: string[]) => ({ ...cfg, content_roots: r });

  it('reads a file inside a configured root', () => {
    expect(codeOf({ content_path: join(allowed, 'ok.md') }, roots(allowed))).toBe('none');
  });

  it('refuses a file in a sibling directory that only shares the root as a prefix', () => {
    expect(codeOf({ content_path: join(outside, 'secret.md') }, roots(allowed))).toBe('PATH_OUTSIDE_ROOTS');
  });

  it('refuses a path that climbs out of the root with ..', () => {
    expect(codeOf({ content_path: `${allowed}/../allowed-not/secret.md` }, roots(allowed))).toBe('PATH_OUTSIDE_ROOTS');
  });

  it('refuses a symlink inside the root that points outside it', () => {
    expect(codeOf({ content_path: join(allowed, 'escape.md') }, roots(allowed))).toBe('PATH_OUTSIDE_ROOTS');
  });

  it('checks the extension of the file on disk, not only the filename', () => {
    expect(codeOf({ content_path: join(allowed, 'id_rsa'), filename: 'key.txt' }, roots(allowed))).toBe('EXTENSION_FORBIDDEN');
  });

  it('checks the extension of the symlink target, not of the link', () => {
    expect(codeOf({ content_path: join(allowed, 'key.md') }, roots(allowed))).toBe('EXTENSION_FORBIDDEN');
  });

  it('accepts both spellings of a root that is itself a symlink (/tmp and /private/tmp on macOS)', () => {
    expect(codeOf({ content_path: join(allowed, 'ok.md') }, roots(join(tmp, 'link-to-allowed')))).toBe('none');
    expect(codeOf({ content_path: join(tmp, 'link-to-allowed', 'ok.md') }, roots(join(tmp, 'link-to-allowed')))).toBe('none');
  });

  // The path as given is checked before the disk is touched, so a detour
  // through a symlink that is not a root is refused even when it lands inside
  // one. Name the file by its real path or by the root's own spelling.
  it('refuses a path that reaches a root only through another symlink', () => {
    expect(codeOf({ content_path: join(tmp, 'link-to-allowed', 'ok.md') }, roots(allowed))).toBe('PATH_OUTSIDE_ROOTS');
  });

  it('says nothing about whether a path outside the roots exists', () => {
    const missing = codeOf({ content_path: join(outside, 'missing.md') }, roots(allowed));
    const present = codeOf({ content_path: join(outside, 'secret.md') }, roots(allowed));
    expect(missing).toBe('PATH_OUTSIDE_ROOTS');
    expect(present).toBe('PATH_OUTSIDE_ROOTS');
  });

  it('refuses a scalar where a list of roots belongs', () => {
    expect(codeOf({ content_path: join(allowed, 'ok.md') }, { ...cfg, content_roots: '/tmp' as unknown as string[] })).toBe('CONFIG_ERROR');
    expect(codeOf({ content_path: join(allowed, 'ok.md') }, { ...cfg, content_roots: [null] as unknown as string[] })).toBe('CONFIG_ERROR');
  });

  it('refuses a scalar where a list of extensions belongs', () => {
    expect(codeOf({ content_path: join(allowed, 'ok.md') }, { ...roots(allowed), allowed_extensions: 'md' as unknown as string[] })).toBe('CONFIG_ERROR');
    expect(codeOf({ content_base64: b64('x'), filename: 'a.d' }, { ...cfg, allowed_extensions: 'md' as unknown as string[] })).toBe('CONFIG_ERROR');
  });

  it('expands ~ in a root to the home directory', () => {
    fakeHome.value = tmp;
    try {
      expect(codeOf({ content_path: join(allowed, 'ok.md') }, roots('~/allowed'))).toBe('none');
      expect(codeOf({ content_path: join(outside, 'secret.md') }, roots('~/allowed'))).toBe('PATH_OUTSIDE_ROOTS');
    }
    finally {
      fakeHome.value = undefined;
    }
  });

  it('refuses a relative root', () => {
    expect(codeOf({ content_path: join(allowed, 'ok.md') }, roots('allowed'))).toBe('CONFIG_ERROR');
  });

  it('turns content_path off with an empty list', () => {
    expect(codeOf({ content_path: join(allowed, 'ok.md') }, roots())).toBe('PATH_OUTSIDE_ROOTS');
  });

  it('ignores a root that does not exist', () => {
    expect(codeOf({ content_path: join(allowed, 'ok.md') }, roots(join(tmp, 'missing'), allowed))).toBe('none');
  });

  it('admits everything under / when / is a root (the 0.5.0 behaviour)', () => {
    expect(codeOf({ content_path: join(outside, 'secret.md') }, roots('/'))).toBe('none');
  });

  it('refuses a FIFO without blocking on it', () => {
    const fifo = join(allowed, 'pipe.md');
    execFileSync('mkfifo', [fifo]);
    expect(codeOf({ content_path: fifo }, roots(allowed))).toBe('PATH_NOT_FILE');
  });

  it('leaves content_base64 alone', () => {
    expect(codeOf({ content_base64: b64('x') }, roots())).toBe('none');
  });
});
