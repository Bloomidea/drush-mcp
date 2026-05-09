<?php

declare(strict_types=1);

namespace DrushMcp\Drush\Commands;

use Drupal\Core\Entity\ContentEntityInterface;
use Drupal\Core\Entity\EntityFieldManagerInterface;
use Drupal\Core\Entity\EntityTypeBundleInfoInterface;
use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\Core\File\FileExists;
use Drupal\Core\File\FileSystemInterface;
use Drupal\Core\Session\AccountInterface;
use Drupal\Core\Session\AccountSwitcherInterface;
use Drupal\Core\StreamWrapper\StreamWrapperManagerInterface;
use Drupal\file\FileInterface;
use Drupal\file\FileRepositoryInterface;
use Drupal\file\FileUsage\FileUsageInterface;
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
    protected FileSystemInterface $fileSystem,
    protected FileRepositoryInterface $fileRepository,
    protected FileUsageInterface $fileUsage,
    protected StreamWrapperManagerInterface $streamWrapperManager,
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
      $container->get('file_system'),
      $container->get('file.repository'),
      $container->get('file.usage'),
      $container->get('stream_wrapper_manager'),
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
   * Uploads a file to the site, returning the new managed file entity as JSON.
   *
   * Reads file bytes from STDIN. Validates scheme, destination, extension, and
   * declared size from CLI options BEFORE consuming stdin so rejected uploads
   * waste at most one OS pipe buffer of network bytes.
   *
   * @param array<string, mixed> $options
   *   Command options.
   */
  #[CLI\Command(name: 'mcp:file-upload', aliases: ['mfu'])]
  #[CLI\Option(name: 'filename', description: 'Display filename including extension')]
  #[CLI\Option(name: 'scheme', description: 'Stream wrapper scheme (public, private, temporary)')]
  #[CLI\Option(name: 'destination', description: 'Directory within the scheme')]
  #[CLI\Option(name: 'uid', description: 'Owning user ID')]
  #[CLI\Option(name: 'size', description: 'Declared payload size in bytes (verified against stdin)')]
  #[CLI\Option(name: 'sha256', description: 'Optional SHA-256 of the payload for integrity check')]
  #[CLI\Option(name: 'field-extensions', description: 'Space-separated extension allowlist from the target field (intersected when attaching)')]
  #[CLI\Option(name: 'field-max-size', description: 'Max size in bytes from the target field instance')]
  public function fileUpload(array $options = [
    'filename'         => self::REQ,
    'scheme'           => 'public',
    'destination'      => self::REQ,
    'uid'              => '0',
    'size'             => self::REQ,
    'sha256'           => NULL,
    'field-extensions' => NULL,
    'field-max-size'   => NULL,
  ]): void {
    $actingUid = (string) ($options['uid'] ?? '0');
    $this->runAsUser($actingUid !== '0' ? $actingUid : '1', function () use ($options) {
      try {
        $file = $this->processUpload($options);
        $this->io()->write(json_encode($this->fileToOutput($file), JSON_THROW_ON_ERROR));
      }
      catch (FilePreflightException $e) {
        $this->outputError($e->getErrorCode(), $e->getMessage());
      }
      catch (\Exception $e) {
        $this->outputError('drush_error', $e->getMessage());
      }
    });
  }

  /**
   * Uploads a file and attaches it to a file/image field on a target entity.
   *
   * @param array<string, mixed> $options
   *   Command options.
   */
  #[CLI\Command(name: 'mcp:file-attach', aliases: ['mfa'])]
  #[CLI\Option(name: 'filename', description: 'Display filename including extension')]
  #[CLI\Option(name: 'scheme', description: 'Stream wrapper scheme (public, private, temporary)')]
  #[CLI\Option(name: 'destination', description: 'Directory within the scheme')]
  #[CLI\Option(name: 'uid', description: 'Owning user ID')]
  #[CLI\Option(name: 'size', description: 'Declared payload size in bytes')]
  #[CLI\Option(name: 'sha256', description: 'Optional SHA-256 of the payload')]
  #[CLI\Option(name: 'entity-type', description: 'Target entity type (e.g. node, comment)')]
  #[CLI\Option(name: 'entity-id', description: 'Target entity ID')]
  #[CLI\Option(name: 'field-name', description: 'Target field (must be of type file or image)')]
  #[CLI\Option(name: 'mode', description: 'append or replace')]
  #[CLI\Option(name: 'alt', description: 'Alt text for image fields')]
  #[CLI\Option(name: 'title', description: 'Title text for image fields')]
  public function fileAttach(array $options = [
    'filename'    => self::REQ,
    'scheme'      => 'public',
    'destination' => self::REQ,
    'uid'         => '0',
    'size'        => self::REQ,
    'sha256'      => NULL,
    'entity-type' => self::REQ,
    'entity-id'   => self::REQ,
    'field-name'  => self::REQ,
    'mode'        => 'append',
    'alt'         => NULL,
    'title'       => NULL,
  ]): void {
    $entityTypeId = (string) $options['entity-type'];
    $entityId     = (string) $options['entity-id'];
    $fieldName    = (string) $options['field-name'];
    $mode         = (string) $options['mode'];
    $alt          = $options['alt']   !== NULL ? (string) $options['alt']   : '';
    $title        = $options['title'] !== NULL ? (string) $options['title'] : '';

    if (!in_array($mode, ['append', 'replace'], TRUE)) {
      $this->outputError('VALIDATION_ERROR', sprintf('mode must be "append" or "replace", got "%s"', $mode));
      return;
    }

    $actingUid = (string) ($options['uid'] ?? '0');
    $this->runAsUser($actingUid !== '0' ? $actingUid : '1', function () use ($options, $entityTypeId, $entityId, $fieldName, $mode, $alt, $title) {
    try {
      // Load and validate entity + field BEFORE consuming stdin.
      $storage = $this->entityTypeManager->getStorage($entityTypeId);
      $entity  = $storage->load($entityId);
      if ($entity === NULL) {
        throw new FilePreflightException(sprintf('Entity %s:%s not found', $entityTypeId, $entityId), 'ENTITY_NOT_FOUND');
      }
      if (!$entity instanceof ContentEntityInterface) {
        throw new FilePreflightException(sprintf('Entity %s is not a content entity', $entityTypeId), 'FIELD_INVALID');
      }
      if (!$entity->hasField($fieldName)) {
        throw new FilePreflightException(sprintf('Field %s does not exist on %s', $fieldName, $entityTypeId), 'FIELD_INVALID');
      }
      $fieldDefinition = $entity->getFieldDefinition($fieldName);
      $fieldType       = $fieldDefinition->getType();
      if (!in_array($fieldType, ['file', 'image'], TRUE)) {
        throw new FilePreflightException(sprintf('Field %s is type "%s", not file/image', $fieldName, $fieldType), 'FIELD_INVALID');
      }

      // Cardinality check (for append only — replace clears first).
      $cardinality = $fieldDefinition->getFieldStorageDefinition()->getCardinality();
      $current     = $entity->get($fieldName);
      if ($mode === 'append' && $cardinality !== -1 && $current->count() >= $cardinality) {
        throw new FilePreflightException(sprintf('Field %s is at cardinality limit (%d)', $fieldName, $cardinality), 'CARDINALITY_EXCEEDED');
      }

      // Feed field-aware constraints into the upload step.
      $fieldSettings = $fieldDefinition->getSettings();
      $uploadOptions = $options;
      $uploadOptions['field-extensions'] = $fieldSettings['file_extensions'] ?? NULL;
      $uploadOptions['field-max-size']   = $this->parseMaxFilesize($fieldSettings['max_filesize'] ?? NULL);

      $file = $this->processUpload($uploadOptions);

      // Attach to the field.
      try {
        $newItem = ['target_id' => $file->id()];
        if ($fieldType === 'image') {
          $newItem['alt']   = $alt;
          $newItem['title'] = $title;
        }
        if ($mode === 'replace') {
          $entity->set($fieldName, [$newItem]);
        }
        else {
          $items   = $current->getValue();
          $items[] = $newItem;
          $entity->set($fieldName, $items);
        }
        $violations = $entity->validate();
        if ($violations->count() > 0) {
          $errors = [];
          foreach ($violations as $violation) {
            $errors[] = ['field' => $violation->getPropertyPath(), 'message' => (string) $violation->getMessage()];
          }
          throw new \RuntimeException('Entity validation failed: ' . json_encode($errors));
        }
        $entity->save();
        $this->fileUsage->add($file, 'mcp', $entityTypeId, (string) $entity->id());
      }
      catch (\Throwable $attachError) {
        // Roll back the just-written file so we don't leave an orphan.
        try {
          $uri = $file->getFileUri();
          $file->delete();
          if ($uri && file_exists($uri)) {
            $this->fileSystem->delete($uri);
          }
        }
        catch (\Throwable $rollbackError) {
          // Best-effort rollback; surface the original error.
        }
        throw $attachError;
      }

      $output = $this->fileToOutput($file);
      $output['attached_to'] = [
        'entity_type'   => $entityTypeId,
        'entity_id'     => (int) $entity->id(),
        'field_name'    => $fieldName,
        'mode'          => $mode,
        'current_count' => $entity->get($fieldName)->count(),
      ];
      $this->io()->write(json_encode($output, JSON_THROW_ON_ERROR));
    }
    catch (FilePreflightException $e) {
      $this->outputError($e->getErrorCode(), $e->getMessage());
    }
    catch (\Exception $e) {
      $this->outputError('drush_error', $e->getMessage());
    }
    });
  }

  /**
   * Performs the full upload flow: argv validation, stdin read, writeData.
   *
   * @param array<string, mixed> $options
   *   Resolved CLI options.
   *
   * @return \Drupal\file\FileInterface
   *   The created managed file entity (already permanent and saved).
   *
   * @throws \DrushMcp\Drush\Commands\FilePreflightException
   */
  private function processUpload(array $options): FileInterface {
    $filename       = (string) $options['filename'];
    $scheme         = (string) ($options['scheme'] ?? 'public');
    $destination    = (string) $options['destination'];
    $uid            = (int)    ($options['uid'] ?? 0);
    $declaredSize   = (int)    $options['size'];
    $declaredSha256 = $options['sha256'] !== NULL ? (string) $options['sha256'] : NULL;

    // 1. Scheme.
    if ($this->streamWrapperManager->getViaScheme($scheme) === FALSE) {
      throw new FilePreflightException(sprintf('Scheme "%s" is not registered on this site', $scheme), 'INVALID_SCHEME');
    }

    // 2. Destination — reject absolute paths and traversal segments.
    if ($destination === '' || $destination[0] === '/' || str_contains($destination, '..')) {
      throw new FilePreflightException('destination must be relative and must not contain ".."', 'INVALID_DESTINATION');
    }

    // 3. Extension allowlist (intersected with field allowlist when present).
    $ext = strtolower(pathinfo($filename, PATHINFO_EXTENSION));
    if ($ext === '') {
      throw new FilePreflightException('filename has no extension', 'EXTENSION_FORBIDDEN');
    }
    if (!empty($options['field-extensions'])) {
      $allowed = array_filter(preg_split('/\s+/', strtolower((string) $options['field-extensions'])));
      if (!in_array($ext, $allowed, TRUE)) {
        throw new FilePreflightException(
          sprintf('extension "%s" not allowed for the target field (allowed: %s)', $ext, implode(' ', $allowed)),
          'EXTENSION_FORBIDDEN',
        );
      }
    }

    // 4. Declared size — against field max, then site PHP limits.
    if (!empty($options['field-max-size']) && $declaredSize > (int) $options['field-max-size']) {
      throw new FilePreflightException(
        sprintf('declared size %d exceeds field max %d', $declaredSize, (int) $options['field-max-size']),
        'SIZE_EXCEEDED',
      );
    }
    $phpMax = $this->phpUploadMax();
    if ($phpMax > 0 && $declaredSize > $phpMax) {
      throw new FilePreflightException(
        sprintf('declared size %d exceeds PHP upload limit %d', $declaredSize, $phpMax),
        'SIZE_EXCEEDED',
      );
    }

    // 5. Resolve target directory.
    $directory = sprintf('%s://%s', $scheme, trim($destination, '/'));
    if (!$this->fileSystem->prepareDirectory($directory, FileSystemInterface::CREATE_DIRECTORY | FileSystemInterface::MODIFY_PERMISSIONS)) {
      throw new FilePreflightException(sprintf('Could not prepare destination directory "%s"', $directory), 'WRITE_FAILED');
    }

    // 6. Safe filename.
    $safeUri = $this->fileSystem->createFilename(basename($filename), $directory);
    if (!str_starts_with($safeUri, $directory . '/')) {
      throw new FilePreflightException('resolved filename escapes destination directory', 'INVALID_DESTINATION');
    }

    // 7. Read stdin.
    $bytes = file_get_contents('php://stdin');
    if ($bytes === FALSE) {
      throw new FilePreflightException('Failed to read payload from stdin', 'WRITE_FAILED');
    }
    $actual = strlen($bytes);
    // Allow a small slack (one pipe buffer) since clients may end early on EPIPE.
    if (abs($actual - $declaredSize) > 65536) {
      throw new FilePreflightException(
        sprintf('actual stdin bytes (%d) diverge from declared --size (%d)', $actual, $declaredSize),
        'SIZE_MISMATCH',
      );
    }
    if ($declaredSha256 !== NULL) {
      $hash = hash('sha256', $bytes);
      if (!hash_equals($declaredSha256, $hash)) {
        throw new FilePreflightException('SHA-256 of received bytes does not match --sha256', 'INTEGRITY_FAILED');
      }
    }

    // 8. Write — file_repository sets permanent + save() internally.
    $file = $this->fileRepository->writeData($bytes, $safeUri, FileExists::Rename);

    // 9. Owner.
    if ($uid > 0 && (int) $file->getOwnerId() !== $uid) {
      $file->setOwnerId($uid);
      $file->save();
    }

    return $file;
  }

  /**
   * Builds the JSON output shape for a managed file.
   *
   * @return array<string, mixed>
   */
  private function fileToOutput(FileInterface $file): array {
    $uri    = $file->getFileUri();
    $scheme = $this->streamWrapperManager::getScheme($uri);
    $url    = NULL;
    if ($scheme === 'public') {
      $candidate = $file->createFileUrl(FALSE);
      // Drupal CLI without --uri returns "http://default/..." which is not a
      // routable URL. Suppress it so consumers don't paste a broken link.
      if (!str_starts_with($candidate, 'http://default') && !str_starts_with($candidate, 'https://default')) {
        $url = $candidate;
      }
    }
    return [
      'fid'      => (int) $file->id(),
      'uuid'     => $file->uuid(),
      'uri'      => $uri,
      'url'      => $url,
      'filename' => $file->getFilename(),
      'filemime' => $file->getMimeType(),
      'filesize' => (int) $file->getSize(),
      'status'   => $file->isPermanent() ? 'permanent' : 'temporary',
    ];
  }

  /**
   * Parses a Drupal max_filesize string ("2 MB", "500 KB") into bytes.
   */
  private function parseMaxFilesize(?string $value): ?int {
    if ($value === NULL || $value === '') {
      return NULL;
    }
    return (int) \Drupal\Component\Utility\Bytes::toNumber($value);
  }

  /**
   * Returns the smaller of upload_max_filesize and post_max_size, in bytes.
   */
  private function phpUploadMax(): int {
    $upload = \Drupal\Component\Utility\Bytes::toNumber((string) ini_get('upload_max_filesize'));
    $post   = \Drupal\Component\Utility\Bytes::toNumber((string) ini_get('post_max_size'));
    $values = array_filter([$upload, $post], fn($v) => $v > 0);
    return $values ? (int) min($values) : 0;
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

/**
 * Carries a structured error code (e.g. INVALID_SCHEME) alongside the message.
 *
 * Caught by the file commands and emitted through outputError() so the TS layer
 * sees the same error codes documented in the PRD.
 */
final class FilePreflightException extends \Exception {

  /**
   * @param string $message
   *   Human-readable error message.
   * @param string $errorCode
   *   Machine-readable error code (e.g. INVALID_SCHEME, EXTENSION_FORBIDDEN).
   */
  public function __construct(string $message, private string $errorCode) {
    parent::__construct($message);
  }

  public function getErrorCode(): string {
    return $this->errorCode;
  }

}
