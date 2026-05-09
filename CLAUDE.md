# CLAUDE.md

Guidance for AI agents working in this repository.

## What this project is

`drush-mcp` exposes Drupal sites to MCP-aware agents by running Drush. It is a monorepo with two packages that ship in lockstep:

- `packages/mcp-server/` — TypeScript MCP server, npm package `@bloomidea/drush-mcp`.
- `packages/drush-mcp-bridge/` — PHP Drush commands, Composer package `bloomidea/drush-mcp-bridge`.

User-facing docs are in `README.md` and `CONTRIBUTING.md`. This file is for agents.

## Architecture

The MCP server does not call Drupal directly. Each tool flows through three layers:

1. **Tool stub** (`packages/mcp-server/src/tools/<area>.ts`) — receives validated input, returns a `DrushArgs` object describing which Drush command to run and with what flags. No I/O.
2. **Transport** (`packages/mcp-server/src/transport/{local,ssh,docker}.ts`) — executes the Drush command against the configured site. Uses `execFile` with argv; **stdin is not currently piped through any transport**.
3. **Drush bridge** (`packages/drush-mcp-bridge/src/Drush/Commands/McpBridgeDrushCommands.php`) — for structured operations (entity CRUD, introspection), commands named `mcp:*` accept JSON args and return JSON.

Power tools (`drupal_drush`, `drupal_php_eval`, `drupal_sql_query`) skip the bridge and run raw Drush.

## Naming conventions

- MCP tool names: `drupal_<area>_<verb>` (e.g. `drupal_entity_create`, `drupal_user_block`).
- Drush bridge commands: `mcp:<area>-<verb>` (e.g. `mcp:entity-create`, `mcp:entity-list`).
- TypeScript builders: `build<Area><Verb>Args` returning `DrushArgs`.
- Site config keys live under `sites:` in `drush-mcp.yml`; see `drush-mcp.example.yml` for the shape and supported transports.

## When adding a tool

1. Add the builder in `packages/mcp-server/src/tools/<area>.ts`.
2. Register it in `packages/mcp-server/src/index.ts` with a Zod schema and a description (the description is what agents see — be precise).
3. If structured I/O is needed, add the matching `mcp:<area>-<verb>` Drush command in `McpBridgeDrushCommands.php` returning JSON.
4. Add a Vitest unit test for the builder. Functional/Drupal-side tests live with the bridge.
5. Update the tools table in `README.md`. If the change is user-visible, also update `skills/drupal/SKILL.md`.

## Transport limits to remember

- Args are passed via shell argv. SSH and docker transports nest the command inside `ssh user@host '... docker exec ... drush ...'`, so payloads compete with `ARG_MAX` (typically a few hundred KB after nesting).
- Anything above ~200 KB needs a different mechanism than `--data=<base64>`. There is no stdin path on the transport today; adding one means extending `Transport.execute`.
- The `--uri` flag is appended automatically by `transport/base.ts:19` when `config.uri` is set; do not pass it from tool stubs.

## Versioning

The npm package and the Composer package release together. When bumping a feature, bump both `packages/mcp-server/package.json` and `packages/drush-mcp-bridge/composer.json` (if version is set there) in the same change. The skill at `skills/drupal/SKILL.md` is the third leg — update it whenever a tool's contract changes.

## Build, test, lint

```bash
# TypeScript
cd packages/mcp-server
npm install
npm run build      # tsc
npm test           # vitest run

# PHP (syntax check only — no autoloader at repo root)
php -l packages/drush-mcp-bridge/src/Drush/Commands/*.php
```

PHP unit/functional tests run inside a real Drupal site that has the bridge installed; there is no in-repo PHPUnit harness.

## Style

- TypeScript: strict mode, ES2022, NodeNext modules. Prefer explicit types on exports.
- PHP: `declare(strict_types=1)`, PSR-12, Drush 12/13 attributes (`#[CLI\Command]`, `#[CLI\Option]`).
- JSON contracts between TS and PHP are the source of truth; if you change a field name, change it in both places and in the skill.
- Do not add helper abstractions for a single call site. The current builders are deliberately flat.

## Things that are easy to get wrong

- The bridge is a Drush package (`type: drupal-drush`), not a Drupal module. Service registration goes in `drush.services.yml`, not `*.services.yml`.
- `entity:delete` is a stock Drush command; the project deliberately reuses it instead of shipping `mcp:entity-delete` (see `buildEntityDeleteArgs` in `tools/entity.ts`). Keep that pattern unless a reason to diverge appears.
- `siteParam` in `index.ts` is a Zod helper for the per-tool `site` argument that selects which configured site to target — every new tool must accept it.
