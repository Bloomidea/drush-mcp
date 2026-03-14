---
name: drupal
version: 1.0.0
description: >-
  Drupal site management: create, read, update, delete, and query entities,
  introspect field schemas, manage configuration, rebuild caches, view logs,
  and run arbitrary Drush commands. Use when the user asks to "create a node",
  "add a comment", "list tasks", "check Drupal status", "clear caches",
  "read config", "query the database", "introspect fields", "drupal",
  "drush", or any content management task involving a Drupal site.
metadata:
  openclaw:
    category: "cms"
    requires:
      mcpServers: ["drush-mcp"]
---

# drush-mcp

MCP server for Drupal via Drush. Connects to any Drupal 10+/11+ site over local shell, SSH, or Docker.

## Rules of Engagement

- **Introspect before creating:** Always call `drupal_introspect` with `entity_type` and `bundle` before creating or updating entities. This returns required fields, field types, allowed values for taxonomy references, and list field options. Never guess field values.
- **Use the `user` parameter:** Bridge tools (`drupal_entity_create`, `drupal_entity_read`, `drupal_entity_update`, `drupal_entity_list`, `drupal_introspect`) run as anonymous by default on the Drush side. Pass `user` (a Drupal user ID) to run with that user's permissions. Default is uid 1 (admin). Use a specific user when access checks matter (e.g., creating comments, referencing access-controlled entities).
- **Confirm before destructive operations:** `drupal_entity_delete`, `drupal_config_set`, `drupal_php_eval`, and `drupal_sql_query` modify data. Always confirm with the user before executing.
- **Multi-site:** When multiple Drupal sites are configured, every tool accepts a `site` parameter. With a single site, it resolves automatically.

## Tools

### Entity Operations (bridge commands)

These use the drush-bridge package (`bloomidea/drush-mcp-bridge`) installed on the Drupal site.

| Tool | Description |
|------|-------------|
| `drupal_entity_create` | Create entity from JSON fields |
| `drupal_entity_read` | Load entity by type + numeric ID |
| `drupal_entity_update` | Update specific fields on existing entity |
| `drupal_entity_list` | Query entities with filters, pagination, sorting |
| `drupal_entity_delete` | Delete entity by type + numeric ID |
| `drupal_introspect` | Discover entity types, bundles, fields, allowed values |

### System Operations (built-in Drush)

| Tool | Description |
|------|-------------|
| `drupal_cache_rebuild` | Clear all caches |
| `drupal_watchdog` | View recent log entries (supports `count`, `severity` filters) |
| `drupal_status` | Site info: Drupal version, DB, PHP, paths |
| `drupal_config_get` | Read a configuration value (e.g., `system.site`) |
| `drupal_config_set` | Write a configuration value |
| `drupal_field_info` | Field definitions for an entity type |

### User Operations (built-in Drush)

| Tool | Description |
|------|-------------|
| `drupal_user_create` | Create user account |
| `drupal_user_block` | Block a user account |

### Power Tools (built-in Drush)

| Tool | Description |
|------|-------------|
| `drupal_drush` | Run any Drush command (e.g., `pm:security`, `queue:list`). Accepts optional `format` param (json, table, yaml) |
| `drupal_php_eval` | Execute arbitrary PHP on the Drupal site |
| `drupal_sql_query` | Run SQL query against the database |

## Field Value Formats

### Entity references (taxonomy terms, users, nodes)

```json
{"field_name": {"target_id": 42}}
```

Multiple values (if cardinality > 1):
```json
{"field_name": [{"target_id": 42}, {"target_id": 43}]}
```

### Text fields (body, text_with_summary, text_long)

```json
{"body": {"value": "The content here.", "format": "basic_html"}}
```

Common text formats: `basic_html`, `full_html`, `plain_text`, `restricted_html`. When unsure, use `basic_html`.

### Simple fields (string, integer, boolean, email)

```json
{"title": "My Title", "status": 1, "field_email": "user@example.com"}
```

### Date fields

```json
{"field_date": "2026-03-15"}
{"field_date": {"value": "2026-03-15T09:00:00", "end_value": "2026-03-15T17:00:00"}}
```

### List fields (select lists)

Use the machine value, not the label. Call `drupal_introspect` to see `allowed_values`:

```json
{"field_color": "red"}
```

## Common Workflows

### Create an entity (node, comment, etc.)

1. **Introspect** to discover required fields and allowed values:
   ```
   drupal_introspect(entity_type="node", bundle="article")
   ```
2. **Create** with all required fields:
   ```
   drupal_entity_create(entity_type="node", bundle="article", fields={"title": "My Article", "body": {"value": "Content", "format": "basic_html"}, "uid": 1})
   ```

### Add a comment to a node

1. **Introspect** the comment bundle:
   ```
   drupal_introspect(entity_type="comment", bundle="comment_node_article")
   ```
   The bundle name is typically `comment_node_<content_type>`.

2. **Create** the comment with the correct `entity_id`, `entity_type`, `field_name`, and `user`:
   ```
   drupal_entity_create(
     entity_type="comment",
     bundle="comment_node_article",
     user=4,
     fields={
       "entity_id": {"target_id": 123},
       "entity_type": "node",
       "field_name": "comment_node_article",
       "uid": 4,
       "subject": "My comment",
       "comment_body": {"value": "Comment text.", "format": "basic_html"}
     }
   )
   ```
   The `user` parameter is critical for comments since access checks verify the acting user can reference the target node and use the text format.

### Query entities with filters

```
drupal_entity_list(
  entity_type="node",
  bundle="ol_todo",
  filters={"status": 1},
  limit=10,
  sort="changed:DESC"
)
```

### Read a specific entity

```
drupal_entity_read(entity_type="node", id=12345)
```

### Update specific fields

```
drupal_entity_update(entity_type="node", id=12345, fields={"title": "New Title", "field_status": {"target_id": 2}})
```

### Working with Groups (Group module v3)

Groups use `group` and `group_relationship` entities. Content is linked to groups through relationship entities, not directly.

**List groups:**
```
drupal_entity_list(entity_type="group", bundle="client", limit=10)
```

**Create a group:**
```
drupal_entity_create(entity_type="group", bundle="bloom", user=4, fields={"label": "My Project", "uid": 4})
```
Note: groups use `label` (not `title`) for the name field.

**Add a member to a group:**
```
drupal_entity_create(
  entity_type="group_relationship",
  bundle="bloom-group_membership",
  user=4,
  fields={
    "gid": {"target_id": GROUP_ID},
    "entity_id": {"target_id": USER_ID},
    "plugin_id": "group_membership",
    "group_type": {"target_id": "bloom"},
    "uid": 4
  }
)
```

**Add content (e.g. a task) to a group:**
```
drupal_entity_create(
  entity_type="group_relationship",
  bundle="bloom-group_node-ol_todo",
  user=4,
  fields={
    "gid": {"target_id": GROUP_ID},
    "entity_id": {"target_id": NODE_ID},
    "plugin_id": "group_node:ol_todo",
    "group_type": {"target_id": "bloom"},
    "uid": 4
  }
)
```

**Discover available relationship types for a group type:**
```
drupal_introspect(entity_type="group_relationship")
```
This lists all relationship bundles (e.g., `bloom-group_membership`, `bloom-group_node-ol_todo`, `client-group_node-ol_todo`). Use this to find the correct bundle before adding content to a group.

**Key details:**
- Relationship bundle format: `{group_type}-{plugin_id_with_hyphens}` (e.g., `bloom-group_node-ol_todo`)
- The `plugin_id` field value uses colons: `group_node:ol_todo`, `group_membership`
- To find the right bundle: the bundle name replaces colons with hyphens and prepends the group type. So for group type `bloom` and content plugin `group_node:ol_todo`, the bundle is `bloom-group_node-ol_todo`
- To list content in a group, query `group_relationship` filtered by `gid`:
  ```
  drupal_entity_list(entity_type="group_relationship", bundle="bloom-group_node-ol_todo", filters={"gid": GROUP_ID})
  ```
- To list group members: filter by the `*-group_membership` bundle
- When deleting: remove `group_relationship` entities first, then the content, then the group

### Check site health

```
drupal_status()
drupal_watchdog(count=10, severity="error")
drupal_cache_rebuild()
```

### Read and write configuration

```
drupal_config_get(name="system.site")
drupal_config_get(name="system.site", key="name")
drupal_config_set(name="system.site", key="name", value="My Site")
```

### Run arbitrary Drush commands

```
drupal_drush(command="pm:security")
drupal_drush(command="queue:list")
drupal_drush(command="state:get", arguments=["system.cron_last"])
drupal_drush(command="core:status", format="json")
```

Use `format="json"` to get structured output from built-in Drush commands. Common formats: `json`, `table`, `yaml`.

### Execute PHP or SQL

```
drupal_php_eval(code="echo \\Drupal::VERSION;")
drupal_sql_query(query="SELECT COUNT(*) FROM node_field_data WHERE status = 1")
```

## Introspect Modes

`drupal_introspect` operates in three modes depending on which parameters you provide:

| Parameters | Returns |
|---|---|
| (none) | All content entity types with their bundles |
| `entity_type` only | All bundles for that entity type |
| `entity_type` + `bundle` | Full field definitions including type, required, cardinality, and allowed values for entity_reference and list fields |

Always use the third mode (type + bundle) before creating entities to discover required fields and valid values.

## Entity Types Cheat Sheet

Common Drupal entity types:

| Entity Type | Typical Bundles | Notes |
|---|---|---|
| `node` | article, page, custom types | Main content type. Bundle key: `type` |
| `comment` | comment_node_* | One bundle per node type's comment field |
| `taxonomy_term` | vocabulary machine names | Vocabulary is the bundle |
| `user` | user | Single bundle, no bundle key needed |
| `paragraph` | custom paragraph types | Used in nested content structures |
| `media` | image, document, video | Media library items |
| `group` | custom group types | Name field is `label`, not `title`. Requires Group module |
| `group_relationship` | {group_type}-{plugin} | Joins groups to content/members. Bundle format: `bloom-group_node-ol_todo` |

## Safety Rules

> **Write operations** (`drupal_entity_create`, `drupal_entity_update`, `drupal_entity_delete`, `drupal_config_set`) modify data. Always confirm with the user before executing.

> **Power tools** (`drupal_drush`, `drupal_php_eval`, `drupal_sql_query`) provide unrestricted access to the Drupal runtime and database. These can break a site. Use with caution and always confirm.

> `drupal_php_eval` executes arbitrary PHP. Double-check the code before running. Syntax errors or fatal errors can produce unhelpful output.

## Error Handling

All errors are returned as structured JSON:

```json
{"error": "drush_error", "message": "Entity \"node\" with ID \"99999\" not found."}
```

```json
{"error": "validation_error", "message": "Entity validation failed.", "violations": [{"field": "title", "message": "This value should not be null."}]}
```

When you get a `validation_error`, check the `violations` array for which fields failed and why. Often it means a required field is missing or an entity reference target doesn't exist.
