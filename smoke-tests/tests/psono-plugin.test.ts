import {
  describe, test, expect, afterAll,
} from 'vitest';
import {
  mkdirSync, writeFileSync, rmSync, cpSync,
} from 'node:fs';
import { join } from 'node:path';
import { runVarlock } from '../helpers/run-varlock.js';

const SMOKE_TESTS_DIR = join(import.meta.dirname, '..');
const FIXTURE_DIR = 'smoke-test-psono';
const tmpDirs: Array<string> = [];

function createPsonoTestProject(name: string, schema: string): string {
  const projectDir = join(SMOKE_TESTS_DIR, FIXTURE_DIR, `tmp-${name}`);
  mkdirSync(projectDir, { recursive: true });

  // Copy mock plugin files into the temp project
  const srcPlugins = join(SMOKE_TESTS_DIR, FIXTURE_DIR, 'plugins');
  const destPlugins = join(projectDir, 'plugins');
  cpSync(srcPlugins, destPlugins, { recursive: true });

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
    const testCwd = createPsonoTestProject('no-init', [
      '# @plugin(./plugins/psono-plugin/)',
      '# @defaultSensitive=false',
      '# ---',
      'SECRET=psono("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")',
    ].join('\n'));

    const result = runVarlock(['load', '--format', 'json'], { cwd: testCwd });
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('not defined');
  });
});
