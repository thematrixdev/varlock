import { Resolver } from 'varlock/plugin-lib';
import { ExecError, spawnAsync } from '@env-spec/utils/exec-helpers';

const { SchemaError, ResolutionError } = plugin.ERRORS;

const PSONO_ICON = 'mdi:shield-key';

plugin.name = 'psono';
const { debug } = plugin;
debug('init - version =', plugin.version);
plugin.icon = PSONO_ICON;

const FIX_INSTALL_TIP = [
  'The `psonoci` command was not found on your system.',
  'Install it from: https://doc.psono.com/admin/installation/install-psono-ci.html',
  'Or download the binary from: https://github.com/meldron/psonoci/releases',
].join('\n');

/**
 * Manages interaction with a Psono server via the `psonoci` CLI.
 * Each instance maps to one Psono API key (via config file or direct credentials).
 */
class PsonoPluginInstance {
  /** Path to the psonoci TOML config file */
  private configPath?: string;
  /** Direct credentials (alternative to configPath) */
  private apiKeyId?: string;
  private apiSecretKeyHex?: string;
  private serverUrl?: string;

  /** Cache of fetched secret fields for the current resolution session */
  private cache = new Map<string, string>();
  /** Track whether `psonoci` CLI is available (lazy check) */
  private psonociChecked = false;

  constructor(readonly id: string) {}

  configure(opts: {
    configPath?: string;
    apiKeyId?: string;
    apiSecretKeyHex?: string;
    serverUrl?: string;
  }) {
    this.configPath = opts.configPath;
    this.apiKeyId = opts.apiKeyId;
    this.apiSecretKeyHex = opts.apiSecretKeyHex;
    this.serverUrl = opts.serverUrl;
    debug(
      'psono instance',
      this.id,
      'configured -',
      this.configPath
        ? `configPath: ${this.configPath}`
        : `direct credentials (hasApiKeyId: ${!!this.apiKeyId}, hasServerUrl: ${!!this.serverUrl})`,
    );
  }

  /**
   * Build the base args for psonoci commands.
   * Uses direct credentials (--api-key-id, etc.) when provided,
   * otherwise falls back to config file (-c) or env vars.
   */
  private get baseArgs(): Array<string> {
    if (this.apiKeyId && this.apiSecretKeyHex && this.serverUrl) {
      return [
        '--api-key-id',
        this.apiKeyId,
        '--api-secret-key-hex',
        this.apiSecretKeyHex,
        '--server-url',
        this.serverUrl,
      ];
    }
    if (this.configPath) return ['-c', this.configPath];
    return [];
  }

  /**
   * Lazily check that the `psonoci` command is available.
   */
  private async ensurePsonociInstalled(): Promise<void> {
    if (this.psonociChecked) return;
    try {
      await spawnAsync('psonoci', ['--version']);
      this.psonociChecked = true;
    } catch (err) {
      if ((err as any).code === 'ENOENT') {
        throw new ResolutionError('`psonoci` command not found', { tip: FIX_INSTALL_TIP });
      }
      // --version might succeed even without config, so we're good
      this.psonociChecked = true;
    }
  }

  /**
   * Retrieve a specific field from a Psono secret by UUID.
   *
   * Maps to: `psonoci -c <config> secret get <uuid> <field>`
   *
   * Field names correspond to psonoci's secret-value-type:
   * password, username, url, notes, title, url_filter, json,
   * gpg_key_private, gpg_key_public, ssh_key_private, ssh_key_public,
   * totp_code, env_vars, credit_card_number, etc.
   */
  async getSecret(secretId: string, field: string): Promise<string> {
    await this.ensurePsonociInstalled();

    const cacheKey = `${secretId}:${field}`;
    if (this.cache.has(cacheKey)) {
      debug('cache hit for', cacheKey);
      return this.cache.get(cacheKey)!;
    }

    try {
      debug('fetching psono secret:', secretId, 'field:', field);
      const result = await spawnAsync(
        'psonoci',
        [...this.baseArgs, 'secret', 'get', secretId, field],
      );
      const value = result.trimEnd();
      this.cache.set(cacheKey, value);
      return value;
    } catch (err) {
      return this.handlePsonociError(err, secretId, field);
    }
  }

  /**
   * Get a TOTP token for a secret.
   *
   * Maps to: `psonoci -c <config> totp get-token <uuid>`
   */
  async getTotpToken(secretId: string): Promise<string> {
    await this.ensurePsonociInstalled();

    // TOTP tokens are time-based and change every 30s, so never cache them
    try {
      debug('fetching psono TOTP token:', secretId);
      const result = await spawnAsync(
        'psonoci',
        [...this.baseArgs, 'totp', 'get-token', secretId],
      );
      return result.trimEnd();
    } catch (err) {
      return this.handlePsonociError(err, secretId, 'totp');
    }
  }

  /**
   * Handle errors from `psonoci` CLI commands with helpful messages.
   */
  private handlePsonociError(err: unknown, secretId: string, field: string): never {
    if (err instanceof ExecError) {
      const errMsg = err.data || err.message;

      if (errMsg.includes('not found') || errMsg.includes('does not exist')) {
        throw new ResolutionError(`Secret "${secretId}" not found in Psono`, {
          tip: [
            'Verify the secret UUID is correct.',
            'List available secrets: psonoci -c <config> api-key secrets | jq keys',
          ].join('\n'),
        });
      }

      if (errMsg.includes('Unauthorized') || errMsg.includes('401') || errMsg.includes('permission')) {
        throw new ResolutionError(`Access denied for secret "${secretId}"`, {
          tip: [
            'Check that your API key has access to this secret.',
            'Verify the API key permissions in Psono admin panel.',
          ].join('\n'),
        });
      }

      if (errMsg.includes('config') || errMsg.includes('api_key_id') || errMsg.includes('server_url')) {
        throw new ResolutionError('Psono configuration error', {
          tip: [
            `Check your config file: ${this.configPath || '(not set)'}`,
            'Ensure it contains: api_key_id, api_secret_key_hex, server_url',
            'See: https://doc.psono.com/admin/installation/install-psono-ci.html',
          ].join('\n'),
        });
      }

      if (errMsg.includes('connect') || errMsg.includes('timeout') || errMsg.includes('resolve')) {
        throw new ResolutionError('Cannot connect to Psono server', {
          tip: [
            'Check that the Psono server is reachable.',
            `Config: ${this.configPath || '(not set)'}`,
          ].join('\n'),
        });
      }

      throw new ResolutionError(
        `Failed to fetch Psono secret "${secretId}" field "${field}": ${errMsg}`,
      );
    }

    if ((err as any).code === 'ENOENT') {
      throw new ResolutionError('`psonoci` command not found', { tip: FIX_INSTALL_TIP });
    }

    throw new ResolutionError(
      `Failed to fetch Psono secret "${secretId}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}


// --- Plugin Instances ---

const pluginInstances: Record<string, PsonoPluginInstance> = {};


// --- Root Decorator: @initPsono ---

plugin.registerRootDecorator({
  name: 'initPsono',
  description: 'Initialize a Psono plugin instance for psono() and psonoTotp() resolvers',
  isFunction: true,
  async process(argsVal) {
    const objArgs = argsVal.objArgs;

    // Validate id is static (if provided)
    if (objArgs?.id && !objArgs.id.isStatic) {
      throw new SchemaError('Expected id to be static');
    }
    const id = String(objArgs?.id?.staticValue || '_default');
    if (pluginInstances[id]) {
      throw new SchemaError(`Psono instance with id "${id}" already initialized`);
    }

    // Validate configPath is static (required for psonoci -c flag)
    if (objArgs?.configPath && !objArgs.configPath.isStatic) {
      throw new SchemaError('Expected configPath to be static');
    }
    const configPath = objArgs?.configPath
      ? String(objArgs.configPath.staticValue)
      : undefined;

    // configPath and direct credentials are mutually exclusive
    if (configPath && (objArgs?.apiKeyId || objArgs?.apiSecretKeyHex || objArgs?.serverUrl)) {
      throw new SchemaError('Cannot use configPath together with apiKeyId/apiSecretKeyHex/serverUrl', {
        tip: 'Use either configPath for a config file, or apiKeyId + apiSecretKeyHex + serverUrl for direct credentials.',
      });
    }

    pluginInstances[id] = new PsonoPluginInstance(id);

    return {
      id,
      configPath,
      apiKeyIdResolver: objArgs?.apiKeyId,
      apiSecretKeyHexResolver: objArgs?.apiSecretKeyHex,
      serverUrlResolver: objArgs?.serverUrl,
    };
  },
  async execute({
    id, configPath, apiKeyIdResolver, apiSecretKeyHexResolver, serverUrlResolver,
  }) {
    const apiKeyId = apiKeyIdResolver ? String(await apiKeyIdResolver.resolve()) : undefined;
    const apiSecretKeyHex = apiSecretKeyHexResolver ? String(await apiSecretKeyHexResolver.resolve()) : undefined;
    const serverUrl = serverUrlResolver ? String(await serverUrlResolver.resolve()) : undefined;

    pluginInstances[id].configure({
      configPath, apiKeyId, apiSecretKeyHex, serverUrl,
    });
  },
});


// --- Resolver: psono() ---

plugin.registerResolverFunction({
  name: 'psono',
  label: 'Fetch a secret field from Psono password manager',
  icon: PSONO_ICON,
  argsSchema: {
    type: 'array',
    arrayMinLength: 1,
    arrayMaxLength: 3,
  },
  process() {
    let instanceId: string;
    let secretIdResolver: Resolver;
    let fieldResolver: Resolver | undefined;

    const argCount = this.arrArgs?.length ?? 0;

    if (argCount === 1) {
      // psono("uuid") - default instance, default field "password"
      instanceId = '_default';
      secretIdResolver = this.arrArgs![0];
    } else if (argCount === 2) {
      // psono("uuid", "field") - default instance, explicit field
      instanceId = '_default';
      secretIdResolver = this.arrArgs![0];
      fieldResolver = this.arrArgs![1];
    } else if (argCount === 3) {
      // psono("instanceId", "uuid", "field")
      if (!this.arrArgs![0].isStatic) {
        throw new SchemaError('Expected instance id (first argument) to be a static value');
      }
      instanceId = String(this.arrArgs![0].staticValue);
      secretIdResolver = this.arrArgs![1];
      fieldResolver = this.arrArgs![2];
    } else {
      throw new SchemaError('Expected 1, 2, or 3 arguments: psono(uuid), psono(uuid, field), or psono(instanceId, uuid, field)');
    }

    // Validate instance exists
    if (!Object.values(pluginInstances).length) {
      throw new SchemaError('No Psono plugin instances found', {
        tip: 'Initialize at least one Psono plugin instance using the @initPsono() root decorator',
      });
    }

    const selectedInstance = pluginInstances[instanceId];
    if (!selectedInstance) {
      if (instanceId === '_default') {
        throw new SchemaError('Psono plugin instance (without id) not found', {
          tip: [
            'Either remove the `id` param from your @initPsono call',
            'or use `psono(id, uuid, field)` to select an instance by id',
            `Available ids: ${Object.keys(pluginInstances).join(', ')}`,
          ].join('\n'),
        });
      } else {
        throw new SchemaError(`Psono plugin instance id "${instanceId}" not found`, {
          tip: `Available ids: ${Object.keys(pluginInstances).join(', ')}`,
        });
      }
    }

    return { instanceId, secretIdResolver, fieldResolver };
  },
  async resolve({ instanceId, secretIdResolver, fieldResolver }) {
    const selectedInstance = pluginInstances[instanceId];

    const secretId = await secretIdResolver.resolve();
    if (typeof secretId !== 'string') {
      throw new SchemaError('Expected secret UUID to resolve to a string');
    }

    // Validate UUID format
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(secretId)) {
      throw new SchemaError(`Invalid secret UUID format: "${secretId}"`, {
        tip: 'Psono secret IDs are UUIDs like "4cd7a400-e8b5-43b2-b732-c36fafc07808"',
      });
    }

    let field = 'password';
    if (fieldResolver) {
      const resolvedField = await fieldResolver.resolve();
      if (typeof resolvedField !== 'string') {
        throw new SchemaError('Expected field name to resolve to a string');
      }
      field = resolvedField;
    }

    return await selectedInstance.getSecret(secretId, field);
  },
});


// --- Resolver: psonoTotp() ---

plugin.registerResolverFunction({
  name: 'psonoTotp',
  label: 'Get a TOTP token from Psono',
  icon: PSONO_ICON,
  argsSchema: {
    type: 'array',
    arrayMinLength: 1,
    arrayMaxLength: 2,
  },
  process() {
    let instanceId: string;
    let secretIdResolver: Resolver;

    const argCount = this.arrArgs?.length ?? 0;

    if (argCount === 1) {
      // psonoTotp("uuid") - default instance
      instanceId = '_default';
      secretIdResolver = this.arrArgs![0];
    } else if (argCount === 2) {
      // psonoTotp("instanceId", "uuid")
      if (!this.arrArgs![0].isStatic) {
        throw new SchemaError('Expected instance id (first argument) to be a static value');
      }
      instanceId = String(this.arrArgs![0].staticValue);
      secretIdResolver = this.arrArgs![1];
    } else {
      throw new SchemaError('Expected 1 or 2 arguments: psonoTotp(uuid) or psonoTotp(instanceId, uuid)');
    }

    if (!Object.values(pluginInstances).length) {
      throw new SchemaError('No Psono plugin instances found', {
        tip: 'Initialize at least one Psono plugin instance using the @initPsono() root decorator',
      });
    }

    const selectedInstance = pluginInstances[instanceId];
    if (!selectedInstance) {
      if (instanceId === '_default') {
        throw new SchemaError('Psono plugin instance (without id) not found', {
          tip: [
            'Either remove the `id` param from your @initPsono call',
            'or use `psonoTotp(id, uuid)` to select an instance by id',
            `Available ids: ${Object.keys(pluginInstances).join(', ')}`,
          ].join('\n'),
        });
      } else {
        throw new SchemaError(`Psono plugin instance id "${instanceId}" not found`, {
          tip: `Available ids: ${Object.keys(pluginInstances).join(', ')}`,
        });
      }
    }

    return { instanceId, secretIdResolver };
  },
  async resolve({ instanceId, secretIdResolver }) {
    const selectedInstance = pluginInstances[instanceId];

    const secretId = await secretIdResolver.resolve();
    if (typeof secretId !== 'string') {
      throw new SchemaError('Expected secret UUID to resolve to a string');
    }

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(secretId)) {
      throw new SchemaError(`Invalid secret UUID format: "${secretId}"`, {
        tip: 'Psono secret IDs are UUIDs like "4cd7a400-e8b5-43b2-b732-c36fafc07808"',
      });
    }

    return await selectedInstance.getTotpToken(secretId);
  },
});


// --- Data Type: psonoApiKeyId ---

plugin.registerDataType({
  name: 'psonoApiKeyId',
  sensitive: false,
  typeDescription: 'Psono API key ID (UUID) used to identify the API key for psonoci CLI (the secret key is the sensitive credential, not the ID)',
  icon: PSONO_ICON,
  docs: [
    {
      description: 'Psono CI documentation',
      url: 'https://doc.psono.com/admin/installation/install-psono-ci.html',
    },
  ],
  async validate(val) {
    if (typeof val !== 'string') {
      throw new plugin.ERRORS.ValidationError('Must be a string');
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val)) {
      throw new plugin.ERRORS.ValidationError(
        'Must be a valid UUID (e.g. "12345678-1234-1234-1234-123456789abc")',
      );
    }
  },
});
