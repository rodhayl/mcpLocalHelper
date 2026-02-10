/**
 * Centralized Test Configuration
 *
 * Single source of truth for test backend/model endpoints.
 * Reads from the centralized settings files (env*.settings), not YAML.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parseEnvSettings } from '../src/config/index.js';

let cachedConfig: TestConfig | null = null;

export interface TestConfig {
  localBackendId: string;
  sotaBackendId: string;
  localModel: string;
  sotaModel: string;

  lmStudioBaseUrl: string;
  lmStudioApiBaseUrl: string;
  ollamaBaseUrl: string;

  repoRoot: string;
  settingsPath: string;
}

type SettingsConfigJson = {
  backends?: Array<{
    id: string;
    type: string;
    base_url?: string;
    model?: string;
  }>;
  defaults?: {
    localBackendId?: string;
    sotaBackendId?: string;
    localModel?: string;
    sotaModel?: string;
  };
};

function resolveSettingsPath(repoRoot: string): string {
  const envPath = process.env.MCP_LOCAL_LLM_SETTINGS_PATH || process.env.MCP_LOCAL_LLM_CONFIG;
  if (envPath) return path.resolve(envPath);

  const automated = path.resolve(repoRoot, 'config', 'env-automated-tests.settings');
  if (existsSync(automated)) return automated;

  const automatedCompat = path.resolve(repoRoot, 'env-automated-tests.settings');
  if (existsSync(automatedCompat)) return automatedCompat;

  const canonical = path.resolve(repoRoot, 'config', 'env.settings');
  if (existsSync(canonical)) return canonical;

  const canonicalExample = path.resolve(repoRoot, 'config', 'env.settings.example');
  if (existsSync(canonicalExample)) return canonicalExample;

  const exampleCompat = path.resolve(repoRoot, 'env.settings.example');
  if (existsSync(exampleCompat)) return exampleCompat;

  const legacy = path.resolve(repoRoot, 'env.settings');
  if (existsSync(legacy)) return legacy;

  return automated;
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function toApiBase(url: string): string {
  const normalized = normalizeBaseUrl(url);
  return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`;
}

function loadTestConfig(): TestConfig {
  if (cachedConfig) return cachedConfig;

  const repoRoot = path.resolve(__dirname, '..');
  const settingsPath = resolveSettingsPath(repoRoot);

  // Fallback defaults (should rarely be used; tests expect settings files to exist)
  const config: TestConfig = {
    localBackendId: 'lmstudio',
    sotaBackendId: 'lmstudio',
    localModel: 'default',
    sotaModel: 'default',
    lmStudioBaseUrl: 'http://127.0.0.1:1234',
    lmStudioApiBaseUrl: 'http://127.0.0.1:1234/v1',
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    repoRoot,
    settingsPath,
  };

  if (!existsSync(settingsPath)) {
    cachedConfig = config;
    return config;
  }

  try {
    const content = readFileSync(settingsPath, 'utf-8');
    const sections = parseEnvSettings(content);
    const configSection = sections.config || sections.CONFIG || {};
    const raw = configSection.CONFIG_JSON || configSection.CONFIG_JSON_B64;
    if (!raw) {
      cachedConfig = config;
      return config;
    }

    let jsonText = raw.trim();
    if (configSection.CONFIG_JSON_B64 && !configSection.CONFIG_JSON) {
      jsonText = Buffer.from(jsonText, 'base64').toString('utf-8');
    }

    const parsed = JSON.parse(jsonText) as SettingsConfigJson;

    const defaults = parsed.defaults || {};
    if (defaults.localBackendId) config.localBackendId = defaults.localBackendId;
    if (defaults.sotaBackendId) config.sotaBackendId = defaults.sotaBackendId;
    if (defaults.localModel) config.localModel = defaults.localModel;
    if (defaults.sotaModel) config.sotaModel = defaults.sotaModel;

    const backends = parsed.backends || [];
    const lm = backends.find((b) => b.type === 'lmstudio' && b.base_url);
    if (lm?.base_url) {
      config.lmStudioBaseUrl = normalizeBaseUrl(lm.base_url);
      config.lmStudioApiBaseUrl = toApiBase(config.lmStudioBaseUrl);
      if (lm.model && config.localModel === 'default') config.localModel = lm.model;
      if (lm.model && config.sotaModel === 'default') config.sotaModel = lm.model;
    }

    const ol = backends.find((b) => b.type === 'ollama' && b.base_url);
    if (ol?.base_url) config.ollamaBaseUrl = normalizeBaseUrl(ol.base_url);
  } catch (error) {
    console.warn(`[test-config] Failed to parse settings file ${settingsPath}: ${error}`);
  }

  // Allow environment variable overrides (highest priority)
  if (process.env.MCP_LOCAL_LLM_BACKEND_ID) {
    config.localBackendId = process.env.MCP_LOCAL_LLM_BACKEND_ID;
    config.sotaBackendId = process.env.MCP_LOCAL_LLM_BACKEND_ID;
  }
  if (process.env.MCP_LOCAL_LLM_MODEL) {
    config.localModel = process.env.MCP_LOCAL_LLM_MODEL;
    config.sotaModel = process.env.MCP_LOCAL_LLM_MODEL;
  }
  if (process.env.MCP_LOCAL_LLM_LMSTUDIO_BASE_URL) {
    const url = normalizeBaseUrl(process.env.MCP_LOCAL_LLM_LMSTUDIO_BASE_URL);
    config.lmStudioBaseUrl = url;
    config.lmStudioApiBaseUrl = toApiBase(url);
  }
  if (process.env.MCP_LOCAL_LLM_OLLAMA_BASE_URL) {
    config.ollamaBaseUrl = normalizeBaseUrl(process.env.MCP_LOCAL_LLM_OLLAMA_BASE_URL);
  }

  cachedConfig = config;
  return config;
}

export function getTestConfig(): TestConfig {
  return loadTestConfig();
}

export function clearConfigCache(): void {
  cachedConfig = null;
}

export const testConfig = loadTestConfig();

export const LMSTUDIO_BASE_URL = testConfig.lmStudioBaseUrl;
export const LMSTUDIO_API_BASE_URL = testConfig.lmStudioApiBaseUrl;
export const LMSTUDIO_MODEL = testConfig.localModel;
export const LOCAL_BACKEND_ID = testConfig.localBackendId;
export const SOTA_BACKEND_ID = testConfig.sotaBackendId;
export const REPO_ROOT = testConfig.repoRoot;
