import {
  describe, test, expect, afterAll,
} from 'vitest';
import {
  mkdirSync, writeFileSync, rmSync, cpSync,
} from 'node:fs';
import { join } from 'node:path';
import { runVarlock } from '../helpers/run-varlock.js';

const SMOKE_TESTS_DIR = join(import.meta.dirname, '..');
const FIXTURE_DIR = 'smoke-test-vault';
const tmpDirs: Array<string> = [];

function createVaultTestProject(name: string, schema: string): string {
  const projectDir = join(SMOKE_TESTS_DIR, FIXTURE_DIR, `tmp-${name}`);
  mkdirSync(projectDir, { recursive: true });

  const srcPlugins = join(SMOKE_TESTS_DIR, FIXTURE_DIR, 'plugins');
  const destPlugins = join(projectDir, 'plugins');
  cpSync(srcPlugins, destPlugins, { recursive: true });

  writeFileSync(join(projectDir, '.env.schema'), schema, 'utf-8');
  tmpDirs.push(projectDir);
  return join(FIXTURE_DIR, `tmp-${name}`);
}

describe('Vault plugin (mock)', () => {
  const cwd = FIXTURE_DIR;

  afterAll(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('load resolves vault() values with and without key', () => {
    const result = runVarlock(['load', '--format', 'json'], { cwd });
    expect(result.exitCode, result.output).toBe(0);

    const env = JSON.parse(result.stdout);
    expect(env.DB_ALL).toBe(JSON.stringify({ mock: 'vault-myapp/database' }));
    expect(env.DB_PASS).toBe('mock-vault-myapp/database-password');
  });

  test('fails when @initVault is missing', () => {
    const testCwd = createVaultTestProject('no-init', [
      '# @plugin(./plugins/vault-plugin/)',
      '# @defaultSensitive=false',
      '# ---',
      'SECRET=vault("myapp/secret", "key")',
    ].join('\n'));

    const result = runVarlock(['load', '--format', 'json'], { cwd: testCwd });
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('not defined');
  });
});
