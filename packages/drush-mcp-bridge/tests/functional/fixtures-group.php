<?php

/**
 * @file
 * Group fixtures for access.sh, run only when the group module is enabled.
 *
 * A group type "team" with group_node:article installed, members (insiders
 * synced from authenticated) allowed to add articles, and a group created by
 * uid 1, who therefore is its only member. Prints the gid and the
 * relationship type id as JSON.
 */

declare(strict_types=1);

use Drupal\group\Entity\Group;
use Drupal\group\Entity\GroupRole;
use Drupal\group\Entity\GroupType;

$type = GroupType::load('team') ?? GroupType::create(['id' => 'team', 'label' => 'Team', 'creator_membership' => TRUE, 'creator_wizard' => FALSE]);
$type->save();

$storage = \Drupal::entityTypeManager()->getStorage('group_relationship_type');
$id      = $storage->getRelationshipTypeId('team', 'group_node:article');
$relationshipType = $storage->load($id) ?? $storage->createFromPlugin($type, 'group_node:article');
$relationshipType->save();

$role = GroupRole::load('team-insider') ?? GroupRole::create([
  'id'          => 'team-insider',
  'label'       => 'Member',
  'group_type'  => 'team',
  'scope'       => 'insider',
  'global_role' => 'authenticated',
]);
$role->grantPermissions(['view group', 'create group_node:article relationship', 'view group_node:article entity'])->save();

$group = Group::create(['type' => 'team', 'label' => 'Team', 'uid' => 1]);
$group->save();

echo json_encode(['gid' => (int) $group->id(), 'relationship_type' => $relationshipType->id()]) . "\n";
