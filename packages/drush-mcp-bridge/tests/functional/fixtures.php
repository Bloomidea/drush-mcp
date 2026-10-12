<?php

/**
 * @file
 * Fixtures for access.sh, run with `drush php:script` on a disposable site.
 *
 * Expects the article_comment and content_editor_role core recipes applied.
 * Creates uid 2 (content_editor, may create and edit articles) and uid 3
 * (authenticated only), node 1 published and node 2 unpublished, both by
 * uid 1. Authenticated users get the comment permissions an editor account
 * typically has. Prints the ids it created as JSON.
 */

declare(strict_types=1);

use Drupal\node\Entity\Node;
use Drupal\user\Entity\User;

user_role_grant_permissions('content_editor', ['access content', 'create article content', 'edit any article content']);
user_role_grant_permissions('authenticated', ['access content', 'access comments', 'post comments', 'skip comment approval']);

foreach ([['editor', ['content_editor']], ['plain', []]] as [$name, $roles]) {
  if (!user_load_by_name($name)) {
    $account = User::create(['name' => $name, 'mail' => "$name@example.com", 'status' => 1, 'pass' => \Drupal::service('password_generator')->generate()]);
    foreach ($roles as $role) {
      $account->addRole($role);
    }
    $account->save();
  }
}

$published = Node::create(['type' => 'article', 'title' => 'Published by admin', 'uid' => 1, 'status' => 1]);
$published->save();
$unpublished = Node::create(['type' => 'article', 'title' => 'Unpublished by admin', 'uid' => 1, 'status' => 0]);
$unpublished->save();

echo json_encode([
  'editor'      => (int) user_load_by_name('editor')->id(),
  'plain'       => (int) user_load_by_name('plain')->id(),
  'published'   => (int) $published->id(),
  'unpublished' => (int) $unpublished->id(),
]) . "\n";
