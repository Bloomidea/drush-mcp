# PRD — File upload tool

Status: Draft v0.2
Owner: introfini
Maintainer: Bloomidea

## 0. Reference design

Drupal core's canonical "binary upload + attach to a field in one round trip" is the JSON:API file-upload endpoint: `POST /jsonapi/{entity_type}/{bundle}/{field_name}` with `Content-Type: application/octet-stream` and `Content-Disposition: file; filename="…"`. The body is the raw bytes; the response is a JSON:API document for the new file entity, already attached to the host field. See [Drupal JSON:API file uploads](https://www.drupal.org/docs/core-modules-and-themes/core-modules/jsonapi-module/file-uploads).

`drush-mcp` cannot use that endpoint (no HTTP layer; transport is Drush over local/SSH/docker). The MCP tools defined here mirror the same *semantics* — single-call upload, single-call upload-and-attach, server-side validation against the field's settings — over the Drush transport.

## 1. Problem

There is currently no first-class way to get a file into a Drupal site through `drush-mcp`. Agents that need to attach a PRD, screenshot, SQL dump, log file, or any other binary to a node, comment, or `field_*` of type `file` have to fall back to base64-chunked writes through `drupal_php_eval` plus `state` accumulation, then manually decode and create a managed file entity.

That workflow is fragile in practice:

- `php_eval` truncates input above ~4–8 KB on most transports, forcing many small round trips.
- Every chunk must be PHP-string-safe (single quoting, no embedded `'`), even though base64 already is.
- The agent has to know Drupal internals (`file_repository`, URI schemes, file_managed columns) just to land a file on disk.
- There is no validation of extension, MIME type, or destination scheme — easy to corrupt files or write to the wrong place.
- Cleanup of the temporary `state` keys is the agent's responsibility.

The result: agents either skip the upload (the PRD lives only in git) or invest a dozen tool calls in a flow that should be one. Concrete recent example: attempting to attach a 27 KB PRD markdown to an Atrium task required 18 sequential `drupal_php_eval` calls and still failed mid-way with a parse error.

## 2. Goals

- A single MCP tool that takes binary content + a destination and returns a managed file entity.
- A second, optional tool that does the upload **and** attaches the resulting `fid` to a `field_*` of type `file` on a node/comment/other entity in one round trip.
- Reuse Drupal's `file_repository` + `FileSystem` services so validation, MIME detection, and managed-file bookkeeping are correct.
- Stay consistent with existing `drush-mcp` tools: TypeScript stub in `packages/mcp-server/src/tools/`, PHP implementation as a Drush bridge command, structured JSON I/O.

## 3. Non-goals

- Resumable / chunked uploads (TUS, Dropzone-style). The bridge accepts the file in one call. Anything that can't fit in a single bridge invocation is out of scope; agents should fall back to `rsync` / object storage for those cases.
- Image manipulation (resize, crop). That's a downstream concern handled by Drupal image styles.
- Replacing existing fields with file references — only adding/replacing on a single field per call.

## 3.1 Transport prerequisite

The current transport (`packages/mcp-server/src/transport/{base,ssh,docker}.ts`) only passes data through argv. Argv is bounded by `ARG_MAX` on every shell hop (typically a few hundred KB after SSH + `docker exec` nesting), so it cannot be the data path for file bytes.

This PRD adds **stdin support** to the transport as a hard prerequisite:

- `Transport.executeWithStdin(drushCommand, args, stdin: Buffer): Promise<TransportResult>`
- `local`: `execFile` with `child.stdin.write(buf); child.stdin.end()`.
- `ssh`: `ssh -T user@host "<remote cmd>"` with the buffer piped to the local SSH process's stdin.
- `docker`: `ssh -T user@host "docker exec -i <container> <remote cmd>"` — `-i` is required for stdin to reach the container.

The bridge command reads bytes from `php://stdin` (not `/dev/stdin`, which fails on some systems — see [drush issue #926766](https://www.drupal.org/project/drush/issues/926766)).

With stdin in place, the practical ceiling becomes the smaller of `upload_max_filesize` / `post_max_size` on the target site and the configured `file_upload.max_size` in `drush-mcp.yml` (default below).

## 4. Tools

### 4.1 `drupal_file_upload`

Uploads a file to the site's file system and creates a permanent managed `file` entity. Does not attach it anywhere; the agent uses the returned `fid` afterwards.

Input:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `content_base64` | string | — | Base64-encoded file bytes. Required. The TS layer decodes and pipes the raw bytes to the bridge over stdin (see §3.1). |
| `filename` | string | — | Display filename including extension. Required. Sanitised by Drupal core's filename sanitiser before write. |
| `scheme` | enum: `public` / `private` / `temporary` | `public` | Drupal stream wrapper scheme. Validated against `StreamWrapperManager`. |
| `destination` | string | `mcp-uploads/<YYYY-MM>/` (UTC) | Directory within the scheme. The final URI is `<scheme>://<destination>/<sanitised filename>`. Collisions resolved via `FileExists::Rename` (`_0`, `_1`, …). |
| `uid` | number | (configurable, see §6) | Owning user ID. |
| `site` | string | (resolved) | Site key when multiple sites configured. |

Output:

```json
{
  "fid": 12345,
  "uuid": "c8b3a4d2-…",
  "uri": "public://mcp-uploads/2026-05/mautic_audiences_PRD.md",
  "url": "https://example.com/sites/default/files/mcp-uploads/2026-05/mautic_audiences_PRD.md",
  "filename": "mautic_audiences_PRD.md",
  "filemime": "text/markdown",
  "filesize": 27645,
  "status": "permanent"
}
```

`url` is `null` for `private://` and `temporary://` schemes (no public URL available).

Errors:

- `INVALID_BASE64` — content not decodable.
- `INVALID_SCHEME` — scheme not registered in this site.
- `INVALID_DESTINATION` — destination contains `..`, an absolute path, or escapes the scheme root.
- `WRITE_FAILED` — filesystem write rejected (permissions, disk full).
- `EXTENSION_FORBIDDEN` — extension not in the site's allowed list (configurable, see §6).
- `SIZE_EXCEEDED` — payload over the configured `max_size` *or* the site's `upload_max_filesize` / `post_max_size`.
- `SIZE_MISMATCH` — actual stdin byte count diverges from declared `--size`.
- `INTEGRITY_FAILED` — declared `--sha256` does not match the bytes received.

Validation order is documented in §5.2: cheap argv-derivable checks (scheme, destination, extension, declared size) run *before* the bridge reads stdin, so rejected uploads transfer at most one OS pipe buffer.

### 4.2 `drupal_file_attach`

Convenience wrapper: uploads a file (same input as `drupal_file_upload`) **and** appends or replaces the resulting `fid` on a target entity's file-typed field. Image fields (`image`) are supported in v1 with optional `alt` / `title` metadata, since they share the same storage as `file`.

Additional input:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `entity_type` | string | — | Target entity type (e.g. `node`, `comment`, `media`). Required. |
| `entity_id` | number | — | Target entity ID. Required. |
| `field_name` | string | — | Target field. Must be of type `file` or `image`. Required. |
| `mode` | enum: `append` / `replace` | `append` | Whether to keep existing references or overwrite them. |
| `alt` | string | `""` | Alt text. Stored on the field item. Only meaningful for `image` fields. |
| `title` | string | `""` | Title text. Stored on the field item. Only meaningful for `image` fields. |

When the target field is known, validation **also** intersects the file's extension with the field's `file_extensions` setting (which Drupal stores as a space-separated string on the field instance). This catches mismatches *before* the file is written, so no orphan files are produced on rejection.

After the host entity is saved, the bridge registers usage with `\Drupal::service('file.usage')->add($file, 'mcp', $entity_type, $entity_id)`. This binds the file's lifecycle to the host entity so cascade-deletes work correctly. Without it, the file would survive host deletion.

Output: same as `drupal_file_upload` plus:

```json
{
  "attached_to": {
    "entity_type": "comment",
    "entity_id": 190281,
    "field_name": "field_shared_files",
    "mode": "append",
    "current_count": 3
  }
}
```

`current_count` is the post-save number of items on the field.

The two tools share an implementation; `drupal_file_attach` is `drupal_file_upload` followed by a guarded entity load + field-item set + save + `file.usage->add()`. Both run in a single bridge invocation, so failures roll back consistently (file is not orphaned if the entity save fails — see §7).

## 5. Implementation

Mirrors the existing project layout:

### 5.1 TypeScript tool stubs

`packages/mcp-server/src/tools/file.ts` exports `buildFileUploadArgs` and `buildFileAttachArgs`. Unlike the existing builders in `tools/entity.ts`, these return a richer shape because they need to push bytes:

```ts
export interface DrushArgsWithStdin extends DrushArgs {
  stdin?: Buffer; // if present, transport must use executeWithStdin
}
```

The TS layer:
1. Validates input (Zod schema in `index.ts`) — non-empty `filename`, valid `scheme`, `content_base64` decodes.
2. **Pre-flight against cached site config** (`drush-mcp.yml`):
   - Reject with `SIZE_EXCEEDED` if decoded size > `file_upload.max_size`.
   - Reject with `EXTENSION_FORBIDDEN` if the filename's extension is not in `file_upload.allowed_extensions`.
   These are cheap local checks against config the TS layer already has in memory; they save a round trip on the obvious rejects without duplicating the authoritative server-side logic.
3. Decodes `content_base64` → `Buffer`. The decoded bytes go on `stdin`; everything else (`--filename`, `--scheme`, `--destination`, `--uid`, `--size`, `--sha256`, plus the attach target if applicable) goes through argv as `--key=value`. `--size` is sent so the bridge can fail fast on size before reading stdin; `--sha256` lets the bridge verify the bytes match what the client claimed.
4. Calls the transport's new `executeWithStdin('mcp:file-upload', argv, buf)`.

Registered in `packages/mcp-server/src/index.ts` between `drupal_user_block` and `drupal_drush`, matching §9.

### 5.2 Drush bridge commands

`packages/drush-mcp-bridge/src/Drush/Commands/McpBridgeDrushCommands.php` adds:

- `mcp:file-upload` (alias `mfu`) — reads metadata from CLI options (`--filename`, `--scheme`, `--destination`, `--uid`, `--size`, `--sha256`, plus `--field-extensions` and `--field-max-size` when called via `mcp:file-attach`). The command **validates everything it can from argv before touching `php://stdin`**:
  1. Validate scheme against `StreamWrapperManager::getValidStreamWrapper()`. Reject with `INVALID_SCHEME`.
  2. Validate `destination` (no `..`, not absolute, normalises within scheme root). Reject with `INVALID_DESTINATION`.
  3. Validate filename extension against the configured allowlist (∩ field allowlist when applicable). Reject with `EXTENSION_FORBIDDEN`.
  4. Validate `--size` against the configured `max_size`, the field's `max_filesize` (when applicable), and the site's `upload_max_filesize` / `post_max_size`. Reject with `SIZE_EXCEEDED`.
  5. Resolve target directory: `"{$scheme}://{$destination}"`, ensure it exists via `FileSystemInterface::prepareDirectory()` with `CREATE_DIRECTORY | MODIFY_PERMISSIONS`.
  6. Build a safe filename via `FileSystemInterface::createFilename($filename, $directory)`. Reject if the result escapes `$directory`.

  Only after every argv-derivable check has passed does the command consume stdin:

  7. Read bytes from `php://stdin`. If the actual byte count diverges from `--size` by more than the kernel pipe buffer's slack (~64 KB), reject with `SIZE_MISMATCH`. If `--sha256` was provided and doesn't match the actual content hash, reject with `INTEGRITY_FAILED`.
  8. Call `\Drupal::service('file.repository')->writeData($bytes, $uri, FileExists::Rename)`. This returns a `FileInterface` that is **already permanent and saved** (verified in core 11.x `FileRepository::createOrUpdate()` → `$file->setPermanent(); $file->save();`).
  9. Set the owner if `uid` was provided and differs from `$currentUser`.
  10. Emit JSON to stdout.

  Failing fast on argv (steps 1–6) means a rejected upload transfers at most one OS pipe buffer (~64 KB on Linux, ~16 KB on macOS) regardless of declared `--size`, because once the bridge exits non-zero the SSH/docker pipe tears down and the TS-side `child.stdin.write()` gets `EPIPE`.

- `mcp:file-attach` (alias `mfa`) — same as above, plus `--entity-type`, `--entity-id`, `--field-name`, `--mode`, `--alt`, `--title`. Internal flow (attach-specific checks happen in the argv-validation phase, before stdin is read):
  1. Load the host entity. Reject with `ENTITY_NOT_FOUND` if missing.
  2. Reject with `FIELD_INVALID` if the field doesn't exist on the bundle or is not of type `file` / `image`.
  3. Read the field's `file_extensions` and `max_filesize` from the field instance config; feed them into the upload command's argv-validation phase as `--field-extensions` and `--field-max-size`.
  4. Reject with `CARDINALITY_EXCEEDED` if `mode = append` and the field is already at its cardinality limit.
  5. *Now* run the upload (the 10-step flow in `mcp:file-upload`). All field-aware rejections above happen before any byte is read from stdin.
  6. Build the field item: `['target_id' => $file->id(), 'alt' => $alt, 'title' => $title]` (alt/title ignored for `file` type).
  7. `append` mode appends to the existing list; `replace` mode overwrites.
  8. Save the host entity. **If the save fails, delete the just-written file** (file system + managed-file row) to avoid orphans.
  9. Register `\Drupal::service('file.usage')->add($file, 'mcp', $entity_type, $entity_id)`.

Both commands wrap their work in a try/catch that maps Drupal exceptions to the error codes in §4.

### 5.3 No `php:eval` fallback

A previous draft proposed a pure-`drush php:eval` fallback for sites without the bridge installed. It is dropped: §1 documents that `php:eval` truncates argv input around 4–8 KB, which makes it useless for the use cases that motivated this PRD. Sites without the bridge get a clear error at tool-registration time (`drupal_introspect` already detects bridge presence).

## 6. Configuration

- **Allowed extensions**: per-site allowlist, default `txt md pdf png jpg jpeg gif svg log sql json yaml yml zip tar gz`. When `drupal_file_attach` runs against a known field, the global allowlist is **intersected** with the field's `file_extensions` setting (Drupal stores it as a space-separated string on the field instance) and the file is rejected with `EXTENSION_FORBIDDEN` *before* any bytes are written.
- **Max size**: per-site limit, default **10 MB**. With stdin transport the practical ceiling is the smaller of this value and the site's `upload_max_filesize` / `post_max_size`. Above ~25 MB consider the non-goals in §3 (use rsync / object storage instead).
- **Default uid**: `0` (anonymous) by default. Sites can configure `default_uid` to point at a dedicated `mcp_uploader` account if they want non-anonymous attribution. The previous draft defaulted to `1` (User 1) which leaked admin attribution to AI uploads — this is now an explicit opt-in.

Configurable in `drush-mcp.yml`:

```yaml
sites:
  atrium:
    transport: docker
    ...
    file_upload:
      max_size: 10485760
      allowed_extensions: [txt, md, pdf, png, jpg, sql, log, yml, json]
      default_uid: 0  # or: 42 for a dedicated mcp_uploader user
      destination_prefix: "mcp-uploads"  # optional, default shown
```

- **Default destination**: `mcp-uploads/<YYYY-MM>/` (computed in **UTC** to keep bucket boundaries deterministic across servers in different timezones). Keeps agent-uploaded files in one auditable folder, separate from editorial uploads.

## 7. Security

- **Access checks**: bridge command runs through Drupal's normal access checks. The configured user (`uid`) is honoured for ownership; the *acting* user is whoever Drush runs as (typically root or the web user — same boundary as every other `drush-mcp` tool).
- **Path traversal**: `destination` is rejected if it is absolute, contains `..` segments, or — after `FileSystemInterface::createFilename()` resolves the final URI — escapes the resolved directory under `<scheme>://`. The relevant API is `\Drupal\Core\File\FileSystemInterface` and `\Drupal\Core\StreamWrapper\StreamWrapperManager`. (A previous draft cited `\Drupal\Component\Utility\Crypt` for path normalisation — that was wrong; `Crypt` is a hashing utility.)
- **Filename sanitisation**: Drupal core's filename sanitiser runs on every write (configurable per-site via `system.file.yml`: transliteration, lowercase, whitespace replacement). The bridge does not bypass it.
- **Extension validation**: enforced *before* writing, so rejection produces no orphan file. When the target field is known (`drupal_file_attach`), the field's `file_extensions` is intersected with the global allowlist; the more restrictive set wins.
- **MIME type**: validated via `\Drupal::service('file.mime_type.guesser')->guessMimeType($filename)`. This is filename-derived, not content-sniffing — so it catches `.exe` rename attacks but cannot detect a `.pdf` whose bytes are actually JPEG. That trade-off is consistent with how Drupal core's File field validates uploads.
- **File lifecycle**: `FileRepository::writeData()` creates the file with `status = 1` (permanent). `drupal_file_attach` registers `file.usage` against the host entity so cascade-deletes work. `drupal_file_upload` returns a permanent file with no usage entries — the agent is responsible for either attaching it (which registers usage) or deleting it via `drupal_entity_delete`.
- **Roll-back on attach failure**: if the host entity save fails after `writeData` has succeeded, the bridge deletes the just-written file (file system + managed-file entity) before returning the error. No orphans.
- **Transport boundary**: the tool inherits the transport's credentials. No separate auth layer.

## 8. Testing

- **Unit (Vitest, TypeScript)**: tool input validation, base64 decoding, error mapping, transport `executeWithStdin` for each transport (mocked `child_process`).
- **Functional (PHPUnit, Drupal kernel test)**:
  - File written to expected URI, `file_managed` row exists with `status = 1`.
  - Extension and size limits enforced; rejected uploads leave no file on disk.
  - `drupal_file_attach` against a `node` `field_*` (file) appears via `drupal_entity_read`.
  - `drupal_file_attach` against an `image` field stores `alt` / `title` correctly.
  - `file_usage` row exists after attach; deleting the host entity cascades to the file (via standard Drupal logic).
  - `cardinality = 1` field with `mode = append` and existing item rejects with `CARDINALITY_EXCEEDED`.
  - Roll-back: induce an entity save failure (e.g. validation constraint) and assert no file remains.
- **End-to-end manual smoke**: attach a 30 KB markdown to an `ol_todo` comment on the Atrium dev site, verify it downloads correctly. Repeat with a 5 MB SQL dump to exercise the stdin path.

## 9. Documentation

- Add to README's tools table (between `drupal_user_block` and `drupal_drush`).
- Add `docs/file-upload.md` with an end-to-end example: agent receives a screenshot from the user, uploads it, attaches to a comment.
- Add the new bridge command to the bridge commands table.

## 10. Release plan

- 0.x.x feature release of `@bloomidea/drush-mcp` and `bloomidea/drush-mcp-bridge` (lockstep version bump).
- Changelog entry highlighting that agents no longer need the chunked-base64 workaround.
- Skill `Bloomidea/drush-mcp` updated with a section on file uploads (replaces ad-hoc instructions in downstream skills like `post-atrium`).

## 11. Open questions

- **Quota / rate limiting**: out of scope for v1; revisit if abuse appears.
- **Resumable uploads**: if 10 MB proves restrictive in practice, consider adding a `drupal_file_upload_chunk` flow that accumulates chunks in `state` and assembles via `writeData()` once complete. Out of scope for v1; documented in §3 as a non-goal.
- **MIME content-sniffing**: filename-based MIME guessing is enough for v1 (it matches stock Drupal File field behaviour). Revisit only if a security finding requires byte-level sniffing.

Resolved since v0.1:

- ~~Image fields~~ — supported in v1 with optional `alt` / `title` (§4.2).
- ~~Default `uid: 1`~~ — changed to `0` (anonymous) by default; sites can configure a dedicated uploader user (§6).
