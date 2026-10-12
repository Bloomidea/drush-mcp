# Changelog

Both packages, `@bloomidea/drush-mcp` and `bloomidea/drush-mcp-bridge`, ship
from one git tag, so one entry covers both. Releases before 0.5.1 are described
in the [GitHub Releases](https://github.com/Bloomidea/drush-mcp/releases).

Every change to a default says how to get the previous behaviour back.

## 0.5.1

Security fixes. Upgrade every installation.

### Fixed

- **Shell injection through `drupal_drush`.** The ssh and docker transports
  put the command name unquoted into the remote shell line, so a `command`
  such as `status; id` ran `id` on the remote host as the ssh user. With the
  docker transport that is the host, outside the container. Every transport
  now refuses a command name that is not letters, digits, `:`, `.`, `-` or
  `_`, and every word of the remote line is quoted. The `drupal_drush` schema
  carries the same pattern.
- **`content_path` read any file on the machine running the server.** Any
  absolute path was accepted, and the extension allowlist checked `filename`
  only, so `content_path: ~/.ssh/id_rsa` with `filename: key.txt` uploaded a
  private key to the site. The path must now sit inside a configured root as
  written and once symlinks are resolved, the file it resolves to must carry
  an allowed extension of its own, and nothing outside the roots is touched,
  so the error does not reveal whether a file exists there.
- A scalar `content_roots` or `allowed_extensions` in `drush-mcp.yml` is now
  a `CONFIG_ERROR`. Before, `allowed_extensions: pdf` matched any extension
  that is a substring of `pdf`.

### Changed defaults

- **`file_upload.content_roots`**, new, defaults to the system temp directory
  and `/tmp`. A `content_path` elsewhere fails with `PATH_OUTSIDE_ROOTS`.
  So does a path that reaches a root only through some other symlink: name
  the file by its real path or by the root's own spelling. A path with `.` or
  `..` segments fails with `PATH_NOT_ABSOLUTE`. To keep 0.5.0's
  reach, set `content_roots: [/]` under `defaults.file_upload` or the site's
  `file_upload` (the extension of the real file is checked either way).
  Better: list the folders agents actually upload from (`[/tmp, ~/Dev]`).
- **The `drush` setting is read as plain words.** A wrapper such as
  `php -d memory_limit=-1 vendor/bin/drush` still works; `~`, `$VAR` and other
  shell syntax in it no longer expand, and a path containing a space no
  longer works. Write the path out in full, without spaces (a symlink helps).
- **`drupal_drush` takes a bare command name.** A `command` that carried
  options or a site alias (`"status --format=json"`, `"@prod status"`) is now
  refused; pass options in `arguments`. There is no switch back: the
  unquoted form was the injection.
