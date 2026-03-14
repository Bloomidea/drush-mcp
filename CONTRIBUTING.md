# Contributing to drush-mcp

## Setup

```bash
git clone https://github.com/drush-mcp/drush-mcp.git
cd drush-mcp

# TypeScript MCP server
cd packages/mcp-server
npm install
npm test
npm run build

# PHP Drush bridge (no install needed for syntax checks)
php -l packages/drush-bridge/src/Drush/Commands/*.php
```

## Development

The project is a monorepo with two packages:

- `packages/mcp-server/` - TypeScript MCP server (Node.js 18+)
- `packages/drush-bridge/` - PHP Drush commands (PHP 8.1+, Drush 12+)

### TypeScript

```bash
cd packages/mcp-server
npm run dev          # Watch mode
npm test             # Run tests
npm run build        # Compile to dist/
```

Tests use [Vitest](https://vitest.dev/). Add tests alongside your changes in the `tests/` directory.

### PHP

The bridge package has no local dependencies beyond PHP itself. To test with a real Drupal site:

```bash
cd /path/to/drupal
composer config repositories.drush-mcp path /path/to/drush-mcp/packages/drush-bridge
composer require drush-mcp/drush-bridge:@dev
drush mcp:introspect
```

## Pull Requests

1. Fork the repo and create a feature branch
2. Make your changes with tests
3. Run `npm test` and `npm run build` to verify
4. Open a PR against `main`

Keep PRs focused on a single change. Separate bug fixes from features.

## Code Style

- **TypeScript**: Strict mode, ES2022 target, NodeNext modules
- **PHP**: PSR-12, `declare(strict_types=1)`, PHP 8.1+ features, Drush attributes for commands

## Reporting Issues

Open an issue at https://github.com/drush-mcp/drush-mcp/issues with:

- What you expected vs. what happened
- drush-mcp version (`drush-mcp --version`)
- Drupal/Drush version
- Transport type (local/SSH/Docker)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
