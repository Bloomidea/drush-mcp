#!/usr/bin/env bash
#
# Functional test of the bridge's access checks, against a disposable Drupal
# site that has the bridge installed. See README.md in this directory for how
# to build one. Usage: access.sh <composer project dir>
#
# Every call names the account it acts as (or none, for anonymous) and checks
# the JSON the bridge prints. Needs jq.

set -u

PROJECT="$(cd "${1:?usage: access.sh <composer project dir>}" && pwd)"
HERE="$(cd "$(dirname "$0")" && pwd)"
drush() { "$PROJECT/vendor/bin/drush" --root="$PROJECT/web" "$@" 2>&1; }

ids="$(drush php:script "$HERE/fixtures.php" | tail -1)"
EDITOR="$(jq -r .editor <<<"$ids")"
PLAIN="$(jq -r .plain <<<"$ids")"
PUBLISHED="$(jq -r .published <<<"$ids")"
UNPUBLISHED="$(jq -r .unpublished <<<"$ids")"

pass=0
fail=0

# check <label> <jq filter that must hold> <output>
check() {
  if printf '%s' "$3" | jq -e "$2" >/dev/null 2>&1; then
    pass=$((pass + 1)); printf 'PASS  %s\n' "$1"
  else
    fail=$((fail + 1)); printf 'FAIL  %s\n      %s\n' "$1" "$(printf '%s' "$3" | head -c 400)"
  fi
}

# expect <label> <jq filter> <drush args...>
expect() {
  local label="$1" filter="$2"; shift 2
  check "$label" "$filter" "$(drush "$@")"
}

echo '# read'
expect 'plain reads a published node'             ".id == \"$PUBLISHED\""            mcp:entity-read --type=node --id="$PUBLISHED" --user="$PLAIN"
expect 'plain cannot read an unpublished node'    '.error == "access_denied"'        mcp:entity-read --type=node --id="$UNPUBLISHED" --user="$PLAIN"
expect 'admin reads the unpublished node'         ".id == \"$UNPUBLISHED\""          mcp:entity-read --type=node --id="$UNPUBLISHED" --user=1
expect 'no --user reads as anonymous'             '.error == "access_denied"'        mcp:entity-read --type=node --id="$UNPUBLISHED"
expect 'own user entity carries no password hash' '(.fields | has("pass")) == false' mcp:entity-read --type=user --id="$PLAIN" --user="$PLAIN"
expect 'admin sees mail, never pass'              '(.fields | has("mail")) and ((.fields | has("pass")) == false)' mcp:entity-read --type=user --id="$PLAIN" --user=1

echo '# update'
expect 'plain cannot update a node'               '.error == "access_denied"'        mcp:entity-update --type=node --id="$PUBLISHED" --fields='{"title":"x"}' --user="$PLAIN"
expect 'editor updates a node'                    '.status == "updated"'             mcp:entity-update --type=node --id="$PUBLISHED" --fields='{"title":"Edited by editor"}' --user="$EDITOR"
expect 'editor cannot reassign the author'        '.error == "access_denied" and .fields == ["uid"]' mcp:entity-update --type=node --id="$PUBLISHED" --fields="{\"uid\":$PLAIN}" --user="$EDITOR"
expect 'editor may resend the unchanged author'   '.status == "updated"'             mcp:entity-update --type=node --id="$PUBLISHED" --fields='{"uid":1,"title":"Again"}' --user="$EDITOR"

echo '# create'
expect 'plain cannot create an article'           '.error == "access_denied"'        mcp:entity-create --type=node --bundle=article --fields='{"title":"x"}' --user="$PLAIN"
expect 'anonymous cannot create an article'       '.error == "access_denied"'        mcp:entity-create --type=node --bundle=article --fields='{"title":"x"}'
expect 'editor creates an article'                '.id != null'                      mcp:entity-create --type=node --bundle=article --fields='{"title":"By editor"}' --user="$EDITOR"
expect 'editor may name itself as author'         '.id != null'                      mcp:entity-create --type=node --bundle=article --fields="{\"title\":\"Self\",\"uid\":$EDITOR}" --user="$EDITOR"
expect 'editor cannot name another author'        '.error == "access_denied" and .fields == ["uid"]' mcp:entity-create --type=node --bundle=article --fields='{"title":"Spoof","uid":1}' --user="$EDITOR"
expect 'plain posts a published comment as itself' '.id != null'                     mcp:entity-create --type=comment --bundle=comment --fields="{\"entity_id\":{\"target_id\":$PUBLISHED},\"entity_type\":\"node\",\"field_name\":\"comment\",\"uid\":$PLAIN,\"subject\":\"Hi\",\"comment_body\":{\"value\":\"<p>Hi</p>\",\"format\":\"basic_html\"},\"status\":1}" --user="$PLAIN"

expect 'a create cannot carry the id of an existing node' '.error == "access_denied" and (.fields | index("nid") != null)' mcp:entity-create --type=node --bundle=article --fields="{\"title\":\"Overwrite\",\"nid\":$PUBLISHED}" --user="$EDITOR"
expect 'a create cannot carry a name that is not a field' '.error == "access_denied" and .fields == ["not_a_field"]' mcp:entity-create --type=node --bundle=article --fields='{"title":"x","not_a_field":1}' --user="$EDITOR"
expect 'an update cannot change a read-only key'  '.error == "access_denied" and .fields == ["uuid"]' mcp:entity-update --type=node --id="$PUBLISHED" --fields='{"uuid":"00000000-0000-0000-0000-000000000000"}' --user="$EDITOR"

echo '# list'
expect 'plain does not see the unpublished node'  "[.items[].id] | index(\"$UNPUBLISHED\") == null" mcp:entity-list --type=node --user="$PLAIN"
expect 'admin sees the unpublished node'          "[.items[].id] | index(\"$UNPUBLISHED\") != null" mcp:entity-list --type=node --user=1
expect 'plain may filter and sort on visible fields' '.items | type == "array"'      mcp:entity-list --type=node --filters='{"status":1}' --sort=created:DESC --user="$PLAIN"
expect 'plain cannot filter users on mail'        '.error == "access_denied" and .fields == ["mail"]' mcp:entity-list --type=user --filters='{"mail":"editor@example.com"}' --user="$PLAIN"
expect 'plain cannot sort users on mail'          '.error == "access_denied"'        mcp:entity-list --type=user --sort=mail --user="$PLAIN"
expect 'no filter may follow a reference'         '.error == "access_denied"'        mcp:entity-list --type=node --filters='{"uid.entity.mail":"admin@example.com"}' --user=1
expect 'nor through an entity:type specifier'     '.error == "access_denied"'        mcp:entity-list --type=node --filters='{"uid.entity:user.mail":"admin@example.com"}' --user=1
expect 'nor sort through one'                     '.error == "access_denied"'        mcp:entity-list --type=node --sort=uid.entity:user.mail --user=1
expect 'a column of the field is fine'            '.items | type == "array"'         mcp:entity-list --type=node --filters='{"uid.target_id":1}' --user="$PLAIN"
expect 'a delta and a column are fine'            '.items | type == "array"'         mcp:entity-list --type=node --filters='{"uid.0.target_id":1}' --user="$PLAIN"
expect 'a property that is not a column is not'   '.error == "access_denied"'        mcp:entity-list --type=node --filters='{"uid.entity":1}' --user=1
expect 'admin may filter users on mail'           '.items | length == 1'             mcp:entity-list --type=user --filters='{"mail":"editor@example.com"}' --user=1

echo '# attach'
PNG="$(mktemp -t drush-mcp-pixel).png"
base64 -d > "$PNG" <<<'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
SIZE="$(wc -c < "$PNG" | tr -d ' ')"
attach() {
  "$PROJECT/vendor/bin/drush" --root="$PROJECT/web" mcp:file-attach --filename=pixel.png --destination=mcp-uploads/test \
    --size="$SIZE" --entity-type=node --entity-id="$PUBLISHED" --field-name=field_image --alt=pixel "$@" < "$PNG" 2>&1
}
check 'plain cannot attach to a node it cannot edit'               '.error == "ACCESS_DENIED"'            "$(attach --uid="$PLAIN" --user="$PLAIN")"
check 'anonymous cannot attach'                                    '.error == "ACCESS_DENIED"'            "$(attach)"
check 'editor attaches, acting through --user'                     ".attached_to.entity_id == $PUBLISHED" "$(attach --uid="$EDITOR" --user="$EDITOR")"
check 'a 0.5.x server sending only --uid still acts as that owner' ".attached_to.entity_id == $PUBLISHED" "$(attach --uid="$EDITOR" --mode=replace)"
rm -f "$PNG"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
