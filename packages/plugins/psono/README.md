# @varlock/psono-plugin

[![npm version](https://img.shields.io/npm/v/@varlock/psono-plugin.svg)](https://www.npmjs.com/package/@varlock/psono-plugin) [![GitHub stars](https://img.shields.io/github/stars/dmno-dev/varlock.svg?style=social&label=Star)](https://github.com/dmno-dev/varlock) [![license](https://img.shields.io/npm/l/@varlock/psono-plugin.svg)](https://github.com/dmno-dev/varlock/blob/main/LICENSE)

This package is a [Varlock](https://varlock.dev) [plugin](https://varlock.dev/guides/plugins/) that enables loading data from [Psono](https://psono.com/), a self-hosted open-source password manager, into your configuration.

## Features

- **CLI-based** integration via the `psonoci` command-line tool
- **Multiple account support** for connecting to different Psono servers or API keys
- **Secret field extraction** by UUID and field name
- **TOTP token generation** via dedicated `psonoTotp()` resolver
- **Session-level caching** to minimize API calls within a single resolution
- Comprehensive error handling with helpful tips

## Prerequisites

Install the `psonoci` CLI:

- Download from [GitHub Releases](https://github.com/meldron/psonoci/releases)
- Or follow the [Psono CI documentation](https://doc.psono.com/admin/installation/install-psono-ci.html)

## Installation

If you are in a JavaScript based project and have a package.json file, you can either install the plugin explicitly
```bash
npm install @varlock/psono-plugin
```
And then register the plugin without any version number
```env-spec title=".env.schema"
# @plugin(@varlock/psono-plugin)
```

Otherwise just set the explicit version number when you register it
```env-spec title=".env.schema"
# @plugin(@varlock/psono-plugin@0.0.1)
```

See our [Plugin Guide](https://varlock.dev/guides/plugins/#installation) for more details.

## Setup + Auth

After registering the plugin, you must initialize it with the `@initPsono` root decorator.

### Environment variables (for deployed environments)

For deployed environments (CI/CD, production, etc), you can use environment variables instead of a config file. When `configPath` is omitted, `psonoci` falls back to these env vars automatically:

```env-spec
# @plugin(@varlock/psono-plugin)
# @initPsono()
# ---

# @type=psonoApiKeyId
PSONO_CI_API_KEY_ID=

# @sensitive
PSONO_CI_API_SECRET_KEY_HEX=

PSONO_CI_SERVER_URL=https://your-psono-server.com/server

DB_PASSWORD=psono("4cd7a400-e8b5-43b2-b732-c36fafc07808")
```

Set these env vars in your platform's secret/env management (e.g. GitHub Actions secrets, Docker env, etc).

### Config file (for local development)

During local development, you can point to a `psonoci` config file instead:

```env-spec
# @plugin(@varlock/psono-plugin)
# @initPsono(configPath=~/.config/psonoci/config.toml)
# ---

DB_PASSWORD=psono("4cd7a400-e8b5-43b2-b732-c36fafc07808")
```

**How to create a config file:**

1. Create a [Psono API key](https://doc.psono.com/admin/installation/install-psono-ci.html) in your Psono admin panel
2. Grant the API key access to the required secrets
3. Save the config file:

```toml
api_key_id = "your-api-key-uuid"
api_secret_key_hex = "your-64-byte-hex-secret"
server_url = "https://your-psono-server.com/server"
```

### Multiple instances

If you need to connect to multiple Psono servers or API keys, register multiple named instances:

```env-spec
# @initPsono(configPath=~/.config/psonoci/personal.toml)
# @initPsono(configPath=~/.config/psonoci/work.toml, id=work)
```

## Reading secrets

### `psono()` - Fetch a secret field

Secrets are referenced by their UUID. The default field is `password`.

```env-spec
# Fetch password (default field)
DB_PASSWORD=psono("4cd7a400-e8b5-43b2-b732-c36fafc07808")

# Fetch a specific field
DB_USERNAME=psono("4cd7a400-e8b5-43b2-b732-c36fafc07808", "username")

# Fetch from a named instance
WORK_SECRET=psono("work", "9f10de7d-34ad-469a-a062-cafbd3dd847c", "password")
```

### `psonoTotp()` - Get a TOTP token

Generate a time-based one-time password from a TOTP secret:

```env-spec
MFA_CODE=psonoTotp("ba2a3cff-c29d-42ef-b965-9919d867279f")

# From a named instance
WORK_MFA=psonoTotp("work", "ba2a3cff-c29d-42ef-b965-9919d867279f")
```

---

## Reference

### Root decorators

#### `@initPsono()`

Initialize a Psono plugin instance.

**Parameters:**

- `configPath?: string` - Path to `psonoci` TOML config file. If omitted, `psonoci` falls back to environment variables.
- `id?: string` - Instance identifier for multiple accounts (defaults to `_default`)

### Functions

#### `psono()`

Fetch a specific field from a Psono secret by UUID.

**Signatures:**

- `psono(uuid)` - Fetch `password` field from default instance
- `psono(uuid, field)` - Fetch specific field from default instance
- `psono(instanceId, uuid, field)` - Fetch specific field from named instance

#### `psonoTotp()`

Get a TOTP token for a Psono secret.

**Signatures:**

- `psonoTotp(uuid)` - Get TOTP from default instance
- `psonoTotp(instanceId, uuid)` - Get TOTP from named instance

### Data Types

- `psonoApiKeyId` - Psono API key ID (UUID format, non-sensitive identifier)

### Available Fields

`password`, `username`, `url`, `notes`, `title`, `url_filter`, `json`, `gpg_key_private`, `gpg_key_public`, `ssh_key_private`, `ssh_key_public`, `totp_code`, `totp_period`, `totp_algorithm`, `totp_digits`, `env_vars`, `credit_card_number`, `credit_card_cvc`, `credit_card_name`, `credit_card_valid_through`, `credit_card_pin`, `secret_type`

---

## Troubleshooting

### `psonoci` command not found
- Install from [GitHub Releases](https://github.com/meldron/psonoci/releases)
- Ensure the binary is in your `$PATH`

### Secret not found
- Verify the secret UUID is correct
- List available secrets: `psonoci -c <config> api-key secrets | jq keys`

### Authentication failed
- Check that your API key has access to the secret
- Verify the API key permissions in Psono admin panel

### Configuration error
- Ensure your config file contains `api_key_id`, `api_secret_key_hex`, and `server_url`
- Verify the config file path is correct

## Resources

- [Psono](https://psono.com/)
- [Psono CI Client](https://github.com/meldron/psonoci)
- [Psono CI Documentation](https://doc.psono.com/admin/installation/install-psono-ci.html)
