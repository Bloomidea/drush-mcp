# PRD — File upload: `content_path` input

Status: Implemented in v0.3.1
Owner: introfini
Maintainer: Bloomidea
Extends: [PRD-file-upload.md](./PRD-file-upload.md)

## 0. TL;DR

Add a new optional input to `drupal_file_upload` and `drupal_file_attach` called `content_path`. The MCP server (running locally on the agent host) reads the file from the local filesystem and pipes the bytes to the Drush bridge, exactly as it does today with `content_base64`. The LLM emits only a short path string, never the file bytes.

This unblocks attaching files larger than a few KB through agents whose LLM provider applies safety filters to dense base64 in tool call parameters.

## 1. Problem

The existing `drupal_file_upload` / `drupal_file_attach` tools require `content_base64` as the data input. Even though the MCP server already decodes the base64 and pipes raw bytes to the bridge via stdin (see PRD-file-upload §3.1), the **input** to the MCP server still has to be a base64 string.

For agents that talk to the MCP server via an LLM provider's tool-use API (Anthropic, OpenAI, etc.), the base64 has to travel through the LLM message stream:

```
Agent code <-(JSON tool call with content_base64)-> LLM provider API <-> MCP server
                          ↑
            base64 sits inside the assistant message
```

Anthropic's API has rejected tool calls where the `content_base64` field is ~15-20 KB or larger, returning Usage Policy errors. Empirical evidence:

> Request ID `req_011Cavna5KaffFASaJKj8dHM`, 2026-05-11, attempting to upload a 14.7 KB markdown file (~19.6 KB base64) to an Atrium deal via `drupal_file_attach`. The previous turn had also emitted the same base64 inside a Bash `cat` output. The Usage Policy filter triggered on the dense base64 payload.

The filter does not distinguish between "data inside a structured tool parameter" and "raw output in a chat message". Both are part of the request body that the safety layer scans, and a wall of base64 with no semantic content scores high on the suspicious-payload heuristic.

Consequence: any upload over ~10-15 KB from a Claude Code (or similar) agent is unreliable. The previously documented chunked `php_eval` fallback is even worse (PRD-file-upload §1) and was the original motivation for this tool.

## 2. Goal

Allow agents to pass a **filesystem path** instead of (or in addition to) the base64 payload. The MCP server reads the file locally and proceeds with the existing stdin pipeline.

Non-goal: removing `content_base64`. It remains the canonical path for transports where the agent and the MCP server are not co-located (eg. future hosted MCP deployments).

## 3. Threat model

The MCP server runs as a Node.js process owned by the user. With `content_path`, that process gains the ability to read **any file** the user can read on the host. Considerations:

- **Within the user's own machine**: an agent that already executes Bash, edits files, and runs Drush is not gaining new capability by reading from `content_path`. The risk surface does not meaningfully grow.
- **In multi-tenant or sandboxed environments**: the path-based input may leak files outside the intended working directory. Mitigation: optional `allowed_paths` allowlist in `drush-mcp.yml` (§7).
- **Path traversal / symlink follow**: the implementation resolves the path (`path.resolve`) and checks `statSync(...).isFile()`. Symlinks are followed, which matches Unix expectations; if `allowed_paths` is configured, the resolved real path must be inside one of the allowed roots.

For the typical single-user dev workflow (Claude Code on a personal laptop, MCP server in the same shell), default behaviour is "any absolute path the process can read" and the allowlist is opt-in.

## 4. API changes

### 4.1 `drupal_file_upload`

Input schema (Zod):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `content_base64` | string | optional | Base64-encoded file bytes. Provide this **OR** `content_path`. |
| `content_path`   | string | optional | Absolute local path to a file on the MCP host. Provide this **OR** `content_base64`. Use to avoid sending large base64 payloads through the LLM. |
| `filename`       | string | required | (unchanged) |
| `scheme`         | enum   | optional | (unchanged) |
| `destination`    | string | optional | (unchanged) |
| `uid`            | number | optional | (unchanged) |

Exactly one of `content_base64` / `content_path` must be present. Sending both → `VALIDATION_ERROR`. Sending neither → `VALIDATION_ERROR`.

### 4.2 `drupal_file_attach`

Same additions; everything else (`entity_type`, `entity_id`, `field_name`, `mode`, `alt`, `title`) is unchanged.

### 4.3 New error codes

| Code | When |
|------|------|
| `PATH_NOT_ABSOLUTE` | `content_path` is not an absolute path. |
| `PATH_NOT_FOUND` | `content_path` does not exist or is not readable. |
| `PATH_NOT_FILE` | `content_path` points to a directory, socket, device, etc. |
| `PATH_NOT_ALLOWED` | `content_path` resolves outside the configured `allowed_paths` (only when allowlist is enabled — see §7). |
| `VALIDATION_ERROR` | Both `content_base64` and `content_path` provided, or neither provided. |

Existing `SIZE_EXCEEDED` and `EXTENSION_FORBIDDEN` continue to apply, evaluated **after** the file is read from disk.

## 5. Implementation

All changes live in `packages/mcp-server/`. The Drush bridge does not change — the bytes still arrive over stdin.

### 5.1 `src/tools/file.ts`

Import filesystem helpers at the top:

```ts
import { readFileSync, statSync } from 'fs';
import { isAbsolute, resolve } from 'path';
```

Extend the input type:

```ts
export interface FileUploadInput {
  content_base64?: string;
  content_path?:   string;
  filename:        string;
  scheme?:         'public' | 'private' | 'temporary';
  destination?:    string;
  uid?:            number;
}
```

Add a private helper that returns the buffer regardless of input mode:

```ts
function readContentBuffer(
  input:    FileUploadInput,
  maxSize:  number,
): Buffer {
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
  return decodeBase64(input.content_base64!);
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
```

Update `preflight()` to use the new helper:

```ts
export function preflight(
  input:      FileUploadInput,
  fileConfig: Required<FileUploadConfig>,
): { buf: Buffer; sha256: string } {
  if (!input.filename || input.filename.trim() === '') {
    throw new FilePreflightError('VALIDATION_ERROR', 'filename is required');
  }
  if (input.filename.includes('/') || input.filename.includes('\\')) {
    throw new FilePreflightError('VALIDATION_ERROR', 'filename must not contain path separators');
  }

  const buf = readContentBuffer(input, fileConfig.max_size);

  // Defensive: readContentBuffer already enforces max_size for the path case,
  // but keep this check for the base64 path that doesn't know the size upfront.
  if (buf.byteLength > fileConfig.max_size) {
    throw new FilePreflightError(
      'SIZE_EXCEEDED',
      `payload is ${buf.byteLength} bytes, max_size is ${fileConfig.max_size} bytes`,
    );
  }

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
```

The existing `decodeBase64`, `commonArgs`, `buildFileUploadArgs`, `buildFileAttachArgs` need no changes — they all go through `preflight()`.

### 5.2 `src/index.ts`

Make `content_base64` optional and add `content_path`. Both tool registrations:

```ts
server.tool(
  'drupal_file_upload',
  'Upload a file to the Drupal site and create a managed file entity. Returns the new fid, uri, and url. Provide either content_base64 (inline bytes) or content_path (path to a local file on the MCP host).',
  {
    content_base64: z.string().optional().describe(
      'Base64-encoded file bytes. Provide this OR content_path.',
    ),
    content_path: z.string().optional().describe(
      'Absolute local path to a file on the MCP host. Provide this OR content_base64. ' +
      'Use to avoid sending large base64 payloads through the LLM (some providers' safety filters reject dense base64).',
    ),
    filename:    z.string().describe('Display filename including extension'),
    scheme:      z.enum(['public', 'private', 'temporary']).optional().describe('Stream wrapper scheme (default: public)'),
    destination: z.string().optional().describe('Directory within the scheme (default: mcp-uploads/<YYYY-MM> in UTC)'),
    uid:         z.coerce.number().optional().describe('Owning user ID (default: site-configured default_uid)'),
    site:        siteParam,
  },
  createFileHandler<FileUploadInput>(buildFileUploadArgs),
);
```

Same shape for `drupal_file_attach` (keeping its `entity_type`, `entity_id`, `field_name`, `mode`, `alt`, `title`).

### 5.3 Tests (`tests/file.test.ts`)

Add cases:

- `content_path` happy path: existing file is read and matches base64 round-trip.
- `content_path` not absolute → `PATH_NOT_ABSOLUTE`.
- `content_path` to non-existent file → `PATH_NOT_FOUND`.
- `content_path` to directory → `PATH_NOT_FILE`.
- `content_path` to oversized file → `SIZE_EXCEEDED`.
- Both `content_base64` and `content_path` → `VALIDATION_ERROR`.
- Neither → `VALIDATION_ERROR`.
- `content_path` to file with disallowed extension → `EXTENSION_FORBIDDEN`.

Tests use `fs.mkdtempSync` + `fs.writeFileSync` to create real fixture files, kept in a temp directory and removed in `afterAll`.

## 6. Backward compatibility

`content_base64` remains accepted exactly as before. Existing agents and integrations need no change. The Zod schema relaxes `content_base64` from required to optional, which is a non-breaking type change for callers (they can still send it).

The error message when both are sent is new; callers that were not sending both are unaffected.

## 7. Deferred: `allowed_paths` allowlist

For multi-user or sandboxed deployments, add an optional config key:

```yaml
file_upload:
  max_size: 10485760
  allowed_extensions: [md, pdf, png, jpg, gif, webp, txt, csv, json, sql, yml, yaml]
  allowed_paths:                # optional, default: no restriction
    - /Users/josefernandes/Dev
    - /tmp/mcp-uploads
```

When set, `content_path` (after `path.resolve`) must start with one of the allowed roots (using `path.relative` + `startsWith('..')` check to avoid `/abc` matching `/ab`). Violations return `PATH_NOT_ALLOWED`.

This is out of scope for the initial implementation. Single-user dev workflows do not need it. Add when the first multi-user use case appears.

## 8. Rollout

1. Implement §5.1 and §5.2.
2. Add §5.3 tests.
3. Update [PRD-file-upload.md](./PRD-file-upload.md) §4.1 / §4.2 input tables to mark `content_base64` optional and add `content_path` row.
4. Update [skills/drupal/SKILL.md](./skills/drupal/SKILL.md) (if it documents the upload tool) to mention `content_path` as the preferred path for local agent uploads.
5. Bump minor version of `@bloomidea/drush-mcp` (new optional input, non-breaking).
6. Release notes: mention the LLM-safety motivation so users who hit similar errors know the workaround.

## 9. Validation

A successful end-to-end test from Claude Code:

```
Tool call:
  drupal_file_attach
    content_path: "/Users/josefernandes/Dev/ascenza/proposta-ascenza-26-27-v2-2026-05-11.md"
    filename: "proposta-ascenza-26-27-v2.md"
    entity_type: "node"
    entity_id: 402911
    field_name: "field_shared_files"
    site: "atrium"

Expected result:
  {
    "fid": <new fid>,
    "uri": "public://mcp-uploads/2026-05/proposta-ascenza-26-27-v2.md",
    "url": "https://bloomidea.net/sites/default/files/mcp-uploads/2026-05/proposta-ascenza-26-27-v2.md",
    "attached_to": { "entity_type": "node", "entity_id": 402911, "field_name": "field_shared_files" }
  }
```

The same call with `content_base64` (today) reproduces the safety-filter rejection; the `content_path` variant should succeed.

## 10. Open questions

- Do we want to log the resolved path (server-side) for observability? Probably yes, but redacted to last 2 segments to avoid leaking home dir details.
- Behaviour when `content_path` points to a symlink whose target is outside the user's home: follow (current default) or reject? Current default is fine; revisit if `allowed_paths` lands.
- Should `filename` default to `path.basename(content_path)` if not provided? Convenience win, but the explicit `filename` argument keeps the API consistent across both input modes. Defer.
