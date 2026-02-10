import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnvSettings } from '../../src/config/index.js';

export function resolveCentralSettingsPath(): string {
  const envPath = process.env.MCP_LOCAL_LLM_SETTINGS_PATH || process.env.MCP_LOCAL_LLM_CONFIG;
  if (envPath) return path.resolve(envPath);

  const repoRoot = path.resolve(__dirname, '..', '..');
  const automated = path.join(repoRoot, 'config', 'env-automated-tests.settings');
  if (existsSync(automated)) return automated;

  const automatedCompat = path.join(repoRoot, 'env-automated-tests.settings');
  if (existsSync(automatedCompat)) return automatedCompat;

  const canonicalExample = path.join(repoRoot, 'config', 'env.settings.example');
  if (existsSync(canonicalExample)) return canonicalExample;

  const legacyExample = path.join(repoRoot, 'env.settings.example');
  if (existsSync(legacyExample)) return legacyExample;

  return path.join(repoRoot, 'env.settings');
}

export function loadConfigJsonFromSettingsFile(settingsPath: string): any {
  const content = readFileSync(settingsPath, 'utf-8');
  const sections = parseEnvSettings(content);
  const configSection = sections.config || sections.CONFIG || {};
  const raw = configSection.CONFIG_JSON || configSection.CONFIG_JSON_B64;
  if (!raw) throw new Error(`Missing [config] CONFIG_JSON in settings file: ${settingsPath}`);

  const jsonText =
    configSection.CONFIG_JSON_B64 && !configSection.CONFIG_JSON
      ? Buffer.from(String(raw).trim(), 'base64').toString('utf-8')
      : String(raw).trim();

  return JSON.parse(jsonText);
}

export function loadCentralConfigJson(): any {
  const settingsPath = resolveCentralSettingsPath();
  if (!existsSync(settingsPath)) {
    throw new Error(`Central settings file not found: ${settingsPath}`);
  }
  return loadConfigJsonFromSettingsFile(settingsPath);
}

export function writeSettingsFile(
  filePath: string,
  configJson: unknown,
  opts?: {
    serverPort?: number;
    serverHost?: string;
    testingEnabled?: boolean;
    toolGroupMode?: string;
    exposeSystemProfile?: boolean;
  }
): string {
  const serverPort = opts?.serverPort ?? 0;
  const serverHost = opts?.serverHost ?? '127.0.0.1';
  const testingEnabled = opts?.testingEnabled ?? true;
  const toolGroupMode = opts?.toolGroupMode ?? 'DEVELOPMENT';
  const exposeSystemProfile = opts?.exposeSystemProfile ?? false;

  const text =
    `[config]\nCONFIG_JSON=${JSON.stringify(configJson)}\n\n` +
    `[advanced]\nSERVER_PORT=${serverPort}\nSERVER_HOST=${serverHost}\nEXPOSE_SYSTEM_PROFILE=${
      exposeSystemProfile ? 'true' : 'false'
    }\nTOOL_GROUP_MODE=${toolGroupMode}\nAGENT_MAX_STEPS=50\nAGENT_MAX_ACTIONS_PER_STEP=100\nAGENT_MAX_SUBTASKS=8\nAGENT_TIMEOUT_MS=300000\n\n` +
    `[testing]\nTESTING_MODE_ENABLED=${testingEnabled ? 'true' : 'false'}\nTEST_LOCAL_BACKEND_ID=ollama\nTEST_LOCAL_MODEL=\nTEST_LOCAL_BACKEND_URL=http://127.0.0.1:11434\nTEST_SOTA_BACKEND_TYPE=local\nTEST_SOTA_BACKEND_ID=\nTEST_SOTA_MODEL=\nTEST_SOTA_BACKEND_URL=\nOPENROUTER_API_KEY=\n\n` +
    `[CLI_ORCHESTRATION]\nCLI_ORCHESTRATION_ENABLED=false\nCLI_ORCHESTRATION_BACKENDS=copilot-cli\nCLI_AUTO_VERIFY=true\nCLI_SCORE_THRESHOLD=7\nCLI_MAX_ITERATIONS=3\n`;

  writeFileSync(filePath, text, 'utf-8');
  return filePath;
}
