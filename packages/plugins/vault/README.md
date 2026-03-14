# @varlock/vault-plugin

[![npm version](https://img.shields.io/npm/v/@varlock/vault-plugin.svg)](https://www.npmjs.com/package/@varlock/vault-plugin) [![GitHub stars](https://img.shields.io/github/stars/dmno-dev/varlock.svg?style=social&label=Star)](https://github.com/dmno-dev/varlock) [![license](https://img.shields.io/npm/l/@varlock/vault-plugin.svg)](https://github.com/dmno-dev/varlock/blob/main/LICENSE)

This package is a [Varlock](https://varlock.dev) [plugin](https://varlock.dev/guides/plugins/) that enables loading data from [HashiCorp Vault](https://www.vaultproject.io/) into your configuration.

## Features

- **HTTP API based** - no `vault` CLI dependency required
- **Token authentication** for simple setups
- **AppRole authentication** for CI/CD and production environments (with automatic token caching)
- **KV v1 and v2** secrets engine support
- **Key extraction** from secret data or full JSON retrieval
- **Multiple instance support** for connecting to different Vault servers
- **Namespace support** for Vault Enterprise
- **Path prefixing** for multi-environment setups
- Comprehensive error handling with helpful tips

## Installation

If you are in a JavaScript based project and have a package.json file, you can either install the plugin explicitly
```bash
npm install @varlock/vault-plugin
```
And then register the plugin without any version number
```env-spec title=".env.schema"
# @plugin(@varlock/vault-plugin)
```

Otherwise just set the explicit version number when you register it
```env-spec title=".env.schema"
# @plugin(@varlock/vault-plugin@0.0.1)
```

See our [Plugin Guide](https://varlock.dev/guides/plugins/#installation) for more details.

## Setup

After registering the plugin, initialize it with the `@initVault` root decorator.

### Token authentication

The simplest setup using a Vault token:

```env-spec
# @plugin(@varlock/vault-plugin)
# @initVault(addr=https://vault.example.com:8200, token=$VAULT_TOKEN)
# ---

# @type=vaultToken @sensitive
VAULT_TOKEN=

DB_PASSWORD=vault("myapp/database", "password")
```

### AppRole authentication

For CI/CD and production environments:

```env-spec
# @plugin(@varlock/vault-plugin)
# @initVault(addr=https://vault.example.com:8200, roleId=$VAULT_ROLE_ID, secretId=$VAULT_SECRET_ID)
# ---

VAULT_ROLE_ID=
# @sensitive
VAULT_SECRET_ID=

DB_PASSWORD=vault("myapp/database", "password")
```

The plugin automatically handles token acquisition and caching for AppRole auth.

### Multiple instances

Connect to different Vault servers or namespaces:

```env-spec
# @initVault(addr=https://vault-dev.example.com:8200, token=$VAULT_TOKEN_DEV)
# @initVault(addr=https://vault-prod.example.com:8200, token=$VAULT_TOKEN_PROD, id=prod)
```

### Additional options

```env-spec
# Custom KV mount path (default: "secret")
# @initVault(addr=..., token=..., mount=kv)

# KV v1 instead of v2 (default: 2)
# @initVault(addr=..., token=..., kvVersion=1)

# Vault Enterprise namespace
# @initVault(addr=..., token=..., namespace=admin/team-a)

# Path prefix for all secrets
# @initVault(addr=..., token=..., namePrefix=production/)
```

## Reading secrets

### Extract a specific key

```env-spec
# Fetch the "password" key from the secret at path "myapp/database"
DB_PASSWORD=vault("myapp/database", "password")
DB_USERNAME=vault("myapp/database", "username")
```

### Get entire secret as JSON

```env-spec
# Returns all key-value pairs as a JSON string
DB_CONFIG=vault("myapp/database")
```

### Using named instances

```env-spec
# Fetch from the "prod" instance
PROD_DB_PASS=vault("prod", "myapp/database", "password")
```

---

## Reference

### Root decorators

#### `@initVault()`

Initialize a HashiCorp Vault plugin instance.

**Parameters:**

- `addr?: string` - Vault server URL (e.g. `https://vault.example.com:8200`)
- `token?: string` - Vault authentication token
- `roleId?: string` - AppRole role ID (used with `secretId`)
- `secretId?: string` - AppRole secret ID (used with `roleId`)
- `mount?: string` - KV secrets engine mount path (default: `secret`)
- `kvVersion?: number` - KV engine version: `1` or `2` (default: `2`)
- `namespace?: string` - Vault namespace (Enterprise feature)
- `namePrefix?: string` - Prefix to prepend to all secret paths
- `id?: string` - Instance identifier for multiple instances (defaults to `_default`)

### Functions

#### `vault()`

Fetch a secret from HashiCorp Vault.

**Signatures:**

- `vault(path)` - Get all data as JSON from default instance
- `vault(path, key)` - Get a specific key from default instance
- `vault(instanceId, path, key)` - Get a specific key from named instance

### Data Types

- `vaultToken` - HashiCorp Vault authentication token (sensitive)

---

## Vault Setup

### Required Policy

The token or AppRole must have a policy granting read access:

```hcl
# For KV v2
path "secret/data/*" {
  capabilities = ["read"]
}

# For KV v1
path "secret/*" {
  capabilities = ["read"]
}
```

### Create an AppRole

```bash
# Enable AppRole auth method
vault auth enable approle

# Create a policy
vault policy write myapp-read - <<EOF
path "secret/data/myapp/*" {
  capabilities = ["read"]
}
EOF

# Create a role
vault write auth/approle/role/myapp \
  token_policies="myapp-read" \
  token_ttl=1h \
  token_max_ttl=4h

# Get the role ID
vault read auth/approle/role/myapp/role-id

# Generate a secret ID
vault write -f auth/approle/role/myapp/secret-id
```

---

## Troubleshooting

### Cannot connect to Vault server
- Verify the Vault address is correct and reachable
- Check that the server is not sealed (`vault status`)

### Authentication failed
- For token auth: verify `$VAULT_TOKEN` is correct and not expired
- For AppRole: verify both `roleId` and `secretId` are valid

### Secret not found (404)
- Verify the secret path is correct
- For KV v2, the plugin automatically adds `/data/` to the path
- Check the mount path matches your Vault configuration

### Permission denied (403)
- Check that your token/role has the required policy
- For KV v2, the policy path must include `/data/` (e.g. `secret/data/myapp/*`)

### Vault is sealed (503)
- The Vault server needs to be unsealed before it can serve requests
- Contact your Vault administrator

## Resources

- [HashiCorp Vault](https://www.vaultproject.io/)
- [Vault KV Secrets Engine](https://developer.hashicorp.com/vault/docs/secrets/kv)
- [Vault AppRole Auth](https://developer.hashicorp.com/vault/docs/auth/approle)
- [Vault Tokens](https://developer.hashicorp.com/vault/docs/concepts/tokens)
- [Vault Policies](https://developer.hashicorp.com/vault/docs/concepts/policies)
