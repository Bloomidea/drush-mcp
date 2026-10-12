# Bridge functional tests

`access.sh` checks that the `mcp:*` commands apply Drupal's access checks for
the account they act as: entity create, view and update access, field edit
and view access, and update access on the target of a file attach. It runs
against a real site, so it needs a disposable one with the bridge installed
from this checkout. SQLite keeps it to a directory you can delete.

```bash
composer create-project drupal/recommended-project d11
cd d11
composer require drush/drush
composer config repositories.bridge '{"type":"path","url":"/path/to/drush-mcp/packages/drush-mcp-bridge","options":{"symlink":true}}'
composer require 'bloomidea/drush-mcp-bridge:*@dev'
vendor/bin/drush si standard --db-url=sqlite://sites/default/files/.ht.sqlite -y
vendor/bin/drush recipe "$PWD/web/core/recipes/article_comment"
vendor/bin/drush recipe "$PWD/web/core/recipes/content_editor_role"

/path/to/drush-mcp/packages/drush-mcp-bridge/tests/functional/access.sh .
```

On Drupal 11.4 the standard profile installs no content types, hence the two
recipes. Each run creates its own users and nodes, so the script can be run
again on the same site. It needs `jq`.

The group relationship cases run only when the Group module is enabled, and
are skipped otherwise:

```bash
composer require 'drupal/group:^3'
vendor/bin/drush en group gnode -y
```
