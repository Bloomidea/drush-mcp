<?php

declare(strict_types=1);

namespace DrushMcp\Drush\Commands;

use Drupal\Core\Entity\ContentEntityInterface;
use Drupal\Core\Entity\EntityFieldManagerInterface;
use Drupal\Core\Entity\EntityTypeBundleInfoInterface;
use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\Core\Session\AccountInterface;
use Drupal\Core\Session\AccountSwitcherInterface;
use Drush\Attributes as CLI;
use Drush\Commands\DrushCommands;
use Psr\Container\ContainerInterface;

/**
 * Drush MCP bridge commands for entity CRUD operations.
 *
 * All output is JSON only, consumed by the MCP layer.
 */
final class McpBridgeDrushCommands extends DrushCommands {

  /**
   * Constructs a McpBridgeDrushCommands instance.
   *
   * @param \Drupal\Core\Entity\EntityTypeManagerInterface $entityTypeManager
   *   The entity type manager.
   * @param \Drupal\Core\Entity\EntityFieldManagerInterface $entityFieldManager
   *   The entity field manager.
   * @param \Drupal\Core\Entity\EntityTypeBundleInfoInterface $entityTypeBundleInfo
   *   The entity type bundle info service.
   * @param \DrushMcp\Drush\Commands\EntitySerializer $entitySerializer
   *   The entity serializer.
   * @param \Drupal\Core\Session\AccountSwitcherInterface $accountSwitcher
   *   The account switcher service.
   */
  public function __construct(
    protected EntityTypeManagerInterface $entityTypeManager,
    protected EntityFieldManagerInterface $entityFieldManager,
    protected EntityTypeBundleInfoInterface $entityTypeBundleInfo,
    protected EntitySerializer $entitySerializer,
    protected AccountSwitcherInterface $accountSwitcher,
  ) {
    parent::__construct();
  }

  /**
   * Factory method for Drush's PSR-4 command discovery.
   *
   * @param \Psr\Container\ContainerInterface $container
   *   The service container.
   *
   * @return static
   */
  public static function create(ContainerInterface $container): self {
    $entityTypeManager = $container->get('entity_type.manager');
    return new self(
      $entityTypeManager,
      $container->get('entity_field.manager'),
      $container->get('entity_type.bundle.info'),
      new EntitySerializer($entityTypeManager),
      $container->get('account_switcher'),
    );
  }

  /**
   * Creates a new entity of the given type and bundle.
   *
   * @param array<string, mixed> $options
   *   Command options.
   */
  #[CLI\Command(name: 'mcp:entity-create', aliases: ['mec'])]
  #[CLI\Option(name: 'type', description: 'Entity type (e.g. node, taxonomy_term)')]
  #[CLI\Option(name: 'bundle', description: 'Bundle (e.g. article, page)')]
  #[CLI\Option(name: 'fields', description: 'JSON-encoded field values')]
  #[CLI\Option(name: 'user', description: 'Drupal user ID to run as (default: 1)')]
  public function entityCreate(array $options = ['type' => self::REQ, 'bundle' => self::REQ, 'fields' => self::REQ, 'user' => '1']): void {
    $entityTypeId = (string) $options['type'];
    $bundle       = (string) $options['bundle'];
    $fieldsJson   = (string) $options['fields'];

    try {
      $fields = json_decode($fieldsJson, TRUE, 512, JSON_THROW_ON_ERROR);
    }
    catch (\JsonException $e) {
      $this->outputError('validation_error', 'Invalid JSON in --fields: ' . $e->getMessage());
      return;
    }

    $this->runAsUser($options['user'], function () use ($entityTypeId, $bundle, $fields) {
      try {
        $entityType   = $this->entityTypeManager->getDefinition($entityTypeId);
        $bundleKey    = $entityType->getKey('bundle');
        $storage      = $this->entityTypeManager->getStorage($entityTypeId);

        $createValues = $fields;
        if ($bundleKey) {
          $createValues[$bundleKey] = $bundle;
        }

        $entity = $storage->create($createValues);

        $violations = $entity->validate();
        if ($violations->count() > 0) {
          $errors = [];
          foreach ($violations as $violation) {
            $errors[] = [
              'field'   => $violation->getPropertyPath(),
              'message' => $violation->getMessage(),
            ];
          }
          $this->outputError('validation_error', 'Entity validation failed.', ['violations' => $errors]);
          return;
        }

        $entity->save();

        $this->io()->write(json_encode([
          'id'   => $entity->id(),
          'uuid' => $entity->uuid(),
          'uri'  => '/' . $entityTypeId . '/' . $entity->id(),
        ], JSON_THROW_ON_ERROR));
      }
      catch (\Exception $e) {
        $this->outputError('drush_error', $e->getMessage());
      }
    });
  }

  /**
   * Reads and serializes a single entity by type and ID.
   *
   * @param array<string, mixed> $options
   *   Command options.
   */
  #[CLI\Command(name: 'mcp:entity-read', aliases: ['mer'])]
  #[CLI\Option(name: 'type', description: 'Entity type (e.g. node, taxonomy_term)')]
  #[CLI\Option(name: 'id', description: 'Entity ID')]
  #[CLI\Option(name: 'user', description: 'Drupal user ID to run as (default: 1)')]
  public function entityRead(array $options = ['type' => self::REQ, 'id' => self::REQ, 'user' => '1']): void {
    $entityTypeId = (string) $options['type'];
    $entityId     = (string) $options['id'];

    $this->runAsUser($options['user'], function () use ($entityTypeId, $entityId) {
      try {
        $entity = $this->entityTypeManager->getStorage($entityTypeId)->load($entityId);

        if ($entity === NULL) {
          $this->outputError('drush_error', sprintf('Entity "%s" with ID "%s" not found.', $entityTypeId, $entityId));
          return;
        }

        $serialized = $this->entitySerializer->serialize($entity);
        $this->io()->write(json_encode($serialized, JSON_THROW_ON_ERROR));
      }
      catch (\Exception $e) {
        $this->outputError('drush_error', $e->getMessage());
      }
    });
  }

  /**
   * Updates fields on an existing entity.
   *
   * @param array<string, mixed> $options
   *   Command options.
   */
  #[CLI\Command(name: 'mcp:entity-update', aliases: ['meu'])]
  #[CLI\Option(name: 'type', description: 'Entity type (e.g. node, taxonomy_term)')]
  #[CLI\Option(name: 'id', description: 'Entity ID')]
  #[CLI\Option(name: 'fields', description: 'JSON-encoded field values to update')]
  #[CLI\Option(name: 'user', description: 'Drupal user ID to run as (default: 1)')]
  public function entityUpdate(array $options = ['type' => self::REQ, 'id' => self::REQ, 'fields' => self::REQ, 'user' => '1']): void {
    $entityTypeId = (string) $options['type'];
    $entityId     = (string) $options['id'];
    $fieldsJson   = (string) $options['fields'];

    try {
      $fields = json_decode($fieldsJson, TRUE, 512, JSON_THROW_ON_ERROR);
    }
    catch (\JsonException $e) {
      $this->outputError('validation_error', 'Invalid JSON in --fields: ' . $e->getMessage());
      return;
    }

    $this->runAsUser($options['user'], function () use ($entityTypeId, $entityId, $fields) {
      try {
        $entity = $this->entityTypeManager->getStorage($entityTypeId)->load($entityId);

        if ($entity === NULL) {
          $this->outputError('drush_error', sprintf('Entity "%s" with ID "%s" not found.', $entityTypeId, $entityId));
          return;
        }

        $changedFields = [];
        foreach ($fields as $fieldName => $fieldValue) {
          $entity->set($fieldName, $fieldValue);
          $changedFields[] = $fieldName;
        }

        $violations = $entity->validate();
        if ($violations->count() > 0) {
          $errors = [];
          foreach ($violations as $violation) {
            $errors[] = [
              'field'   => $violation->getPropertyPath(),
              'message' => $violation->getMessage(),
            ];
          }
          $this->outputError('validation_error', 'Entity validation failed.', ['violations' => $errors]);
          return;
        }

        $entity->save();

        $this->io()->write(json_encode([
          'id'             => $entity->id(),
          'status'         => 'updated',
          'changed_fields' => $changedFields,
        ], JSON_THROW_ON_ERROR));
      }
      catch (\Exception $e) {
        $this->outputError('drush_error', $e->getMessage());
      }
    });
  }

  /**
   * Lists entities of a given type with optional filtering and sorting.
   *
   * @param array<string, mixed> $options
   *   Command options.
   */
  #[CLI\Command(name: 'mcp:entity-list', aliases: ['mel'])]
  #[CLI\Option(name: 'type', description: 'Entity type')]
  #[CLI\Option(name: 'bundle', description: 'Bundle filter')]
  #[CLI\Option(name: 'filters', description: 'JSON-encoded field filters')]
  #[CLI\Option(name: 'limit', description: 'Maximum results')]
  #[CLI\Option(name: 'offset', description: 'Result offset')]
  #[CLI\Option(name: 'sort', description: 'Sort field:direction (e.g. created:DESC)')]
  #[CLI\Option(name: 'user', description: 'Drupal user ID to run as (default: 1)')]
  public function entityList(array $options = [
    'type'    => self::REQ,
    'bundle'  => NULL,
    'filters' => NULL,
    'limit'   => '50',
    'offset'  => '0',
    'sort'    => NULL,
    'user'    => '1',
  ]): void {
    $type        = (string) $options['type'];
    $limit       = (int) $options['limit'];
    $offset      = (int) $options['offset'];
    $bundle      = !empty($options['bundle']) ? (string) $options['bundle'] : NULL;
    $filtersJson = !empty($options['filters']) ? (string) $options['filters'] : NULL;
    $sort        = !empty($options['sort']) ? (string) $options['sort'] : NULL;

    if ($filtersJson !== NULL) {
      try {
        $filters = json_decode($filtersJson, TRUE, 512, JSON_THROW_ON_ERROR);
      }
      catch (\JsonException $e) {
        $this->outputError('validation_error', 'Invalid JSON in --filters: ' . $e->getMessage());
        return;
      }
    }
    else {
      $filters = [];
    }

    $this->runAsUser($options['user'], function () use ($type, $limit, $offset, $bundle, $filters, $sort) {
      try {
        $storage   = $this->entityTypeManager->getStorage($type);
        $query     = $storage->getQuery()->accessCheck(TRUE);

        if ($bundle !== NULL) {
          $entityType = $this->entityTypeManager->getDefinition($type);
          $bundleKey  = $entityType->getKey('bundle');
          if ($bundleKey) {
            $query->condition($bundleKey, $bundle);
          }
        }

        foreach ($filters as $field => $value) {
          $query->condition($field, $value);
        }

        if ($sort !== NULL) {
          $parts     = explode(':', $sort, 2);
          $sortField = $parts[0];
          $sortDir   = $parts[1] ?? 'ASC';
          $query->sort($sortField, $sortDir);
        }

        $query->range($offset, $limit);

        $ids      = $query->execute();
        $entities = $storage->loadMultiple($ids);

        $items = [];
        foreach ($entities as $entity) {
          $items[] = $this->entitySerializer->serializeSummary($entity);
        }

        $this->io()->write(json_encode([
          'total' => count($items),
          'items' => $items,
        ], JSON_THROW_ON_ERROR));
      }
      catch (\Exception $e) {
        $this->outputError('drush_error', $e->getMessage());
      }
    });
  }

  /**
   * Introspects entity types, bundles, or field definitions.
   *
   * When called with no options, lists all content entity types and their
   * bundles. With --type only, lists bundles for that type. With --type and
   * --bundle, returns full field definitions for that type/bundle combination.
   *
   * @param array<string, mixed> $options
   *   Command options.
   */
  #[CLI\Command(name: 'mcp:introspect', aliases: ['mi'])]
  #[CLI\Option(name: 'type', description: 'Entity type to inspect')]
  #[CLI\Option(name: 'bundle', description: 'Bundle to inspect')]
  #[CLI\Option(name: 'user', description: 'Drupal user ID to run as (default: 1)')]
  public function introspect(array $options = ['type' => NULL, 'bundle' => NULL, 'user' => '1']): void {
    $type   = !empty($options['type']) ? (string) $options['type'] : NULL;
    $bundle = !empty($options['bundle']) ? (string) $options['bundle'] : NULL;

    $this->runAsUser($options['user'], function () use ($type, $bundle) {
      try {
        // Mode 1: No type — list all content entity types with bundles.
        if ($type === NULL) {
          $result = [];
          foreach ($this->entityTypeManager->getDefinitions() as $id => $entityType) {
            if (!$entityType->entityClassImplements(ContentEntityInterface::class)) {
              continue;
            }
            $bundles  = $this->entityTypeBundleInfo->getBundleInfo($id);
            $result[] = [
              'type'    => $id,
              'label'   => (string) $entityType->getLabel(),
              'bundles' => array_keys($bundles),
            ];
          }
          $this->io()->write(json_encode($result, JSON_THROW_ON_ERROR));
          return;
        }

        // Mode 2: Type only — list bundles for that type.
        if ($bundle === NULL) {
          $bundles     = $this->entityTypeBundleInfo->getBundleInfo($type);
          $bundleInfos = [];
          foreach ($bundles as $bundleId => $bundleData) {
            $bundleInfos[] = [
              'id'    => $bundleId,
              'label' => (string) $bundleData['label'],
            ];
          }
          $this->io()->write(json_encode($bundleInfos, JSON_THROW_ON_ERROR));
          return;
        }

        // Mode 3: Type + bundle — full field details.
        $fieldDefinitions = $this->entityFieldManager->getFieldDefinitions($type, $bundle);
        $fields           = [];
        foreach ($fieldDefinitions as $fieldName => $definition) {
          $fieldInfo = [
            'name'        => $fieldName,
            'type'        => $definition->getType(),
            'label'       => (string) $definition->getLabel(),
            'required'    => $definition->isRequired(),
            'cardinality' => $definition->getFieldStorageDefinition()->getCardinality(),
          ];

          // For entity_reference fields, include target info.
          if ($definition->getType() === 'entity_reference') {
            $settings = $definition->getSettings();
            $fieldInfo['target_type']    = $settings['target_type'] ?? NULL;
            $fieldInfo['target_bundles'] = $settings['handler_settings']['target_bundles'] ?? NULL;

            // Load allowed values for taxonomy term references.
            if (($settings['target_type'] ?? '') === 'taxonomy_term' && !empty($settings['handler_settings']['target_bundles'])) {
              $terms   = $this->entityTypeManager->getStorage('taxonomy_term')
                ->loadByProperties(['vid' => array_keys($settings['handler_settings']['target_bundles'])]);
              $allowed = [];
              foreach ($terms as $term) {
                $allowed[] = ['id' => $term->id(), 'label' => $term->label()];
              }
              $fieldInfo['allowed_values'] = $allowed;
            }
          }

          // For list fields, include allowed values.
          if (str_starts_with($definition->getType(), 'list_')) {
            $storageSettings             = $definition->getFieldStorageDefinition()->getSettings();
            $fieldInfo['allowed_values'] = $storageSettings['allowed_values'] ?? [];
          }

          $fields[] = $fieldInfo;
        }

        $this->io()->write(json_encode($fields, JSON_THROW_ON_ERROR));
      }
      catch (\Exception $e) {
        $this->outputError('drush_error', $e->getMessage());
      }
    });
  }

  /**
   * Switches the current Drupal user account for the duration of a callback.
   *
   * @param string $uid
   *   The user ID to switch to.
   * @param callable $callback
   *   The callback to execute as the given user.
   */
  private function runAsUser(string $uid, callable $callback): void {
    if (!is_numeric($uid)) {
      $this->outputError('validation_error', 'The --user option must be a numeric user ID.');
      return;
    }
    $numericUid = (int) $uid;
    try {
      $account = $this->entityTypeManager->getStorage('user')->load($numericUid);
      if (!$account instanceof AccountInterface) {
        $this->outputError('drush_error', sprintf('User with ID "%d" not found.', $numericUid));
        return;
      }
      $this->accountSwitcher->switchTo($account);
      try {
        $callback();
      }
      finally {
        $this->accountSwitcher->switchBack();
      }
    }
    catch (\Exception $e) {
      $this->outputError('drush_error', 'Failed to switch user: ' . $e->getMessage());
    }
  }

  /**
   * Outputs a structured JSON error response.
   *
   * @param string $type
   *   The error type identifier (e.g. 'drush_error', 'validation_error').
   * @param string $message
   *   Human-readable error message.
   * @param array<string, mixed> $context
   *   Additional context to merge into the error output.
   */
  private function outputError(string $type, string $message, array $context = []): void {
    $error = array_merge(['error' => $type, 'message' => $message], $context);
    $this->io()->write(json_encode($error, JSON_THROW_ON_ERROR));
  }

}
