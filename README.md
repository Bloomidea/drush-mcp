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

## Configuration

Three methods: CLI flags, YAML config file, or environment variables.

### CLI Flags

```bash
# Local
drush-mcp --local --command "ddev drush"

# SSH
drush-mcp --ssh --host example.com --user deploy --root /var/www/html

# Docker
drush-mcp --docker --host example.com --user deploy --container mycontainer
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
