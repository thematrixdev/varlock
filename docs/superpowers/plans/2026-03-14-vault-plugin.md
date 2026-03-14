# HashiCorp Vault Plugin Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a Varlock plugin that fetches secrets from HashiCorp Vault via its HTTP API, supporting token and AppRole authentication.

**Architecture:** HTTP API approach (like the Azure Key Vault plugin, using `ky`). No `vault` CLI dependency required. Supports KV v2 (default) and v1 secrets engines, multiple Vault instances, token caching for AppRole auth, and path-based secret addressing with optional key extraction.

**Tech Stack:** TypeScript, tsup (bundler), Vitest (tests), `ky` (HTTP client), HashiCorp Vault HTTP API

---

## File Structure

```
packages/plugins/vault/
  package.json
  tsconfig.json
  tsup.config.ts
  src/
    plugin.ts           # Main plugin: instance class, HTTP client, decorators, resolvers
```

---

## Task 1: Create package scaffolding

**Files:**
- Create: `packages/plugins/vault/package.json`
- Create: `packages/plugins/vault/tsconfig.json`
- Create: `packages/plugins/vault/tsup.config.ts`
- Create: `packages/plugins/vault/src/plugin.ts` (minimal stub)

## Task 2: Write the full plugin

**Files:**
- Modify: `packages/plugins/vault/src/plugin.ts`

## Task 3: Create smoke tests

**Files:**
- Create: `smoke-tests/smoke-test-vault/plugins/vault-plugin/package.json`
- Create: `smoke-tests/smoke-test-vault/plugins/vault-plugin/plugin.js`
- Create: `smoke-tests/smoke-test-vault/.env.schema`
- Create: `smoke-tests/tests/vault-plugin.test.ts`

## Task 4: Lint and final verification
