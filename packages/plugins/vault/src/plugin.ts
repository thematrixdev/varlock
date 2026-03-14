import { Resolver } from 'varlock/plugin-lib';
import ky from 'ky';

const { ValidationError, SchemaError, ResolutionError } = plugin.ERRORS;

const VAULT_ICON = 'skill-icons:vault-dark';

plugin.name = 'vault';
const { debug } = plugin;
debug('init - version =', plugin.version);
plugin.icon = VAULT_ICON;

interface CachedToken {
  token: string;
  expiresAt: number;
}

/**
 * Vault KV v2 GET response shape.
 * GET /v1/{mount}/data/{path}
 */
interface VaultKvV2Response {
  request_id: string;
  data: {
    data: Record<string, string>;
    metadata: {
      created_time: string;
      version: number;
      destroyed: boolean;
      deletion_time: string;
    };
  };
}

/**
 * Vault KV v1 GET response shape.
 * GET /v1/{mount}/{path}
 */
interface VaultKvV1Response {
  request_id: string;
  data: Record<string, string>;
}

/**
 * Vault AppRole login response.
 * POST /v1/auth/approle/login
 */
interface VaultAppRoleLoginResponse {
  auth: {
    client_token: string;
    lease_duration: number;
    renewable: boolean;
    policies: Array<string>;
  };
}

/**
 * Manages interaction with a HashiCorp Vault server via its HTTP API.
 * Each instance maps to one Vault server + auth configuration.
 */
class VaultPluginInstance {
  /** Vault server address (e.g. https://vault.example.com:8200) */
  private addr?: string;
  /** Vault namespace (Enterprise feature) */
  private namespace?: string;
  /** KV secrets engine mount path */
  private mount = 'secret';
  /** KV version: 1 or 2 */
  private kvVersion: 1 | 2 = 2;
  /** Prefix to prepend to all secret paths */
  private namePrefix?: string;

  /** Direct token auth */
  private token?: string;
  /** AppRole credentials */
  private roleId?: string;
  private secretId?: string;

  /** Cached auth token (for AppRole) */
  private cachedToken?: CachedToken;
  /** Cache of fetched secrets for the current resolution session */
  private secretCache = new Map<string, Record<string, string>>();

  constructor(readonly id: string) {}

  configure(opts: {
    addr?: string;
    token?: string;
    roleId?: string;
    secretId?: string;
    namespace?: string;
    mount?: string;
    kvVersion?: number;
    namePrefix?: string;
  }) {
    this.addr = opts.addr;
    this.token = opts.token;
    this.roleId = opts.roleId;
    this.secretId = opts.secretId;
    this.namespace = opts.namespace;
    if (opts.mount) this.mount = opts.mount;
    if (opts.kvVersion === 1 || opts.kvVersion === 2) this.kvVersion = opts.kvVersion;
    this.namePrefix = opts.namePrefix;

    debug(
      'vault instance',
      this.id,
      'configured - addr:',
      this.addr || '(not set)',
      'mount:',
      this.mount,
      'kvVersion:',
      this.kvVersion,
      'hasToken:',
      !!this.token,
      'hasAppRole:',
      !!(this.roleId && this.secretId),
    );
  }

  applyNamePrefix(path: string): string {
    if (this.namePrefix) {
      return this.namePrefix + path;
    }
    return path;
  }

  /**
   * Get a valid auth token, using cache when possible.
   * Supports direct token and AppRole authentication.
   */
  private async getAuthToken(): Promise<string> {
    // Direct token takes priority
    if (this.token) {
      return this.token;
    }

    // Check cached AppRole token (with 30s buffer)
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now() + 30_000) {
      debug('Using cached AppRole token');
      return this.cachedToken.token;
    }

    // AppRole login
    if (this.roleId && this.secretId) {
      return this.loginAppRole();
    }

    throw new ResolutionError('No Vault authentication configured', {
      tip: [
        'Provide authentication in @initVault():',
        '  Token auth:   @initVault(addr=..., token=$VAULT_TOKEN)',
        '  AppRole auth: @initVault(addr=..., roleId=$ROLE_ID, secretId=$SECRET_ID)',
      ].join('\n'),
    });
  }

  /**
   * Authenticate via AppRole and cache the resulting token.
   * POST /v1/auth/approle/login
   */
  private async loginAppRole(): Promise<string> {
    if (!this.addr) throw new ResolutionError('Vault addr is required');

    try {
      debug('Authenticating via AppRole');
      const response = await ky.post(`${this.addr}/v1/auth/approle/login`, {
        json: {
          role_id: this.roleId,
          secret_id: this.secretId,
        },
        headers: this.namespace ? { 'X-Vault-Namespace': this.namespace } : undefined,
      }).json<VaultAppRoleLoginResponse>();

      const { client_token, lease_duration } = response.auth;

      this.cachedToken = {
        token: client_token,
        expiresAt: Date.now() + (lease_duration * 1000),
      };

      debug('AppRole login successful, token cached for', lease_duration, 'seconds');
      return client_token;
    } catch (err) {
      return this.handleHttpError(err, 'AppRole login');
    }
  }

  /**
   * Build common request headers for Vault API calls.
   */
  private buildHeaders(token: string): Record<string, string> {
    const headers: Record<string, string> = {
      'X-Vault-Token': token,
    };
    if (this.namespace) {
      headers['X-Vault-Namespace'] = this.namespace;
    }
    return headers;
  }

  /**
   * Fetch a secret's data map from Vault.
   * Returns the full key-value data of the secret.
   *
   * KV v2: GET /v1/{mount}/data/{path}
   * KV v1: GET /v1/{mount}/{path}
   */
  async getSecretData(path: string): Promise<Record<string, string>> {
    if (!this.addr) throw new ResolutionError('Vault addr is required');

    // Check cache
    if (this.secretCache.has(path)) {
      debug('cache hit for', path);
      return this.secretCache.get(path)!;
    }

    const token = await this.getAuthToken();

    const url = this.kvVersion === 2
      ? `${this.addr}/v1/${this.mount}/data/${path}`
      : `${this.addr}/v1/${this.mount}/${path}`;

    try {
      debug('fetching vault secret:', path, '(kv v' + this.kvVersion + ')');

      if (this.kvVersion === 2) {
        const response = await ky.get(url, {
          headers: this.buildHeaders(token),
        }).json<VaultKvV2Response>();

        const data = response.data.data;
        this.secretCache.set(path, data);
        return data;
      } else {
        const response = await ky.get(url, {
          headers: this.buildHeaders(token),
        }).json<VaultKvV1Response>();

        const data = response.data;
        this.secretCache.set(path, data);
        return data;
      }
    } catch (err) {
      return this.handleHttpError(err, `secret "${path}"`);
    }
  }

  /**
   * Handle HTTP errors from Vault API with helpful messages.
   */
  private handleHttpError(err: unknown, context: string): never {
    if (err instanceof ResolutionError) throw err;

    const httpErr = err as any;

    if (httpErr.response) {
      const status = httpErr.response.status;

      if (status === 404) {
        throw new ResolutionError(`Vault ${context} not found`, {
          tip: [
            'Verify the secret path is correct.',
            `Current mount: "${this.mount}" (kv v${this.kvVersion})`,
            'List secrets: vault kv list -mount=<mount> <path>',
          ].join('\n'),
        });
      }

      if (status === 403) {
        throw new ResolutionError(`Permission denied for ${context}`, {
          tip: [
            'Check that your token/role has the required policy.',
            'Required capability: "read" on the secret path.',
            `Example policy: path "${this.mount}/data/*" { capabilities = ["read"] }`,
          ].join('\n'),
        });
      }

      if (status === 401) {
        throw new ResolutionError('Vault authentication failed', {
          tip: [
            'Your token may be expired or invalid.',
            'For token auth: verify $VAULT_TOKEN is correct.',
            'For AppRole: verify roleId and secretId are valid.',
          ].join('\n'),
        });
      }

      if (status === 503) {
        throw new ResolutionError('Vault is sealed or unavailable', {
          tip: 'The Vault server may be sealed, in standby, or not initialized.',
        });
      }

      throw new ResolutionError(`Vault API error (HTTP ${status}) for ${context}`);
    }

    // Network-level errors
    if (httpErr.code === 'ECONNREFUSED' || httpErr.message?.includes('ECONNREFUSED')) {
      throw new ResolutionError('Cannot connect to Vault server', {
        tip: [
          `Check that Vault is running at: ${this.addr}`,
          'Verify VAULT_ADDR is correct.',
        ].join('\n'),
      });
    }

    if (httpErr.message?.includes('ENOTFOUND') || httpErr.message?.includes('getaddrinfo')) {
      throw new ResolutionError('Cannot resolve Vault server hostname', {
        tip: `Check that the Vault address is correct: ${this.addr}`,
      });
    }

    throw new ResolutionError(
      `Failed to access Vault ${context}: ${httpErr instanceof Error ? httpErr.message : String(httpErr)}`,
    );
  }
}


// --- Plugin Instances ---

const pluginInstances: Record<string, VaultPluginInstance> = {};


// --- Root Decorator: @initVault ---

plugin.registerRootDecorator({
  name: 'initVault',
  description: 'Initialize a HashiCorp Vault plugin instance for vault() resolver',
  isFunction: true,
  async process(argsVal) {
    const objArgs = argsVal.objArgs;

    // Validate id is static (if provided)
    if (objArgs?.id && !objArgs.id.isStatic) {
      throw new SchemaError('Expected id to be static');
    }
    const id = String(objArgs?.id?.staticValue || '_default');
    if (pluginInstances[id]) {
      throw new SchemaError(`Vault instance with id "${id}" already initialized`);
    }

    // Validate static-only params
    if (objArgs?.mount && !objArgs.mount.isStatic) {
      throw new SchemaError('Expected mount to be static');
    }
    if (objArgs?.kvVersion && !objArgs.kvVersion.isStatic) {
      throw new SchemaError('Expected kvVersion to be static');
    }
    if (objArgs?.namePrefix && !objArgs.namePrefix.isStatic) {
      throw new SchemaError('Expected namePrefix to be static');
    }
    if (objArgs?.namespace && !objArgs.namespace.isStatic) {
      throw new SchemaError('Expected namespace to be static');
    }

    const mount = objArgs?.mount ? String(objArgs.mount.staticValue) : undefined;
    const kvVersion = objArgs?.kvVersion ? Number(objArgs.kvVersion.staticValue) : undefined;
    const namePrefix = objArgs?.namePrefix ? String(objArgs.namePrefix.staticValue) : undefined;
    const namespace = objArgs?.namespace ? String(objArgs.namespace.staticValue) : undefined;

    pluginInstances[id] = new VaultPluginInstance(id);

    return {
      id,
      mount,
      kvVersion,
      namePrefix,
      namespace,
      addrResolver: objArgs?.addr,
      tokenResolver: objArgs?.token,
      roleIdResolver: objArgs?.roleId,
      secretIdResolver: objArgs?.secretId,
    };
  },
  async execute({
    id, mount, kvVersion, namePrefix, namespace,
    addrResolver, tokenResolver, roleIdResolver, secretIdResolver,
  }) {
    const addr = addrResolver ? String(await addrResolver.resolve()) : undefined;
    const token = tokenResolver ? String(await tokenResolver.resolve()) : undefined;
    const roleId = roleIdResolver ? String(await roleIdResolver.resolve()) : undefined;
    const secretId = secretIdResolver ? String(await secretIdResolver.resolve()) : undefined;

    pluginInstances[id].configure({
      addr, token, roleId, secretId, namespace, mount, kvVersion, namePrefix,
    });
  },
});


// --- Resolver: vault() ---

plugin.registerResolverFunction({
  name: 'vault',
  label: 'Fetch a secret from HashiCorp Vault',
  icon: VAULT_ICON,
  argsSchema: {
    type: 'array',
    arrayMinLength: 1,
    arrayMaxLength: 3,
  },
  process() {
    let instanceId: string;
    let pathResolver: Resolver;
    let keyResolver: Resolver | undefined;

    const argCount = this.arrArgs?.length ?? 0;

    if (argCount === 1) {
      // vault("path") - default instance, return all data as JSON
      instanceId = '_default';
      pathResolver = this.arrArgs![0];
    } else if (argCount === 2) {
      // vault("path", "key") - default instance, extract specific key
      instanceId = '_default';
      pathResolver = this.arrArgs![0];
      keyResolver = this.arrArgs![1];
    } else if (argCount === 3) {
      // vault("instanceId", "path", "key")
      if (!this.arrArgs![0].isStatic) {
        throw new SchemaError('Expected instance id (first argument) to be a static value');
      }
      instanceId = String(this.arrArgs![0].staticValue);
      pathResolver = this.arrArgs![1];
      keyResolver = this.arrArgs![2];
    } else {
      throw new SchemaError('Expected 1, 2, or 3 arguments: vault(path), vault(path, key), or vault(instanceId, path, key)');
    }

    // Validate instance exists
    if (!Object.values(pluginInstances).length) {
      throw new SchemaError('No Vault plugin instances found', {
        tip: 'Initialize at least one Vault plugin instance using the @initVault() root decorator',
      });
    }

    const selectedInstance = pluginInstances[instanceId];
    if (!selectedInstance) {
      if (instanceId === '_default') {
        throw new SchemaError('Vault plugin instance (without id) not found', {
          tip: [
            'Either remove the `id` param from your @initVault call',
            'or use `vault(id, path, key)` to select an instance by id',
            `Available ids: ${Object.keys(pluginInstances).join(', ')}`,
          ].join('\n'),
        });
      } else {
        throw new SchemaError(`Vault plugin instance id "${instanceId}" not found`, {
          tip: `Available ids: ${Object.keys(pluginInstances).join(', ')}`,
        });
      }
    }

    return { instanceId, pathResolver, keyResolver };
  },
  async resolve({ instanceId, pathResolver, keyResolver }) {
    const selectedInstance = pluginInstances[instanceId];

    const path = await pathResolver.resolve();
    if (typeof path !== 'string') {
      throw new SchemaError('Expected secret path to resolve to a string');
    }

    const finalPath = selectedInstance.applyNamePrefix(path);
    const data = await selectedInstance.getSecretData(finalPath);

    // If no key specified, return entire secret data as JSON
    if (!keyResolver) {
      return JSON.stringify(data);
    }

    const key = await keyResolver.resolve();
    if (typeof key !== 'string') {
      throw new SchemaError('Expected key to resolve to a string');
    }

    if (!(key in data)) {
      throw new ResolutionError(`Key "${key}" not found in Vault secret "${finalPath}"`, {
        tip: `Available keys: ${Object.keys(data).join(', ')}`,
      });
    }

    return String(data[key]);
  },
});


// --- Data Type: vaultToken ---

plugin.registerDataType({
  name: 'vaultToken',
  sensitive: true,
  typeDescription: 'HashiCorp Vault authentication token',
  icon: VAULT_ICON,
  docs: [
    {
      description: 'Vault tokens documentation',
      url: 'https://developer.hashicorp.com/vault/docs/concepts/tokens',
    },
  ],
  async validate(val) {
    if (typeof val !== 'string') {
      throw new ValidationError('Must be a string');
    }
    if (val.length === 0) {
      throw new ValidationError('Must not be empty');
    }
  },
});
