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

The npm package and the Composer package release together via a **single git tag**. The bridge's `composer.json` has no `version` field — its version comes from the tag. Only `packages/mcp-server/package.json` carries an explicit version number.

The skill at `skills/drupal/SKILL.md` is the third leg — update it whenever a tool's contract changes, and bump its own frontmatter `version:`.

## Publishing a new release

**Always check what's already taken before picking a version** — doc-only patch releases happen and collisions are easy:

```bash
npm view @bloomidea/drush-mcp versions --json
gh release list --repo Bloomidea/drush-mcp
```

SemVer policy (we're in `0.x`):
- **Patch** (`0.x.y → 0.x.y+1`): bug fixes, doc updates, no behaviour change.
- **Minor** (`0.x.y → 0.(x+1).0`): new tools, new config blocks, additive features.
- Composer's `^0.x` is **patch-only** (`^0.3` means `>=0.3.0 <0.4.0`, NOT `<1.0.0`). Consumers must bump their constraint on every minor — `"^0.1 || ^0.3"` is the standard cross-minor pattern, not `"^0.1"`.

Release steps in order:

1. Bump `packages/mcp-server/package.json` to the new version.
2. If a tool contract changed: update `skills/drupal/SKILL.md` (table + frontmatter `version:`), `README.md` tool/bridge tables, `drush-mcp.example.yml` if config schema grew.
3. Commit (`feat:` for new tools, `fix:` for bug fixes, `chore:` for version-only bumps). One commit per logical change is preferred over a single mega-commit.
4. Annotated tag: `git tag -a v0.x.y -m "v0.x.y — short description"`.
5. Push: `git push origin main && git push origin v0.x.y`.
6. Create the GitHub Release (project convention is one Release per tag, formatted like `v0.2.1`):
   ```bash
   gh release create v0.x.y --title "v0.x.y" --notes "$(cat <<'EOF'
   # drush-mcp v0.x.y
   ## Features / Fixes / Skill / ...
   - bullet points
   ## Install
   \`\`\`bash
   npm install -g @bloomidea/drush-mcp@0.x.y
   \`\`\`
   EOF
   )"
   ```
7. `cd packages/mcp-server && npm publish` — pushes to the npm registry.
8. Refresh Packagist if `composer update` doesn't see the new version: log in to https://packagist.org/packages/bloomidea/drush-mcp-bridge and click "Update". The GitHub→Packagist webhook can lag; manual refresh resolves within ~30s.

After publishing, consumers (atrium and others) need their `bloomidea/drush-mcp-bridge` composer constraint bumped, then `composer update bloomidea/drush-mcp-bridge --with-dependencies`, then a deploy. Tell agents to restart their Claude Code session so the MCP server respawns with the new npm binary.

If `composer update` fails on a consumer with a `composer-plugin-api` constraint conflict (we hit this with `simplesamlphp/composer-module-installer ~2.9.0`), `composer self-update` to the latest is usually the fix — the plugin API version is decoupled from the composer binary version.

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
