# Psono Plugin Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a Varlock plugin that fetches secrets and TOTP codes from Psono password manager via the `psonoci` CLI.

**Architecture:** CLI-wrapper approach (like the `pass` plugin). The plugin shells out to `psonoci` for all secret retrieval, supporting multiple Psono accounts via named instances. Secrets are referenced by UUID; fields are specified by name. A separate `psonoTotp()` resolver handles TOTP code generation since it uses a distinct CLI command.

**Tech Stack:** TypeScript, tsup (bundler), Vitest (tests), `psonoci` CLI (runtime dependency), `@env-spec/utils/exec-helpers` (subprocess execution)

---

## File Structure

```
packages/plugins/psono/
  package.json          # Package manifest with varlock peer dep
  tsconfig.json         # TypeScript config (identical to other plugins)
  tsup.config.ts        # Build config (identical to pass plugin)
  src/
    plugin.ts           # Main plugin: instance class, decorators, resolvers
```

**Responsibilities:**

| File | Responsibility |
|------|---------------|
| `package.json` | Package metadata, exports `"./plugin"`, devDependencies |
| `tsup.config.ts` | Bundle `src/plugin.ts` to `dist/plugin.js` as ESM |
| `src/plugin.ts` | `PsonoPluginInstance` class (CLI wrapper, caching), `@initPsono` root decorator, `psono()` resolver, `psonoTotp()` resolver, `psonoApiKeyId` data type |

---

## Chunk 1: Project Scaffolding and Plugin Instance Class

### Task 1: Create package scaffolding

**Files:**
- Create: `packages/plugins/psono/package.json`
- Create: `packages/plugins/psono/tsconfig.json`
- Create: `packages/plugins/psono/tsup.config.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@varlock/psono-plugin",
  "description": "Varlock plugin to load secrets from Psono password manager",
  "version": "0.0.1",
  "type": "module",
  "homepage": "https://varlock.dev/plugins/psono/",
  "bugs": "https://github.com/dmno-dev/varlock/issues",
  "repository": {
    "type": "git",
    "url": "https://github.com/dmno-dev/varlock.git",
    "directory": "packages/plugins/psono"
  },
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    "./plugin": "./dist/plugin.js"
  },
  "files": ["dist"],
  "scripts": {
    "dev": "tsup --watch",
    "build": "tsup",
    "test": "vitest"
  },
  "keywords": [
    "varlock",
    "plugin",
    "varlock-plugin",
    "psono",
    "password-manager",
    "secrets",
    "secret-management",
    "env",
    ".env",
    "dotenv",
    "environment variables",
    "env vars",
    "config",
    "self-hosted"
  ],
  "author": "dmno-dev",
  "license": "MIT",
  "engines": {
    "node": ">=22"
  },
  "peerDependencies": {
    "varlock": "workspace:^"
  },
  "devDependencies": {
    "@env-spec/utils": "workspace:^",
    "@types/node": "catalog:",
    "tsup": "catalog:",
    "varlock": "workspace:^",
    "vitest": "catalog:"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "es2021",
    "moduleResolution": "bundler",
    "strict": true,
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "skipLibCheck": false,
    "customConditions": ["ts-src"]
  },
  "include": ["**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create `tsup.config.ts`**

```typescript
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/plugin.ts'],
  dts: true,
  sourcemap: true,
  treeshake: true,
  clean: false,
  outDir: 'dist',
  format: ['esm'],
  splitting: false,
  target: 'esnext',
  external: ['varlock'],
});
```

- [ ] **Step 4: Install dependencies**

Run: `cd /home/y2kbug/Personal\ Projects/varlock && bun install`
Expected: Dependencies resolved, new workspace package `@varlock/psono-plugin` linked.

- [ ] **Step 5: Verify build scaffolding**

Create a minimal `packages/plugins/psono/src/plugin.ts`:

```typescript
plugin.name = 'psono';
```

Run: `bun run --filter @varlock/psono-plugin build`
Expected: Build succeeds, `dist/plugin.js` created.

- [ ] **Step 6: Commit**

```bash
git add packages/plugins/psono/
git commit -m "feat: scaffold @varlock/psono-plugin package"
```

---

### Task 2: Write the PsonoPluginInstance class

**Files:**
- Modify: `packages/plugins/psono/src/plugin.ts`

- [ ] **Step 1: Write the plugin initialization and instance class**

```typescript
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
 * Each instance maps to one Psono API key (i.e. one config file).
 */
class PsonoPluginInstance {
  /** Path to the psonoci TOML config file */
  private configPath?: string;

  /** Cache of fetched secret fields for the current resolution session */
  private cache = new Map<string, string>();
  /** Track whether `psonoci` CLI is available (lazy check) */
  private psonociChecked = false;

  constructor(readonly id: string) {}

  configure(configPath?: string) {
    this.configPath = configPath;
    debug(
      'psono instance',
      this.id,
      'configured - configPath:',
      this.configPath || '(env/default)',
    );
  }

  /**
   * Build the base args for psonoci commands.
   * If configPath is set, prepends `-c <path>`.
   */
  private get baseArgs(): Array<string> {
    if (!this.configPath) return [];
    return ['-c', this.configPath];
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
```

- [ ] **Step 2: Verify build still succeeds**

Run: `bun run --filter @varlock/psono-plugin build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add packages/plugins/psono/src/plugin.ts
git commit -m "feat(psono): add PsonoPluginInstance class with CLI wrapper"
```

---

## Chunk 2: Root Decorator and Resolvers

### Task 3: Add the `@initPsono` root decorator

**Files:**
- Modify: `packages/plugins/psono/src/plugin.ts` (append after the class)

- [ ] **Step 1: Add instance registry and root decorator**

Append to `plugin.ts`:

```typescript
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

    pluginInstances[id] = new PsonoPluginInstance(id);

    return { id, configPath };
  },
  async execute({ id, configPath }) {
    pluginInstances[id].configure(configPath);
  },
});
```

- [ ] **Step 2: Verify build**

Run: `bun run --filter @varlock/psono-plugin build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add packages/plugins/psono/src/plugin.ts
git commit -m "feat(psono): add @initPsono root decorator with multi-instance support"
```

---

### Task 4: Add the `psono()` resolver function

**Files:**
- Modify: `packages/plugins/psono/src/plugin.ts` (append after root decorator)

- [ ] **Step 1: Add the psono() resolver**

Append to `plugin.ts`:

```typescript
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
```

- [ ] **Step 2: Verify build**

Run: `bun run --filter @varlock/psono-plugin build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add packages/plugins/psono/src/plugin.ts
git commit -m "feat(psono): add psono() resolver for fetching secret fields by UUID"
```

---

### Task 5: Add the `psonoTotp()` resolver function

**Files:**
- Modify: `packages/plugins/psono/src/plugin.ts` (append after psono() resolver)

- [ ] **Step 1: Add the psonoTotp() resolver**

Append to `plugin.ts`:

```typescript
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
```

- [ ] **Step 2: Verify build**

Run: `bun run --filter @varlock/psono-plugin build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add packages/plugins/psono/src/plugin.ts
git commit -m "feat(psono): add psonoTotp() resolver for TOTP token generation"
```

---

### Task 6: Add the `psonoApiKeyId` data type

**Files:**
- Modify: `packages/plugins/psono/src/plugin.ts` (append after resolvers)

- [ ] **Step 1: Register the data type**

Append to `plugin.ts`:

```typescript
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
```

- [ ] **Step 2: Verify build**

Run: `bun run --filter @varlock/psono-plugin build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add packages/plugins/psono/src/plugin.ts
git commit -m "feat(psono): add psonoApiKeyId data type with UUID validation"
```

---

## Chunk 3: Smoke Test and Lint

### Task 7: Create a smoke test for the plugin

**Files:**
- Create: `smoke-tests/smoke-test-psono/plugins/psono-plugin/package.json`
- Create: `smoke-tests/smoke-test-psono/plugins/psono-plugin/plugin.js`
- Create: `smoke-tests/smoke-test-psono/.env.schema`
- Create: `smoke-tests/tests/psono-plugin.test.ts`

This smoke test uses a **mock plugin** that mimics Psono's resolver interface without requiring a real `psonoci` binary. It verifies the plugin loading and schema parsing pipeline work correctly.

- [ ] **Step 1: Create the mock Psono plugin package.json**

```json
{
  "name": "test-psono-plugin",
  "version": "0.0.1",
  "type": "module",
  "exports": {
    "./plugin": "./plugin.js"
  }
}
```

- [ ] **Step 2: Create the mock plugin.js**

This mock plugin registers the same resolver names (`psono`, `psonoTotp`) but returns predictable test values without calling `psonoci`:

```javascript
plugin.name = 'psono';
plugin.icon = 'mdi:shield-key';

const pluginInstances = {};

plugin.registerRootDecorator({
  name: 'initPsono',
  description: 'Initialize a mock Psono plugin instance',
  isFunction: true,
  async process(argsVal) {
    const objArgs = argsVal.objArgs;
    const id = String(objArgs?.id?.staticValue || '_default');
    if (pluginInstances[id]) {
      throw new plugin.ERRORS.SchemaError(`Instance "${id}" already initialized`);
    }
    const configPath = objArgs?.configPath
      ? String(objArgs.configPath.staticValue)
      : undefined;
    pluginInstances[id] = { id, configPath };
    return { id, configPath };
  },
  async execute({ id, configPath }) {
    // no-op for mock
  },
});

plugin.registerResolverFunction({
  name: 'psono',
  label: 'Mock Psono secret resolver',
  icon: 'mdi:shield-key',
  argsSchema: { type: 'mixed', arrayMinLength: 1, arrayMaxLength: 3 },
  process() {
    let instanceId = '_default';
    let secretIdResolver;
    let fieldResolver;
    const argCount = this.arrArgs?.length ?? 0;

    if (argCount === 1) {
      secretIdResolver = this.arrArgs[0];
    } else if (argCount === 2) {
      secretIdResolver = this.arrArgs[0];
      fieldResolver = this.arrArgs[1];
    } else if (argCount === 3) {
      instanceId = String(this.arrArgs[0].staticValue);
      secretIdResolver = this.arrArgs[1];
      fieldResolver = this.arrArgs[2];
    }

    if (!pluginInstances[instanceId]) {
      throw new plugin.ERRORS.SchemaError(`Psono instance "${instanceId}" not found`);
    }

    return { instanceId, secretIdResolver, fieldResolver };
  },
  async resolve({ instanceId, secretIdResolver, fieldResolver }) {
    const secretId = await secretIdResolver.resolve();
    let field = 'password';
    if (fieldResolver) {
      field = await fieldResolver.resolve();
    }
    return `mock-${instanceId}-${secretId}-${field}`;
  },
});

plugin.registerResolverFunction({
  name: 'psonoTotp',
  label: 'Mock Psono TOTP resolver',
  icon: 'mdi:shield-key',
  argsSchema: { type: 'array', arrayMinLength: 1, arrayMaxLength: 2 },
  process() {
    let instanceId = '_default';
    let secretIdResolver;
    const argCount = this.arrArgs?.length ?? 0;

    if (argCount === 1) {
      secretIdResolver = this.arrArgs[0];
    } else if (argCount === 2) {
      instanceId = String(this.arrArgs[0].staticValue);
      secretIdResolver = this.arrArgs[1];
    }

    if (!pluginInstances[instanceId]) {
      throw new plugin.ERRORS.SchemaError(`Psono instance "${instanceId}" not found`);
    }

    return { instanceId, secretIdResolver };
  },
  async resolve({ instanceId, secretIdResolver }) {
    const secretId = await secretIdResolver.resolve();
    return `mock-totp-${secretId}`;
  },
});
```

- [ ] **Step 3: Create the test `.env.schema`**

```bash
# @plugin(./plugins/psono-plugin/)
# @initPsono(configPath=/mock/config.toml)
# @defaultSensitive=false
# ---
SECRET_PASS=psono("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
SECRET_USER=psono("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "username")
TOTP_CODE=psonoTotp("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
```

- [ ] **Step 4: Write the test file**

```typescript
import {
  describe, test, expect, beforeAll, afterAll,
} from 'vitest';
import {
  mkdirSync, writeFileSync, rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { runVarlock } from '../helpers/run-varlock.js';

const SMOKE_TESTS_DIR = join(import.meta.dirname, '..');
const FIXTURE_DIR = 'smoke-test-psono';
const tmpDirs: Array<string> = [];

function createPsonoTestProject(name: string, schema: string): string {
  const projectDir = join(SMOKE_TESTS_DIR, FIXTURE_DIR, `tmp-${name}`);
  mkdirSync(join(projectDir, 'plugins', 'psono-plugin'), { recursive: true });

  // Copy mock plugin files into the temp project
  const mockPkgJson = JSON.stringify({
    name: 'test-psono-plugin',
    version: '0.0.1',
    type: 'module',
    exports: { './plugin': './plugin.js' },
  });
  writeFileSync(join(projectDir, 'plugins', 'psono-plugin', 'package.json'), mockPkgJson);

  // Read mock plugin source from fixture dir and copy it
  const { readFileSync } = require('node:fs');
  const mockPluginSrc = readFileSync(
    join(SMOKE_TESTS_DIR, FIXTURE_DIR, 'plugins', 'psono-plugin', 'plugin.js'),
    'utf-8',
  );
  writeFileSync(join(projectDir, 'plugins', 'psono-plugin', 'plugin.js'), mockPluginSrc);

  writeFileSync(join(projectDir, '.env.schema'), schema, 'utf-8');
  tmpDirs.push(projectDir);
  return join(FIXTURE_DIR, `tmp-${name}`);
}

describe('Psono plugin (mock)', () => {
  const cwd = FIXTURE_DIR;

  afterAll(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('load resolves psono() and psonoTotp() values', () => {
    const result = runVarlock(['load', '--format', 'json'], { cwd });
    expect(result.exitCode, result.output).toBe(0);

    const env = JSON.parse(result.stdout);
    expect(env.SECRET_PASS).toBe('mock-_default-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-password');
    expect(env.SECRET_USER).toBe('mock-_default-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-username');
    expect(env.TOTP_CODE).toBe('mock-totp-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });

  test('fails when @initPsono is missing', () => {
    const cwd = createPsonoTestProject('no-init', [
      '# @plugin(./plugins/psono-plugin/)',
      '# @defaultSensitive=false',
      '# ---',
      'SECRET=psono("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")',
    ].join('\n'));

    const result = runVarlock(['load', '--format', 'json'], { cwd });
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('not found');
  });
});
```

- [ ] **Step 5: Run the smoke test**

Run: `cd /home/y2kbug/Personal\ Projects/varlock/smoke-tests && bun run test -- --run psono`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add smoke-tests/smoke-test-psono/ smoke-tests/tests/psono-plugin.test.ts
git commit -m "test(psono): add smoke tests with mock Psono plugin"
```

---

### Task 8: Lint and final verification

**Files:**
- Possibly modify: `packages/plugins/psono/src/plugin.ts` (lint fixes)

- [ ] **Step 1: Run linter**

Run: `cd /home/y2kbug/Personal\ Projects/varlock && bun run lint:fix`
Expected: Linter runs, auto-fixes applied. No remaining errors.

- [ ] **Step 2: Fix any lint errors that auto-fix cannot resolve**

Manually fix any remaining lint issues reported by the linter.

- [ ] **Step 3: Verify full build**

Run: `bun run build`
Expected: All packages build successfully including the new psono plugin.

- [ ] **Step 4: Commit any lint fixes**

```bash
git add -A
git commit -m "chore(psono): apply lint fixes"
```

---

## Usage Reference

After implementation, the plugin is used in `.env.schema` files like this:

```bash
# @plugin(@varlock/psono-plugin)
# @initPsono(configPath=~/.config/psonoci/personal.toml)
# @initPsono(configPath=~/.config/psonoci/work.toml, id=work)
# ---

# Fetch password (default field) from personal Psono
DB_PASSWORD=psono("4cd7a400-e8b5-43b2-b732-c36fafc07808")

# Fetch specific field
DB_USERNAME=psono("4cd7a400-e8b5-43b2-b732-c36fafc07808", "username")

# Fetch from work account
WORK_API_KEY=psono("work", "9f10de7d-34ad-469a-a062-cafbd3dd847c", "password")

# Get TOTP code
MFA_CODE=psonoTotp("ba2a3cff-c29d-42ef-b965-9919d867279f")

# Get TOTP from work account
WORK_MFA=psonoTotp("work", "ba2a3cff-c29d-42ef-b965-9919d867279f")
```

### `@initPsono()` Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `configPath` | No* | Path to `psonoci` TOML config file. If omitted, `psonoci` falls back to env vars (`PSONO_CI_API_KEY_ID`, etc.) |
| `id` | No | Instance identifier for multi-account setups. Defaults to `_default` |

### `psono()` Arguments

| Form | Description |
|------|-------------|
| `psono("uuid")` | Fetch `password` field from default instance |
| `psono("uuid", "field")` | Fetch specific field from default instance |
| `psono("id", "uuid", "field")` | Fetch specific field from named instance |

### `psonoTotp()` Arguments

| Form | Description |
|------|-------------|
| `psonoTotp("uuid")` | Get TOTP token from default instance |
| `psonoTotp("id", "uuid")` | Get TOTP token from named instance |

### Available Fields

`password`, `username`, `url`, `notes`, `title`, `url_filter`, `json`, `gpg_key_private`, `gpg_key_public`, `ssh_key_private`, `ssh_key_public`, `totp_code`, `totp_period`, `totp_algorithm`, `totp_digits`, `env_vars`, `credit_card_number`, `credit_card_cvc`, `credit_card_name`, `credit_card_valid_through`, `credit_card_pin`, `elster_certificate_file_content`, `elster_certificate_password`, `elster_certificate_retrieval_code`, `secret_type`
