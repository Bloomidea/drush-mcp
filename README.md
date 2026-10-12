# drush-mcp

MCP server for Drupal via Drush. Lets AI agents (Claude Code, Gemini CLI, etc.) interact with any Drupal 10+/11+ site - locally, over SSH, or via Docker - by executing Drush commands.

Two packages:
- **`@bloomidea/drush-mcp`** (npm) - TypeScript MCP server
- **`bloomidea/drush-mcp-bridge`** (Composer) - PHP Drush bridge for structured entity operations

## Requirements

- Node.js 18+
- PHP 8.1+
- Drush 12+ or 13+
- Drupal 10+ or 11+

## Quick Start

Install the MCP server:

```bash
npm install -g @bloomidea/drush-mcp
```

Install the Drush bridge on your Drupal site:

```bash
composer require bloomidea/drush-mcp-bridge
```

Add the [agent skill](skills/drupal/SKILL.md) so your agent knows how to work with Drupal entities, fields, and groups:

```bash
npx skills add Bloomidea/drush-mcp
```

> *"create a task in the Atrium group"* / *"list all published articles"* / *"check Drupal status"* / *"add a comment to node 123"*
>
> Works with [Claude Code, Cursor, Codex, Gemini, Windsurf, and 37+ agents](https://add-skill.org/).

Register in Claude Code (local):

```bash
claude mcp add drupal -- drush-mcp --local --command "drush"
```

Or with SSH:

```bash
claude mcp add drupal -- drush-mcp --ssh --host example.com --user deploy --root /var/www/html
```

## Configuration

Three methods: CLI flags, YAML config file, or environment variables.

### CLI Flags

```bash
# Local
drush-mcp --local --command "ddev drush"

# SSH
drush-mcp --ssh --host example.com --user deploy --root /var/www/html

# Docker (static container name)
drush-mcp --docker --host example.com --user deploy --container mycontainer

# Docker (dynamic container lookup via filter)
drush-mcp --docker --host example.com --user deploy --container-filter "label=coolify.serviceName=myapp"
```

### Config File

Create `drush-mcp.yml` in your project root or home directory, or pass `--config path`. The file is used when no transport or host flag is given on the command line; a site defined by CLI flags takes precedence over it (only the file's `defaults:` block is still read). Per-site settings such as `file_upload` therefore need the file route: point the MCP server entry at `drush-mcp` with no site flags and describe the sites in the YAML.

```yaml
sites:
  production:
    transport: ssh
    host: example.com
    user: deploy
    root: /var/www/html
  local:
    transport: local
    command: ddev drush

defaults:
  timeout: 30
```

Each site also takes `tools`, `run_as` and `file_upload`, and `defaults` takes the same three plus `audit_log`; see [Security](#security) and [File upload settings](#file-upload-settings).

### Drush Site Aliases

If your project already uses [Drush site aliases](https://www.drush.org/13.x/site-aliases/) (`drush/sites/self.site.yml`), the fields map directly to `drush-mcp.yml`:

| Drush alias field | drush-mcp equivalent |
|-------------------|---------------------|
| `host` | `host` |
| `user` | `user` |
| `root` | `root` |
| `uri` | `uri` |
| `docker.service` | `container` |

So a Drush alias like:

```yaml
# drush/sites/self.site.yml
live:
  host: example.com
  user: deploy
  root: /var/www/html
  uri: https://example.com
```

Becomes:

```yaml
# drush-mcp.yml
sites:
  live:
    transport: ssh
    host: example.com
    user: deploy
    root: /var/www/html
    uri: https://example.com
```

The main difference is that drush-mcp requires an explicit `transport` field and supports additional options like `containerFilter` for dynamic Docker container lookup.

### File upload settings

Uploads land in the scheme the site expects: `drupal_file_attach` uses the target field's `uri_scheme` and `drupal_file_upload` uses `system.file` `default_scheme`. Pass `scheme` only to override.

`drupal_file_upload` and `drupal_file_attach` accept optional `file_upload` settings in `drush-mcp.yml` (all keys optional, defaults shown):

```yaml
sites:
  production:
    transport: ssh
    host: example.com
    user: deploy
    root: /var/www/html
    uri: https://example.com   # required to get a real public URL back
    file_upload:
      max_size: 10485760                # 10 MB; further capped by upload_max_filesize / post_max_size
      allowed_extensions: [txt, md, pdf, png, jpg, jpeg, gif, svg, log, sql, json, yaml, yml, zip, tar, gz]
      default_uid: 0                    # 0 = anonymous; set to a real user ID for attribution
      destination_prefix: mcp-uploads   # files land in <scheme>://<prefix>/<UTC YYYY-MM>/
      content_roots: [<system temp dir>, /tmp]   # where content_path may read from
```

`content_roots` lists the local directories `content_path` may read from, on
the machine running the MCP server. A path is accepted only when it sits inside
one of them both as written and once symlinks and `..` are resolved, and the
file it resolves to must itself carry an allowed extension: naming a key
`key.txt` in `filename` no longer gets `~/.ssh/id_rsa` through. A root that is
a symlink (`/tmp` on macOS) matches under either spelling. Entries are absolute
or start with `~/`; a root that does not exist is skipped. The default is the system temp
directory and `/tmp`, so the usual flow (write or resize the file into `/tmp`,
then upload it) keeps working. Add a project or documents folder when agents
should upload from there, set `[]` to turn `content_path` off, or set `[/]` to
get the 0.5.0 behaviour of reading any path back.

The same block is accepted under `defaults`, applying to every site that does
not set its own. That is the only route into a server started from CLI flags:
when flags define the site, the config file's `sites` are discarded and only
its `defaults` survive, so a flag-configured server has no `file_upload` of its
own and no way to grow one.

```yaml
defaults:
  timeout: 30
  file_upload:
    allowed_extensions: [txt, md, pdf, png, jpg, jpeg, gif, svg, html, htm, log, sql, json, yaml, yml, zip, tar, gz]
    content_roots: [/tmp, ~/Dev, ~/Downloads]
```

Resolution is three layers deep, each overriding the one before it key by key:
the built-in defaults, then `defaults.file_upload`, then the site's own block.
`allowed_extensions` and `content_roots` **replace** the list rather than
extending it, at every layer: a `content_roots` that should still include
`/tmp` has to name it.

Before adding `html`, `htm` or anything else a browser executes, know what the
list is and is not. It gates the agent, not a person: `drupal_file_attach`
already intersects with the target field's own `file_extensions`, and anyone
with an account can upload against that same field allowlist through the site's
own forms. What the list buys is that an agent talked into it by a poisoned
comment cannot write active content, which matters until the site serves
uploads with something like `Content-Security-Policy: sandbox allow-scripts`.
Note that `svg` ships in the built-in list and is the same class of document as
`html`.

Without a `uri` configured for the site, the tool still works but `url` in the response is `null` (drush in CLI mode without `--uri` cannot build a routable public URL).

### Environment Variables

| Variable | Description |
|----------|-------------|
| `DRUSH_MCP_TRANSPORT` | `local`, `ssh`, or `docker` |
| `DRUSH_MCP_HOST` | SSH/Docker host |
| `DRUSH_MCP_USER` | SSH/Docker user |
| `DRUSH_MCP_ROOT` | Drupal root path |
| `DRUSH_MCP_COMMAND` | Local command (e.g. `ddev drush`) |
| `DRUSH_MCP_CONTAINER` | Docker container name |
| `DRUSH_MCP_CONTAINER_FILTER` | Docker filter for dynamic container lookup |

## Dynamic Container Resolution

When using Docker-based hosting platforms (Coolify, Docker Swarm, etc.), container names change on every deploy. Use `--container-filter` or the `containerFilter` config option with any valid `docker ps --filter` expression:

```bash
# Coolify: match by service name label
drush-mcp --docker --host example.com --user root --container-filter "label=coolify.serviceName=myapp-web"

# Docker Compose: match by compose service
drush-mcp --docker --host example.com --user root --container-filter "label=com.docker.compose.service=web"

# Match by image name
drush-mcp --docker --host example.com --user root --container-filter "ancestor=myimage:latest"
```

Or in `drush-mcp.yml`:

```yaml
sites:
  production:
    transport: docker
    host: example.com
    user: root
    containerFilter: "label=coolify.serviceName=myapp-web"
```

The container name is resolved fresh on every command via `docker ps --filter`, so it automatically picks up new containers after deploys.

### Coolify Setup

If your Drupal site runs on [Coolify](https://coolify.io/):

1. Set a service name in Coolify: **Configuration > General > Name** (e.g., `atrium-web`)
2. Use the label filter:
   ```bash
   claude mcp add drupal-production -- drush-mcp \
     --docker --host your-server.com --user root \
     --container-filter "label=coolify.serviceName=atrium-web"
   ```
3. Install the bridge on your Drupal site: `composer require bloomidea/drush-mcp-bridge`
4. Deploy - the bridge commands are available immediately

## Tools

All 19 tools work on every transport. Which of them a site exposes is its tools profile's call; see [Security](#security).

| Tool | Description |
|------|-------------|
| `drupal_entity_create` | Create entity from JSON fields |
| `drupal_entity_read` | Load entity by type + ID |
| `drupal_entity_update` | Update fields on existing entity |
| `drupal_entity_list` | Query entities with filters |
| `drupal_entity_delete` | Delete entity by type + ID |
| `drupal_introspect` | Discover entity types, bundles, fields |
| `drupal_cache_rebuild` | Clear all caches |
| `drupal_watchdog` | View recent log entries |
| `drupal_status` | Site info (version, DB, PHP) |
| `drupal_config_get` | Read configuration value |
| `drupal_config_set` | Write configuration value |
| `drupal_field_info` | Field definitions for entity type |
| `drupal_user_create` | Create user account |
| `drupal_user_block` | Block user account |
| `drupal_file_upload` | Upload bytes and create a managed file entity |
| `drupal_file_attach` | Upload bytes and attach to a file/image field on a node, comment, or other entity in one round trip |
| `drupal_drush` | Run a Drush command by name; options and arguments go in `arguments` |
| `drupal_php_eval` | Execute PHP code |
| `drupal_sql_query` | Run SQL query |

## Multi-site

When multiple sites are configured, all tools accept a `site` parameter to target a specific site. With a single site configured, it is resolved automatically.

## Drush Bridge Commands

The `bloomidea/drush-mcp-bridge` Composer package provides structured entity commands auto-discovered by Drush:

| Command | Description |
|---------|-------------|
| `mcp:entity-create` | Create an entity |
| `mcp:entity-read` | Read an entity |
| `mcp:entity-update` | Update an entity |
| `mcp:entity-list` | Query entities |
| `mcp:introspect` | Introspect entity types and fields |
| `mcp:file-upload` | Upload bytes (read from stdin) and create a managed file entity |
| `mcp:file-attach` | Upload bytes and attach to a file/image field on an entity, with `file.usage` registration and rollback on failure |

Install via Composer and Drush picks them up automatically - no additional registration needed.

Each command acts as the account in `--user` (default: anonymous; uid 1 before 0.6.0) and applies Drupal's access checks for it, as described under [The acting account](#the-acting-account). The file commands act as `--user` when given, else as the file's owner in `--uid`. `tests/functional/` in the bridge package checks this against a disposable site.

**Important:** The bridge command class file must be named `*DrushCommands.php` (not `*Commands.php`) for Drush 12's PSR-4 discovery. The class also provides a static `create()` factory method for dependency injection from Drupal's service container.

## How is this different from the Drupal MCP Server module?

The [MCP Server](https://www.drupal.org/project/mcp_server) Drupal module takes a different approach: it runs the MCP server **inside** Drupal as a PHP module, exposing tools via HTTP with OAuth 2.1 authentication.

drush-mcp runs **outside** Drupal as a standalone TypeScript process that executes Drush commands over shell, SSH, or Docker. This leads to several practical differences:

| | drush-mcp | MCP Server module |
|---|---|---|
| **Install on Drupal** | Optional Composer package (bridge) | Required module + Tool API + Simple OAuth |
| **Runs as** | External Node.js process | Inside Drupal's PHP runtime |
| **Transport** | STDIO (local shell, SSH, Docker) | HTTP endpoint (`/_mcp`) |
| **Auth model** | SSH keys / shell access | OAuth 2.1 tokens |
| **Config** | YAML file or CLI flags | Drupal config entities |
| **Tools** | 17 fixed tools + arbitrary Drush | Extensible via Tool API plugins |
| **Multi-site** | Built-in (one server, many sites) | One instance per Drupal site |
| **Works without Drupal changes** | Yes (built-in Drush commands work without the bridge) | No (module must be installed and configured) |

**When to use drush-mcp:** You already have SSH/shell access to your sites, want to connect multiple Drupal sites through one MCP server, or prefer not to install additional Drupal modules. Good for development workflows with DDEV/Lando and for ops teams managing multiple sites.

**When to use MCP Server module:** You need fine-grained OAuth-based access control, want to expose custom Tool API plugins, or prefer keeping everything within Drupal's ecosystem.

## Security

The server can do whatever its transport lets it do: an SSH key, the Docker socket or a local process reaches the whole site. An agent, in turn, can be steered by anything it reads, a comment or a web page included. The settings below bound what an agent does with that reach and record what it did.

### Tool profiles

Each site exposes one profile, optionally adjusted with `allow` and `deny`:

| Profile | Tools |
|---------|-------|
| `read-only` | `drupal_entity_read`, `drupal_entity_list`, `drupal_introspect`, `drupal_field_info`, `drupal_status` |
| `content` | `read-only`, plus `drupal_entity_create`, `drupal_entity_update`, `drupal_file_attach` |
| `full` (default) | all 19 |

The restricted profiles hold only the bridge commands, which go through Drupal's access checks, plus `drupal_field_info` and `drupal_status` (which never returns the database username or password, on any profile). On these profiles the server first asks the site's bridge whether it applies access checks (`mcp:bridge-info`) and answers `bridge_too_old` if it does not, and `drupal_file_attach` refuses `scheme` and `destination`: the file goes where the field puts it. Everything that runs as the Drush superuser (config, logs, users, deletes, cache, file upload without a target, raw Drush, PHP, SQL) is `full` only; name it in `allow` to add it anyway.

```yaml
sites:
  production:
    transport: ssh
    host: example.com
    user: deploy
    root: /var/www/html
    run_as: 12                 # the agent's own Drupal account
    tools:
      profile: content
      allow: [drupal_watchdog]
```

`tools` and `run_as` are accepted per site and under `defaults`; a site's own `tools` block replaces the default one whole. `--profile <name>` and `--run-as <uid>` on the command line apply to every site and win over the file. An unknown profile or tool name stops the server at startup. A tool that no site exposes is not listed at all; one that another site exposes answers `tool_disabled`.

### The acting account

Bridge commands act as one Drupal account and apply its permissions: create, view and update access on the entity, view access on every field returned (a user's `pass` and another user's `mail` never come back), edit access on every field whose value changes, and update access on the entity a file is attached to. `drupal_entity_list` drops entities the account may not view, so a page can come back shorter than `limit`, and refuses to filter or sort on a field the account may not view, or along a reference (`uid.entity.mail`): a filter on `mail` answers whose address it is even if `mail` is never returned. `fields` may not change the entity keys (`nid`, `uuid`, `vid`, the bundle), nor carry names that are not fields, nor point `path.pid` at an alias other than the entity's own. Whatever the profile, no upload may land under `styles/`, `css/`, `js/` or `php/`, which Drupal generates and serves itself.

The account is the `user` (or, for the file tools, `uid`) the agent names, else the site's `run_as`, else anonymous; `file_upload.default_uid` only sets the owner recorded on the file, never the account that acts. Before 0.6.0 the fallback was uid 1. On the `read-only` and `content` profiles the agent may not name any account other than `run_as`, so the checks stay the operator's; on `full`, which already has `drupal_php_eval`, it may.

`drupal_file_upload` writes a managed file with no entity to check against, and the tools outside the bridge run as the Drush superuser. That is why neither is in a restricted profile.

### Audit log

Every tool call appends one JSON line to `~/.drush-mcp/audit.jsonl`: time, site, tool, the account a bridge command acted as (`as`), arguments, outcome (`ok`, `error` or `refused`), error code, exit code and duration. A call the MCP SDK turns away before any tool runs (a tool the site does not list, arguments that fail the schema) leaves no line, and the line is written when the call ends. Credential-shaped names (`password`, `secret`, `token`, `api_key`) are redacted at any depth, as are the value of a `drupal_config_set` on such a key and the password of `drush user:password`; PHP code and SQL are logged as given. `content_base64` is reduced to a hash and a length, and strings over 500 characters keep their first 200 plus a hash. The file is created `0600` in a `0700` directory and only ever appended to. Set `defaults.audit_log` to another path, or to `false` to turn it off. When the default path cannot be opened (a read-only home in a container) the server starts without a log and says so on stderr; a path you set must open, or the server does not start.

```json
{"time":"2026-10-12T12:20:03.114Z","site":"production","tool":"drupal_entity_update","args":{"entity_type":"node","id":1,"fields":{"title":"New title"}},"outcome":"ok","exit_code":0,"duration_ms":1843}
```

### Local files

`content_path` reads only from `file_upload.content_roots`; see [File upload settings](#file-upload-settings).

## License

MIT
