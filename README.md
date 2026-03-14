# drush-mcp

MCP server for Drupal via Drush. Lets AI agents (Claude Code, Gemini CLI, etc.) interact with any Drupal 10+/11+ site by executing Drush commands.

Two packages:
- **`drush-mcp`** (npm) - TypeScript MCP server
- **`bloomidea/drush-mcp-bridge`** (Composer) - PHP Drush bridge for structured entity operations

## Requirements

- Node.js 18+
- PHP 8.1+
- Drush 12+ or 13+
- Drupal 10+ or 11+

## Quick Start

Install the MCP server:

```bash
npm install -g drush-mcp
```

Install the Drush bridge on your Drupal site:

```bash
composer require bloomidea/drush-mcp-bridge
```

Register in Claude Code (local):

```bash
claude mcp add drupal -- drush-mcp --local --command "drush"
```

Or with SSH:

```bash
claude mcp add drupal -- drush-mcp --ssh --host example.com --user deploy --root /var/www/html
```

**Using an AI agent?** Add the [skill](skills/drupal/SKILL.md) to teach your agent how to use the tools effectively:

```bash
npx skills add Bloomidea/drush-mcp
```

> *"create a task in the Atrium group"* / *"list all published articles"* / *"check Drupal status"* / *"add a comment to node 123"*
>
> Works with [Claude Code, Cursor, Codex, Gemini, Windsurf, and 37+ agents](https://add-skill.org/).

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

Create `drush-mcp.yml` in your project root or home directory, or pass `--config path`:

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

All 17 tools are available regardless of transport:

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
| `drupal_drush` | Run any Drush command |
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

Install via Composer and Drush picks them up automatically - no additional registration needed.

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

There are no artificial capability tiers. If you have Drush access to a site, you have access to all tools.

The security boundary is transport access: SSH keys, Docker socket permissions, or local process access. Bridge commands (`mcp:entity-*`) enforce Drupal's entity access checks. Power tools (`drupal_drush`, `drupal_php_eval`, `drupal_sql_query`) do not - treat them accordingly.

## License

MIT
