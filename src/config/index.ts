import { readFileSync, writeFileSync, existsSync, accessSync } from 'fs';
import { join, resolve, normalize, isAbsolute, sep as pathSep, dirname } from 'path';
import { homedir } from 'os';
import {
  Config,
  ConfigSchema,
  ToolGroup,
  ToolGroupMode,
  ToolGroupStatus,
  DEFAULT_TOOL_GROUPS,
  DEFAULT_TOOL_MODES,
  EnvironmentSettings,
  ToolOrchestrationGlobalSettingsSchema,
  McpServersConfigSchema,
  McpServerConfigSchema,
  BackendConfigSchema,
  TimeoutsConfigSchema,
} from '../types/index.js';
import type { BackendConfig, TimeoutsConfig } from '../types/index.js';
import type { McpServersConfig } from '../types/index.js';

const SETTINGS_ENV_VAR = 'MCP_LOCAL_LLM_SETTINGS_PATH';
// Back-compat: historically pointed at YAML config; now treated as a settings-file path.
const LEGACY_CONFIG_ENV_VAR = 'MCP_LOCAL_LLM_CONFIG';

/**
 * Normalize a path to use consistent separators and resolve any . or .. components.
 * This handles Windows paths that might come with forward or back slashes.
 */
export function normalizePath(inputPath: string): string {
  // First normalize to use consistent separators
  let normalized = normalize(inputPath);

  // On Windows, some clients accidentally prefix absolute drive paths with a leading slash,
  // e.g. "/c:/Users/..." or "\\c:\\Users\\...". That becomes a rooted path where "c:" is
  // treated as a folder name and can later resolve to "C:\\c:\\Users\\...". Strip that prefix.
  if (process.platform === 'win32' && /^[\\/][a-zA-Z]:[\\/]/.test(normalized)) {
    normalized = normalized.slice(1);
  }

  // On Windows, some paths can still get resolved into a double-drive form like:
  // "C:\\c:\\Users\\..." (current-drive root + a drive path treated as a folder).
  // Collapse that back to the intended drive path.
  if (process.platform === 'win32' && /^[a-zA-Z]:[\\/][a-zA-Z]:[\\/]/.test(normalized)) {
    normalized = normalized.replace(/^[a-zA-Z]:[\\/](?=[a-zA-Z]:[\\/])/, '');
  }

  // On Windows, ensure drive letter is uppercase for consistency
  if (process.platform === 'win32' && /^[a-z]:/.test(normalized)) {
    normalized = normalized[0].toUpperCase() + normalized.slice(1);
  }

  return normalized;
}

function normalizeMcpServersConfig(config: McpServersConfig): McpServersConfig {
  const normalized: McpServersConfig = {};

  for (const [name, server] of Object.entries(config)) {
    const rawArgs = server.args ?? [];
    const flattened: string[] = [];

    for (const arg of rawArgs) {
      // Repair accidentally-combined args like "-y chrome-devtools-mcp@latest"
      if (/\s/.test(arg)) {
        flattened.push(...arg.split(/\s+/).filter(Boolean));
      } else {
        flattened.push(arg);
      }
    }

    // Repair a common corruption we observed: "@late", "t" -> "@latest"
    const repaired: string[] = [];
    for (let i = 0; i < flattened.length; i++) {
      if (flattened[i] === '@late' && flattened[i + 1] === 't') {
        repaired.push('@latest');
        i++;
        continue;
      }
      repaired.push(flattened[i]);
    }

    // If the chrome-devtools server args look corrupted, snap them back to a known-good template.
    if (name === 'chrome-devtools') {
      const hasKnownPkg = repaired.some((a) => a.includes('chrome-devtools-mcp'));
      const suspicious =
        repaired.some(
          (a) => a === '@late' || a === 't' || a.includes('olated') || a.includes('@late')
        ) ||
        repaired.some((a) => a.includes('chrome-devtool') && !a.includes('chrome-devtools-mcp'));

      if (!hasKnownPkg && suspicious) {
        normalized[name] = {
          ...server,
          args: ['-y', 'chrome-devtools-mcp@latest', '--isolated'],
        };
        continue;
      }
    }

    normalized[name] = {
      ...server,
      args: repaired.length > 0 ? repaired : undefined,
    };
  }

  return normalized;
}

// Helper to parse INI-style env.settings file
export function parseEnvSettings(content: string): Record<string, Record<string, string>> {
  const sections: Record<string, Record<string, string>> = {};
  let currentSection = 'default';

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const sectionMatch = trimmed.match(/^\[(\w+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      if (!sections[currentSection]) sections[currentSection] = {};
      continue;
    }

    const kvMatch = trimmed.match(/^([A-Z_]+)=(.*)$/);
    if (kvMatch) {
      if (!sections[currentSection]) sections[currentSection] = {};
      sections[currentSection][kvMatch[1]] = kvMatch[2];
    }
  }

  return sections;
}

function stripWrappingQuotes(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

// Helper to serialize env.settings file
function serializeEnvSettings(settings: EnvironmentSettings, config: Config): string {
  const configJson = JSON.stringify(config);
  const lines: string[] = [
    '# MCP Local LLM Server - Environment Settings',
    '# This file is managed by the settings page and can be edited manually.',
    '',
    '# ============================================',
    '# CENTRAL CONFIG (JSON)',
    '# ============================================',
    '# All server configuration is centralized here.',
    '',
    '[config]',
    `CONFIG_JSON=${configJson}`,
    '',
    '# ============================================',
    '# PRODUCTION SETTINGS',
    '# ============================================',
    '# In production mode, only LOCAL LLM is available through MCP tools.',
    '# The calling LLM (e.g., GitHub Copilot) acts as the SOTA backend.',
    '',
    '[production]',
    `LOCAL_BACKEND_ID=${settings.production.localBackendId}`,
    `LOCAL_MODEL=${settings.production.localModel || ''}`,
    `LOCAL_BACKEND_URL=${settings.production.localBackendUrl}`,
    '',
    '# ============================================',
    '# TESTING SETTINGS',
    '# ============================================',
    '# In testing mode, both LOCAL and SOTA backends can be configured.',
    '',
    '[testing]',
    `TESTING_MODE_ENABLED=${settings.testing.enabled}`,
    `TEST_LOCAL_BACKEND_ID=${settings.testing.localBackendId}`,
    `TEST_LOCAL_MODEL=${settings.testing.localModel || ''}`,
    `TEST_LOCAL_BACKEND_URL=${settings.testing.localBackendUrl}`,
    `TEST_SOTA_BACKEND_TYPE=${settings.testing.sotaBackendType}`,
    `TEST_SOTA_BACKEND_ID=${settings.testing.sotaBackendId || ''}`,
    `TEST_SOTA_MODEL=${settings.testing.sotaModel || ''}`,
    `TEST_SOTA_BACKEND_URL=${settings.testing.sotaBackendUrl || ''}`,
    `OPENROUTER_API_KEY=${settings.testing.openRouterApiKey || ''}`,
    '',
    '# ============================================',
    '# ADVANCED SETTINGS',
    '# ============================================',
    '',
    '[advanced]',
    `SERVER_PORT=${settings.advanced.serverPort}`,
    `SERVER_HOST=${settings.advanced.serverHost}`,
    `EXPOSE_SYSTEM_PROFILE=${settings.advanced.exposeSystemProfile}`,
    `TOOL_GROUP_MODE=${settings.advanced.toolGroupMode}`,
    `EMBEDDING_MODEL=${settings.advanced.embeddingModel || ''}`,
    `EMBEDDING_BACKEND_URL=${settings.advanced.embeddingBackendUrl || ''}`,
    `AGENT_MAX_STEPS=${settings.advanced.agentMaxSteps}`,
    `AGENT_MAX_ACTIONS_PER_STEP=${settings.advanced.agentMaxActionsPerStep}`,
    `AGENT_MAX_SUBTASKS=${settings.advanced.agentMaxSubtasks}`,
    `AGENT_TIMEOUT_MS=${settings.advanced.agentTimeoutMs}`,
    '',
    '# ============================================',
    '# CLI ORCHESTRATION SETTINGS',
    '# ============================================',
    '# Enable CLI orchestration for complex multi-step tasks',
    '',
    '[CLI_ORCHESTRATION]',
    `CLI_ORCHESTRATION_ENABLED=${settings.advanced.cliOrchestrationEnabled}`,
    `CLI_ORCHESTRATION_BACKENDS=${settings.advanced.cliOrchestrationBackends.join(',')}`,
    `CLI_AUTO_VERIFY=${settings.advanced.cliAutoVerify}`,
    `CLI_SCORE_THRESHOLD=${settings.advanced.cliScoreThreshold}`,
    `CLI_MAX_ITERATIONS=${settings.advanced.cliMaxIterations}`,
    `CLI_PURE_MODE=${settings.advanced.cliPureMode ?? false}`,
  ];

  return lines.join('\n');
}

export class ConfigManager {
  private config: Config;
  private envSettings: EnvironmentSettings;
  private workspaceRoots: string[] = [];
  private defaultWorkspaceRoot: string = process.cwd();
  private settingsPath: string;
  private configDir: string; // Directory containing the config file

  constructor(settingsPath?: string) {
    this.settingsPath = this.resolveSettingsPath(settingsPath);
    this.configDir = dirname(this.settingsPath);

    const { config, envSettings } = this.loadFromSettingsFile();
    this.config = config;
    this.envSettings = envSettings;

    this.applyEnvSettings();
    this.initWorkspace();
  }

  private resolveSettingsPath(providedPath?: string): string {
    const explicit =
      providedPath ||
      process.env[SETTINGS_ENV_VAR] ||
      process.env[LEGACY_CONFIG_ENV_VAR] ||
      undefined;

    if (explicit) {
      const resolvedPath = resolve(explicit);
      if (!existsSync(resolvedPath)) {
        throw new Error(
          `Settings file not found: ${resolvedPath}\n` +
            `Set ${SETTINGS_ENV_VAR} or provide a path via --config/--settings.`
        );
      }
      return resolvedPath;
    }

    return this.findSettingsFile();
  }

  private findSettingsFile(): string {
    const possibleFiles = [
      'config/env.settings',
      'env.settings',
      'config/env-automated-tests.settings',
      'env-automated-tests.settings',
    ];

    // 1. Check CWD (Current Working Directory)
    for (const file of possibleFiles) {
      try {
        const fullPath = join(process.cwd(), file);
        accessSync(fullPath);
        return fullPath;
      } catch {
        continue;
      }
    }

    // 2. Check Home Directory (~/.mcp-local-llm/env.settings)
    try {
      const home = homedir();
      const homeSettings = join(home, '.mcp-local-llm', 'env.settings');
      if (existsSync(homeSettings)) {
        return homeSettings;
      }
    } catch {
      // Ignore errors accessing home dir
    }

    // 3. Check XDG Config (~/.config/mcp-local-llm/env.settings)
    try {
      const home = homedir();
      const xdgSettings = join(home, '.config', 'mcp-local-llm', 'env.settings');
      if (existsSync(xdgSettings)) {
        return xdgSettings;
      }
    } catch {
      // Ignore
    }

    throw new Error(
      'No settings file found. Create config/env.settings or env.settings (copy env.settings.example), ' +
        `or set ${SETTINGS_ENV_VAR} to point at a settings file.`
    );
  }

  private loadFromSettingsFile(): { config: Config; envSettings: EnvironmentSettings } {
    if (!existsSync(this.settingsPath)) {
      throw new Error(`Settings file not found: ${this.settingsPath}`);
    }

    const content = readFileSync(this.settingsPath, 'utf-8');
    const sections = parseEnvSettings(content);

    const configSection = sections.config || sections.CONFIG;
    const jsonRaw = configSection?.CONFIG_JSON || configSection?.CONFIG_JSON_B64;
    if (!jsonRaw) {
      throw new Error(
        `Missing [config] CONFIG_JSON in settings file: ${this.settingsPath}\n\n` +
          'This project requires centralized configuration in env.settings.\n\n' +
          'To fix this issue:\n' +
          '1. If you have env.settings.example, copy the [config] section from it\n' +
          '2. Or delete the file and reinstall: npm install -g mcp-local-llm\n' +
          '3. Or copy the entire env.settings.example to env.settings\n\n' +
          'The [config] section should contain: CONFIG_JSON={...backends...}'
      );
    }

    let jsonText = stripWrappingQuotes(jsonRaw);
    if (configSection?.CONFIG_JSON_B64 && !configSection?.CONFIG_JSON) {
      try {
        jsonText = Buffer.from(jsonText, 'base64').toString('utf-8');
      } catch (e) {
        throw new Error(`Invalid CONFIG_JSON_B64 in ${this.settingsPath}: ${e}`);
      }
    }

    let parsedConfig: unknown;
    try {
      parsedConfig = JSON.parse(jsonText);
    } catch (e) {
      throw new Error(`Failed to parse CONFIG_JSON in ${this.settingsPath}: ${e}`);
    }

    const config = ConfigSchema.parse(parsedConfig);
    if (config.mcpServers) {
      config.mcpServers = normalizeMcpServersConfig(config.mcpServers);
    }

    const envSettings = this.loadEnvSettings(sections);
    return { config, envSettings };
  }

  /**
   * Load environment settings from env.settings file
   */
  private loadEnvSettings(sections?: Record<string, Record<string, string>>): EnvironmentSettings {
    const defaults: EnvironmentSettings = {
      production: {
        localBackendId: 'ollama',
        localModel: undefined,
        localBackendUrl: 'http://127.0.0.1:11434',
      },
      testing: {
        enabled: false,
        localBackendId: 'ollama',
        localModel: undefined,
        localBackendUrl: 'http://127.0.0.1:11434',
        sotaBackendType: 'local',
        sotaBackendId: undefined,
        sotaModel: undefined,
        sotaBackendUrl: undefined,
        openRouterApiKey: undefined,
      },
      advanced: {
        serverPort: 3000,
        serverHost: '127.0.0.1',
        exposeSystemProfile: false,
        toolGroupMode: 'DEVELOPMENT',
        // QA_feedback_9: Parse embedding model settings
        embeddingModel: undefined,
        embeddingBackendUrl: undefined,
        // QA_feedback_11: Parse agent configuration settings
        agentMaxSteps: 50,
        agentMaxActionsPerStep: 100,
        agentMaxSubtasks: 8,
        agentTimeoutMs: 300000, // 5 minutes default
        // CLI Orchestration defaults
        // QA_feedback_26012026: Enable CLI orchestration by default with opencode-cli
        cliOrchestrationEnabled: true,
        cliOrchestrationBackends: ['opencode-cli'],
        cliAutoVerify: true,
        cliScoreThreshold: 7,
        cliMaxIterations: 3,
        // V24: Pure CLI mode for zero LLM overhead
        cliPureMode: false,
      },
    };

    try {
      const parsed = sections || {};

      // Parse production section
      if (parsed.production) {
        defaults.production.localBackendId =
          parsed.production.LOCAL_BACKEND_ID || defaults.production.localBackendId;
        defaults.production.localModel = parsed.production.LOCAL_MODEL || undefined;
        defaults.production.localBackendUrl =
          parsed.production.LOCAL_BACKEND_URL || defaults.production.localBackendUrl;
      }

      // Parse testing section
      if (parsed.testing) {
        defaults.testing.enabled = parsed.testing.TESTING_MODE_ENABLED === 'true';
        defaults.testing.localBackendId =
          parsed.testing.TEST_LOCAL_BACKEND_ID || defaults.testing.localBackendId;
        defaults.testing.localModel = parsed.testing.TEST_LOCAL_MODEL || undefined;
        defaults.testing.localBackendUrl =
          parsed.testing.TEST_LOCAL_BACKEND_URL || defaults.testing.localBackendUrl;
        defaults.testing.sotaBackendType =
          (parsed.testing.TEST_SOTA_BACKEND_TYPE as 'local' | 'openrouter') || 'local';
        defaults.testing.sotaBackendId = parsed.testing.TEST_SOTA_BACKEND_ID || undefined;
        defaults.testing.sotaModel = parsed.testing.TEST_SOTA_MODEL || undefined;
        defaults.testing.sotaBackendUrl = parsed.testing.TEST_SOTA_BACKEND_URL || undefined;
        defaults.testing.openRouterApiKey = parsed.testing.OPENROUTER_API_KEY || undefined;
      }

      // Parse advanced section
      if (parsed.advanced) {
        // Allow SERVER_PORT=0 for ephemeral ports (used by automated tests).
        if (parsed.advanced.SERVER_PORT !== undefined) {
          const port = parseInt(parsed.advanced.SERVER_PORT, 10);
          if (!Number.isNaN(port)) {
            defaults.advanced.serverPort = port;
          }
        }
        defaults.advanced.serverHost = parsed.advanced.SERVER_HOST || defaults.advanced.serverHost;
        defaults.advanced.exposeSystemProfile = parsed.advanced.EXPOSE_SYSTEM_PROFILE === 'true';
        defaults.advanced.toolGroupMode =
          parsed.advanced.TOOL_GROUP_MODE || defaults.advanced.toolGroupMode;
        // QA_feedback_9: Parse embedding model settings
        defaults.advanced.embeddingModel = parsed.advanced.EMBEDDING_MODEL || undefined;
        defaults.advanced.embeddingBackendUrl = parsed.advanced.EMBEDDING_BACKEND_URL || undefined;
        // QA_feedback_11: Parse agent configuration settings
        if (parsed.advanced.AGENT_MAX_STEPS) {
          defaults.advanced.agentMaxSteps = parseInt(parsed.advanced.AGENT_MAX_STEPS) || 50;
        }
        if (parsed.advanced.AGENT_MAX_ACTIONS_PER_STEP) {
          defaults.advanced.agentMaxActionsPerStep =
            parseInt(parsed.advanced.AGENT_MAX_ACTIONS_PER_STEP) || 30;
        }
        if (parsed.advanced.AGENT_MAX_SUBTASKS) {
          defaults.advanced.agentMaxSubtasks = parseInt(parsed.advanced.AGENT_MAX_SUBTASKS) || 8;
        }
        if (parsed.advanced.AGENT_TIMEOUT_MS) {
          defaults.advanced.agentTimeoutMs = parseInt(parsed.advanced.AGENT_TIMEOUT_MS) || 300000;
        }
      }

      // Parse CLI_ORCHESTRATION section (separate from advanced)
      const cliSection = parsed.CLI_ORCHESTRATION || parsed.advanced;
      if (cliSection) {
        const cliEnabled = cliSection.CLI_ORCHESTRATION_ENABLED;
        if (cliEnabled === 'true') {
          defaults.advanced.cliOrchestrationEnabled = true;
        } else if (cliEnabled === 'false') {
          defaults.advanced.cliOrchestrationEnabled = false;
        }
        const cliBackends = cliSection.CLI_ORCHESTRATION_BACKENDS;
        if (cliBackends) {
          defaults.advanced.cliOrchestrationBackends = cliBackends
            .split(',')
            .map((b: string) => b.trim())
            .filter(Boolean);
        }
        const cliAutoVerify = cliSection.CLI_AUTO_VERIFY;
        if (cliAutoVerify === 'true') {
          defaults.advanced.cliAutoVerify = true;
        } else if (cliAutoVerify === 'false') {
          defaults.advanced.cliAutoVerify = false;
        }
        const cliScoreThreshold = cliSection.CLI_SCORE_THRESHOLD;
        if (cliScoreThreshold) {
          const threshold = parseInt(cliScoreThreshold);
          if (threshold >= 1 && threshold <= 10) {
            defaults.advanced.cliScoreThreshold = threshold;
          }
        }
        const cliMaxIterations = cliSection.CLI_MAX_ITERATIONS;
        if (cliMaxIterations) {
          const iterations = parseInt(cliMaxIterations);
          if (iterations >= 1 && iterations <= 10) {
            defaults.advanced.cliMaxIterations = iterations;
          }
        }
        // V24: Parse CLI_PURE_MODE for zero LLM overhead
        const cliPureMode = cliSection.CLI_PURE_MODE;
        if (cliPureMode === 'true') {
          defaults.advanced.cliPureMode = true;
        }
      }

      return defaults;
    } catch (error) {
      console.error('Failed to load env.settings:', error);
      return defaults;
    }
  }

  /**
   * Apply environment settings to the config
   * Only applies if env.settings file exists and has explicit values
   * Also checks process.env for OPENROUTER_API_KEY and SOTA_MODEL overrides
   */
  private applyEnvSettings(): void {
    // Check for environment variable overrides (highest priority)
    // This allows MCP config env vars to override file-based settings
    const envApiKey = process.env.OPENROUTER_API_KEY;
    const envSotaModel = process.env.SOTA_MODEL;
    const envTestingEnabled = process.env.TESTING_MODE_ENABLED;

    if (envApiKey) {
      // Silently enable OpenRouter SOTA - avoid logging sensitive info
      this.envSettings.testing.enabled = true;
      this.envSettings.testing.sotaBackendType = 'openrouter';
      this.envSettings.testing.openRouterApiKey = envApiKey;
      if (envSotaModel) {
        this.envSettings.testing.sotaModel = envSotaModel;
      }
    }

    if (envTestingEnabled === 'true') {
      this.envSettings.testing.enabled = true;
    }

    // In testing mode, use testing settings
    if (this.envSettings.testing.enabled) {
      // Apply testing local backend if explicitly set
      if (
        this.envSettings.testing.localBackendId &&
        this.envSettings.testing.localBackendId !== 'ollama'
      ) {
        this.config.defaults.localBackendId = this.envSettings.testing.localBackendId;
      }
      if (this.envSettings.testing.localModel) {
        this.config.defaults.localModel = this.envSettings.testing.localModel;
      }

      // Configure SOTA backend based on type
      if (this.envSettings.testing.sotaBackendType === 'openrouter') {
        // Use OpenRouter as SOTA
        if (this.envSettings.testing.openRouterApiKey) {
          // Add or update OpenRouter backend
          const existing = this.config.backends.find((b) => b.id === 'openrouter-sota');
          if (existing) {
            existing.api_key = this.envSettings.testing.openRouterApiKey;
          } else {
            this.config.backends.push({
              id: 'openrouter-sota',
              type: 'openrouter',
              base_url: 'https://openrouter.ai/api',
              api_key: this.envSettings.testing.openRouterApiKey,
            });
          }
          this.config.defaults.sotaBackendId = 'openrouter-sota';
        }
      } else if (this.envSettings.testing.sotaBackendId) {
        // Use local backend as SOTA
        this.config.defaults.sotaBackendId = this.envSettings.testing.sotaBackendId;
      }

      if (this.envSettings.testing.sotaModel) {
        this.config.defaults.sotaModel = this.envSettings.testing.sotaModel;
      }

      // Enable testing mode in features
      if (!this.config.features) {
        this.config.features = { testingModeEnabled: true };
      } else {
        this.config.features.testingModeEnabled = true;
      }
    }
    // In production mode (or when testing disabled), don't override config values
    // The YAML config is the source of truth

    // Only apply advanced settings if explicitly configured differently
    const ensureServerConfig = () => {
      // Keep defaults in sync with ConfigSchema defaults
      this.config.server ??= {
        port: 3000,
        host: '127.0.0.1',
        maxConcurrentAgentTasks: 2,
        maxConcurrentClients: 3,
        agentTaskQueueTimeoutMs: 300000,
      };
      return this.config.server;
    };

    if (this.envSettings.advanced.serverPort !== 3000) {
      const server = ensureServerConfig();
      server.port = this.envSettings.advanced.serverPort;
    }
    if (this.envSettings.advanced.serverHost !== '127.0.0.1') {
      const server = ensureServerConfig();
      server.host = this.envSettings.advanced.serverHost;
    }
    if (this.envSettings.advanced.exposeSystemProfile) {
      this.config.systemProfile.exposeToLLM = true;
    }
    // Always apply tool group mode from env.settings
    if (this.envSettings.advanced.toolGroupMode) {
      if (!this.config.toolGroups) {
        this.config.toolGroups = {};
      }
      this.config.toolGroups.activeMode = this.envSettings.advanced.toolGroupMode;
    }

    // CLI Orchestration environment variable overrides
    const cliOrchestrationEnabled = process.env.CLI_ORCHESTRATION_ENABLED;
    if (cliOrchestrationEnabled === 'true') {
      this.envSettings.advanced.cliOrchestrationEnabled = true;
    } else if (cliOrchestrationEnabled === 'false') {
      this.envSettings.advanced.cliOrchestrationEnabled = false;
    }

    const cliOrchestrationBackends = process.env.CLI_ORCHESTRATION_BACKENDS;
    if (cliOrchestrationBackends) {
      this.envSettings.advanced.cliOrchestrationBackends = cliOrchestrationBackends
        .split(',')
        .map((b) => b.trim())
        .filter(Boolean);
    }

    const cliAutoVerify = process.env.CLI_AUTO_VERIFY;
    if (cliAutoVerify === 'false') {
      this.envSettings.advanced.cliAutoVerify = false;
    }

    const cliScoreThreshold = process.env.CLI_SCORE_THRESHOLD;
    if (cliScoreThreshold) {
      const threshold = parseInt(cliScoreThreshold);
      if (threshold >= 1 && threshold <= 10) {
        this.envSettings.advanced.cliScoreThreshold = threshold;
      }
    }

    const cliMaxIterations = process.env.CLI_MAX_ITERATIONS;
    if (cliMaxIterations) {
      const iterations = parseInt(cliMaxIterations);
      if (iterations >= 1 && iterations <= 10) {
        this.envSettings.advanced.cliMaxIterations = iterations;
      }
    }

    // V23: CLI orchestration affects ONLY agent_task routing, NOT the underlying LLM backend
    // The previous logic (V22.1) that overrode localBackendId for ALL LLM calls caused agent scenarios
    // to timeout because local fast LLM (LM Studio) was replaced with slow CLI calls.
    // Now: CLI orchestration is handled at agent_task routing level in mcp.ts, keeping local LLM for
    // AgentRunner's internal LLM calls (planning, verification, etc.)
    if (this.envSettings.advanced.cliOrchestrationEnabled) {
      const cliBackends = this.envSettings.advanced.cliOrchestrationBackends;
      if (cliBackends && cliBackends.length > 0) {
        console.log(
          `[CONFIG] CLI orchestration enabled: ${cliBackends.join(', ')} available for agent_task routing (local LLM preserved for AgentRunner)`
        );
      }
    }

    // MCP_LOCAL_LLM_BACKEND_ID env var overrides the default local backend (HIGHEST PRIORITY)
    // Applied at the end after all other overrides to ensure it takes precedence.
    // This is used by run_all_tests_ALL.py to route ALL LLM calls through CLI backends
    const envBackendId = process.env.MCP_LOCAL_LLM_BACKEND_ID;
    if (envBackendId) {
      this.config.defaults.localBackendId = envBackendId;
    }
  }

  /**
   * Save environment settings to env.settings file
   */
  public saveEnvSettings(): void {
    try {
      const content = serializeEnvSettings(this.envSettings, this.getConfigForPersistence());
      writeFileSync(this.settingsPath, content, 'utf-8');
    } catch (error) {
      console.error('Failed to save env.settings:', error);
      throw error;
    }
  }

  /**
   * Get the current environment settings
   */
  public getEnvSettings(): EnvironmentSettings {
    return this.envSettings;
  }

  /**
   * Update environment settings
   * Note: This method saves to file but does NOT re-apply env var overrides
   * to avoid resetting API-set values back to env var defaults.
   */
  public updateEnvSettings(updates: {
    production?: Partial<EnvironmentSettings['production']>;
    testing?: Partial<EnvironmentSettings['testing']>;
    advanced?: Partial<EnvironmentSettings['advanced']>;
  }): void {
    if (updates.production) {
      Object.assign(this.envSettings.production, updates.production);
    }
    if (updates.testing) {
      Object.assign(this.envSettings.testing, updates.testing);
    }
    if (updates.advanced) {
      Object.assign(this.envSettings.advanced, updates.advanced);
    }
    this.saveEnvSettings();
    // Skip applyEnvSettings() to avoid env vars overriding API changes
    // The in-memory settings are already correct, we just need to save
  }

  /**
   * Check if testing mode is enabled
   */
  public isTestingMode(): boolean {
    return this.envSettings.testing.enabled;
  }

  /**
   * Enable testing mode
   */
  public enableTestingMode(config?: Partial<EnvironmentSettings['testing']>): void {
    this.envSettings.testing.enabled = true;
    if (config) {
      Object.assign(this.envSettings.testing, config);
    }
    this.saveEnvSettings();
    this.applyEnvSettings();
  }

  /**
   * Disable testing mode (switch to production)
   */
  public disableTestingMode(): void {
    this.envSettings.testing.enabled = false;
    this.saveEnvSettings();
    this.applyEnvSettings();
  }

  private initWorkspace() {
    // Use config directory as base for relative paths (supports MCP started from any directory)
    const baseDir = normalizePath(this.configDir);
    const envRootRaw = process.env.WORKSPACE_ROOT;
    const envRoot = envRootRaw ? normalizePath(envRootRaw) : '';
    const workspaceCfg = this.config.workspace;

    // If WORKSPACE_ROOT env var is set (e.g., from VS Code's ${workspaceFolder}),
    // use it as the primary workspace root, allowing the MCP server to work
    // with any project the user has open
    if (envRoot && isAbsolute(envRoot)) {
      // Use the environment-provided workspace as the primary root
      const normalizedEnvRoot = normalizePath(resolve(envRoot));
      this.workspaceRoots = [normalizedEnvRoot];
      this.defaultWorkspaceRoot = normalizedEnvRoot;

      // Also update the policy to allow this path
      // This ensures file access checks pass for the dynamic workspace
      const alreadyAllowed = this.config.policy.allowlistPaths.some(
        (p) => normalizePath(p) === envRoot
      );
      if (!alreadyAllowed) {
        this.config.policy.allowlistPaths = [envRoot, ...this.config.policy.allowlistPaths];
      }
    } else {
      // Fallback to config-based workspace roots
      const roots = workspaceCfg?.roots || this.config.policy.allowlistPaths || ['.'];
      this.workspaceRoots = roots.map((p) => normalizePath(resolve(baseDir, normalizePath(p))));
      this.defaultWorkspaceRoot = normalizePath(
        resolve(baseDir, normalizePath(workspaceCfg?.defaultRoot || roots[0] || '.'))
      );
    }
  }

  private getConfigForPersistence(): Config {
    // Avoid persisting runtime-derived secrets (e.g., OpenRouter API key injected as a backend).
    const cloned = JSON.parse(JSON.stringify(this.config)) as Config;
    const shouldStripOpenRouterDerived =
      this.envSettings.testing.enabled && this.envSettings.testing.sotaBackendType === 'openrouter';

    if (shouldStripOpenRouterDerived) {
      cloned.backends = cloned.backends.filter((b) => b.id !== 'openrouter-sota');
      if (cloned.defaults.sotaBackendId === 'openrouter-sota') {
        cloned.defaults.sotaBackendId = undefined;
      }
    }

    return cloned;
  }

  public getConfig(): Config {
    return this.config;
  }

  public reapplyEnvSettings(): void {
    this.applyEnvSettings();
  }

  public getBackends(): BackendConfig[] {
    return this.config.backends;
  }

  /**
   * Get timeout configuration with defaults
   */
  public getTimeouts(): TimeoutsConfig {
    const defaults = TimeoutsConfigSchema.parse({});
    return { ...defaults, ...this.config.timeouts };
  }

  public setBackends(backends: unknown): void {
    const parsed = BackendConfigSchema.array().parse(backends);
    this.config.backends = parsed;

    // Keep defaults sane if current selections disappear
    const ids = new Set(parsed.map((b) => b.id));
    if (!ids.has(this.config.defaults.localBackendId)) {
      this.config.defaults.localBackendId = parsed[0]?.id || this.config.defaults.localBackendId;
    }
    if (this.config.defaults.sotaBackendId && !ids.has(this.config.defaults.sotaBackendId)) {
      this.config.defaults.sotaBackendId = undefined;
    }

    // Ensure env.settings derived backends (e.g., openrouter-sota) still apply
    this.reapplyEnvSettings();
    this.saveEnvSettings();
  }

  public getMcpServers(): NonNullable<Config['mcpServers']> {
    return this.config.mcpServers || {};
  }

  public setMcpServers(servers: unknown): void {
    const parsed = McpServersConfigSchema.parse(servers);
    this.config.mcpServers = normalizeMcpServersConfig(parsed);
    this.saveEnvSettings();
  }

  public upsertMcpServer(name: string, serverConfig: unknown): void {
    if (!name || typeof name !== 'string') {
      throw new Error('Server name is required');
    }
    const parsedConfig = McpServerConfigSchema.parse(serverConfig);
    const current = this.getMcpServers();
    this.config.mcpServers = { ...current, [name]: parsedConfig };
    this.saveEnvSettings();
  }

  public removeMcpServer(name: string): void {
    const current = { ...this.getMcpServers() };
    if (!(name in current)) return;
    delete current[name];
    this.config.mcpServers = current;
    this.saveEnvSettings();
  }

  public getWorkspaceRoots(): string[] {
    return this.workspaceRoots;
  }

  public getDefaultWorkspaceRoot(): string {
    return this.defaultWorkspaceRoot;
  }

  /**
   * Dynamically set workspace roots from MCP client (e.g., VS Code).
   * This is called when the client provides workspace roots via the MCP protocol.
   * Takes precedence over config file settings.
   */
  public setDynamicWorkspaceRoots(roots: string[]): void {
    if (roots.length === 0) return;

    // Normalize paths
    const normalizedRoots = roots.map((r) => resolve(r));

    // Set workspace roots
    this.workspaceRoots = normalizedRoots;
    this.defaultWorkspaceRoot = normalizedRoots[0];

    // Update policy to allow these paths
    // Keep existing allowlist and add new roots
    const existingPaths = this.config.policy.allowlistPaths;
    const newAllowlist = [...new Set([...normalizedRoots, ...existingPaths])];
    this.config.policy.allowlistPaths = newAllowlist;
  }

  public getBackend(id: string) {
    const backend = this.config.backends.find((b) => b.id === id);
    if (!backend) {
      throw new Error(`Backend '${id}' not found in configuration`);
    }
    return backend;
  }

  public getDefaultLocalBackend() {
    return this.getBackend(this.config.defaults.localBackendId);
  }

  public getDefaultSotaBackend() {
    if (!this.config.defaults.sotaBackendId) {
      throw new Error(
        'No SOTA backend configured. The calling LLM (e.g., GitHub Copilot) acts as the SOTA backend. For testing, enable testing mode via settings.'
      );
    }
    return this.getBackend(this.config.defaults.sotaBackendId);
  }

  /**
   * Check if SOTA backend is available (testing mode with configured SOTA)
   */
  public isSotaAvailable(): boolean {
    return this.envSettings.testing.enabled && !!this.config.defaults.sotaBackendId;
  }

  /**
   * Get the OpenRouter API key (if configured in testing mode)
   */
  public getOpenRouterApiKey(): string | undefined {
    return this.envSettings.testing.openRouterApiKey;
  }

  /**
   * Configure OpenRouter as SOTA backend for testing
   */
  public configureOpenRouter(apiKey: string, model?: string): void {
    this.envSettings.testing.enabled = true;
    this.envSettings.testing.sotaBackendType = 'openrouter';
    this.envSettings.testing.openRouterApiKey = apiKey;
    this.envSettings.testing.sotaModel = model;
    this.saveEnvSettings();
    this.applyEnvSettings();
  }

  /**
   * Configure a local backend as SOTA for testing
   */
  public configureLocalSota(backendId: string, model?: string): void {
    this.envSettings.testing.enabled = true;
    this.envSettings.testing.sotaBackendType = 'local';
    this.envSettings.testing.sotaBackendId = backendId;
    this.envSettings.testing.sotaModel = model;
    this.saveEnvSettings();
    this.applyEnvSettings();
  }

  public isPathAllowed(path: string): boolean {
    const { allowlistPaths, denylistPaths } = this.config.policy;
    // Resolve relative policy paths from the config file directory.
    // This preserves intended semantics for canonical config/env.settings values like "..".
    const policyBase = normalizePath(this.configDir);
    const toAbs = (rawPath: string) => {
      const normalized = normalizePath(rawPath);
      if (isAbsolute(normalized)) {
        return normalizePath(resolve(normalized));
      }
      return normalizePath(resolve(policyBase, normalized));
    };
    const allowAbs = allowlistPaths.map(toAbs);
    const denyAbs = (denylistPaths || []).map(toAbs);

    // Windows paths are case-insensitive, so normalize for comparison
    const normalizedPath =
      process.platform === 'win32' ? normalizePath(path).toLowerCase() : normalizePath(path);

    const isUnder = (child: string, parent: string): boolean => {
      if (child === parent) return true;
      const parentWithSep = parent.endsWith(pathSep) ? parent : parent + pathSep;
      return child.startsWith(parentWithSep);
    };

    // Check if path is in allowlist (by absolute prefix)
    const isInAllowlist = allowAbs.some((allowed) => {
      const normalizedAllowed =
        process.platform === 'win32'
          ? normalizePath(allowed).toLowerCase()
          : normalizePath(allowed);
      return isUnder(normalizedPath, normalizedAllowed);
    });

    if (!isInAllowlist) {
      return false;
    }

    // Check if path is in denylist
    if (denyAbs.length > 0) {
      const isInDenylist = denyAbs.some((denied) => {
        const normalizedDenied =
          process.platform === 'win32'
            ? normalizePath(denied).toLowerCase()
            : normalizePath(denied);
        return isUnder(normalizedPath, normalizedDenied);
      });

      if (isInDenylist) {
        return false;
      }
    }

    return true;
  }

  public resolveWorkspacePath(input: string): string {
    // Handle Unix-style "absolute" paths that LLMs often generate (e.g., "/auth/", "/src/index.ts")
    // On Windows, these resolve to the drive root (C:\auth) which is almost never intended.
    // LLMs typically mean these as workspace-relative paths, so normalize them.
    // This check must happen BEFORE normalizePath() which converts / to \.
    let adjustedInput = input;
    const looksLikeUnixRelativeMisuse =
      input.startsWith('/') &&
      !input.startsWith('//') &&
      process.platform === 'win32' &&
      // Don't convert actual system paths - these are rarely meant as workspace paths
      !/^\/(bin|boot|dev|etc|home|lib|mnt|opt|proc|root|run|sbin|srv|sys|tmp|usr|var)\//i.test(
        input
      );

    if (looksLikeUnixRelativeMisuse) {
      // Convert /auth/ to ./auth/ (relative to workspace)
      adjustedInput = '.' + input;
    }

    // Normalize the input path
    let norm = normalizePath(adjustedInput);

    // Strip redundant workspace prefix from relative paths.
    // LLMs often generate paths like "GitHub/mcpLocalLLM/file.ts" when workspace root
    // is already "C:\Users\...\GitHub\mcpLocalLLM". This creates invalid doubled paths.
    // We detect and strip any prefix segments that match trailing parts of workspace root.
    if (!isAbsolute(norm)) {
      const rootParts = this.defaultWorkspaceRoot.replace(/\\/g, '/').split('/').filter(Boolean);
      const inputParts = norm.replace(/\\/g, '/').split('/').filter(Boolean);

      // Try to find a matching prefix: e.g., "GitHub/mcpLocalLLM/..." matches end of root
      for (
        let prefixLen = Math.min(rootParts.length, inputParts.length);
        prefixLen > 0;
        prefixLen--
      ) {
        const rootSuffix = rootParts.slice(-prefixLen).join('/').toLowerCase();
        const inputPrefix = inputParts.slice(0, prefixLen).join('/').toLowerCase();

        if (rootSuffix === inputPrefix) {
          // Strip the redundant prefix from input
          const stripped = inputParts.slice(prefixLen).join('/');
          if (stripped) {
            norm = stripped;
            break;
          }
        }
      }
    }

    // Determine if path is absolute
    // On Windows, a path is absolute if it starts with a drive letter and colon followed by separator
    // e.g., "C:\", "c:\", "C:/", "c:/"
    const isAbs = isAbsolute(norm);

    // Resolve to absolute path
    const abs = isAbs
      ? normalizePath(resolve(norm))
      : normalizePath(resolve(this.defaultWorkspaceRoot, norm));

    if (!this.isInsideWorkspace(abs)) {
      // Provide helpful hint for common mistakes
      const hint =
        input.startsWith('/') && !input.startsWith('//')
          ? ` (hint: use relative path like ".${input}" instead of "${input}")`
          : '';
      throw new Error(`Outside workspace: ${input}${hint}`);
    }
    return abs;
  }

  public isInsideWorkspace(absPath: string): boolean {
    const roots = this.workspaceRoots;
    // Normalize the path for comparison
    const normalizedPath = normalizePath(absPath);
    const pathLower = process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath;

    return roots.some((root) => {
      const normalizedRoot = normalizePath(root);
      const rootLower =
        process.platform === 'win32' ? normalizedRoot.toLowerCase() : normalizedRoot;

      // Handle roots with/without a trailing separator (common for drive roots like "C:\").
      const rootNoTrail = rootLower.endsWith(pathSep) ? rootLower.slice(0, -1) : rootLower;
      return (
        pathLower === rootLower ||
        pathLower === rootNoTrail ||
        pathLower.startsWith(rootNoTrail + pathSep)
      );
    });
  }

  // ============================================
  // Tool Groups Management
  // ============================================

  /**
   * Get the group definitions, merging defaults with any custom config
   */
  public getGroupDefinitions(): Record<string, ToolGroup> {
    const customGroups = this.config.toolGroups?.groups || {};
    return { ...DEFAULT_TOOL_GROUPS, ...customGroups };
  }

  /**
   * Get the mode definitions, merging defaults with any custom config
   */
  public getModeDefinitions(): Record<string, ToolGroupMode> {
    const customModes = this.config.toolGroups?.modes || {};
    return { ...DEFAULT_TOOL_MODES, ...customModes };
  }

  /**
   * Get all currently enabled tool names based on active mode or explicit group list
   */
  public getEnabledTools(): Set<string> {
    const toolGroups = this.config.toolGroups;

    // If no toolGroups config, default to full access (backward compatibility)
    if (!toolGroups) {
      return new Set(['*']);
    }

    // Check for environment variable override
    const envMode = process.env.MCP_TOOL_MODE;
    const envDisableGroups = process.env.MCP_DISABLE_GROUPS?.split(',').map((s) => s.trim()) || [];
    const envEnableGroups = process.env.MCP_ENABLE_GROUPS?.split(',').map((s) => s.trim()) || [];

    let activeGroups: string[] = [];

    // Determine active groups from mode or explicit list
    if (envMode) {
      const modes = this.getModeDefinitions();
      const mode = modes[envMode];
      if (mode) {
        activeGroups = [...mode.groups];
      }
    } else if (toolGroups.enabled) {
      activeGroups = [...toolGroups.enabled];
    } else if (toolGroups.activeMode) {
      const modes = this.getModeDefinitions();
      const mode = modes[toolGroups.activeMode];
      if (mode) {
        activeGroups = [...mode.groups];
      }
    }

    // If still no groups, default to DEVELOPMENT (all tools enabled).
    // NOTE: Respect an explicitly empty `toolGroups.enabled: []` (disable all) if provided.
    const enabledWasExplicitArray = Array.isArray((toolGroups as any).enabled);
    if (activeGroups.length === 0 && !enabledWasExplicitArray) {
      const modes = this.getModeDefinitions();
      const defaultMode = modes['DEVELOPMENT'];
      if (defaultMode) {
        activeGroups = [...defaultMode.groups];
      } else {
        activeGroups = Object.keys(this.getGroupDefinitions());
      }
    }

    // Apply environment overrides
    activeGroups = activeGroups.filter((g) => !envDisableGroups.includes(g));
    for (const g of envEnableGroups) {
      if (!activeGroups.includes(g)) {
        activeGroups.push(g);
      }
    }

    // Collect all tool names from active groups
    const enabledTools = new Set<string>();
    const groupDefs = this.getGroupDefinitions();

    for (const groupName of activeGroups) {
      const group = groupDefs[groupName];
      if (group) {
        for (const tool of group.tools) {
          enabledTools.add(tool);
        }
      }
    }

    return enabledTools;
  }

  /**
   * Check if a specific tool is enabled
   */
  public isToolEnabled(toolName: string): boolean {
    const enabled = this.getEnabledTools();
    return enabled.has('*') || enabled.has(toolName);
  }

  /**
   * Get the currently active groups
   */
  public getActiveGroups(): string[] {
    const toolGroups = this.config.toolGroups;

    if (!toolGroups) {
      // No config = all groups active
      return Object.keys(this.getGroupDefinitions());
    }

    const envMode = process.env.MCP_TOOL_MODE;

    if (envMode) {
      const modes = this.getModeDefinitions();
      return modes[envMode]?.groups || [];
    }

    if (toolGroups.enabled) {
      return toolGroups.enabled;
    }

    if (toolGroups.activeMode) {
      const modes = this.getModeDefinitions();
      return modes[toolGroups.activeMode]?.groups || [];
    }

    // Default to DEVELOPMENT mode (all tools enabled)
    return (
      this.getModeDefinitions()['DEVELOPMENT']?.groups || Object.keys(this.getGroupDefinitions())
    );
  }

  /**
   * Alias for getActiveGroups (for backward compatibility)
   */
  public getEnabledGroups(): string[] {
    return this.getActiveGroups();
  }

  /**
   * Get comprehensive tool group status for API responses
   */
  public getToolGroupsStatus(): ToolGroupStatus {
    const toolGroups = this.config.toolGroups;
    const modes = this.getModeDefinitions();
    const groups = this.getGroupDefinitions();

    const activeMode = process.env.MCP_TOOL_MODE || toolGroups?.activeMode || null;
    const enabledGroups = this.getActiveGroups();
    const enabledTools = Array.from(this.getEnabledTools());

    return {
      activeMode,
      enabledGroups,
      enabledTools: enabledTools.includes('*')
        ? Object.values(groups).flatMap((g) => g.tools)
        : enabledTools,
      availableModes: Object.keys(modes),
      groupDefinitions: groups,
    };
  }

  /**
   * Alias for getToolGroupsStatus (for backward compatibility)
   */
  public getToolGroupStatus(): ToolGroupStatus {
    return this.getToolGroupsStatus();
  }

  /**
   * Set active tool group mode (persisted in settings)
   */
  public setToolGroupMode(mode: string): void {
    const modes = this.getModeDefinitions();
    if (!modes[mode]) {
      throw new Error(`Unknown tool group mode: ${mode}`);
    }

    if (!this.config.toolGroups) {
      this.config.toolGroups = {};
    }

    this.config.toolGroups.activeMode = mode;
    delete this.config.toolGroups.enabled; // Clear explicit list when setting mode

    this.saveEnvSettings();
  }

  /**
   * Set explicitly enabled groups (persisted in settings)
   */
  public setEnabledGroups(groups: string[]): void {
    const groupDefs = this.getGroupDefinitions();

    // Validate all groups exist
    for (const g of groups) {
      if (!groupDefs[g]) {
        throw new Error(`Unknown tool group: ${g}`);
      }
    }

    if (!this.config.toolGroups) {
      this.config.toolGroups = {};
    }

    this.config.toolGroups.enabled = groups;
    delete this.config.toolGroups.activeMode; // Clear mode when setting explicit groups

    this.saveEnvSettings();
  }

  // ============================================
  // Tool Orchestration Configuration
  // ============================================

  /**
   * Get tool orchestration configuration from settings
   */
  public getToolOrchestrationConfig(): Config['toolOrchestration'] | undefined {
    return this.config.toolOrchestration;
  }

  /**
   * Save tool orchestration configuration to settings
   */
  public saveToolOrchestrationConfig(config: NonNullable<Config['toolOrchestration']>): void {
    this.config.toolOrchestration = config;
    this.saveEnvSettings();
  }

  /**
   * Update global tool orchestration settings
   */
  public updateToolOrchestrationGlobalSettings(
    settings: Partial<NonNullable<NonNullable<Config['toolOrchestration']>['globalSettings']>>
  ): void {
    const current = this.getToolOrchestrationConfig() || {};
    const base = current.globalSettings ?? ToolOrchestrationGlobalSettingsSchema.parse({});
    const globalSettings = ToolOrchestrationGlobalSettingsSchema.parse({ ...base, ...settings });

    this.saveToolOrchestrationConfig({
      ...current,
      globalSettings,
    });
  }

  /**
   * Update per-tool orchestration configuration
   */
  public updateToolOrchestrationToolConfig(
    toolName: string,
    config: Partial<NonNullable<NonNullable<Config['toolOrchestration']>['toolConfigs']>[string]>
  ): void {
    const current = this.getToolOrchestrationConfig() || {};
    const toolConfigs = { ...current.toolConfigs };

    toolConfigs[toolName] = { ...toolConfigs[toolName], ...config };

    this.saveToolOrchestrationConfig({
      ...current,
      toolConfigs,
    });
  }

  /**
   * Reset tool orchestration to defaults
   */
  public resetToolOrchestrationConfig(): void {
    delete this.config.toolOrchestration;
    this.saveEnvSettings();
  }
}
