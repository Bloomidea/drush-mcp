<?php

declare(strict_types=1);

namespace DrushMcp\Drush\Commands;

use Drupal\Core\Entity\ContentEntityInterface;
use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\Core\Field\Plugin\Field\FieldType\EntityReferenceItem;

/**
 * Converts Drupal ContentEntityInterface objects to JSON-friendly arrays.
 */
final class EntitySerializer {

  /**
   * Constructs an EntitySerializer instance.
   *
   * @param \Drupal\Core\Entity\EntityTypeManagerInterface $entityTypeManager
   *   The entity type manager for resolving entity references.
   */
  public function __construct(
    protected EntityTypeManagerInterface $entityTypeManager,
  ) {}

  /**
   * Serializes a content entity to a full JSON-friendly array.
   *
   * Includes all fields with their types and values. For entity_reference
   * fields, the referenced entity's label is resolved alongside the target_id.
   *
   * @param \Drupal\Core\Entity\ContentEntityInterface $entity
   *   The entity to serialize.
   *
   * @return array<string, mixed>
   *   A JSON-friendly array representation of the entity.
   */
  public function serialize(ContentEntityInterface $entity): array {
    $fields = [];

    foreach ($entity->getFields() as $fieldName => $fieldItemList) {
      $fieldDefinition = $fieldItemList->getFieldDefinition();
      $fieldType       = $fieldDefinition->getType();
      $values          = [];

      foreach ($fieldItemList as $item) {
        $value = $item->getValue();

        // For entity_reference fields, resolve the label.
        if ($item instanceof EntityReferenceItem && isset($value['target_id'])) {
          try {
            $targetType       = $fieldDefinition->getSetting('target_type');
            $referencedEntity = $this->entityTypeManager->getStorage($targetType)->load($value['target_id']);
            if ($referencedEntity) {
              $value['label'] = $referencedEntity->label();
            }
          }
          catch (\Exception) {
            // If we can't load the referenced entity, just use the target_id.
          }
        }

        $values[] = $value;
      }

      $fields[$fieldName] = [
        'type'   => $fieldType,
        'values' => $values,
      ];
    }

    return [
      'id'     => $entity->id(),
      'uuid'   => $entity->uuid(),
      'type'   => $entity->getEntityTypeId(),
      'bundle' => $entity->bundle(),
      'label'  => $entity->label(),
      'fields' => $fields,
    ];
  }

  /**
   * Serializes a content entity to a lightweight summary array.
   *
   * Suitable for list results where full field data is not required.
   *
   * @param \Drupal\Core\Entity\ContentEntityInterface $entity
   *   The entity to serialize.
   *
   * @return array<string, mixed>
   *   A lightweight JSON-friendly array representation of the entity.
   */
  public function serializeSummary(ContentEntityInterface $entity): array {
    return [
      'id'      => $entity->id(),
      'uuid'    => $entity->uuid(),
      'type'    => $entity->getEntityTypeId(),
      'bundle'  => $entity->bundle(),
      'label'   => $entity->label(),
      'status'  => $entity->hasField('status') ? (bool) $entity->get('status')->value : null,
      'created' => $entity->hasField('created') ? (int) $entity->get('created')->value : null,
      'changed' => $entity->hasField('changed') ? (int) $entity->get('changed')->value : null,
    ];
  }

}
