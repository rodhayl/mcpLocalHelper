import express from 'express';
import cors from 'cors';
import { Server } from 'http';
import { ConfigManager } from '../config/index.js';
import { BackendManager } from '../adapters/factory.js';
import { SystemProfiler } from '../utils/system.js';
import { FileTools } from '../tools/file.js';
import { GrepTools } from '../tools/grep.js';
import { LlmChatTool } from '../tools/llm.js';
import { SummarizationTools } from '../tools/summarize.js';
import { VerifyPlanTool } from '../tools/verify.js';
import { OpenAIModelsResponse, OpenAIModelData } from '../types/index.js';
import { ModelInfoTool } from '../tools/model.js';
import { DEFAULT_TOOL_GROUPS, DEFAULT_TOOL_MODES } from '../types/index.js';
import { RedactionEngine } from '../utils/redaction.js';
import { healthRouter } from '../routes/health.js';

interface LogEntry {
  timestamp: string;
  level: 'info' | 'warning' | 'error';
  category: string;
  message: string;
  details?: Record<string, unknown>;
}

export class HttpServer {
  private app: express.Application;
  private config: ConfigManager;
  private backendManager: BackendManager;
  private systemProfiler: SystemProfiler;
  private fileTools: FileTools;
  private grepTools: GrepTools;
  private llmChat: LlmChatTool;
  private summarization: SummarizationTools;
  private verifyPlan: VerifyPlanTool;
  private modelInfoTool: ModelInfoTool;
  private port: number;
  private host: string;
  private logs: LogEntry[] = [];
  private maxLogs = 100;
  private onMcpServersChanged?: () => void;
  private onBackendsChanged?: () => void;
  private toolProvider?: {
    listLocalTools: (options?: { includeDisabled?: boolean; includeSchema?: boolean }) => unknown;
    getLocalToolSchema: (toolName: string) => unknown;
    executeTool?: (
      toolName: string,
      args: Record<string, unknown>,
      onProgress?: (event: unknown) => void
    ) => Promise<{
      success: boolean;
      content?: Array<{ type: string; text: string }>;
      error?: string;
      isError?: boolean;
    }>;
  };
  private activeToolExecutions: Map<
    string,
    { abortController: AbortController; startTime: number }
  > = new Map();

  constructor(
    config: ConfigManager,
    backendManager: BackendManager,
    opts?: {
      onMcpServersChanged?: () => void;
      onBackendsChanged?: () => void;
      toolProvider?: {
        listLocalTools: (options?: {
          includeDisabled?: boolean;
          includeSchema?: boolean;
        }) => unknown;
        getLocalToolSchema: (toolName: string) => unknown;
        executeTool?: (
          toolName: string,
          args: Record<string, unknown>,
          onProgress?: (event: unknown) => void
        ) => Promise<{
          success: boolean;
          content?: Array<{ type: string; text: string }>;
          error?: string;
          isError?: boolean;
        }>;
      };
    }
  ) {
    this.app = express();
    this.config = config;
    this.backendManager = backendManager;
    this.systemProfiler = new SystemProfiler();
    this.fileTools = new FileTools(this.config);
    this.grepTools = new GrepTools(this.config);
    this.llmChat = new LlmChatTool(this.backendManager, this.config);
    this.summarization = new SummarizationTools(this.fileTools, this.llmChat);
    this.verifyPlan = new VerifyPlanTool(
      this.fileTools,
      this.grepTools,
      this.llmChat,
      this.summarization
    );
    this.modelInfoTool = new ModelInfoTool(this.config, this.backendManager);
    this.onMcpServersChanged = opts?.onMcpServersChanged;
    this.onBackendsChanged = opts?.onBackendsChanged;
    this.toolProvider = opts?.toolProvider;

    const serverConfig = config.getConfig().server || { port: 3000, host: '127.0.0.1' };
    this.port = serverConfig.port;
    this.host = serverConfig.host;

    this.setupMiddleware();
    this.setupRoutes();
  }

  private refreshBackendsFromConfig(): void {
    this.backendManager = new BackendManager(this.config.getConfig().backends);
    this.llmChat = new LlmChatTool(this.backendManager, this.config);
    this.summarization = new SummarizationTools(this.fileTools, this.llmChat);
    this.verifyPlan = new VerifyPlanTool(
      this.fileTools,
      this.grepTools,
      this.llmChat,
      this.summarization
    );
    this.modelInfoTool = new ModelInfoTool(this.config, this.backendManager);
  }

  private setupMiddleware() {
    this.app.use(cors());
    this.app.use(express.json());
    this.app.use(express.static('public'));

    // Request logging middleware
    this.app.use((req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        const duration = Date.now() - start;
        const level = res.statusCode >= 400 ? 'error' : 'info';
        this.addLog(level, 'HTTP', `${req.method} ${req.path}`, {
          statusCode: res.statusCode,
          duration: `${duration}ms`,
        });
      });
      next();
    });
  }

  private addLog(
    level: 'info' | 'warning' | 'error',
    category: string,
    message: string,
    details?: Record<string, unknown>
  ) {
    this.logs.unshift({
      timestamp: new Date().toISOString(),
      level,
      category,
      message,
      details,
    });

    // Keep only the most recent logs
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(0, this.maxLogs);
    }
  }

  private setupRoutes() {
    // Health router already defines GET /health, so mount at root.
    this.app.use('/', healthRouter as any);

    // Backend management
    this.app.get('/api/backends', async (req, res) => {
      void req;
      try {
        const backends = this.backendManager.getAllBackendsWithType().map(({ backend, type }) => ({
          id: backend.id,
          kind: backend.kind,
          type: type,
          displayName: backend.displayName,
        }));

        const probeResults = await this.backendManager.probeAll();

        const result = backends.map((backend) => {
          const probe = probeResults.get(backend.id);
          const available = probe?.available || false;

          // Log backend status
          if (!available && probe?.error) {
            this.addLog('warning', 'Backend', `${backend.id} unavailable`, { error: probe.error });
          }

          return {
            ...backend,
            available,
            error: probe?.error,
          };
        });

        res.json(result);
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    // Backend configuration management (CRUD via full replace)
    this.app.get('/api/backends-config', (req, res) => {
      void req;
      try {
        // Mask api_key (never return secrets)
        const backends = this.config.getBackends().map((b) => ({
          ...b,
          api_key: b.api_key ? '********' : undefined,
        }));
        res.json({ backends });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    this.app.put('/api/backends-config', (req, res) => {
      try {
        const incoming = req.body?.backends;
        if (!Array.isArray(incoming)) {
          return res.status(400).json({ error: 'Expected { backends: [...] }' });
        }

        // Preserve existing api keys when client sends placeholder/empty
        const existing = new Map(this.config.getBackends().map((b) => [b.id, b]));
        const merged = incoming.map((b: any) => {
          const prev = existing.get(b.id);
          const apiKey = b.api_key;
          const shouldPreserve =
            apiKey === undefined || apiKey === null || apiKey === '' || apiKey === '********';
          return {
            ...b,
            api_key: shouldPreserve ? prev?.api_key : apiKey,
          };
        });

        this.config.setBackends(merged);
        this.refreshBackendsFromConfig();
        this.onBackendsChanged?.();
        this.addLog('info', 'Settings', 'Backends updated', {
          backends: this.config.getBackends().map((b) => b.id),
        });

        res.json({
          success: true,
          backends: this.config
            .getBackends()
            .map((b) => ({ ...b, api_key: b.api_key ? '********' : undefined })),
        });
      } catch (error) {
        res
          .status(400)
          .json({ error: error instanceof Error ? error.message : 'Invalid backends config' });
      }
    });

    this.app.get('/api/backends/:id/models', async (req, res) => {
      try {
        const backend = this.backendManager.getBackend(req.params.id);
        if (!backend) {
          return res.status(404).json({ error: 'Backend not found' });
        }

        const models = await backend.listModels();
        // Extract just the model IDs/names for display
        const modelNames = models.map((m) => m.id || m.name || String(m));
        res.json(modelNames);
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    // System profile
    this.app.get('/api/system-profile', async (req, res) => {
      void req;
      try {
        const profile = await this.systemProfiler.getSystemProfile();

        // Get model suitability info for local backend
        let suitability = null;
        try {
          const localModels = await this.modelInfoTool.getBackendModels();
          if (localModels.success && localModels.currentModel) {
            suitability = {
              currentModel: localModels.currentModel.name,
              capability: localModels.currentModel.estimatedCapability,
              recommendedTasks: localModels.currentModel.recommendedTasks.slice(0, 5),
              cautionTasks: localModels.currentModel.cautionTasks.slice(0, 3),
            };
          }
        } catch {
          // Suitability is optional, don't fail if model info unavailable
        }

        res.json({
          profile,
          exposeToLLM: this.config.getConfig().systemProfile.exposeToLLM,
          suitability,
        });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    // ============================================
    // Environment Settings API
    // ============================================

    // Get current environment settings
    this.app.get('/api/settings', (req, res) => {
      void req;
      try {
        const settings = this.config.getEnvSettings();
        const config = this.config.getConfig();

        res.json({
          settings,
          currentMode: settings.testing.enabled ? 'testing' : 'production',
          sotaAvailable: this.config.isSotaAvailable(),
          sotaBackendId: config.defaults.sotaBackendId || null,
          localBackendId: config.defaults.localBackendId,
          // QA_feedback_9: Include embedding model configuration
          embeddingModel:
            settings.advanced.embeddingModel || 'godiscus-sapientia/embeddinggemma-300m.Q4_0',
          embeddingBackendUrl: settings.advanced.embeddingBackendUrl || 'http://127.0.0.1:1234',
          // QA_feedback_11: Include agent configuration
          agent: {
            maxSteps: settings.advanced.agentMaxSteps ?? 50,
            maxActionsPerStep: settings.advanced.agentMaxActionsPerStep ?? 30,
            maxSubtasks: settings.advanced.agentMaxSubtasks ?? 8,
            timeoutMs: settings.advanced.agentTimeoutMs ?? 300000,
            description:
              'Agent task limits. Higher values = longer execution time. Use with caution.',
          },
        });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    // Update environment settings
    this.app.post('/api/settings', (req, res) => {
      try {
        const updates = req.body;
        this.config.updateEnvSettings(updates);
        this.refreshBackendsFromConfig();
        this.onBackendsChanged?.();
        this.addLog('info', 'Settings', 'Environment settings updated', updates);

        res.json({
          success: true,
          message: 'Settings updated. Some changes may require server restart.',
          settings: this.config.getEnvSettings(),
        });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    // Enable testing mode
    this.app.post('/api/settings/testing/enable', (req, res) => {
      try {
        const { sotaType, openRouterApiKey, openRouterModel, sotaBackendId, sotaModel } = req.body;

        if (sotaType === 'openrouter') {
          if (!openRouterApiKey) {
            return res.status(400).json({
              error: 'OpenRouter API key is required. Get one from https://openrouter.ai/',
            });
          }
          this.config.configureOpenRouter(openRouterApiKey, openRouterModel);
          this.refreshBackendsFromConfig();
          this.onBackendsChanged?.();
          this.addLog(
            'info',
            'Settings',
            'Testing mode enabled with OpenRouter' + (openRouterModel ? ': ' + openRouterModel : '')
          );
        } else {
          // Use local backend as SOTA
          this.config.configureLocalSota(sotaBackendId || 'ollama', sotaModel);
          this.refreshBackendsFromConfig();
          this.onBackendsChanged?.();
          this.addLog('info', 'Settings', 'Testing mode enabled with local SOTA');
        }

        res.json({
          success: true,
          message: 'Testing mode enabled. Restart the server for full effect.',
          settings: this.config.getEnvSettings(),
        });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    // Disable testing mode (switch to production)
    this.app.post('/api/settings/testing/disable', (req, res) => {
      void req;
      try {
        this.config.disableTestingMode();
        this.refreshBackendsFromConfig();
        this.onBackendsChanged?.();
        this.addLog('info', 'Settings', 'Testing mode disabled, switched to production');

        res.json({
          success: true,
          message: 'Switched to production mode. Only local LLM is available.',
          settings: this.config.getEnvSettings(),
        });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    // Legacy OpenRouter API (deprecated - kept for backward compatibility)
    this.app.get('/api/openrouter/status', (req, res) => {
      void req;
      try {
        const settings = this.config.getEnvSettings();
        const isEnabled =
          settings.testing.enabled && settings.testing.sotaBackendType === 'openrouter';
        const hasApiKey = !!settings.testing.openRouterApiKey;

        res.json({
          enabled: isEnabled,
          hasApiKey,
          sotaBackendId: isEnabled ? 'openrouter-sota' : null,
          message: isEnabled
            ? 'OpenRouter is enabled for testing'
            : 'OpenRouter is disabled. Use /api/settings for configuration.',
          deprecated: true,
          useInstead: '/api/settings',
        });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    this.app.post('/api/openrouter/enable', async (req, res) => {
      try {
        const { apiKey } = req.body;

        if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
          return res.status(400).json({
            error: 'API key is required. Get one from https://openrouter.ai/',
          });
        }

        this.config.configureOpenRouter(apiKey.trim());
        this.refreshBackendsFromConfig();
        this.onBackendsChanged?.();
        this.addLog('info', 'Settings', 'OpenRouter enabled via legacy API');

        res.json({
          success: true,
          message: 'OpenRouter enabled. Restart the server for changes to take effect.',
          enabled: true,
          sotaBackendId: 'openrouter-sota',
          deprecated: true,
          useInstead: '/api/settings/testing/enable',
        });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    this.app.post('/api/openrouter/disable', (req, res) => {
      void req;
      try {
        this.config.disableTestingMode();
        this.refreshBackendsFromConfig();
        this.onBackendsChanged?.();
        this.addLog('info', 'Settings', 'Testing mode disabled via legacy API');

        res.json({
          success: true,
          message: 'Testing mode disabled. The calling LLM will act as SOTA.',
          enabled: false,
          deprecated: true,
          useInstead: '/api/settings/testing/disable',
        });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    // Fetch OpenRouter models
    this.app.post('/api/openrouter/models', async (req, res) => {
      try {
        const { apiKey } = req.body;

        if (!apiKey || typeof apiKey !== 'string') {
          return res.status(400).json({
            error: 'API key is required to fetch models',
          });
        }

        // Fetch models from OpenRouter
        const response = await fetch('https://openrouter.ai/api/v1/models', {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + apiKey,
            'HTTP-Referer': 'http://localhost:3000',
            'X-Title': 'MCP Local LLM Server',
          },
        });

        if (!response.ok) {
          const errorText = await response.text();
          return res.status(response.status).json({
            error: 'OpenRouter API error: ' + response.statusText,
            details: errorText,
          });
        }

        const data = (await response.json()) as OpenAIModelsResponse;

        if (!data.data || !Array.isArray(data.data)) {
          return res.status(500).json({
            error: 'Invalid response from OpenRouter',
          });
        }

        // Sort models by name and return simplified list
        const models = data.data
          .map((m: OpenAIModelData) => ({
            id: m.id,
            name: m.name || m.id,
            context_length: m.context_length,
            pricing: m.pricing,
          }))
          .sort((a, b) => a.id.localeCompare(b.id));

        res.json({
          success: true,
          models,
          count: models.length,
        });
      } catch (error) {
        res.status(500).json({
          error: error instanceof Error ? error.message : 'Failed to fetch models',
        });
      }
    });

    // ============================================
    // CLI Orchestration Settings API
    // ============================================

    // Get current CLI orchestration settings
    this.app.get('/api/settings/cli-orchestration', async (req, res) => {
      void req;
      try {
        const settings = this.config.getEnvSettings();
        const config = this.config.getConfig();
        const backends = config.backends || [];

        // Filter CLI backends and probe their availability
        const cliBackendConfigs = backends.filter((b) => ['opencode', 'copilot'].includes(b.type));
        const availableBackends = [];

        for (const b of cliBackendConfigs) {
          // Probe the CLI backend to check availability
          const backend = this.backendManager.getBackend(b.id);
          let available = false;
          let probeError: string | undefined;

          if (backend) {
            try {
              const probeResult = await backend.probe();
              available = probeResult.available;
              probeError = probeResult.error;
            } catch (e) {
              probeError = e instanceof Error ? e.message : 'Probe failed';
            }
          }

          availableBackends.push({
            id: b.id,
            type: b.type,
            displayName: b.type === 'opencode' ? 'OpenCode CLI' : 'GitHub Copilot CLI',
            available,
            error: probeError,
          });
        }

        res.json({
          enabled: settings.advanced.cliOrchestrationEnabled || false,
          backends: settings.advanced.cliOrchestrationBackends || [],
          autoVerify: settings.advanced.cliAutoVerify !== false,
          scoreThreshold: settings.advanced.cliScoreThreshold || 7,
          maxIterations: settings.advanced.cliMaxIterations || 3,
          availableBackends,
        });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    // Update CLI orchestration settings
    this.app.post('/api/settings/cli-orchestration', (req, res) => {
      try {
        const { enabled, backends, autoVerify, scoreThreshold, maxIterations } = req.body;
        const settings = this.config.getEnvSettings();

        if (enabled !== undefined) {
          settings.advanced.cliOrchestrationEnabled = enabled;
        }
        if (backends !== undefined) {
          settings.advanced.cliOrchestrationBackends = backends;
        }
        if (autoVerify !== undefined) {
          settings.advanced.cliAutoVerify = autoVerify;
        }
        if (scoreThreshold !== undefined && scoreThreshold >= 1 && scoreThreshold <= 10) {
          settings.advanced.cliScoreThreshold = scoreThreshold;
        }
        if (maxIterations !== undefined && maxIterations >= 1 && maxIterations <= 10) {
          settings.advanced.cliMaxIterations = maxIterations;
        }

        this.config.updateEnvSettings({ advanced: settings.advanced });
        this.addLog('info', 'Settings', 'CLI orchestration settings updated', req.body);

        res.json({
          success: true,
          message: 'CLI orchestration settings updated',
          settings: {
            enabled: settings.advanced.cliOrchestrationEnabled,
            backends: settings.advanced.cliOrchestrationBackends,
            autoVerify: settings.advanced.cliAutoVerify,
            scoreThreshold: settings.advanced.cliScoreThreshold,
            maxIterations: settings.advanced.cliMaxIterations,
          },
        });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    // Enable CLI orchestration
    this.app.post('/api/settings/cli-orchestration/enable', (req, res) => {
      void req;
      try {
        const settings = this.config.getEnvSettings();
        settings.advanced.cliOrchestrationEnabled = true;
        this.config.updateEnvSettings({ advanced: settings.advanced });
        this.addLog('info', 'Settings', 'CLI orchestration enabled');

        res.json({ success: true, enabled: true });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    // Disable CLI orchestration
    this.app.post('/api/settings/cli-orchestration/disable', (req, res) => {
      void req;
      try {
        const settings = this.config.getEnvSettings();
        settings.advanced.cliOrchestrationEnabled = false;
        this.config.updateEnvSettings({ advanced: settings.advanced });
        this.addLog('info', 'Settings', 'CLI orchestration disabled');

        res.json({ success: true, enabled: false });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    // Run CLI orchestration task
    this.app.post('/api/orchestration/run', async (req, res) => {
      try {
        const { task, contextRoot } = req.body;

        if (!task || typeof task !== 'string' || !task.trim()) {
          return res.status(400).json({
            success: false,
            error: 'Task is required and must be a non-empty string',
          });
        }

        const { getOrchestrationService } = await import('../orchestration/index.js');
        const orchestrationService = getOrchestrationService();

        if (!orchestrationService) {
          return res.status(500).json({
            success: false,
            error: 'Orchestration service not initialized',
          });
        }

        const status = orchestrationService.getStatus();

        if (!status.enabled) {
          return res.status(400).json({
            success: false,
            error: 'CLI orchestration is not enabled',
            hint: 'Enable it via POST /api/settings/cli-orchestration/enable',
            status,
          });
        }

        if (status.backends.length === 0) {
          return res.status(400).json({
            success: false,
            error: 'No CLI backends selected',
            hint: 'Select at least one backend in settings',
            status,
          });
        }

        this.addLog(
          'info',
          'Orchestration',
          `Starting orchestration for task: ${task.substring(0, 100)}...`
        );

        const result = await orchestrationService.orchestrate(task, { contextRoot });

        this.addLog(
          result.success ? 'info' : 'error',
          'Orchestration',
          `Orchestration ${result.success ? 'completed' : 'failed'}: score=${result.score}/10`,
          { planId: result.planId }
        );

        res.json({
          ...result,
          orchestrationStatus: status,
        });
      } catch (error) {
        this.addLog('error', 'Orchestration', 'Error running orchestration', {
          error: String(error),
        });
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // Probe CLI backends
    this.app.get('/api/orchestration/probe', async (req, res) => {
      void req;
      try {
        const { getOrchestrationService } = await import('../orchestration/index.js');
        const orchestrationService = getOrchestrationService();

        if (!orchestrationService) {
          return res.status(500).json({
            success: false,
            error: 'Orchestration service not initialized',
          });
        }

        const probeResults = await orchestrationService.probeBackends();
        const status = orchestrationService.getStatus();

        const results: Record<string, { available: boolean; error?: string }> = {};
        probeResults.forEach((value, key) => {
          results[key] = value;
        });

        res.json({
          success: true,
          backends: results,
          orchestrationStatus: status,
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // ============================================
    // Per-Tool Orchestration API Endpoints
    // ============================================

    // Get all per-tool orchestration settings
    this.app.get('/api/settings/tool-orchestration', async (req, res) => {
      void req;
      try {
        const { getToolOrchestrationManager, ALL_LLM_TOOLS, TOOL_CATEGORIES } = await import(
          '../orchestration/tool-orchestration-manager.js'
        );
        const { getOrchestrationService } = await import('../orchestration/index.js');

        const manager = getToolOrchestrationManager();
        const orchestrationService = getOrchestrationService();

        // Get orchestration status
        const status = orchestrationService?.getStatus();
        const orchestrationAvailable = !!(status?.enabled && status.backends.length > 0);

        // Get all tool configs
        const toolConfigs: Record<string, unknown> = {};
        for (const toolName of ALL_LLM_TOOLS) {
          toolConfigs[toolName] = manager.getToolConfig(toolName);
        }

        res.json({
          success: true,
          globalSettings: manager.getGlobalSettings(),
          toolConfigs,
          availableTools: [...ALL_LLM_TOOLS],
          toolCategories: TOOL_CATEGORIES,
          orchestrationAvailable,
          orchestrationBackends: status?.backends || [],
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // Update global tool orchestration settings
    this.app.post('/api/settings/tool-orchestration/global', async (req, res) => {
      try {
        const { getToolOrchestrationManager } = await import(
          '../orchestration/tool-orchestration-manager.js'
        );
        const manager = getToolOrchestrationManager();

        const {
          defaultOrchestrationEnabled,
          defaultPreferredBackend,
          defaultFallbackToLocal,
          defaultQuickMode,
        } = req.body;

        const updates: Record<string, unknown> = {};
        if (typeof defaultOrchestrationEnabled === 'boolean') {
          updates.defaultOrchestrationEnabled = defaultOrchestrationEnabled;
        }
        if (typeof defaultPreferredBackend === 'string') {
          updates.defaultPreferredBackend = defaultPreferredBackend;
        }
        if (typeof defaultFallbackToLocal === 'boolean') {
          updates.defaultFallbackToLocal = defaultFallbackToLocal;
        }
        if (typeof defaultQuickMode === 'boolean') {
          updates.defaultQuickMode = defaultQuickMode;
        }

        manager.updateGlobalSettings(updates as Parameters<typeof manager.updateGlobalSettings>[0]);

        // Persist to config
        this.config.updateToolOrchestrationGlobalSettings(
          updates as Parameters<typeof this.config.updateToolOrchestrationGlobalSettings>[0]
        );

        this.addLog('info', 'ToolOrchestration', 'Global settings updated', updates);

        res.json({
          success: true,
          globalSettings: manager.getGlobalSettings(),
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // Update individual tool orchestration config
    this.app.post('/api/settings/tool-orchestration/:toolName', async (req, res) => {
      try {
        const { toolName } = req.params;
        const { getToolOrchestrationManager, ALL_LLM_TOOLS } = await import(
          '../orchestration/tool-orchestration-manager.js'
        );

        // Validate tool name
        if (!ALL_LLM_TOOLS.includes(toolName as (typeof ALL_LLM_TOOLS)[number])) {
          return res.status(400).json({
            success: false,
            error: `Unknown tool: ${toolName}`,
            availableTools: [...ALL_LLM_TOOLS],
          });
        }

        const manager = getToolOrchestrationManager();

        const { orchestrationEnabled, preferredBackend, fallbackToLocal, quickMode } = req.body;

        const updates: Record<string, unknown> = {};
        if (typeof orchestrationEnabled === 'boolean') {
          updates.orchestrationEnabled = orchestrationEnabled;
        }
        if (typeof preferredBackend === 'string') {
          updates.preferredBackend = preferredBackend;
        }
        if (typeof fallbackToLocal === 'boolean') {
          updates.fallbackToLocal = fallbackToLocal;
        }
        if (typeof quickMode === 'boolean') {
          updates.quickMode = quickMode;
        }

        manager.setToolConfig(toolName, updates as Parameters<typeof manager.setToolConfig>[1]);

        // Persist to config
        this.config.updateToolOrchestrationToolConfig(
          toolName,
          updates as Parameters<typeof this.config.updateToolOrchestrationToolConfig>[1]
        );

        this.addLog('info', 'ToolOrchestration', `Tool ${toolName} config updated`, updates);

        res.json({
          success: true,
          toolName,
          config: manager.getToolConfig(toolName),
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // Batch update tools by category
    this.app.post('/api/settings/tool-orchestration/batch', async (req, res) => {
      try {
        const { getToolOrchestrationManager, TOOL_CATEGORIES } = await import(
          '../orchestration/tool-orchestration-manager.js'
        );
        const manager = getToolOrchestrationManager();

        const { category, toolNames, config } = req.body;

        // Determine which tools to update
        let tools: string[] = [];
        if (category && TOOL_CATEGORIES[category as keyof typeof TOOL_CATEGORIES]) {
          tools = [...TOOL_CATEGORIES[category as keyof typeof TOOL_CATEGORIES]];
        } else if (Array.isArray(toolNames)) {
          tools = toolNames;
        } else {
          return res.status(400).json({
            success: false,
            error: 'Either category or toolNames array is required',
            availableCategories: Object.keys(TOOL_CATEGORIES),
          });
        }

        if (!config || typeof config !== 'object') {
          return res.status(400).json({
            success: false,
            error: 'config object is required',
          });
        }

        const result = manager.bulkUpdateByGroup(tools, config);

        // Persist each updated tool
        for (const toolName of result.updated) {
          this.config.updateToolOrchestrationToolConfig(toolName, config);
        }

        this.addLog(
          'info',
          'ToolOrchestration',
          `Batch update: ${result.updated.length} tools updated`
        );

        res.json({
          success: true,
          ...result,
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // Reset all tool orchestration to defaults
    this.app.post('/api/settings/tool-orchestration/reset', async (req, res) => {
      void req;
      try {
        const { getToolOrchestrationManager } = await import(
          '../orchestration/tool-orchestration-manager.js'
        );
        const manager = getToolOrchestrationManager();

        manager.resetAllToolConfigs();
        this.config.resetToolOrchestrationConfig();

        this.addLog(
          'info',
          'ToolOrchestration',
          'All tool orchestration settings reset to defaults'
        );

        res.json({
          success: true,
          message: 'All tool orchestration settings reset to defaults',
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // Get/Set model preferences
    this.app.post('/api/config/set-model', async (req, res) => {
      try {
        const { role, model } = req.body;
        if (!role || !model) {
          return res.status(400).json({ error: 'Role and model are required' });
        }

        if (role === 'local') {
          this.config.getConfig().defaults.localModel = model;
        } else if (role === 'sota') {
          this.config.getConfig().defaults.sotaModel = model;

          // Keep env.settings in sync when testing mode is enabled
          const env = this.config.getEnvSettings();
          if (env.testing.enabled) {
            this.config.updateEnvSettings({ testing: { sotaModel: model } });
          }
        } else {
          return res.status(400).json({ error: 'Invalid role' });
        }

        this.config.saveEnvSettings();
        this.refreshBackendsFromConfig();
        this.onBackendsChanged?.();
        this.addLog('info', 'System', `Default ${role} model changed to ${model} (persisted)`);
        res.json({ success: true, role, model });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    // Configuration
    this.app.get('/api/config', (req, res) => {
      void req;
      const config = this.config.getConfig();
      // Return safe config (without sensitive data)
      res.json({
        defaults: config.defaults,
        policy: {
          maxFileBytes: config.policy.maxFileBytes,
          allowlistPaths: config.policy.allowlistPaths,
        },
        systemProfile: config.systemProfile,
        server: config.server,
        mcpServers: config.mcpServers || {},
      });
    });

    // ============================================
    // MCP Servers Configuration API
    // ============================================

    this.app.get('/api/mcp-servers', (req, res) => {
      void req;
      try {
        res.json(this.config.getMcpServers());
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    this.app.put('/api/mcp-servers', (req, res) => {
      try {
        const servers = req.body;
        this.config.setMcpServers(servers);
        this.onMcpServersChanged?.();
        this.addLog('info', 'Settings', 'MCP servers updated', {
          servers: Object.keys(this.config.getMcpServers()),
        });
        res.json({ success: true, servers: this.config.getMcpServers() });
      } catch (error) {
        res
          .status(400)
          .json({ error: error instanceof Error ? error.message : 'Invalid MCP servers' });
      }
    });

    this.app.post('/api/mcp-servers/:name', (req, res) => {
      try {
        const name = req.params.name;
        const serverCfg = req.body;
        this.config.upsertMcpServer(name, serverCfg);
        this.onMcpServersChanged?.();
        this.addLog('info', 'Settings', `MCP server upserted: ${name}`);
        res.json({ success: true, servers: this.config.getMcpServers() });
      } catch (error) {
        res
          .status(400)
          .json({ error: error instanceof Error ? error.message : 'Invalid MCP server config' });
      }
    });

    this.app.delete('/api/mcp-servers/:name', (req, res) => {
      try {
        const name = req.params.name;
        this.config.removeMcpServer(name);
        this.onMcpServersChanged?.();
        this.addLog('info', 'Settings', `MCP server removed: ${name}`);
        res.json({ success: true, servers: this.config.getMcpServers() });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    // Graceful restart (best-effort). Useful after config changes.
    this.app.post('/api/restart', (req, res) => {
      try {
        const dryRun = req.body?.dryRun === true;
        this.addLog('info', 'System', 'Restart requested', { dryRun });

        res.json({
          success: true,
          message: dryRun
            ? 'Dry-run: server would restart'
            : 'Server restarting. Your MCP client should reconnect automatically.',
        });

        if (dryRun) return;

        // Give the response time to flush.
        setTimeout(() => {
          try {
            process.kill(process.pid, 'SIGTERM');
          } catch {
            process.exit(0);
          }
        }, 150);
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    this.app.post('/api/config/toggle-system-profile', (req, res) => {
      void req;
      try {
        // This would need to be implemented with config persistence
        const current = this.config.getConfig().systemProfile.exposeToLLM;
        // For now, just return the current state (would need config update logic)
        res.json({ exposeToLLM: current });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    this.app.post('/api/config/set-backend', (req, res) => {
      try {
        const { role, backendId } = req.body;

        if (!role || !backendId) {
          return res.status(400).json({ error: 'role and backendId are required' });
        }

        if (role !== 'local' && role !== 'sota') {
          return res.status(400).json({ error: 'role must be "local" or "sota"' });
        }

        // Verify backend exists
        const backend = this.backendManager.getBackend(backendId);
        if (!backend) {
          return res.status(404).json({ error: `Backend '${backendId}' not found` });
        }

        // Update config and persist to disk
        const config = this.config.getConfig();
        if (role === 'local') {
          config.defaults.localBackendId = backendId;
        } else {
          config.defaults.sotaBackendId = backendId;

          // Keep env.settings in sync when testing mode is enabled.
          // This avoids a mismatch where the UI shows one SOTA backend but the server uses another.
          const env = this.config.getEnvSettings();
          if (env.testing.enabled) {
            const nextType = backendId === 'openrouter-sota' ? 'openrouter' : 'local';
            this.config.updateEnvSettings({
              testing: {
                sotaBackendType: nextType as 'local' | 'openrouter',
                sotaBackendId: nextType === 'local' ? backendId : env.testing.sotaBackendId,
              },
            });
          }
        }

        this.config.saveEnvSettings();
        this.refreshBackendsFromConfig();
        this.onBackendsChanged?.();
        this.addLog(
          'info',
          'System',
          `Default ${role} backend changed to ${backendId} (persisted)`
        );

        res.json({
          success: true,
          defaults: config.defaults,
          message: 'Backend updated and saved to settings file',
        });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    // Tool Groups Management
    this.app.get('/api/tool-groups', (req, res) => {
      void req;
      try {
        const status = this.config.getToolGroupStatus();
        res.json(status);
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    this.app.get('/api/tool-groups/modes', (req, res) => {
      void req;
      try {
        // Return available modes with their descriptions
        const modes = Object.entries(DEFAULT_TOOL_MODES).map(([modeName, modeConfig]) => ({
          mode: modeName,
          groups: modeConfig.groups,
          description: modeConfig.description,
        }));
        res.json({
          modes,
          currentMode: this.config.getConfig().toolGroups?.activeMode || 'DEVELOPMENT',
        });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    this.app.post('/api/tool-groups/set-mode', (req, res) => {
      try {
        const { mode } = req.body;

        if (!mode) {
          return res.status(400).json({ error: 'mode is required' });
        }

        const validModes = Object.keys(DEFAULT_TOOL_MODES);
        if (!validModes.includes(mode)) {
          return res.status(400).json({
            error: `Invalid mode. Valid modes are: ${validModes.join(', ')}`,
          });
        }

        this.config.setToolGroupMode(mode);
        this.addLog('info', 'Tool Groups', `Mode changed to ${mode}`, {
          enabledGroups: this.config.getEnabledGroups(),
        });

        const status = this.config.getToolGroupStatus();
        res.json({
          success: true,
          message: `Tool group mode set to ${mode}`,
          status,
        });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    this.app.post('/api/tool-groups/set-groups', (req, res) => {
      try {
        const { groups } = req.body;

        if (!groups || !Array.isArray(groups)) {
          return res.status(400).json({ error: 'groups must be an array of group names' });
        }

        // Validate group names
        const validGroups = Object.keys(DEFAULT_TOOL_GROUPS);
        const invalidGroups = groups.filter((g: string) => !validGroups.includes(g));
        if (invalidGroups.length > 0) {
          return res.status(400).json({
            error: `Invalid groups: ${invalidGroups.join(', ')}. Valid groups are: ${validGroups.join(', ')}`,
          });
        }

        this.config.setEnabledGroups(groups);
        this.addLog('info', 'Tool Groups', 'Custom groups configured', { groups });

        const status = this.config.getToolGroupStatus();
        res.json({
          success: true,
          message: 'Tool groups updated',
          status,
        });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    this.app.get('/api/tool-groups/definitions', (req, res) => {
      void req;
      try {
        // Return all group definitions with their tools
        const definitions = Object.entries(DEFAULT_TOOL_GROUPS).map(([id, group]) => ({
          id,
          ...group,
        }));
        res.json({ groups: definitions });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    // ============================================
    // Tool Schemas (HTTP discoverability)
    // ============================================

    this.app.get('/api/tools', (req, res) => {
      try {
        if (!this.toolProvider) {
          res.status(501).json({ error: 'Tool schema provider not available' });
          return;
        }

        const includeDisabled =
          req.query.includeDisabled === '1' || req.query.includeDisabled === 'true';
        const includeSchema = req.query.includeSchema === '1' || req.query.includeSchema === 'true';

        const tools = this.toolProvider.listLocalTools({ includeDisabled, includeSchema });
        res.json({ tools });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    this.app.get('/api/tools/:name/schema', (req, res) => {
      try {
        if (!this.toolProvider) {
          res.status(501).json({ error: 'Tool schema provider not available' });
          return;
        }

        const name = String(req.params.name || '').trim();
        const result: any = this.toolProvider.getLocalToolSchema(name);
        if (!result || result.found !== true) {
          res.status(404).json({ error: `Tool '${name}' not found` });
          return;
        }

        res.json(result);
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    // ============================================
    // Tool Execution API (for Tool Tester UI)
    // ============================================

    // Execute a tool with given arguments (SSE for streaming progress)
    this.app.post('/api/tools/:name/execute', async (req, res) => {
      const toolName = String(req.params.name || '').trim();
      const args = req.body?.arguments || req.body?.args || {};
      const useSSE = req.query.sse === '1' || req.query.sse === 'true';
      const executionId = `exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      this.addLog('info', 'Tool', `Executing tool: ${toolName}`, { executionId, args });

      if (!this.toolProvider?.executeTool) {
        res.status(501).json({ error: 'Tool execution not available' });
        return;
      }

      // Create abort controller for this execution
      const abortController = new AbortController();
      this.activeToolExecutions.set(executionId, { abortController, startTime: Date.now() });

      if (useSSE) {
        // Server-Sent Events for streaming progress
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Execution-Id', executionId);
        res.flushHeaders();

        const sendEvent = (event: string, data: unknown) => {
          res.write(`event: ${event}\n`);
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        sendEvent('start', { executionId, tool: toolName, timestamp: new Date().toISOString() });

        try {
          const result = await this.toolProvider.executeTool(toolName, args, (progressEvent) => {
            sendEvent('progress', progressEvent);
          });

          const durationMs =
            Date.now() - (this.activeToolExecutions.get(executionId)?.startTime || Date.now());
          sendEvent('complete', {
            executionId,
            tool: toolName,
            durationMs,
            isError: result.isError || false,
            content: result.content,
          });

          this.addLog(result.isError ? 'error' : 'info', 'Tool', `Tool ${toolName} completed`, {
            executionId,
            durationMs,
            isError: result.isError,
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          sendEvent('error', { executionId, tool: toolName, error: errorMessage });
          this.addLog('error', 'Tool', `Tool ${toolName} failed`, {
            executionId,
            error: errorMessage,
          });
        } finally {
          this.activeToolExecutions.delete(executionId);
          res.end();
        }
      } else {
        // Regular JSON response
        try {
          const result = await this.toolProvider.executeTool(toolName, args, undefined);
          const durationMs =
            Date.now() - (this.activeToolExecutions.get(executionId)?.startTime || Date.now());

          this.addLog(result.isError ? 'error' : 'info', 'Tool', `Tool ${toolName} completed`, {
            executionId,
            durationMs,
            isError: result.isError,
          });

          res.json({
            executionId,
            tool: toolName,
            durationMs,
            isError: result.isError || false,
            content: result.content,
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          this.addLog('error', 'Tool', `Tool ${toolName} failed`, {
            executionId,
            error: errorMessage,
          });
          res.status(500).json({ executionId, tool: toolName, error: errorMessage, isError: true });
        } finally {
          this.activeToolExecutions.delete(executionId);
        }
      }
    });

    // Cancel an active tool execution
    this.app.post('/api/tools/cancel/:executionId', (req, res) => {
      const executionId = req.params.executionId;
      const execution = this.activeToolExecutions.get(executionId);

      if (!execution) {
        res.status(404).json({ error: 'Execution not found or already completed' });
        return;
      }

      execution.abortController.abort();
      this.activeToolExecutions.delete(executionId);
      this.addLog('info', 'Tool', `Execution cancelled`, { executionId });

      res.json({ success: true, executionId, message: 'Execution cancelled' });
    });

    // List active tool executions
    this.app.get('/api/tools/executions', (req, res) => {
      void req;
      const executions = Array.from(this.activeToolExecutions.entries()).map(([id, exec]) => ({
        executionId: id,
        startTime: new Date(exec.startTime).toISOString(),
        durationMs: Date.now() - exec.startTime,
      }));
      res.json({ executions, count: executions.length });
    });

    // ============================================
    // Model Capabilities API (Phase 2)
    // ============================================

    // Get all models with their capabilities
    this.app.get('/api/models', async (req, res) => {
      try {
        const backendId = req.query.backendId as string | undefined;
        const result = backendId
          ? await this.modelInfoTool.getBackendModels(backendId)
          : await this.modelInfoTool.getAllBackendModels();
        res.json(result);
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    // Analyze a specific model
    this.app.get('/api/models/analyze', (req, res) => {
      try {
        const modelId = req.query.modelId as string;
        const modelName = req.query.modelName as string | undefined;

        if (!modelId) {
          return res.status(400).json({ error: 'modelId is required' });
        }

        const capabilities = this.modelInfoTool.getModelCapabilities(modelId, modelName);
        res.json({ capabilities });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    // Check task suitability for a model
    this.app.get('/api/models/task-suitability', (req, res) => {
      try {
        const modelId = req.query.modelId as string;
        const taskType = req.query.taskType as string;
        const modelName = req.query.modelName as string | undefined;

        if (!modelId || !taskType) {
          return res.status(400).json({ error: 'modelId and taskType are required' });
        }

        const suitability = this.modelInfoTool.checkTaskSuitability(modelId, taskType, modelName);
        res.json(suitability);
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    // Get model recommendation for a task
    this.app.get('/api/models/recommend', async (req, res) => {
      try {
        const taskType = req.query.taskType as string;
        const backendId = req.query.backendId as string | undefined;

        if (!taskType) {
          return res.status(400).json({ error: 'taskType is required' });
        }

        const recommendation = await this.modelInfoTool.recommendModelForTask(taskType, backendId);
        res.json(recommendation);
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    // Quick model analysis (without backend access)
    this.app.get('/api/models/quick-analyze', (req, res) => {
      try {
        const modelName = req.query.modelName as string;

        if (!modelName) {
          return res.status(400).json({ error: 'modelName is required' });
        }

        const analysis = this.modelInfoTool.quickAnalyze(modelName);
        res.json(analysis);
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    // Scenarios
    this.app.post('/api/scenarios/run', async (req, res) => {
      try {
        const { scenario, parameters } = req.body;
        void parameters;

        if (scenario === 'repo-summary-compact') {
          const summary = await this.summarization.summarizeRepo(process.cwd(), 'compact');
          return res.json({ scenario, status: 'completed', result: summary });
        }

        if (scenario === 'repo-summary-extended') {
          const summary = await this.summarization.summarizeRepo(process.cwd(), 'extended');
          return res.json({ scenario, status: 'completed', result: summary });
        }

        if (scenario === 'explain-file') {
          const path = (req.body && req.body.path) || 'README.md';
          const summary = await this.summarization.summarizePath(path, 'compact');
          return res.json({ scenario, status: 'completed', result: summary });
        }

        if (scenario === 'verify-plan') {
          const plan = (req.body && req.body.plan) || {
            plan_id: 'ui-sample',
            context_root: process.cwd(),
            steps: [
              {
                id: 's1',
                title: 'Find adapters',
                description: 'Check adapter classes and files',
                targets: ['src/adapters/', 'optional-pattern:class\\s+OllamaAdapter'],
              },
            ],
            mode: 'quick',
          };
          const result = await this.verifyPlan.verifyPlan(plan);
          return res.json({ scenario, status: 'completed', result });
        }

        if (scenario === 'sota-vs-local') {
          const userMessage = { role: 'user' as const, content: 'Return the word "ok" only.' };
          const local = await this.llmChat.chat({ messages: [userMessage] }, 'local');
          let sotaError: string | undefined;
          let sotaRes: Awaited<ReturnType<typeof this.llmChat.chat>> | undefined;
          try {
            sotaRes = await this.llmChat.chat({ messages: [userMessage] }, 'sota');
          } catch (e) {
            sotaError = e instanceof Error ? e.message : String(e);
          }
          return res.json({
            scenario,
            status: 'completed',
            result: { local, sota: sotaRes, sotaError },
          });
        }

        if (scenario === 'workspace-smoke') {
          const root = this.config.getDefaultWorkspaceRoot();
          const listed = this.fileTools.listDirectory(root, 10);
          let fileSample: ReturnType<typeof this.fileTools.readFile> | null = null;
          try {
            const firstFile = listed.entries.find((e) => e.type === 'file')?.name;
            if (firstFile) {
              fileSample = this.fileTools.readFile(`${root}/${firstFile}`, 2048);
            }
          } catch {
            /* ignore file read errors */
          }
          return res.json({
            scenario,
            status: 'completed',
            result: {
              status: 'ok',
              workspaceRoot: root,
              listed,
              fileSample,
              checks: [
                'workspaceRoot set',
                'list_dir ok',
                fileSample ? 'read_file ok' : 'no file sample',
              ],
            },
          });
        }

        if (scenario === 'agent-complex-repo-docs') {
          const { AgentRunner } = await import('../agent/runner.js');
          const runner = new AgentRunner({
            config: this.config,
            llmChat: this.llmChat,
            fileTools: this.fileTools,
            grepTools: this.grepTools,
            summarization: this.summarization,
            editTools: new (await import('../tools/edit.js')).EditTools(this.config),
            mcpClient: new (await import('../utils/mcp-client.js')).McpClientManager(
              this.config.getConfig().mcpServers
            ),
          });

          const task =
            'Complex repo task (read-only): Audit docs for outdated MCP connection types (sse/websocket). ' +
            'Find any occurrences and produce a short report listing the files/lines and what should be changed. ' +
            'Also verify whether chrome-devtools examples include --isolated.';

          const result = await runner.runTask(task, {
            contextRoot: this.config.getDefaultWorkspaceRoot(),
            maxSubtasks: 5,
            maxSteps: 10,
            maxActionsPerStep: 10,
            dryRun: false,
            readOnly: true,
          });

          return res.json({ scenario, status: 'completed', result });
        }

        if (scenario === 'agent-complex-browser-screenshot') {
          const { AgentRunner } = await import('../agent/runner.js');
          const { McpClientManager } = await import('../utils/mcp-client.js');
          const { EditTools } = await import('../tools/edit.js');
          const runner = new AgentRunner({
            config: this.config,
            llmChat: this.llmChat,
            fileTools: this.fileTools,
            grepTools: this.grepTools,
            summarization: this.summarization,
            editTools: new EditTools(this.config),
            mcpClient: new McpClientManager(this.config.getConfig().mcpServers),
          });

          const task =
            'Complex browser task: Using the chrome-devtools MCP server, open https://github.com, ' +
            'take a full-page screenshot, and save it to .mcp_cache/agent_scenarios/github.png. ' +
            'Then report the saved file path.';

          const result = await runner.runTask(task, {
            contextRoot: this.config.getDefaultWorkspaceRoot(),
            allowMcpServers: ['chrome-devtools'],
            maxSubtasks: 4,
            maxSteps: 10,
            maxActionsPerStep: 12,
            dryRun: false,
          });

          return res.json({ scenario, status: 'completed', result });
        }

        res.json({ scenario, status: 'error', message: 'Unknown scenario' });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    // Logs
    this.app.get('/api/logs', (req, res) => {
      const level = req.query.level as string | undefined;
      const category = req.query.category as string | undefined;

      let filteredLogs = this.logs;

      if (level) {
        filteredLogs = filteredLogs.filter((log) => log.level === level);
      }

      if (category) {
        filteredLogs = filteredLogs.filter((log) => log.category === category);
      }

      // Redact sensitive values from logs before returning
      const redaction = new RedactionEngine();
      const redactedLogs = filteredLogs.map((log) => redaction.redactObject(log));

      res.json({
        logs: redactedLogs,
        total: this.logs.length,
        filtered: filteredLogs.length,
      });
    });

    this.app.delete('/api/logs', (req, res) => {
      void req;
      this.logs = [];
      this.addLog('info', 'System', 'Logs cleared');
      res.json({ success: true });
    });

    // Health check
    this.app.get('/api/health', (req, res) => {
      void req;
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // Serve the main UI
    this.app.get('/', (req, res) => {
      void req;
      res.send(this.getMainUI());
    });
  }

  private getMainUI(): string {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MCP Local LLM Server</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
        .container { max-width: 1200px; margin: 0 auto; background: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); overflow: hidden; }
        .header { background: #2563eb; color: white; padding: 20px; }
        .header h1 { margin: 0; font-size: 24px; }
        .header p { margin: 5px 0 0; opacity: 0.9; }
        .tabs { display: flex; border-bottom: 1px solid #e5e7eb; }
        .tab { padding: 12px 20px; cursor: pointer; border-bottom: 2px solid transparent; }
        .tab.active { border-bottom-color: #2563eb; color: #2563eb; font-weight: 500; }
        .content { padding: 20px; }
        .tab-content { display: none; }
        .tab-content.active { display: block; }
        .backend-card { border: 1px solid #e5e7eb; border-radius: 6px; padding: 16px; margin-bottom: 12px; }
        .backend-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
        .backend-name { font-weight: 500; font-size: 16px; }
        .backend-status { padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: 500; }
        .status-available { background: #dcfce7; color: #166534; }
        .status-unavailable { background: #fef2f2; color: #dc2626; }
        .system-profile { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 16px; }
        .profile-item { display: flex; justify-content: space-between; margin-bottom: 8px; }
        .profile-item:last-child { margin-bottom: 0; }
        .model-list { display: flex; flex-wrap: wrap; gap: 8px; }
        .model-tag { background: #e0e7ff; color: #4338ca; padding: 4px 8px; border-radius: 4px; font-size: 12px; }
        .scenario-card { border: 1px solid #e5e7eb; border-radius: 6px; padding: 16px; margin-bottom: 12px; }
        .scenario-title { font-weight: 500; margin-bottom: 8px; }
        .scenario-description { color: #6b7280; margin-bottom: 12px; }
        .btn { background: #2563eb; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 14px; }
        .btn:hover { background: #1d4ed8; }
        .btn:disabled { background: #9ca3af; cursor: not-allowed; }
        .btn-small { background: #6b7280; color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
        .btn-small:hover { background: #4b5563; }
        .btn-small:disabled { background: #d1d5db; cursor: not-allowed; }
        .btn-secondary { background: #6b7280; }
        .btn-secondary:hover { background: #4b5563; }
        .toggle { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }
        .toggle-switch { position: relative; width: 44px; height: 24px; background: #d1d5db; border-radius: 12px; cursor: pointer; }
        .toggle-switch.active { background: #2563eb; }
        .toggle-slider { position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; background: white; border-radius: 50%; transition: transform 0.2s; }
        .toggle-switch.active .toggle-slider { transform: translateX(20px); }
        /* QA_feedback_26012026: CSS for CLI orchestration toggle active state */
        #cli-orchestration-toggle.active span:first-of-type { background-color: #2563eb !important; }
        #cli-orchestration-slider.active { transform: translateX(22px); }
        .loading { text-align: center; padding: 40px; color: #6b7280; }
        .error { background: #fef2f2; color: #dc2626; padding: 12px; border-radius: 4px; margin-bottom: 16px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>MCP Local LLM Server</h1>
            <p>Agent-like, Plug-and-Play LLM Integration with Plan Verification</p>
        </div>
        
        <div class="tabs">
            <div class="tab active" data-tab="config">Configuration</div>
            <div class="tab" data-tab="governance">Tool Governance</div>
            <div class="tab" data-tab="tool-orchestration">Tool Orchestration</div>
            <div class="tab" data-tab="tool-tester">Tool Tester</div>
            <div class="tab" data-tab="models">Model Capabilities</div>
            <div class="tab" data-tab="scenarios">Scenarios</div>
            <div class="tab" data-tab="logs">Logs</div>
        </div>
        
        <div class="content">
            <div class="tab-content active" id="config">
                <!-- Current Mode Banner -->
                <div id="mode-banner" style="padding: 12px 16px; border-radius: 6px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <span id="mode-icon" style="font-size: 20px; margin-right: 8px;"></span>
                        <span id="mode-text" style="font-weight: 600;"></span>
                        <span id="mode-description" style="color: #6b7280; margin-left: 8px;"></span>
                    </div>
                    <div id="mode-toggle-container"></div>
                </div>
                
                <div class="system-profile">
                    <h3>System Profile</h3>
                    <div id="system-profile-content">
                        <div class="loading">Loading system profile...</div>
                    </div>
                </div>
                
                <!-- Production Settings Section -->
                <div id="production-section" style="margin-top: 24px;">
                    <h3 style="display: flex; align-items: center; gap: 8px;">
                        <span style="background: #dcfce7; color: #166534; padding: 4px 8px; border-radius: 4px; font-size: 12px;">PRODUCTION</span>
                        Local Backend Configuration
                    </h3>
                    <p style="color: #6b7280; margin-bottom: 16px; font-size: 14px;">
                        Production mode uses only local LLMs. Your data stays on your machine.
                    </p>
                    <div style="background: #f0fdf4; border: 1px solid #86efac; border-radius: 6px; padding: 16px; margin-bottom: 16px;">
                        <div style="margin-bottom: 12px;">
                            <label style="display: block; font-weight: 500; margin-bottom: 4px;">Local Backend:</label>
                            <select id="local-backend-select" onchange="setBackend('local')" style="width: 100%; padding: 8px; border-radius: 4px; border: 1px solid #86efac;">
                                <option value="">Loading...</option>
                            </select>
                            <div style="font-size: 12px; color: #166534; margin-top: 4px;">✓ Runs locally on your machine</div>
                        </div>
                        <div>
                            <label style="display: block; font-weight: 500; margin-bottom: 4px;">Local Model:</label>
                            <select id="local-model-select" onchange="setModel('local')" style="width: 100%; padding: 8px; border-radius: 4px; border: 1px solid #86efac;">
                                <option value="">Auto-select</option>
                            </select>
                            <div style="font-size: 12px; color: #6b7280; margin-top: 4px;">Leave as Auto-select to use first available model</div>
                        </div>
                    </div>
                </div>

                <!-- Backends Configuration Section -->
                <div id="backends-config-section" style="margin-top: 24px;">
                    <h3>Backend Providers</h3>
                    <p style="color: #6b7280; margin-bottom: 12px; font-size: 14px;">
                        Add or edit backends (Ollama, LM Studio, OpenRouter, Generic OpenAI, or CLI tools).
                        API keys are stored server-side and never shown in the UI.
                    </p>
                    <div style="display:flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px;">
                        <button class="btn btn-small" onclick="addBackendTemplate('ollama')">Add Ollama</button>
                        <button class="btn btn-small" onclick="addBackendTemplate('lmstudio')">Add LM Studio</button>
                        <button class="btn btn-small" onclick="addBackendTemplate('openrouter')">Add OpenRouter</button>
                        <button class="btn btn-small" onclick="addBackendTemplate('generic')">Add Generic</button>
                        <button class="btn btn-small" onclick="addBackendTemplate('opencode')" style="background: #dbeafe; border-color: #93c5fd; color: #1e40af;">Add OpenCode CLI</button>
                        <button class="btn btn-small" onclick="addBackendTemplate('copilot')" style="background: #dcfce7; border-color: #86efac; color: #166534;">Add Copilot CLI</button>
                    </div>
                    <div id="backends-config-content">
                        <div class="loading">Loading backends configuration...</div>
                    </div>
                    <button class="btn btn-small" onclick="saveBackendsConfig()" style="margin-top: 8px;">Save Backends</button>
                </div>
                
                <!-- Testing Settings Section -->
                <div id="testing-section" style="margin-top: 24px;">
                    <h3 style="display: flex; align-items: center; gap: 8px;">
                        <span style="background: #fef3c7; color: #92400e; padding: 4px 8px; border-radius: 4px; font-size: 12px;">TESTING</span>
                        SOTA Backend Configuration
                    </h3>
                    <p style="color: #6b7280; margin-bottom: 16px; font-size: 14px;">
                        Testing mode enables a State-Of-The-Art backend for evaluation and comparison.
                        <strong style="color: #dc2626;">Data may be sent to external services.</strong>
                    </p>
                    
                    <!-- Testing Mode Toggle -->
                    <div id="testing-toggle-section" style="background: #fef3c7; border: 1px solid #fcd34d; border-radius: 6px; padding: 16px; margin-bottom: 16px;">
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <div>
                                <div style="font-weight: 600; color: #92400e;">Enable Testing Mode</div>
                                <div style="font-size: 12px; color: #a16207;">Enables SOTA backend for llm_chat with role=sota</div>
                            </div>
                            <label id="testing-toggle" style="position: relative; display: inline-block; width: 50px; height: 26px; cursor: pointer;">
                                <input type="checkbox" id="testing-enabled" onchange="toggleTestingMode(this.checked)" style="opacity: 0; width: 0; height: 0;">
                                <span style="position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #d1d5db; transition: 0.3s; border-radius: 13px;"></span>
                                <span id="toggle-slider" style="position: absolute; content: ''; height: 20px; width: 20px; left: 3px; bottom: 3px; background-color: white; transition: 0.3s; border-radius: 50%;"></span>
                            </label>
                        </div>
                    </div>
                    
                    <!-- SOTA Configuration (hidden when testing disabled) -->
                    <div id="sota-config-section" style="background: #fffbeb; border: 1px solid #fcd34d; border-radius: 6px; padding: 16px; display: none;">
                        <div style="margin-bottom: 16px;">
                            <label style="display: block; font-weight: 500; margin-bottom: 4px;">SOTA Backend Type:</label>
                            <select id="sota-type-select" onchange="onSotaTypeChange()" style="width: 100%; padding: 8px; border-radius: 4px; border: 1px solid #fcd34d;">
                                <option value="local">Use Local Backend as SOTA</option>
                                <option value="openrouter">OpenRouter (External API)</option>
                            </select>
                            <div style="font-size: 12px; color: #6b7280; margin-top: 4px;">Choose how to provide SOTA capabilities</div>
                        </div>
                        
                        <!-- OpenRouter Config (shown when openrouter selected) -->
                        <div id="openrouter-config" style="display: none; margin-bottom: 16px; padding: 12px; background: #fef2f2; border: 1px solid #fecaca; border-radius: 4px;">
                            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
                                <span style="color: #dc2626;">⚠</span>
                                <span style="color: #dc2626; font-weight: 500;">External API - Data sent to OpenRouter</span>
                            </div>
                            <label style="display: block; font-weight: 500; margin-bottom: 4px;">OpenRouter API Key:</label>
                            <div style="display: flex; gap: 8px; margin-bottom: 8px;">
                                <input type="password" id="openrouter-api-key" placeholder="sk-or-..." style="flex: 1; padding: 8px; border-radius: 4px; border: 1px solid #fecaca;" onchange="onOpenRouterApiKeyChange()">
                                <button class="btn" onclick="toggleApiKeyVisibility()" style="padding: 8px 12px;">👁</button>
                            </div>
                            <div style="font-size: 12px; color: #6b7280; margin-bottom: 12px;">
                                Get your API key from <a href="https://openrouter.ai/" target="_blank" style="color: #2563eb;">openrouter.ai</a>
                            </div>
                            
                            <!-- OpenRouter Model Selection -->
                            <div id="openrouter-model-section" style="margin-top: 12px; padding-top: 12px; border-top: 1px solid #fecaca;">
                                <label style="display: block; font-weight: 500; margin-bottom: 4px;">OpenRouter Model:</label>
                                <div style="display: flex; gap: 8px;">
                                    <select id="openrouter-model-select" style="flex: 1; padding: 8px; border-radius: 4px; border: 1px solid #fecaca;">
                                        <option value="">Enter API key to load models...</option>
                                    </select>
                                    <button class="btn btn-small" onclick="loadOpenRouterModels()" id="load-openrouter-models-btn" style="padding: 8px 12px;">🔄</button>
                                </div>
                                <div id="openrouter-model-status" style="font-size: 12px; color: #6b7280; margin-top: 4px;"></div>
                            </div>
                            
                            <!-- Popular OpenRouter Models Quick Select -->
                            <div style="margin-top: 12px;">
                                <label style="display: block; font-size: 12px; color: #6b7280; margin-bottom: 4px;">Popular Models:</label>
                                <div style="display: flex; flex-wrap: wrap; gap: 4px;">
                                    <button class="btn-small" onclick="selectOpenRouterModel('anthropic/claude-3-opus')" style="font-size: 11px; padding: 4px 8px;">Claude 3 Opus</button>
                                    <button class="btn-small" onclick="selectOpenRouterModel('anthropic/claude-3-sonnet')" style="font-size: 11px; padding: 4px 8px;">Claude 3 Sonnet</button>
                                    <button class="btn-small" onclick="selectOpenRouterModel('openai/gpt-4-turbo')" style="font-size: 11px; padding: 4px 8px;">GPT-4 Turbo</button>
                                    <button class="btn-small" onclick="selectOpenRouterModel('google/gemini-pro')" style="font-size: 11px; padding: 4px 8px;">Gemini Pro</button>
                                    <button class="btn-small" onclick="selectOpenRouterModel('meta-llama/llama-3-70b-instruct')" style="font-size: 11px; padding: 4px 8px;">Llama 3 70B</button>
                                </div>
                            </div>
                        </div>
                        
                        <!-- Local SOTA Config (shown when local selected) -->
                        <div id="local-sota-config">
                            <div style="margin-bottom: 12px;">
                                <label style="display: block; font-weight: 500; margin-bottom: 4px;">SOTA Backend:</label>
                                <select id="sota-backend-select" onchange="setBackend('sota')" style="width: 100%; padding: 8px; border-radius: 4px; border: 1px solid #fcd34d;">
                                    <option value="">Loading...</option>
                                </select>
                            </div>
                            
                            <div style="margin-bottom: 12px;">
                                <label style="display: block; font-weight: 500; margin-bottom: 4px;">SOTA Model:</label>
                                <select id="sota-model-select" onchange="setModel('sota')" style="width: 100%; padding: 8px; border-radius: 4px; border: 1px solid #fcd34d;">
                                    <option value="">Auto-select</option>
                                </select>
                            </div>
                        </div>
                        
                        <button class="btn" onclick="saveTestingConfig()" style="width: 100%; margin-top: 8px;">Save Testing Configuration</button>
                    </div>
                </div>

                <!-- CLI Orchestration Section -->
                <div id="cli-orchestration-section" style="margin-top: 24px;">
                    <h3 style="display: flex; align-items: center; gap: 8px;">
                        <span style="background: #dbeafe; color: #1e40af; padding: 4px 8px; border-radius: 4px; font-size: 12px;">CLI</span>
                        CLI Orchestration Mode
                    </h3>
                    <p style="color: #6b7280; margin-bottom: 16px; font-size: 14px;">
                        Enable CLI orchestration for complex multi-step tasks using OpenCode CLI and GitHub Copilot CLI.
                        The local LLM will decompose tasks, execute them via CLI tools, and verify completion with scoring.
                    </p>
                    
                    <!-- CLI Orchestration Toggle -->
                    <div id="cli-orchestration-toggle-section" style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 6px; padding: 16px; margin-bottom: 16px;">
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <div>
                                <div style="font-weight: 600; color: #1e40af;">Enable CLI Orchestration</div>
                                <div style="font-size: 12px; color: #3b82f6;">Use CLI tools for complex multi-step tasks</div>
                            </div>
                            <label id="cli-orchestration-toggle" style="position: relative; display: inline-block; width: 50px; height: 26px; cursor: pointer;">
                                <input type="checkbox" id="cli-orchestration-enabled" onchange="toggleCliOrchestration(this.checked)" style="opacity: 0; width: 0; height: 0;">
                                <span id="cli-orchestration-track" style="position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #d1d5db; transition: 0.3s; border-radius: 13px;"></span>
                                <span id="cli-orchestration-slider" style="position: absolute; content: ''; height: 20px; width: 20px; left: 3px; bottom: 3px; background-color: white; transition: 0.3s; border-radius: 50%;"></span>
                            </label>
                        </div>
                    </div>
                    
                    <!-- CLI Orchestration Configuration (hidden when disabled) -->
                    <div id="cli-orchestration-config" style="background: #f0f9ff; border: 1px solid #bfdbfe; border-radius: 6px; padding: 16px; display: none;">
                        <!-- Backend Selection -->
                        <div style="margin-bottom: 16px;">
                            <label style="display: block; font-weight: 500; margin-bottom: 8px;">Available CLI Backends:</label>
                            <div id="cli-backends-list" style="display: flex; flex-direction: column; gap: 8px;">
                                <div style="padding: 12px; background: white; border-radius: 4px; border: 1px solid #bfdbfe;">
                                    <label style="display: flex; align-items: center; gap: 8px;">
                                        <input type="checkbox" id="backend-opencode" value="opencode-cli" onchange="updateCliOrchestrationBackends('backend-opencode')">
                                        <span style="font-weight: 500;">OpenCode CLI</span>
                                        <span id="opencode-status" style="margin-left: auto; font-size: 12px; color: #6b7280;">Not configured</span>
                                    </label>
                                    <div id="opencode-model-section" style="margin-top: 8px; margin-left: 24px; display: none;">
                                        <label style="display: block; font-size: 12px; color: #4b5563; margin-bottom: 4px;">Model:</label>
                                        <select id="opencode-model-select" onchange="updateCliOrchestrationSettings()" style="width: 100%; padding: 6px; border-radius: 4px; border: 1px solid #bfdbfe; font-size: 12px;">
                                            <option value="">Loading models...</option>
                                        </select>
                                        <button onclick="refreshCliModels('opencode-cli')" style="margin-top: 4px; padding: 4px 8px; font-size: 11px; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 4px; cursor: pointer;">🔄 Refresh</button>
                                    </div>
                                </div>
                                <div style="padding: 12px; background: white; border-radius: 4px; border: 1px solid #bfdbfe;">
                                    <label style="display: flex; align-items: center; gap: 8px;">
                                        <input type="checkbox" id="backend-copilot" value="copilot-cli" onchange="updateCliOrchestrationBackends('backend-copilot')">
                                        <span style="font-weight: 500;">GitHub Copilot CLI</span>
                                        <span id="copilot-status" style="margin-left: auto; font-size: 12px; color: #6b7280;">Not installed</span>
                                    </label>
                                    <div id="copilot-model-section" style="margin-top: 8px; margin-left: 24px; display: none;">
                                        <label style="display: block; font-size: 12px; color: #4b5563; margin-bottom: 4px;">Model:</label>
                                        <select id="copilot-model-select" onchange="updateCliOrchestrationSettings()" style="width: 100%; padding: 6px; border-radius: 4px; border: 1px solid #bfdbfe; font-size: 12px;">
                                            <option value="">Loading models...</option>
                                        </select>
                                        <button onclick="refreshCliModels('copilot-cli')" style="margin-top: 4px; padding: 4px 8px; font-size: 11px; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 4px; cursor: pointer;">🔄 Refresh</button>
                                    </div>
                                </div>
                            </div>
                        </div>
                        
                        <!-- Execution Flow Explanation -->
                        <div style="margin-bottom: 16px; padding: 12px; background: #f0fdf4; border: 1px solid #86efac; border-radius: 6px;">
                            <div style="font-weight: 600; color: #166534; margin-bottom: 8px;">🔄 How CLI Orchestration Works:</div>
                            <div style="font-size: 12px; color: #166534; line-height: 1.6;">
                                <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
                                    <span style="background: #dcfce7; padding: 2px 6px; border-radius: 4px;">1. 🧠 LM Studio</span>
                                    <span>→ Decomposes task into steps (planning only, ~50 tokens)</span>
                                </div>
                                <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
                                    <span style="background: #dcfce7; padding: 2px 6px; border-radius: 4px;">2. 🚀 CLI Tool</span>
                                    <span>→ <strong>Executes each step</strong> (OpenCode with FREE model)</span>
                                </div>
                                <div style="display: flex; align-items: center; gap: 8px;">
                                    <span style="background: #dcfce7; padding: 2px 6px; border-radius: 4px;">3. ✅ LM Studio</span>
                                    <span>→ Verifies completion (quick yes/no, ~20 tokens)</span>
                                </div>
                            </div>
                        </div>
                        
                        <!-- Auto-verify Toggle -->
                        <div style="margin-bottom: 16px;">
                            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                                <input type="checkbox" id="cli-auto-verify" onchange="updateCliOrchestrationSettings()" checked>
                                <span style="font-weight: 500;">Auto-verify CLI results</span>
                            </label>
                            <div style="font-size: 12px; color: #6b7280; margin-top: 4px; margin-left: 24px;">
                                After CLI execution, automatically request verification from the CLI tool
                            </div>
                        </div>
                        
                        <!-- Score Threshold -->
                        <div style="margin-bottom: 16px;">
                            <label style="display: block; font-weight: 500; margin-bottom: 4px;">Minimum Score Threshold:</label>
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <input type="number" id="cli-score-threshold" min="1" max="10" value="7" onchange="updateCliOrchestrationSettings()" style="width: 60px; padding: 8px; border-radius: 4px; border: 1px solid #bfdbfe;">
                                <span style="color: #6b7280;">/ 10</span>
                            </div>
                            <div style="font-size: 12px; color: #6b7280; margin-top: 4px;">
                                Scores below this threshold will trigger plan updates and retries
                            </div>
                        </div>
                        
                        <!-- Max Iterations -->
                        <div style="margin-bottom: 16px;">
                            <label style="display: block; font-weight: 500; margin-bottom: 4px;">Maximum Iterations:</label>
                            <input type="number" id="cli-max-iterations" min="1" max="10" value="3" onchange="updateCliOrchestrationSettings()" style="width: 60px; padding: 8px; border-radius: 4px; border: 1px solid #bfdbfe;">
                            <div style="font-size: 12px; color: #6b7280; margin-top: 4px;">
                                Maximum number of retry attempts before marking a task as failed
                            </div>
                        </div>
                        
                        <button class="btn" onclick="saveCliOrchestrationSettings()" style="width: 100%;">Save CLI Orchestration Settings</button>
                    </div>
                </div>

                <!-- External MCP Servers Section -->
                <div id="mcp-servers-section" style="margin-top: 24px;">
                    <h3>External MCP Servers</h3>
                    <p style="color: #6b7280; margin-bottom: 12px; font-size: 14px;">
                        Configure additional MCP servers (client mode). Changes apply immediately to the MCP tools.
                    </p>
                    <div id="mcp-servers-content">
                        <div class="loading">Loading MCP servers...</div>
                    </div>
                    <button class="btn btn-small" onclick="addMcpServerRow()" style="margin-top: 8px;">Add MCP Server</button>
                    <button class="btn btn-small" onclick="saveMcpServers()" style="margin-top: 8px; margin-left: 6px;">Save MCP Servers</button>
                </div>
                
                <div style="margin-top: 24px;">
                    <h3>Available Backends</h3>
                    <div id="backends-content">
                        <div class="loading">Loading backends...</div>
                    </div>
                </div>
            </div>
            
            <div class="tab-content" id="governance">
                <h3>Tool Governance</h3>
                <p style="color: #6b7280; margin-bottom: 20px;">Control which tools are available to the LLM. Use predefined modes or configure individual tool groups.</p>
                
                <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 16px; margin-bottom: 16px;">
                    <label style="display: block; font-weight: 500; margin-bottom: 8px;">Access Mode:</label>
                    <select id="tool-mode-select" onchange="setToolMode()" style="width: 100%; padding: 10px; border-radius: 4px; border: 1px solid #d1d5db; font-size: 14px;">
                        <option value="">Loading...</option>
                    </select>
                    <div id="mode-description" style="font-size: 12px; color: #6b7280; margin-top: 8px;"></div>
                </div>
                
                <div style="background: #f0fdf4; border: 1px solid #86efac; border-radius: 6px; padding: 16px; margin-bottom: 16px;">
                    <h4 style="margin: 0 0 8px 0; color: #166534;">Currently Enabled Tools</h4>
                    <div id="enabled-tools-list" style="display: flex; flex-wrap: wrap; gap: 6px;">
                        <span style="color: #6b7280;">Loading...</span>
                    </div>
                </div>
                
                <div style="margin-bottom: 16px;">
                    <h4 style="margin-bottom: 12px;">Tool Groups</h4>
                    <div id="tool-groups-list">
                        <div class="loading">Loading tool groups...</div>
                    </div>
                </div>
                
                <div style="display: flex; gap: 12px; margin-top: 20px;">
                    <button class="btn" onclick="loadToolGroups()">Refresh</button>
                    <button class="btn btn-secondary" onclick="resetToDefault()">Reset to Default</button>
                </div>
            </div>
            
            <div class="tab-content" id="tool-orchestration">
                <h3>Per-Tool Orchestration Settings</h3>
                <p style="color: #6b7280; margin-bottom: 20px;">
                    Configure which tools use CLI Orchestration (OpenCode/Copilot CLI) vs Direct LLM calls.
                    <br><strong>Default:</strong> All tools use Orchestration mode with fallback to Direct LLM.
                </p>
                
                <!-- Orchestration Status Banner -->
                <div id="orch-status-banner" style="padding: 12px 16px; border-radius: 6px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center; background: #f9fafb; border: 1px solid #e5e7eb;">
                    <div>
                        <span id="orch-status-icon" style="font-size: 20px; margin-right: 8px;"></span>
                        <span id="orch-status-text" style="font-weight: 600;"></span>
                        <span id="orch-backends-text" style="color: #6b7280; margin-left: 8px;"></span>
                    </div>
                    <button class="btn btn-small" onclick="loadToolOrchestration()">Refresh</button>
                </div>
                
                <!-- Global Settings -->
                <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 16px; margin-bottom: 20px;">
                    <h4 style="margin: 0 0 12px 0;">Global Defaults</h4>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
                        <label style="display: flex; align-items: center; gap: 8px;">
                            <input type="checkbox" id="global-orch-enabled" checked onchange="updateGlobalOrchSettings()">
                            <span>Enable Orchestration by Default</span>
                        </label>
                        <label style="display: flex; align-items: center; gap: 8px;">
                            <input type="checkbox" id="global-fallback" checked onchange="updateGlobalOrchSettings()">
                            <span>Fallback to Direct LLM</span>
                        </label>
                        <label style="display: flex; align-items: center; gap: 8px;">
                            <input type="checkbox" id="global-quick-mode" onchange="updateGlobalOrchSettings()">
                            <span>Quick Mode (Skip Verification)</span>
                        </label>
                        <div>
                            <label style="font-weight: 500; margin-bottom: 4px; display: block;">Preferred Backend:</label>
                            <select id="global-backend" onchange="updateGlobalOrchSettings()" style="padding: 6px; border-radius: 4px; border: 1px solid #d1d5db;">
                                <option value="auto">Auto (Best Available)</option>
                                <option value="opencode">OpenCode CLI</option>
                                <option value="copilot">GitHub Copilot CLI</option>
                                <option value="local">Direct LLM Only</option>
                            </select>
                        </div>
                    </div>
                </div>
                
                <!-- Bulk Actions by Category -->
                <div style="background: #f0fdf4; border: 1px solid #86efac; border-radius: 6px; padding: 16px; margin-bottom: 20px;">
                    <h4 style="margin: 0 0 12px 0; color: #166534;">Bulk Configure by Category</h4>
                    <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px;">
                        <select id="bulk-category" style="padding: 8px; border-radius: 4px; border: 1px solid #d1d5db;">
                            <option value="">Select Category...</option>
                            <option value="code-generation">Code Generation</option>
                            <option value="code-analysis">Code Analysis</option>
                            <option value="code-editing">Code Editing</option>
                            <option value="code-assistance">Code Assistance</option>
                            <option value="summarization">Summarization</option>
                            <option value="planning">Planning</option>
                            <option value="search">Search</option>
                        </select>
                        <button class="btn btn-small" onclick="bulkEnableOrchestration()">Enable Orchestration</button>
                        <button class="btn btn-small btn-secondary" onclick="bulkDisableOrchestration()">Use Direct LLM</button>
                    </div>
                </div>
                
                <!-- Per-Tool Configuration Grid -->
                <h4>Individual Tool Configuration</h4>
                <div id="tool-orch-grid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px;">
                    <div class="loading">Loading tool orchestration settings...</div>
                </div>
                
                <!-- Reset Button -->
                <div style="display: flex; gap: 12px; margin-top: 20px;">
                    <button class="btn" onclick="loadToolOrchestration()">Refresh</button>
                    <button class="btn btn-secondary" onclick="resetAllToolOrchestration()">Reset All to Defaults</button>
                </div>
            </div>
            
            <div class="tab-content" id="tool-tester">
                <h3>Tool Tester</h3>
                <p style="color: #6b7280; margin-bottom: 16px;">Test MCP tools directly. Select a tool, configure parameters, and execute.</p>
                
                <div style="display: grid; grid-template-columns: 300px 1fr; gap: 20px; min-height: 600px;">
                    <!-- Tool List Sidebar -->
                    <div style="border: 1px solid #e5e7eb; border-radius: 6px; overflow: hidden;">
                        <div style="background: #f9fafb; padding: 12px; border-bottom: 1px solid #e5e7eb;">
                            <input type="text" id="tool-search" placeholder="Search tools..." 
                                   oninput="filterToolList()"
                                   style="width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 13px;">
                            <div style="margin-top: 8px; display: flex; gap: 4px; flex-wrap: wrap;">
                                <button class="btn-small" onclick="filterByTier('all')" data-tier="all" style="font-size: 10px; padding: 4px 8px;">All</button>
                                <button class="btn-small" onclick="filterByTier('core')" data-tier="core" style="font-size: 10px; padding: 4px 8px;">Core</button>
                                <button class="btn-small" onclick="filterByTier('discoverable')" data-tier="discoverable" style="font-size: 10px; padding: 4px 8px;">Discover</button>
                                <button class="btn-small" onclick="filterByTier('agent-only')" data-tier="agent-only" style="font-size: 10px; padding: 4px 8px;">Agent</button>
                            </div>
                        </div>
                        <div id="tool-list" style="max-height: 500px; overflow-y: auto;">
                            <div class="loading" style="padding: 20px;">Loading tools...</div>
                        </div>
                    </div>
                    
                    <!-- Tool Configuration Panel -->
                    <div style="border: 1px solid #e5e7eb; border-radius: 6px; overflow: hidden; display: flex; flex-direction: column;">
                        <div id="tool-config-header" style="background: #f9fafb; padding: 12px; border-bottom: 1px solid #e5e7eb;">
                            <div style="font-weight: 600; font-size: 16px;" id="selected-tool-name">Select a tool</div>
                            <div style="font-size: 12px; color: #6b7280; margin-top: 4px;" id="selected-tool-description">Choose a tool from the list to configure and test</div>
                        </div>
                        
                        <div id="tool-params-container" style="flex: 1; padding: 16px; overflow-y: auto; background: white;">
                            <div style="text-align: center; color: #6b7280; padding: 40px;">
                                Select a tool to configure parameters
                            </div>
                        </div>
                        
                        <div style="background: #f9fafb; padding: 12px; border-top: 1px solid #e5e7eb; display: flex; gap: 8px; align-items: center;">
                            <button class="btn" id="execute-tool-btn" onclick="executeTool()" disabled>Execute Tool</button>
                            <button class="btn btn-secondary" id="cancel-tool-btn" onclick="cancelToolExecution()" style="display: none;">Cancel</button>
                            <label style="display: flex; align-items: center; gap: 6px; font-size: 12px; margin-left: auto;">
                                <input type="checkbox" id="stream-progress" checked>
                                Stream Progress
                            </label>
                        </div>
                    </div>
                </div>
                
                <!-- Execution Result Panel -->
                <div id="execution-result-panel" style="margin-top: 20px; display: none;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                        <h4 style="margin: 0;">Execution Result</h4>
                        <div style="display: flex; gap: 8px; align-items: center;">
                            <span id="execution-status" style="font-size: 12px;"></span>
                            <span id="execution-duration" style="font-size: 12px; color: #6b7280;"></span>
                            <button class="btn-small" onclick="clearExecutionResult()">Clear</button>
                            <button class="btn-small" onclick="copyExecutionResult()">Copy</button>
                        </div>
                    </div>
                    
                    <!-- Progress Events -->
                    <div id="progress-events" style="display: none; margin-bottom: 12px; background: #fef3c7; border: 1px solid #fcd34d; border-radius: 6px; padding: 12px; max-height: 200px; overflow-y: auto;">
                        <div style="font-weight: 500; font-size: 12px; color: #92400e; margin-bottom: 8px;">Progress Events:</div>
                        <div id="progress-events-list" style="font-family: monospace; font-size: 11px;"></div>
                    </div>
                    
                    <!-- Result Output -->
                    <div style="background: #1f2937; border-radius: 6px; overflow: hidden;">
                        <div style="background: #374151; padding: 8px 12px; display: flex; justify-content: space-between; align-items: center;">
                            <span style="color: #9ca3af; font-size: 12px;">Response</span>
                            <div style="display: flex; gap: 8px;">
                                <button class="btn-small" onclick="toggleResultView('json')" id="view-json-btn" style="font-size: 10px;">JSON</button>
                                <button class="btn-small" onclick="toggleResultView('text')" id="view-text-btn" style="font-size: 10px;">Text</button>
                            </div>
                        </div>
                        <pre id="execution-output" style="margin: 0; padding: 16px; color: #f3f4f6; font-size: 12px; max-height: 400px; overflow: auto; white-space: pre-wrap; word-break: break-word;"></pre>
                    </div>
                </div>
            </div>
            
            <div class="tab-content" id="models">
                <h3>Model Capabilities</h3>
                <p style="color: #6b7280; margin-bottom: 16px;">Analyze and understand the capabilities of your local LLM models.</p>
                
                <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 16px; margin-bottom: 20px;">
                    <h4 style="margin: 0 0 12px 0;">Quick Model Analysis</h4>
                    <div style="display: flex; gap: 12px;">
                        <input type="text" id="quick-model-name" placeholder="Enter model name (e.g., codellama-7b)" 
                               style="flex: 1; padding: 8px; border: 1px solid #d1d5db; border-radius: 4px;">
                        <button class="btn" onclick="quickAnalyzeModel()">Analyze</button>
                    </div>
                    <div id="quick-analysis-result" style="margin-top: 12px; display: none;"></div>
                </div>
                
                <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 16px; margin-bottom: 20px;">
                    <h4 style="margin: 0 0 12px 0;">Task Suitability Check</h4>
                    <div style="display: flex; gap: 12px; flex-wrap: wrap;">
                        <input type="text" id="task-model-name" placeholder="Model name" 
                               style="flex: 1; min-width: 150px; padding: 8px; border: 1px solid #d1d5db; border-radius: 4px;">
                        <select id="task-type-select" style="padding: 8px; border: 1px solid #d1d5db; border-radius: 4px;">
                            <option value="code generation">Code Generation</option>
                            <option value="summarization">Summarization</option>
                            <option value="code review">Code Review</option>
                            <option value="refactoring">Refactoring</option>
                            <option value="documentation">Documentation</option>
                            <option value="debugging">Debugging</option>
                            <option value="architecture">Architecture</option>
                            <option value="security analysis">Security Analysis</option>
                        </select>
                        <button class="btn" onclick="checkTaskSuitability()">Check</button>
                    </div>
                    <div id="task-suitability-result" style="margin-top: 12px; display: none;"></div>
                </div>
                
                <div>
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                        <h4 style="margin: 0;">Available Models</h4>
                        <button class="btn btn-secondary" onclick="loadModelCapabilities()">Refresh</button>
                    </div>
                    <div id="models-list">
                        <div class="loading">Loading models...</div>
                    </div>
                </div>
            </div>
            
            <div class="tab-content" id="scenarios">
                <h3>Test Scenarios</h3>
                
                <div id="scenario-result" style="display: none; margin-bottom: 20px; padding: 16px; border-radius: 6px; background: #f3f4f6;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                        <strong id="result-title">Scenario Result</strong>
                        <button onclick="document.getElementById('scenario-result').style.display='none'" style="background: none; border: none; cursor: pointer; font-size: 18px; color: #6b7280;">&times;</button>
                    </div>
                    <div id="result-status" style="margin-bottom: 8px;"></div>
                    <div id="result-message" style="white-space: pre-wrap; font-family: monospace; font-size: 12px;"></div>
                </div>
                
                <div id="scenarios-content">
                    <div class="scenario-card">
                        <div class="scenario-title">Repository Summary (Compact)</div>
                        <div class="scenario-description">Generate a compact summary of the current repository using local LLM</div>
                        <button class="btn" id="btn-repo-summary-compact" onclick="runScenario('repo-summary-compact', this)">Run</button>
                    </div>
                    
                    <div class="scenario-card">
                        <div class="scenario-title">Repository Summary (Extended)</div>
                        <div class="scenario-description">Generate an extended summary of the current repository using local LLM</div>
                        <button class="btn" id="btn-repo-summary-extended" onclick="runScenario('repo-summary-extended', this)">Run</button>
                    </div>
                    
                    <div class="scenario-card">
                        <div class="scenario-title">Plan Verification</div>
                        <div class="scenario-description">Verify a multi-step plan using local LLM as reviewer</div>
                        <button class="btn" id="btn-verify-plan" onclick="runScenario('verify-plan', this)">Run</button>
                    </div>
                    
                    <div class="scenario-card">
                        <div class="scenario-title">SOTA vs Local Comparison</div>
                        <div class="scenario-description">Compare responses between SOTA and local LLM backends</div>
                        <button class="btn" id="btn-sota-vs-local" onclick="runScenario('sota-vs-local', this)">Run</button>
                    </div>
                </div>
            </div>
            
            <div class="tab-content" id="logs">
                <h3>Recent Logs</h3>
                <div id="logs-content">
                    <div class="loading">Loading logs...</div>
                </div>
            </div>
        </div>
    </div>

    <script>
        // Tab switching
        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const tabName = tab.dataset.tab;
                
                document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                
                tab.classList.add('active');
                document.getElementById(tabName).classList.add('active');
                
                // Load tab-specific content
                if (tabName === 'config') {
                    loadConfig();
                } else if (tabName === 'governance') {
                    loadToolGroups();
                } else if (tabName === 'tool-orchestration') {
                    loadToolOrchestration();
                } else if (tabName === 'tool-tester') {
                    loadToolTester();
                } else if (tabName === 'models') {
                    loadModelCapabilities();
                } else if (tabName === 'logs') {
                    const savedFilters = loadSavedFilters();
                    const filter = {};
                    if (savedFilters.level) filter.level = savedFilters.level;
                    if (savedFilters.category) filter.category = savedFilters.category;
                    loadLogs(filter);
                }
            });
        });
        
        // Keep the Testing (SOTA) section at the end of the Configuration tab
        (function moveTestingSectionToEnd() {
            const configTab = document.getElementById('config');
            const testingSection = document.getElementById('testing-section');
            if (configTab && testingSection) {
                configTab.appendChild(testingSection);
            }
        })();

        // Load initial data
        loadConfig();
        
        // Store current settings globally
        let currentSettings = null;
        let currentBackends = [];
        let currentBackendsConfig = [];
        
        async function loadConfig() {
            try {
                // Load settings first (includes testing mode state)
                const settingsResponse = await fetch('/api/settings');
                const settingsData = await settingsResponse.json();
                currentSettings = settingsData;
                
                // Load system profile
                const profileResponse = await fetch('/api/system-profile');
                const profileData = await profileResponse.json();
                renderSystemProfile(profileData);
                
                // Load config for defaults
                const configResponse = await fetch('/api/config');
                const configData = await configResponse.json();
                
                // Load backends
                const backendsResponse = await fetch('/api/backends');
                const backendsData = await backendsResponse.json();
                currentBackends = backendsData;
                
                // Render UI with all data
                renderModeBanner(settingsData);
                renderBackends(backendsData, configData.defaults, settingsData);
                updateTestingUI(settingsData);

                // Load CLI orchestration settings
                loadCliOrchestrationSettings();
            } catch (error) {
                console.error('Failed to load config:', error);
                document.getElementById('system-profile-content').innerHTML = 
                    '<div class="error">Failed to load system profile</div>';
                document.getElementById('backends-content').innerHTML = 
                    '<div class="error">Failed to load backends</div>';
            } finally {
                // Always load MCP servers section, even if other panels fail
                loadMcpServers();
                loadBackendsConfig();
            }
        }

        // ============================================
        // Backends Config UI Functions
        // ============================================
        async function loadBackendsConfig() {
            try {
                const resp = await fetch('/api/backends-config');
                const data = await resp.json();
                currentBackendsConfig = (data && data.backends) ? data.backends : [];
                renderBackendsConfig(currentBackendsConfig);
            } catch (error) {
                document.getElementById('backends-config-content').innerHTML =
                    '<div class="error">Failed to load backends configuration</div>';
            }
        }

        function renderBackendsConfig(backends) {
            const container = document.getElementById('backends-config-content');
            if (!backends || backends.length === 0) {
                container.innerHTML =
                    '<div style="color:#6b7280;font-size:13px;font-style:italic;">No backends configured.</div>';
                return;
            }

            let html = '';
            backends.forEach((b, idx) => {
                const hasKey = !!b.api_key && b.api_key === '********';
                html +=
                    '<div class="backend-card" data-backend-index="' + idx + '">' +
                      '<div class="backend-header">' +
                        '<div class="backend-name">' + b.id + ' <span style="font-size:12px;color:#6b7280;">(' + b.type + ')</span></div>' +
                        '<button class="btn-small" onclick="removeBackendRow(' + idx + ')">Remove</button>' +
                      '</div>' +
                      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
                        '<div>' +
                          '<label style="display:block;font-weight:500;margin-bottom:4px;">ID:</label>' +
                          '<input type="text" class="b-id" value="' + (b.id || '') + '" style="width:100%;padding:8px;border-radius:4px;border:1px solid #d1d5db;" />' +
                        '</div>' +
                        '<div>' +
                          '<label style="display:block;font-weight:500;margin-bottom:4px;">Type:</label>' +
                          '<select class="b-type" onchange="onBackendTypeChange(' + idx + ')" style="width:100%;padding:8px;border-radius:4px;border:1px solid #d1d5db;">' +
                            '<option value="ollama"' + (b.type === 'ollama' ? ' selected' : '') + '>ollama</option>' +
                            '<option value="lmstudio"' + (b.type === 'lmstudio' ? ' selected' : '') + '>lmstudio</option>' +
                            '<option value="openrouter"' + (b.type === 'openrouter' ? ' selected' : '') + '>openrouter</option>' +
                            '<option value="generic"' + (b.type === 'generic' ? ' selected' : '') + '>generic</option>' +
                            '<option value="opencode"' + (b.type === 'opencode' ? ' selected' : '') + '>opencode</option>' +
                            '<option value="copilot"' + (b.type === 'copilot' ? ' selected' : '') + '>copilot</option>' +
                          '</select>' +
                        '</div>' +
                      '</div>';
                      if (b.type === 'opencode') {
                        html +=
                          '<div style="margin-top:12px;padding:12px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;">' +
                            '<div style="font-weight:500;color:#1e40af;margin-bottom:8px;">OpenCode CLI Configuration</div>' +
                            '<div>' +
                              '<label style="display:block;font-weight:500;margin-bottom:4px;">Command:</label>' +
                              '<input type="text" class="b-command" value="' + (b.command || 'opencode') + '" style="width:100%;padding:8px;border-radius:4px;border:1px solid #93c5fd;" />' +
                            '</div>' +
                            '<div style="margin-top:8px;">' +
                              '<label style="display:block;font-weight:500;margin-bottom:4px;">Args Template:</label>' +
                              '<input type="text" class="b-args" value="' + (b.args_template || 'run --format json --model {model} {prompt}') + '" placeholder="run --format json --model {model} {prompt}" style="width:100%;padding:8px;border-radius:4px;border:1px solid #93c5fd;" />' +
                              '<div style="font-size:11px;color:#6b7280;margin-top:4px;">Use {prompt} for task, {model} for model name</div>' +
                            '</div>' +
                            '<div style="margin-top:8px;">' +
                              '<label style="display:block;font-weight:500;margin-bottom:4px;">Working Directory:</label>' +
                              '<input type="text" class="b-working-dir" value="' + (b.working_dir || '') + '" placeholder="Leave empty for current directory" style="width:100%;padding:8px;border-radius:4px;border:1px solid #93c5fd;" />' +
                            '</div>' +
                            '<div style="margin-top:8px;">' +
                              '<label style="display:block;font-weight:500;margin-bottom:4px;">Timeout (ms):</label>' +
                              '<input type="number" class="b-timeout" value="' + (b.timeout || 300000) + '" style="width:100%;padding:8px;border-radius:4px;border:1px solid #93c5fd;" />' +
                            '</div>' +
                            '<div style="margin-top:8px;">' +
                              '<label style="display:flex;align-items:center;gap:8px;">' +
                                '<input type="checkbox" class="b-auto-approve"' + (b.auto_approve !== false ? ' checked' : '') + ' style="width:16px;height:16px;" />' +
                                '<span>Auto-approve permissions</span>' +
                              '</label>' +
                            '</div>' +
                          '</div>';
                      } else if (b.type === 'copilot') {
                        html +=
                          '<div style="margin-top:12px;padding:12px;background:#dcfce7;border:1px solid #86efac;border-radius:6px;">' +
                            '<div style="font-weight:500;color:#166534;margin-bottom:8px;">GitHub Copilot CLI Configuration</div>' +
                            '<div>' +
                              '<label style="display:block;font-weight:500;margin-bottom:4px;">Command:</label>' +
                              '<input type="text" class="b-command" value="' + (b.command || 'copilot') + '" style="width:100%;padding:8px;border-radius:4px;border:1px solid #86efac;" />' +
                            '</div>' +
                            '<div style="margin-top:8px;">' +
                              '<label style="display:block;font-weight:500;margin-bottom:4px;">Args Template:</label>' +
                              '<input type="text" class="b-args" value="' + (b.args_template || '--model {model} -p {prompt} --allow-all --no-ask-user') + '" placeholder="--model {model} -p {prompt} --allow-all --no-ask-user" style="width:100%;padding:8px;border-radius:4px;border:1px solid #86efac;" />' +
                              '<div style="font-size:11px;color:#6b7280;margin-top:4px;">Use {prompt} for task, {model} for model name</div>' +
                            '</div>' +
                            '<div style="margin-top:8px;">' +
                              '<label style="display:block;font-weight:500;margin-bottom:4px;">Working Directory:</label>' +
                              '<input type="text" class="b-working-dir" value="' + (b.working_dir || '') + '" placeholder="Leave empty for current directory" style="width:100%;padding:8px;border-radius:4px;border:1px solid #86efac;" />' +
                            '</div>' +
                            '<div style="margin-top:8px;">' +
                              '<label style="display:block;font-weight:500;margin-bottom:4px;">Timeout (ms):</label>' +
                              '<input type="number" class="b-timeout" value="' + (b.timeout || 300000) + '" style="width:100%;padding:8px;border-radius:4px;border:1px solid #86efac;" />' +
                            '</div>' +
                            '<div style="margin-top:8px;">' +
                              '<label style="display:flex;align-items:center;gap:8px;">' +
                                '<input type="checkbox" class="b-auto-approve"' + (b.auto_approve !== false ? ' checked' : '') + ' style="width:16px;height:16px;" />' +
                                '<span>Auto-approve permissions</span>' +
                              '</label>' +
                            '</div>' +
                          '</div>';
                      } else {
                        html +=
                          '<div style="margin-top:8px;">' +
                            '<label style="display:block;font-weight:500;margin-bottom:4px;">Base URL:</label>' +
                            '<input type="text" class="b-url" value="' + (b.base_url || '') + '" placeholder="http://127.0.0.1:11434" style="width:100%;padding:8px;border-radius:4px;border:1px solid #d1d5db;" />' +
                          '</div>' +
                          '<div style="margin-top:8px;">' +
                            '<label style="display:block;font-weight:500;margin-bottom:4px;">API Key (optional):</label>' +
                            '<input type="password" class="b-key" value="" placeholder="' + (hasKey ? '******** (saved)' : '') + '" style="width:100%;padding:8px;border-radius:4px;border:1px solid #d1d5db;" />' +
                            '<div style="font-size:12px;color:#6b7280;margin-top:4px;">Leave blank to keep existing key (if any).</div>' +
                          '</div>';
                      }
                      html += '</div>';
            });
            container.innerHTML = html;
        }

        function addBackendTemplate(type) {
            const templates = {
                ollama: { id: 'ollama', type: 'ollama', base_url: 'http://127.0.0.1:11434' },
                lmstudio: { id: 'lmstudio', type: 'lmstudio', base_url: 'http://127.0.0.1:1234' },
                openrouter: { id: 'openrouter', type: 'openrouter', base_url: 'https://openrouter.ai/api' },
                generic: { id: 'generic', type: 'generic', base_url: 'http://127.0.0.1:3000' },
                opencode: {
                    id: 'opencode',
                    type: 'opencode',
                    command: 'opencode',
                    args_template: 'run --format json --model {model} {prompt}',
                    timeout: 300000,
                    auto_approve: true,
                    working_dir: ''
                },
                copilot: {
                    id: 'copilot',
                    type: 'copilot',
                    command: 'copilot',
                    args_template: '--model {model} -p {prompt} --allow-all --no-ask-user',
                    timeout: 300000,
                    auto_approve: true,
                    working_dir: ''
                }
            };
            const template = templates[type] || templates.generic;
            const newId = prompt('Backend ID', template.id);
            if (!newId) return;
            const newTemplate = { ...template, id: newId };
            currentBackendsConfig.push(newTemplate);
            renderBackendsConfig(currentBackendsConfig);
        }

        function removeBackendRow(idx) {
            if (!confirm('Remove backend?')) return;
            currentBackendsConfig.splice(idx, 1);
            renderBackendsConfig(currentBackendsConfig);
        }

        function onBackendTypeChange(idx) {
            const card = document.querySelector('#backends-config-content [data-backend-index="' + idx + '"]');
            if (!card) return;
            const type = card.querySelector('.b-type').value;
            
            if (type === 'opencode' || type === 'copilot') {
                renderBackendsConfig(currentBackendsConfig);
                return;
            }
            
            const urlEl = card.querySelector('.b-url');
            if (!urlEl.value) {
                urlEl.value =
                    type === 'ollama' ? 'http://127.0.0.1:11434' :
                    type === 'lmstudio' ? 'http://127.0.0.1:1234' :
                    type === 'openrouter' ? 'https://openrouter.ai/api' :
                    'http://127.0.0.1:3000';
            }
        }

        function collectBackendsConfigFromDom() {
            const result = [];
            document.querySelectorAll('#backends-config-content .backend-card').forEach(card => {
                const id = card.querySelector('.b-id').value.trim();
                const type = card.querySelector('.b-type').value;
                const backend = { id, type };

                if (type === 'opencode') {
                    const command = card.querySelector('.b-command')?.value?.trim() || 'opencode';
                    const argsTemplate = card.querySelector('.b-args')?.value?.trim() || 'run --format json --model {model} {prompt}';
                    const workingDir = card.querySelector('.b-working-dir')?.value?.trim();
                    const timeout = parseInt(card.querySelector('.b-timeout')?.value) || 300000;
                    const autoApprove = card.querySelector('.b-auto-approve')?.checked ?? true;

                    Object.assign(backend, {
                        command,
                        args_template: argsTemplate.split(' ').filter(a => a),
                        timeout,
                        auto_approve: autoApprove
                    });
                    if (workingDir) backend.working_dir = workingDir;
                } else if (type === 'copilot') {
                    const command = card.querySelector('.b-command')?.value?.trim() || 'copilot';
                    const argsTemplate = card.querySelector('.b-args')?.value?.trim() || '--model {model} -p {prompt} --allow-all --no-ask-user';
                    const workingDir = card.querySelector('.b-working-dir')?.value?.trim();
                    const timeout = parseInt(card.querySelector('.b-timeout')?.value) || 300000;
                    const autoApprove = card.querySelector('.b-auto-approve')?.checked ?? true;

                    Object.assign(backend, {
                        command,
                        args_template: argsTemplate.split(' ').filter(a => a),
                        timeout,
                        auto_approve: autoApprove
                    });
                    if (workingDir) backend.working_dir = workingDir;
                } else {
                    const base_url = card.querySelector('.b-url')?.value?.trim();
                    const apiKeyInput = card.querySelector('.b-key')?.value;
                    if (base_url) backend.base_url = base_url;
                    if (apiKeyInput && apiKeyInput.trim().length > 0) {
                        backend.api_key = apiKeyInput.trim();
                    } else {
                        backend.api_key = '********';
                    }
                }
                result.push(backend);
            });
            return result;
        }

        async function saveBackendsConfig() {
            try {
                const backends = collectBackendsConfigFromDom();
                const resp = await fetch('/api/backends-config', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ backends })
                });
                const data = await resp.json();
                if (resp.ok) {
                    alert('Backends saved to settings file (env.settings / env-automated-tests.settings)');
                    currentBackendsConfig = data.backends || backends;
                    renderBackendsConfig(currentBackendsConfig);
                    // refresh main config panels so selectors include new backends
                    loadConfig();
                } else {
                    alert('Failed to save backends: ' + (data.error || resp.statusText));
                }
            } catch (error) {
                alert('Failed to save backends: ' + error.message);
            }
        }
        
        function renderModeBanner(settingsData) {
            const banner = document.getElementById('mode-banner');
            const icon = document.getElementById('mode-icon');
            const text = document.getElementById('mode-text');
            const desc = document.getElementById('mode-description');
            
            const isTestingMode = settingsData.currentMode === 'testing';
            
            if (isTestingMode) {
                banner.style.background = '#fef3c7';
                banner.style.border = '1px solid #fcd34d';
                icon.textContent = '🧪';
                text.textContent = 'Testing Mode';
                text.style.color = '#92400e';
                desc.textContent = '- SOTA backend enabled for evaluation';
            } else {
                banner.style.background = '#dcfce7';
                banner.style.border = '1px solid #86efac';
                icon.textContent = '🔒';
                text.textContent = 'Production Mode';
                text.style.color = '#166534';
                desc.textContent = '- Local LLM only, data stays on your machine';
            }
        }
        
        function updateTestingUI(settingsData) {
            const isTestingMode = settingsData.settings.testing.enabled;
            const sotaType = settingsData.settings.testing.sotaBackendType || 'local';
            
            // Update toggle checkbox and slider
            const checkbox = document.getElementById('testing-enabled');
            const toggleSlider = document.getElementById('toggle-slider');
            const toggleBg = checkbox.nextElementSibling;
            
            checkbox.checked = isTestingMode;
            
            if (isTestingMode) {
                toggleBg.style.backgroundColor = '#f59e0b';
                toggleSlider.style.transform = 'translateX(24px)';
            } else {
                toggleBg.style.backgroundColor = '#d1d5db';
                toggleSlider.style.transform = 'translateX(0)';
            }
            
            // Show/hide SOTA config section
            const sotaConfigSection = document.getElementById('sota-config-section');
            sotaConfigSection.style.display = isTestingMode ? 'block' : 'none';
            
            // Update SOTA type selector
            const sotaTypeSelect = document.getElementById('sota-type-select');
            sotaTypeSelect.value = sotaType;
            
            // Show/hide OpenRouter config
            const openrouterConfig = document.getElementById('openrouter-config');
            const localSotaConfig = document.getElementById('local-sota-config');
            
            if (sotaType === 'openrouter') {
                openrouterConfig.style.display = 'block';
                localSotaConfig.style.display = 'none';
                // Mask the API key
                const apiKeyInput = document.getElementById('openrouter-api-key');
                if (settingsData.settings.testing.openRouterApiKey) {
                    apiKeyInput.placeholder = '••••••••••••••••';
                }
            } else {
                openrouterConfig.style.display = 'none';
                localSotaConfig.style.display = 'block';
            }
        }
        
        function onSotaTypeChange() {
            const sotaType = document.getElementById('sota-type-select').value;
            const openrouterConfig = document.getElementById('openrouter-config');
            const localSotaConfig = document.getElementById('local-sota-config');
            
            if (sotaType === 'openrouter') {
                openrouterConfig.style.display = 'block';
                localSotaConfig.style.display = 'none';
            } else {
                openrouterConfig.style.display = 'none';
                localSotaConfig.style.display = 'block';
            }
        }
        
        function toggleApiKeyVisibility() {
            const input = document.getElementById('openrouter-api-key');
            input.type = input.type === 'password' ? 'text' : 'password';
        }
        
        // OpenRouter-specific configuration storage
        let openRouterConfig = {
            apiKey: '',
            model: '',
            models: []
        };
        
        function onOpenRouterApiKeyChange() {
            const apiKey = document.getElementById('openrouter-api-key').value;
            openRouterConfig.apiKey = apiKey;
            
            // Update status message
            const statusEl = document.getElementById('openrouter-model-status');
            if (apiKey && apiKey.startsWith('sk-or-')) {
                statusEl.textContent = 'API key entered. Click 🔄 to load available models.';
                statusEl.style.color = '#166534';
            } else if (apiKey) {
                statusEl.textContent = 'API key should start with sk-or-...';
                statusEl.style.color = '#dc2626';
            } else {
                statusEl.textContent = '';
            }
        }
        
        async function loadOpenRouterModels() {
            const apiKey = document.getElementById('openrouter-api-key').value;
            const statusEl = document.getElementById('openrouter-model-status');
            const selectEl = document.getElementById('openrouter-model-select');
            
            if (!apiKey) {
                statusEl.textContent = 'Please enter an API key first';
                statusEl.style.color = '#dc2626';
                return;
            }
            
            statusEl.textContent = 'Loading models from OpenRouter...';
            statusEl.style.color = '#6b7280';
            
            try {
                const response = await fetch('/api/openrouter/models', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ apiKey })
                });
                
                const result = await response.json();
                
                if (response.ok && result.models) {
                    openRouterConfig.models = result.models;
                    
                    // Populate select dropdown
                    selectEl.innerHTML = '<option value="">Select a model...</option>';
                    result.models.forEach(model => {
                        const option = document.createElement('option');
                        option.value = model.id;
                        option.textContent = model.id + (model.context_length ? ' (' + model.context_length + ' ctx)' : '');
                        selectEl.appendChild(option);
                    });
                    
                    // Restore previously selected model if any
                    if (openRouterConfig.model) {
                        selectEl.value = openRouterConfig.model;
                    }
                    
                    statusEl.textContent = 'Loaded ' + result.models.length + ' models';
                    statusEl.style.color = '#166534';
                } else {
                    statusEl.textContent = result.error || 'Failed to load models';
                    statusEl.style.color = '#dc2626';
                }
            } catch (error) {
                statusEl.textContent = 'Error: ' + error.message;
                statusEl.style.color = '#dc2626';
            }
        }
        
        function selectOpenRouterModel(modelId) {
            const selectEl = document.getElementById('openrouter-model-select');
            
            // Check if model is in dropdown, if not add it
            let found = false;
            for (const opt of selectEl.options) {
                if (opt.value === modelId) {
                    found = true;
                    break;
                }
            }
            
            if (!found) {
                const option = document.createElement('option');
                option.value = modelId;
                option.textContent = modelId;
                selectEl.appendChild(option);
            }
            
            selectEl.value = modelId;
            openRouterConfig.model = modelId;
        }
        
        async function toggleTestingMode(enabled) {
            // Update toggle visuals immediately
            const toggleSlider = document.getElementById('toggle-slider');
            const toggleBg = document.getElementById('testing-enabled').nextElementSibling;
            
            if (enabled) {
                toggleBg.style.backgroundColor = '#f59e0b';
                toggleSlider.style.transform = 'translateX(24px)';
                document.getElementById('sota-config-section').style.display = 'block';
            } else {
                toggleBg.style.backgroundColor = '#d1d5db';
                toggleSlider.style.transform = 'translateX(0)';
                document.getElementById('sota-config-section').style.display = 'none';
                
                // Disable testing mode on server
                try {
                    const response = await fetch('/api/settings/testing/disable', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' }
                    });
                    
                    if (response.ok) {
                        loadConfig();
                    } else {
                        const result = await response.json();
                        alert('Failed to disable testing mode: ' + result.error);
                    }
                } catch (error) {
                    alert('Failed to disable testing mode: ' + error.message);
                }
            }
        }
        
        async function saveTestingConfig() {
            const sotaType = document.getElementById('sota-type-select').value;
            const apiKey = document.getElementById('openrouter-api-key').value;
            const openRouterModel = document.getElementById('openrouter-model-select').value;
            const sotaBackendId = document.getElementById('sota-backend-select').value;
            const sotaModel = document.getElementById('sota-model-select').value;
            
            try {
                const response = await fetch('/api/settings/testing/enable', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        sotaType,
                        openRouterApiKey: sotaType === 'openrouter' ? apiKey : undefined,
                        openRouterModel: sotaType === 'openrouter' ? openRouterModel : undefined,
                        sotaBackendId: sotaType === 'local' ? sotaBackendId : undefined,
                        sotaModel: sotaType === 'local' ? sotaModel : undefined
                    })
                });
                
                const result = await response.json();
                
                if (response.ok) {
                    alert('Testing configuration saved!\\n\\n' + result.message);
                    loadConfig();
                } else {
                    alert('Failed to save: ' + result.error);
                }
            } catch (error) {
                alert('Failed to save: ' + error.message);
            }
        }

        // ============================================
        // CLI Orchestration UI Functions
        // ============================================
        let cliOrchestrationSettings = null;

        async function loadCliOrchestrationSettings() {
            try {
                const response = await fetch('/api/settings/cli-orchestration');
                cliOrchestrationSettings = await response.json();
                renderCliOrchestrationSettings();
            } catch (error) {
                console.error('Failed to load CLI orchestration settings:', error);
            }
        }

        function renderCliOrchestrationSettings() {
            if (!cliOrchestrationSettings) return;

            const enabled = cliOrchestrationSettings.enabled;
            const configSection = document.getElementById('cli-orchestration-config');
            const toggle = document.getElementById('cli-orchestration-toggle');
            const slider = document.getElementById('cli-orchestration-slider');
            const track = document.getElementById('cli-orchestration-track');
            const enabledCheckbox = document.getElementById('cli-orchestration-enabled');

            // Update toggle state
            if (enabled) {
                toggle?.classList.add('active');
                slider?.classList.add('active');
                // QA_feedback_26012026: Update inline styles directly (higher specificity than CSS)
                if (track) track.style.backgroundColor = '#2563eb';
                if (slider) slider.style.transform = 'translateX(22px)';
                if (enabledCheckbox) enabledCheckbox.checked = true;
                if (configSection) configSection.style.display = 'block';
            } else {
                toggle?.classList.remove('active');
                slider?.classList.remove('active');
                // QA_feedback_26012026: Reset inline styles
                if (track) track.style.backgroundColor = '#d1d5db';
                if (slider) slider.style.transform = 'translateX(0)';
                if (enabledCheckbox) enabledCheckbox.checked = false;
                if (configSection) configSection.style.display = 'none';
            }

            // Update backend checkboxes
            const selectedBackends = cliOrchestrationSettings.backends || [];
            const opencodeCheckbox = document.getElementById('backend-opencode');
            const copilotCheckbox = document.getElementById('backend-copilot');

            if (opencodeCheckbox) {
                opencodeCheckbox.checked = selectedBackends.includes('opencode-cli');
            }
            if (copilotCheckbox) {
                copilotCheckbox.checked = selectedBackends.includes('copilot-cli');
            }

            // Show/hide model sections based on selected backends
            const opencodeModelSection = document.getElementById('opencode-model-section');
            const copilotModelSection = document.getElementById('copilot-model-section');

            if (opencodeModelSection) {
                if (selectedBackends.includes('opencode-cli')) {
                    opencodeModelSection.style.display = 'block';
                    loadCliModels('opencode-cli');
                } else {
                    opencodeModelSection.style.display = 'none';
                }
            }
            if (copilotModelSection) {
                if (selectedBackends.includes('copilot-cli')) {
                    copilotModelSection.style.display = 'block';
                    loadCliModels('copilot-cli');
                } else {
                    copilotModelSection.style.display = 'none';
                }
            }

            // Update other settings
            const autoVerifyCheckbox = document.getElementById('cli-auto-verify');
            const scoreThresholdInput = document.getElementById('cli-score-threshold');
            const maxIterationsInput = document.getElementById('cli-max-iterations');

            if (autoVerifyCheckbox) {
                autoVerifyCheckbox.checked = cliOrchestrationSettings.autoVerify !== false;
            }
            if (scoreThresholdInput) {
                scoreThresholdInput.value = String(cliOrchestrationSettings.scoreThreshold || 7);
            }
            if (maxIterationsInput) {
                maxIterationsInput.value = String(cliOrchestrationSettings.maxIterations || 3);
            }

            // Update backend availability status
            const opencodeStatus = document.getElementById('opencode-status');
            const copilotStatus = document.getElementById('copilot-status');

            if (opencodeStatus) {
                const opencodeBackend = cliOrchestrationSettings.availableBackends?.find(b => b.type === 'opencode');
                if (opencodeBackend) {
                    opencodeStatus.textContent = opencodeBackend.available ? 'Available' : (opencodeBackend.error || 'Not configured');
                    opencodeStatus.style.color = opencodeBackend.available ? '#166534' : '#dc2626';
                } else {
                    opencodeStatus.textContent = 'Not configured';
                    opencodeStatus.style.color = '#6b7280';
                }
            }
            if (copilotStatus) {
                const copilotBackend = cliOrchestrationSettings.availableBackends?.find(b => b.type === 'copilot');
                if (copilotBackend) {
                    copilotStatus.textContent = copilotBackend.available ? 'Available' : (copilotBackend.error || 'Not installed');
                    copilotStatus.style.color = copilotBackend.available ? '#166534' : '#dc2626';
                } else {
                    copilotStatus.textContent = 'Not configured';
                    copilotStatus.style.color = '#6b7280';
                }
            }
        }

        async function toggleCliOrchestration(enabled) {
            const toggle = document.getElementById('cli-orchestration-toggle');
            const slider = document.getElementById('cli-orchestration-slider');
            const track = document.getElementById('cli-orchestration-track');
            const configSection = document.getElementById('cli-orchestration-config');

            try {
                const endpoint = enabled ? '/api/settings/cli-orchestration/enable' : '/api/settings/cli-orchestration/disable';
                const response = await fetch(endpoint, { method: 'POST' });
                const result = await response.json();

                if (response.ok) {
                    if (enabled) {
                        toggle?.classList.add('active');
                        slider?.classList.add('active');
                        // QA_feedback_26012026: Update inline styles directly (higher specificity than CSS)
                        if (track) track.style.backgroundColor = '#2563eb';
                        if (slider) slider.style.transform = 'translateX(22px)';
                        if (configSection) configSection.style.display = 'block';
                    } else {
                        toggle?.classList.remove('active');
                        slider?.classList.remove('active');
                        // QA_feedback_26012026: Reset inline styles
                        if (track) track.style.backgroundColor = '#d1d5db';
                        if (slider) slider.style.transform = 'translateX(0)';
                        if (configSection) configSection.style.display = 'none';
                    }
                    if (cliOrchestrationSettings) cliOrchestrationSettings.enabled = enabled;
                } else {
                    // Revert toggle on failure
                    const checkbox = document.getElementById('cli-orchestration-enabled');
                    if (checkbox) checkbox.checked = !enabled;
                    alert('Failed to ' + (enabled ? 'enable' : 'disable') + ' CLI orchestration: ' + result.error);
                }
            } catch (error) {
                const checkbox = document.getElementById('cli-orchestration-enabled');
                if (checkbox) checkbox.checked = !enabled;
                alert('Failed to update CLI orchestration: ' + error.message);
            }
        }

        function updateCliOrchestrationBackends(sourceCheckboxId) {
            // Enforce mutual exclusivity - only one CLI backend can be active at a time
            // This is by design: CLI tools have different execution models and shouldn't run simultaneously
            const backends = [];
            const opencodeCheckbox = document.getElementById('backend-opencode');
            const copilotCheckbox = document.getElementById('backend-copilot');
            const opencodeModelSection = document.getElementById('opencode-model-section');
            const copilotModelSection = document.getElementById('copilot-model-section');

            // If opencode was just checked, uncheck copilot
            if (sourceCheckboxId === 'backend-opencode' && opencodeCheckbox?.checked && copilotCheckbox) {
                copilotCheckbox.checked = false;
            }
            // If copilot was just checked, uncheck opencode
            if (sourceCheckboxId === 'backend-copilot' && copilotCheckbox?.checked && opencodeCheckbox) {
                opencodeCheckbox.checked = false;
            }

            if (opencodeCheckbox?.checked) {
                backends.push('opencode-cli');
                if (opencodeModelSection) {
                    opencodeModelSection.style.display = 'block';
                    loadCliModels('opencode-cli');
                }
            } else if (opencodeModelSection) {
                opencodeModelSection.style.display = 'none';
            }

            if (copilotCheckbox?.checked) {
                backends.push('copilot-cli');
                if (copilotModelSection) {
                    copilotModelSection.style.display = 'block';
                    loadCliModels('copilot-cli');
                }
            } else if (copilotModelSection) {
                copilotModelSection.style.display = 'none';
            }

            if (cliOrchestrationSettings) cliOrchestrationSettings.backends = backends;
        }

        async function loadCliModels(backendId) {
            const selectId = backendId === 'opencode-cli' ? 'opencode-model-select' : 'copilot-model-select';
            const selectEl = document.getElementById(selectId);
            if (!selectEl) return;

            selectEl.innerHTML = '<option value="">Loading models...</option>';

            try {
                const response = await fetch('/api/backends/' + backendId + '/models');
                if (!response.ok) {
                    throw new Error('Backend not available');
                }
                const models = await response.json();
                
                selectEl.innerHTML = '<option value="">Auto-select (first available)</option>';
                models.forEach(model => {
                    const modelId = typeof model === 'string' ? model : (model.id || model.name);
                    const modelName = typeof model === 'string' ? model : (model.name || model.id);
                    const isFree = modelName.toLowerCase().includes('free');
                    const option = document.createElement('option');
                    option.value = modelId;
                    option.textContent = modelName + (isFree ? ' (FREE)' : '');
                    if (isFree) option.style.color = '#166534';
                    selectEl.appendChild(option);
                });
            } catch (error) {
                selectEl.innerHTML = '<option value="">Failed to load models</option>';
            }
        }

        async function refreshCliModels(backendId) {
            await loadCliModels(backendId);
        }

        function updateCliOrchestrationSettings() {
            const autoVerifyCheckbox = document.getElementById('cli-auto-verify');
            const scoreThresholdInput = document.getElementById('cli-score-threshold');
            const maxIterationsInput = document.getElementById('cli-max-iterations');

            if (cliOrchestrationSettings) {
                cliOrchestrationSettings.autoVerify = autoVerifyCheckbox?.checked ?? true;
                cliOrchestrationSettings.scoreThreshold = parseInt(scoreThresholdInput?.value || '7');
                cliOrchestrationSettings.maxIterations = parseInt(maxIterationsInput?.value || '3');
            }
        }

        async function saveCliOrchestrationSettings() {
            try {
                const response = await fetch('/api/settings/cli-orchestration', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        enabled: cliOrchestrationSettings?.enabled,
                        backends: cliOrchestrationSettings?.backends,
                        autoVerify: cliOrchestrationSettings?.autoVerify,
                        scoreThreshold: cliOrchestrationSettings?.scoreThreshold,
                        maxIterations: cliOrchestrationSettings?.maxIterations
                    })
                });

                const result = await response.json();

                if (response.ok) {
                    alert('CLI orchestration settings saved!');
                } else {
                    alert('Failed to save: ' + result.error);
                }
            } catch (error) {
                alert('Failed to save: ' + error.message);
            }
        }

        // ============================================
        // MCP Servers UI Functions
        // ============================================
        let currentMcpServers = {};

        async function loadMcpServers() {
            try {
                const response = await fetch('/api/mcp-servers');
                const data = await response.json();
                currentMcpServers = data || {};
                renderMcpServers(currentMcpServers);
            } catch (error) {
                document.getElementById('mcp-servers-content').innerHTML =
                    '<div class="error">Failed to load MCP servers</div>';
            }
        }

        function renderMcpServers(servers) {
            const container = document.getElementById('mcp-servers-content');
            const names = Object.keys(servers || {});

            if (names.length === 0) {
                container.innerHTML =
                    '<div style="color:#6b7280;font-size:13px;font-style:italic;">No external MCP servers configured.</div>';
                return;
            }

            let html = '';
            names.forEach((name) => {
                const s = servers[name] || {};
                const args = Array.isArray(s.args) ? s.args.join(' ') : '';
                const autoFalseSelected = s.autoConnect ? '' : ' selected';
                const autoTrueSelected = s.autoConnect ? ' selected' : '';
                html +=
                  '<div class="backend-card" data-mcp-name="' + name + '">' +
                    '<div class="backend-header">' +
                      '<div class="backend-name">' + name + '</div>' +
                      '<button class="btn-small" onclick="removeMcpServerRow(\\'' + name + '\\')">Remove</button>' +
                    '</div>' +
                    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
                      '<div>' +
                        '<label style="display:block;font-weight:500;margin-bottom:4px;">Command:</label>' +
                        '<input type="text" class="mcp-command" value="' + (s.command || '') + '" placeholder="npx" ' +
                          'style="width:100%;padding:8px;border-radius:4px;border:1px solid #d1d5db;" />' +
                      '</div>' +
                      '<div>' +
                        '<label style="display:block;font-weight:500;margin-bottom:4px;">Args (space separated):</label>' +
                        '<input type="text" class="mcp-args" value="' + args + '" placeholder="-y package@latest --isolated" ' +
                          'style="width:100%;padding:8px;border-radius:4px;border:1px solid #d1d5db;" />' +
                      '</div>' +
                    '</div>' +
                    '<div style="margin-top:8px;">' +
                      '<label style="display:block;font-weight:500;margin-bottom:4px;">Auto-connect:</label>' +
                      '<select class="mcp-autoconnect" style="padding:6px;border-radius:4px;border:1px solid #d1d5db;">' +
                        '<option value="false"' + autoFalseSelected + '>false</option>' +
                        '<option value="true"' + autoTrueSelected + '>true</option>' +
                      '</select>' +
                    '</div>' +
                    '<div style="margin-top:8px;">' +
                      '<label style="display:block;font-weight:500;margin-bottom:4px;">Description:</label>' +
                      '<input type="text" class="mcp-description" value="' + (s.description || '') + '" placeholder="Optional" ' +
                        'style="width:100%;padding:8px;border-radius:4px;border:1px solid #d1d5db;" />' +
                    '</div>' +
                  '</div>';
            });

            container.innerHTML = html;
        }

        function addMcpServerRow() {
            const name = prompt('Server name (e.g., chrome-devtools)');
            if (!name) return;
            if (currentMcpServers[name]) {
                const overwrite = confirm(
                    'Server "' + name + '" already exists. Overwrite it with a fresh template?\\n\\n' +
                    'Click OK to overwrite, Cancel to keep existing and jump to it.'
                );
                if (overwrite) {
                    const templateArgs =
                        name === 'chrome-devtools'
                            ? ['-y', 'chrome-devtools-mcp@latest', '--isolated']
                            : ['-y', name + '@latest'];
                    currentMcpServers[name] = {
                        type: 'stdio',
                        command: 'npx',
                        args: templateArgs,
                        autoConnect: false
                    };
                    renderMcpServers(currentMcpServers);
                } else {
                    // Jump to existing card
                    setTimeout(() => {
                        const el = document.querySelector('#mcp-servers-content [data-mcp-name="' + name + '"]');
                        if (el) {
                            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            el.style.boxShadow = '0 0 0 2px #2563eb';
                            setTimeout(() => (el.style.boxShadow = ''), 1500);
                        }
                    }, 0);
                }
                return;
            }
            const defaultArgs =
                name === 'chrome-devtools' ? ['-y', 'chrome-devtools-mcp@latest', '--isolated'] : [];
            currentMcpServers[name] = { type: 'stdio', command: 'npx', args: defaultArgs, autoConnect: false };
            renderMcpServers(currentMcpServers);
        }

        function removeMcpServerRow(name) {
            if (!confirm('Remove MCP server ' + name + '?')) return;
            delete currentMcpServers[name];
            renderMcpServers(currentMcpServers);
        }

        function collectMcpServersFromDom() {
            const result = {};
            document.querySelectorAll('#mcp-servers-content .backend-card').forEach(card => {
                const name = card.getAttribute('data-mcp-name');
                const command = card.querySelector('.mcp-command').value.trim();
                const argsStr = card.querySelector('.mcp-args').value.trim();
                const autoConnect = card.querySelector('.mcp-autoconnect').value === 'true';
                const description = card.querySelector('.mcp-description').value.trim();
                // eslint-disable-next-line no-useless-escape
                let args = argsStr ? argsStr.split(/\\s+/).filter(Boolean) : [];

                // Repair common copy/paste wrapping issues for chrome-devtools args.
                if (name === 'chrome-devtools') {
                    const hasKnownPkg = args.some(a => a.includes('chrome-devtools-mcp'));
                    const suspicious =
                        args.some(a => a === '@late' || a === 't' || a.includes('olated') || a.includes('@late')) ||
                        args.some(a => a.includes('chrome-devtool') && !a.includes('chrome-devtools-mcp'));
                    if (!hasKnownPkg && suspicious) {
                        args = ['-y', 'chrome-devtools-mcp@latest', '--isolated'];
                    }
                }
                result[name] = {
                    type: 'stdio',
                    command,
                    args,
                    autoConnect,
                    description: description || undefined
                };
            });
            return result;
        }

        async function saveMcpServers() {
            try {
                const servers = collectMcpServersFromDom();
                const response = await fetch('/api/mcp-servers', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(servers)
                });
                const result = await response.json();
                if (response.ok) {
                    const restart = confirm(
                        'MCP servers saved to settings file (env.settings / env-automated-tests.settings).\\n\\n' +
                        'Restart the server now to ensure everything is applied?\\n\\n' +
                        'OK = restart now, Cancel = keep running (applies immediately in most cases).'
                    );
                    if (restart) {
                        try {
                            await fetch('/api/restart', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({})
                            });
                        } catch {}
                        alert('Restart requested. If your MCP client does not auto-reconnect, restart it manually.');
                    } else {
                        alert('Saved (no restart).');
                    }
                    currentMcpServers = result.servers || servers;
                    renderMcpServers(currentMcpServers);
                } else {
                    alert('Failed to save MCP servers: ' + (result.error || response.statusText));
                }
            } catch (error) {
                alert('Failed to save MCP servers: ' + error.message);
            }
        }
        
        // ============================================
        // Tool Tester Functions
        // ============================================
        
        const CORE_TOOLS = ['agent_task', 'mcp_health', 'search', 'analyze_file', 'suggest_edit', 'local_code_review', 'security', 'summarize', 'discover_tools'];  // generate_tests removed V21
        const AGENT_ONLY_TOOLS = ['llm_chat', 'agent_task_result', 'agent_queue_status', 'mcp_server', 'mcp_ask', 'system_profile', 'model_info', 'mcp_debug', 'mcp_terminal_command', 'refine_prompt'];
        
        let allToolsData = [];
        let selectedTool = null;
        let currentTierFilter = 'all';
        let currentExecutionId = null;
        let eventSource = null;
        
        async function loadToolTester() {
            try {
                const response = await fetch('/api/tools?includeSchema=1&includeDisabled=1');
                const data = await response.json();
                allToolsData = data.tools || [];
                renderToolList();
            } catch (error) {
                document.getElementById('tool-list').innerHTML = 
                    '<div class="error" style="padding: 16px;">Failed to load tools: ' + error.message + '</div>';
            }
        }
        
        function getToolTier(toolName) {
            if (CORE_TOOLS.includes(toolName)) return 'core';
            if (AGENT_ONLY_TOOLS.includes(toolName)) return 'agent-only';
            return 'discoverable';
        }
        
        function filterToolList() {
            renderToolList();
        }
        
        function filterByTier(tier) {
            currentTierFilter = tier;
            // Update button styles
            document.querySelectorAll('[data-tier]').forEach(btn => {
                btn.style.background = btn.getAttribute('data-tier') === tier ? '#2563eb' : '#6b7280';
                btn.style.color = 'white';
            });
            renderToolList();
        }
        
        function renderToolList() {
            const container = document.getElementById('tool-list');
            const searchQuery = (document.getElementById('tool-search')?.value || '').toLowerCase();
            
            let filteredTools = allToolsData.filter(tool => {
                const matchesSearch = tool.name.toLowerCase().includes(searchQuery) || 
                                     (tool.description || '').toLowerCase().includes(searchQuery);
                const toolTier = getToolTier(tool.name);
                const matchesTier = currentTierFilter === 'all' || toolTier === currentTierFilter;
                return matchesSearch && matchesTier;
            });
            
            // Sort: Core first, then Discoverable, then Agent-Only
            filteredTools.sort((a, b) => {
                const tierOrder = { 'core': 0, 'discoverable': 1, 'agent-only': 2 };
                const tierA = tierOrder[getToolTier(a.name)] || 1;
                const tierB = tierOrder[getToolTier(b.name)] || 1;
                if (tierA !== tierB) return tierA - tierB;
                return a.name.localeCompare(b.name);
            });
            
            if (filteredTools.length === 0) {
                container.innerHTML = '<div style="padding: 20px; text-align: center; color: #6b7280;">No tools found</div>';
                return;
            }
            
            let html = '';
            filteredTools.forEach(tool => {
                const tier = getToolTier(tool.name);
                const tierColor = tier === 'core' ? '#10b981' : tier === 'agent-only' ? '#f59e0b' : '#6366f1';
                const tierLabel = tier === 'core' ? 'Core' : tier === 'agent-only' ? 'Agent' : 'Disc';
                const isSelected = selectedTool?.name === tool.name;
                
                html += '<div class="tool-list-item" onclick="selectTool(\\'' + tool.name + '\\')" ' +
                        'style="padding: 10px 12px; border-bottom: 1px solid #e5e7eb; cursor: pointer; ' +
                        (isSelected ? 'background: #eff6ff; border-left: 3px solid #2563eb;' : '') + '">' +
                    '<div style="display: flex; justify-content: space-between; align-items: center;">' +
                        '<span style="font-weight: 500; font-size: 13px;">' + tool.name + '</span>' +
                        '<span style="font-size: 9px; padding: 2px 6px; border-radius: 3px; background: ' + tierColor + '20; color: ' + tierColor + ';">' + tierLabel + '</span>' +
                    '</div>' +
                    '<div style="font-size: 11px; color: #6b7280; margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">' + 
                        (tool.description || '').substring(0, 60) + (tool.description?.length > 60 ? '...' : '') + 
                    '</div>' +
                '</div>';
            });
            
            container.innerHTML = html;
        }
        
        async function selectTool(toolName) {
            try {
                const response = await fetch('/api/tools/' + encodeURIComponent(toolName) + '/schema');
                const data = await response.json();
                
                if (data.error) {
                    alert('Failed to load tool schema: ' + data.error);
                    return;
                }
                
                selectedTool = { name: toolName, ...data };
                
                // Update header
                document.getElementById('selected-tool-name').textContent = toolName;
                document.getElementById('selected-tool-description').textContent = data.description || 'No description';
                
                // Render parameter form
                renderParamForm(data.inputSchema);
                
                // Enable execute button
                document.getElementById('execute-tool-btn').disabled = false;
                
                // Refresh tool list to show selection
                renderToolList();
            } catch (error) {
                alert('Failed to load tool: ' + error.message);
            }
        }
        
        function renderParamForm(schema) {
            const container = document.getElementById('tool-params-container');
            
            if (!schema || !schema.properties || Object.keys(schema.properties).length === 0) {
                container.innerHTML = '<div style="padding: 20px; text-align: center; color: #6b7280;">This tool has no parameters</div>';
                return;
            }
            
            const properties = schema.properties || {};
            const required = schema.required || [];
            
            let html = '<div style="display: flex; flex-direction: column; gap: 16px;">';
            
            for (const [key, prop] of Object.entries(properties)) {
                const propSchema = prop;
                const isRequired = required.includes(key);
                const propType = propSchema.type || 'string';
                const enumValues = propSchema.enum;
                const description = propSchema.description || '';
                
                html += '<div class="param-field" data-param="' + key + '">';
                html += '<label style="display: block; font-weight: 500; margin-bottom: 4px;">';
                html += key;
                if (isRequired) html += ' <span style="color: #dc2626;">*</span>';
                html += '</label>';
                
                if (enumValues && Array.isArray(enumValues)) {
                    // Enum as select
                    html += '<select class="param-input" data-param="' + key + '" data-type="' + propType + '" ' +
                            'style="width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 4px;">';
                    html += '<option value="">-- Select --</option>';
                    enumValues.forEach(val => {
                        html += '<option value="' + val + '">' + val + '</option>';
                    });
                    html += '</select>';
                } else if (propType === 'boolean') {
                    // Boolean as checkbox
                    html += '<label style="display: flex; align-items: center; gap: 8px;">';
                    html += '<input type="checkbox" class="param-input" data-param="' + key + '" data-type="boolean">';
                    html += '<span style="font-size: 12px; color: #6b7280;">Enable</span>';
                    html += '</label>';
                } else if (propType === 'number' || propType === 'integer') {
                    html += '<input type="number" class="param-input" data-param="' + key + '" data-type="' + propType + '" ' +
                            'style="width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 4px;">';
                } else if (propType === 'array') {
                    // Array as textarea (JSON)
                    html += '<textarea class="param-input" data-param="' + key + '" data-type="array" ' +
                            'placeholder="[\\"value1\\", \\"value2\\"]" rows="3" ' +
                            'style="width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 4px; font-family: monospace; font-size: 12px;"></textarea>';
                } else if (propType === 'object') {
                    // Object as textarea (JSON)
                    html += '<textarea class="param-input" data-param="' + key + '" data-type="object" ' +
                            'placeholder="{ \\"key\\": \\"value\\" }" rows="4" ' +
                            'style="width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 4px; font-family: monospace; font-size: 12px;"></textarea>';
                } else {
                    // String as input or textarea for long descriptions
                    const isLongText = description.toLowerCase().includes('task') || 
                                       description.toLowerCase().includes('prompt') ||
                                       description.toLowerCase().includes('code') ||
                                       description.toLowerCase().includes('content') ||
                                       key === 'task' || key === 'prompt' || key === 'code' || key === 'question';
                    if (isLongText) {
                        html += '<textarea class="param-input" data-param="' + key + '" data-type="string" rows="4" ' +
                                'style="width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 4px;"></textarea>';
                    } else {
                        html += '<input type="text" class="param-input" data-param="' + key + '" data-type="string" ' +
                                'style="width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 4px;">';
                    }
                }
                
                if (description) {
                    html += '<div style="font-size: 11px; color: #6b7280; margin-top: 4px;">' + description + '</div>';
                }
                
                html += '</div>';
            }
            
            html += '</div>';
            
            // Add examples if available
            if (schema.examples && Array.isArray(schema.examples) && schema.examples.length > 0) {
                html += '<div style="margin-top: 20px; padding-top: 16px; border-top: 1px solid #e5e7eb;">';
                html += '<div style="font-weight: 500; margin-bottom: 8px;">Examples:</div>';
                schema.examples.forEach((example, idx) => {
                    html += '<button class="btn-small" onclick=\\'applyExample(' + JSON.stringify(example).replace(/'/g, "\\\\'") + ')\\' ' +
                            'style="margin-right: 8px; margin-bottom: 8px; font-size: 11px;">Example ' + (idx + 1) + '</button>';
                });
                html += '</div>';
            }
            
            container.innerHTML = html;
        }
        
        function applyExample(example) {
            if (!example || typeof example !== 'object') return;
            
            for (const [key, value] of Object.entries(example)) {
                const input = document.querySelector('.param-input[data-param="' + key + '"]');
                if (!input) continue;
                
                const dataType = input.getAttribute('data-type');
                
                if (input.type === 'checkbox') {
                    input.checked = !!value;
                } else if (dataType === 'array' || dataType === 'object') {
                    input.value = JSON.stringify(value, null, 2);
                } else {
                    input.value = value;
                }
            }
        }
        
        function collectParams() {
            const params = {};
            document.querySelectorAll('.param-input').forEach(input => {
                const key = input.getAttribute('data-param');
                const dataType = input.getAttribute('data-type');
                let value;
                
                if (input.type === 'checkbox') {
                    value = input.checked;
                } else if (dataType === 'number' || dataType === 'integer') {
                    value = input.value ? Number(input.value) : undefined;
                } else if (dataType === 'boolean') {
                    value = input.checked;
                } else if (dataType === 'array' || dataType === 'object') {
                    try {
                        value = input.value.trim() ? JSON.parse(input.value) : undefined;
                    } catch (e) {
                        // Invalid JSON, treat as undefined
                        value = undefined;
                    }
                } else {
                    value = input.value.trim() || undefined;
                }
                
                if (value !== undefined && value !== '') {
                    params[key] = value;
                }
            });
            
            return params;
        }
        
        async function executeTool() {
            if (!selectedTool) {
                alert('Please select a tool first');
                return;
            }
            
            const params = collectParams();
            const useSSE = document.getElementById('stream-progress').checked;
            
            // Update UI
            document.getElementById('execute-tool-btn').disabled = true;
            document.getElementById('cancel-tool-btn').style.display = 'inline-block';
            document.getElementById('execution-result-panel').style.display = 'block';
            document.getElementById('execution-status').innerHTML = '<span style="color: #f59e0b;">⏳ Running...</span>';
            document.getElementById('execution-duration').textContent = '';
            document.getElementById('execution-output').textContent = 'Executing ' + selectedTool.name + '...';
            document.getElementById('progress-events').style.display = 'none';
            document.getElementById('progress-events-list').innerHTML = '';
            
            const startTime = Date.now();
            
            if (useSSE) {
                // Use Server-Sent Events for streaming
                try {
                    const response = await fetch('/api/tools/' + encodeURIComponent(selectedTool.name) + '/execute?sse=1', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ arguments: params })
                    });
                    
                    currentExecutionId = response.headers.get('X-Execution-Id');
                    
                    const reader = response.body.getReader();
                    const decoder = new TextDecoder();
                    let buffer = '';
                    
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        
                        buffer += decoder.decode(value, { stream: true });
                        const lines = buffer.split('\\n');
                        buffer = lines.pop() || '';
                        
                        for (const line of lines) {
                            if (line.startsWith('event: ')) {
                                const eventType = line.substring(7);
                                continue;
                            }
                            if (line.startsWith('data: ')) {
                                try {
                                    const data = JSON.parse(line.substring(6));
                                    handleSSEEvent(data, startTime);
                                } catch (e) {
                                    // Ignore parse errors
                                }
                            }
                        }
                    }
                } catch (error) {
                    document.getElementById('execution-status').innerHTML = '<span style="color: #dc2626;">❌ Error</span>';
                    document.getElementById('execution-output').textContent = 'Error: ' + error.message;
                } finally {
                    document.getElementById('execute-tool-btn').disabled = false;
                    document.getElementById('cancel-tool-btn').style.display = 'none';
                    currentExecutionId = null;
                }
            } else {
                // Regular JSON request
                try {
                    const response = await fetch('/api/tools/' + encodeURIComponent(selectedTool.name) + '/execute', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ arguments: params })
                    });
                    
                    const result = await response.json();
                    const durationMs = Date.now() - startTime;
                    
                    displayExecutionResult(result, durationMs);
                } catch (error) {
                    document.getElementById('execution-status').innerHTML = '<span style="color: #dc2626;">❌ Error</span>';
                    document.getElementById('execution-output').textContent = 'Error: ' + error.message;
                } finally {
                    document.getElementById('execute-tool-btn').disabled = false;
                    document.getElementById('cancel-tool-btn').style.display = 'none';
                }
            }
        }
        
        function handleSSEEvent(data, startTime) {
            if (data.type === 'progress' || data.progress) {
                // Show progress panel
                document.getElementById('progress-events').style.display = 'block';
                const progressList = document.getElementById('progress-events-list');
                const eventText = typeof data === 'object' ? JSON.stringify(data) : data;
                progressList.innerHTML += '<div style="margin-bottom: 4px;">• ' + eventText + '</div>';
                progressList.scrollTop = progressList.scrollHeight;
            }
            
            if (data.content || data.isError !== undefined) {
                // Final result
                const durationMs = data.durationMs || (Date.now() - startTime);
                displayExecutionResult(data, durationMs);
            }
            
            if (data.error && !data.content) {
                document.getElementById('execution-status').innerHTML = '<span style="color: #dc2626;">❌ Error</span>';
                document.getElementById('execution-output').textContent = 'Error: ' + data.error;
            }
        }
        
        function displayExecutionResult(result, durationMs) {
            const isError = result.isError || result.error;
            
            document.getElementById('execution-status').innerHTML = isError 
                ? '<span style="color: #dc2626;">❌ Error</span>'
                : '<span style="color: #10b981;">✓ Success</span>';
            
            document.getElementById('execution-duration').textContent = 'Duration: ' + (durationMs / 1000).toFixed(2) + 's';
            
            // Extract text content
            let outputText = '';
            if (result.content && Array.isArray(result.content)) {
                outputText = result.content.map(c => c.text || JSON.stringify(c)).join('\\n');
            } else if (result.error) {
                outputText = 'Error: ' + result.error;
            } else {
                outputText = JSON.stringify(result, null, 2);
            }
            
            document.getElementById('execution-output').textContent = outputText;
        }
        
        async function cancelToolExecution() {
            if (!currentExecutionId) return;
            
            try {
                await fetch('/api/tools/cancel/' + currentExecutionId, { method: 'POST' });
                document.getElementById('execution-status').innerHTML = '<span style="color: #f59e0b;">⚠️ Cancelled</span>';
            } catch (error) {
                console.error('Failed to cancel execution:', error);
            }
        }
        
        function clearExecutionResult() {
            document.getElementById('execution-result-panel').style.display = 'none';
            document.getElementById('execution-output').textContent = '';
            document.getElementById('progress-events-list').innerHTML = '';
        }
        
        function copyExecutionResult() {
            const output = document.getElementById('execution-output').textContent;
            navigator.clipboard.writeText(output).then(() => {
                alert('Copied to clipboard');
            });
        }
        
        function toggleResultView(view) {
            const output = document.getElementById('execution-output');
            const content = output.textContent;
            
            if (view === 'json') {
                try {
                    const parsed = JSON.parse(content);
                    output.textContent = JSON.stringify(parsed, null, 2);
                } catch (e) {
                    // Already not JSON
                }
            }
            // Text view is default, no transformation needed
        }
        
        // Tool Governance Functions
        let currentToolGroupData = null;
        
        async function loadToolGroups() {
            try {
                // Load modes
                const modesResponse = await fetch('/api/tool-groups/modes');
                const modesData = await modesResponse.json();
                
                // Load current status
                const statusResponse = await fetch('/api/tool-groups');
                const statusData = await statusResponse.json();
                
                // Load group definitions
                const defsResponse = await fetch('/api/tool-groups/definitions');
                const defsData = await defsResponse.json();
                
                currentToolGroupData = { modes: modesData, status: statusData, definitions: defsData };
                renderToolGroups(modesData, statusData, defsData);
            } catch (error) {
                document.getElementById('tool-groups-list').innerHTML = 
                    '<div class="error">Failed to load tool groups</div>';
            }
        }
        
        function renderToolGroups(modesData, statusData, defsData) {
            // Render mode selector
            const modeSelect = document.getElementById('tool-mode-select');
            modeSelect.innerHTML = '';
            
            modesData.modes.forEach(m => {
                const option = document.createElement('option');
                option.value = m.mode;
                option.textContent = m.mode.replace('_', ' ');
                if (m.mode === modesData.currentMode) option.selected = true;
                modeSelect.appendChild(option);
            });
            
            // Update mode description
            const currentModeInfo = modesData.modes.find(m => m.mode === modesData.currentMode);
            document.getElementById('mode-description').textContent = 
                currentModeInfo ? currentModeInfo.description : '';
            
            // Render enabled tools
            const enabledToolsList = document.getElementById('enabled-tools-list');
            const enabledTools = statusData.enabledTools || [];
            
            if (enabledTools.length === 0) {
                enabledToolsList.innerHTML = '<span style="color: #dc2626;">No tools enabled</span>';
            } else {
                enabledToolsList.innerHTML = enabledTools.map(tool => 
                    '<span style="background: #dcfce7; color: #166534; padding: 4px 8px; border-radius: 4px; font-size: 12px;">' + tool + '</span>'
                ).join('');
            }
            
            // Render tool groups
            const groupsList = document.getElementById('tool-groups-list');
            const enabledGroups = statusData.enabledGroups || [];
            
            let groupsHtml = '';
            defsData.groups.forEach(group => {
                const isEnabled = enabledGroups.includes(group.id);
                const riskLevel = group.riskLevel || 'low';
                const riskColor = riskLevel === 'high' ? '#dc2626' : riskLevel === 'medium' ? '#f59e0b' : '#10b981';
                
                groupsHtml += '<div class="backend-card" style="' + (isEnabled ? 'border-left: 3px solid #10b981;' : 'opacity: 0.7;') + '">';
                groupsHtml += '<div style="display: flex; justify-content: space-between; align-items: flex-start;">';
                groupsHtml += '<div>';
                groupsHtml += '<div style="font-weight: 500; font-size: 14px;">' + group.id + '</div>';
                groupsHtml += '<div style="font-size: 12px; color: #6b7280; margin-top: 2px;">' + group.description + '</div>';
                groupsHtml += '<div style="margin-top: 8px;">';
                group.tools.forEach(tool => {
                    groupsHtml += '<span style="background: #e5e7eb; color: #374151; padding: 2px 6px; border-radius: 3px; font-size: 11px; margin-right: 4px;">' + tool + '</span>';
                });
                groupsHtml += '</div>';
                groupsHtml += '</div>';
                groupsHtml += '<div style="display: flex; align-items: center; gap: 8px;">';
                groupsHtml += '<span style="font-size: 10px; padding: 2px 6px; border-radius: 3px; background: ' + riskColor + '20; color: ' + riskColor + ';">' + riskLevel.toUpperCase() + '</span>';
                groupsHtml += '<label class="toggle-switch-sm" style="position: relative; width: 36px; height: 20px; background: ' + (isEnabled ? '#10b981' : '#d1d5db') + '; border-radius: 10px; cursor: pointer;" onclick="toggleGroup(\\'' + group.id + '\\', ' + !isEnabled + ')">';
                groupsHtml += '<span style="position: absolute; top: 2px; left: ' + (isEnabled ? '18px' : '2px') + '; width: 16px; height: 16px; background: white; border-radius: 50%; transition: left 0.2s;"></span>';
                groupsHtml += '</label>';
                groupsHtml += '</div>';
                groupsHtml += '</div>';
                groupsHtml += '</div>';
            });
            
            groupsList.innerHTML = groupsHtml;
        }
        
        async function setToolMode() {
            const mode = document.getElementById('tool-mode-select').value;
            if (!mode) return;
            
            try {
                const response = await fetch('/api/tool-groups/set-mode', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mode })
                });
                
                const result = await response.json();
                
                if (response.ok) {
                    alert('Tool access mode set to: ' + mode);
                    loadToolGroups();
                } else {
                    alert('Failed to set mode: ' + result.error);
                }
            } catch (error) {
                alert('Failed to set mode: ' + error.message);
            }
        }
        
        async function toggleGroup(groupId, enable) {
            try {
                // Get current enabled groups and toggle this one
                const statusResponse = await fetch('/api/tool-groups');
                const status = await statusResponse.json();
                
                let newGroups = [...(status.enabledGroups || [])];
                if (enable && !newGroups.includes(groupId)) {
                    newGroups.push(groupId);
                } else if (!enable) {
                    newGroups = newGroups.filter(g => g !== groupId);
                }
                
                const response = await fetch('/api/tool-groups/set-groups', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ groups: newGroups })
                });
                
                if (response.ok) {
                    loadToolGroups();
                } else {
                    const result = await response.json();
                    alert('Failed to toggle group: ' + result.error);
                }
            } catch (error) {
                alert('Failed to toggle group: ' + error.message);
            }
        }
        
        async function resetToDefault() {
            if (!confirm('Reset tool groups to DEVELOPMENT mode defaults?')) return;
            
            try {
                await fetch('/api/tool-groups/set-mode', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mode: 'DEVELOPMENT' })
                });
                
                loadToolGroups();
            } catch (error) {
                alert('Failed to reset: ' + error.message);
            }
        }
        
        // ============================================
        // Tool Orchestration Functions
        // ============================================
        let toolOrchestrationData = null;
        
        async function loadToolOrchestration() {
            try {
                const response = await fetch('/api/settings/tool-orchestration');
                const data = await response.json();
                
                if (!data.success) {
                    throw new Error(data.error || 'Failed to load');
                }
                
                toolOrchestrationData = data;
                renderToolOrchestration(data);
            } catch (error) {
                document.getElementById('tool-orch-grid').innerHTML = 
                    '<div class="error">Failed to load tool orchestration settings: ' + error.message + '</div>';
            }
        }
        
        function renderToolOrchestration(data) {
            // Update status banner
            const statusBanner = document.getElementById('orch-status-banner');
            const statusIcon = document.getElementById('orch-status-icon');
            const statusText = document.getElementById('orch-status-text');
            const backendsText = document.getElementById('orch-backends-text');
            
            if (data.orchestrationAvailable) {
                statusBanner.style.background = '#f0fdf4';
                statusBanner.style.borderColor = '#86efac';
                statusIcon.textContent = '✅';
                statusText.textContent = 'Orchestration Available';
                backendsText.textContent = 'Backends: ' + data.orchestrationBackends.join(', ');
            } else {
                statusBanner.style.background = '#fef2f2';
                statusBanner.style.borderColor = '#fecaca';
                statusIcon.textContent = '⚠️';
                statusText.textContent = 'Orchestration Not Available';
                backendsText.textContent = 'Enable CLI Orchestration in Configuration tab';
            }
            
            // Update global settings
            document.getElementById('global-orch-enabled').checked = data.globalSettings.defaultOrchestrationEnabled;
            document.getElementById('global-fallback').checked = data.globalSettings.defaultFallbackToLocal;
            document.getElementById('global-quick-mode').checked = data.globalSettings.defaultQuickMode;
            document.getElementById('global-backend').value = data.globalSettings.defaultPreferredBackend;
            
            // Render tool grid
            const grid = document.getElementById('tool-orch-grid');
            let html = '';
            
            for (const toolName of data.availableTools) {
                const config = data.toolConfigs[toolName] || {};
                const isOrch = config.orchestrationEnabled !== false;
                const backend = config.preferredBackend || 'auto';
                const fallback = config.fallbackToLocal !== false;
                const quick = config.quickMode === true;
                
                html += '<div style="border: 1px solid #e5e7eb; border-radius: 6px; padding: 12px; background: ' + (isOrch ? '#f0fdf4' : '#f9fafb') + ';">';
                html += '<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">';
                html += '<span style="font-weight: 500;">' + toolName + '</span>';
                html += '<span style="font-size: 12px; padding: 2px 6px; border-radius: 3px; background: ' + (isOrch ? '#dcfce7; color: #166534;' : '#e5e7eb; color: #374151;') + '">' + (isOrch ? 'Orchestration' : 'Direct LLM') + '</span>';
                html += '</div>';
                
                html += '<div style="font-size: 12px; display: flex; flex-direction: column; gap: 6px;">';
                
                // Mode toggle
                html += '<label style="display: flex; align-items: center; gap: 6px;">';
                html += '<input type="checkbox" ' + (isOrch ? 'checked' : '') + ' onchange="updateToolOrchConfig(\\'' + toolName + '\\', {orchestrationEnabled: this.checked})">';
                html += '<span>Use Orchestration</span>';
                html += '</label>';
                
                // Backend select
                html += '<div style="display: flex; align-items: center; gap: 6px;">';
                html += '<span>Backend:</span>';
                html += '<select onchange="updateToolOrchConfig(\\'' + toolName + '\\', {preferredBackend: this.value})" style="font-size: 11px; padding: 2px 4px;">';
                html += '<option value="auto"' + (backend === 'auto' ? ' selected' : '') + '>Auto</option>';
                html += '<option value="opencode"' + (backend === 'opencode' ? ' selected' : '') + '>OpenCode</option>';
                html += '<option value="copilot"' + (backend === 'copilot' ? ' selected' : '') + '>Copilot</option>';
                html += '<option value="local"' + (backend === 'local' ? ' selected' : '') + '>Local Only</option>';
                html += '</select>';
                html += '</div>';
                
                // Fallback toggle
                html += '<label style="display: flex; align-items: center; gap: 6px;">';
                html += '<input type="checkbox" ' + (fallback ? 'checked' : '') + ' onchange="updateToolOrchConfig(\\'' + toolName + '\\', {fallbackToLocal: this.checked})">';
                html += '<span>Fallback to Direct LLM</span>';
                html += '</label>';
                
                // Quick mode toggle
                html += '<label style="display: flex; align-items: center; gap: 6px;">';
                html += '<input type="checkbox" ' + (quick ? 'checked' : '') + ' onchange="updateToolOrchConfig(\\'' + toolName + '\\', {quickMode: this.checked})">';
                html += '<span>Quick Mode</span>';
                html += '</label>';
                
                html += '</div>';
                html += '</div>';
            }
            
            grid.innerHTML = html;
        }
        
        async function updateGlobalOrchSettings() {
            const settings = {
                defaultOrchestrationEnabled: document.getElementById('global-orch-enabled').checked,
                defaultFallbackToLocal: document.getElementById('global-fallback').checked,
                defaultQuickMode: document.getElementById('global-quick-mode').checked,
                defaultPreferredBackend: document.getElementById('global-backend').value
            };
            
            try {
                const response = await fetch('/api/settings/tool-orchestration/global', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(settings)
                });
                
                if (!response.ok) {
                    const result = await response.json();
                    throw new Error(result.error || 'Failed to update');
                }
                
                // Refresh display
                loadToolOrchestration();
            } catch (error) {
                alert('Failed to update global settings: ' + error.message);
            }
        }
        
        async function updateToolOrchConfig(toolName, config) {
            try {
                const response = await fetch('/api/settings/tool-orchestration/' + encodeURIComponent(toolName), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(config)
                });
                
                if (!response.ok) {
                    const result = await response.json();
                    throw new Error(result.error || 'Failed to update');
                }
                
                // Refresh display
                loadToolOrchestration();
            } catch (error) {
                alert('Failed to update tool config: ' + error.message);
            }
        }
        
        async function bulkEnableOrchestration() {
            const category = document.getElementById('bulk-category').value;
            if (!category) {
                alert('Please select a category first');
                return;
            }
            
            try {
                const response = await fetch('/api/settings/tool-orchestration/batch', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        category: category,
                        config: { orchestrationEnabled: true }
                    })
                });
                
                if (!response.ok) {
                    const result = await response.json();
                    throw new Error(result.error || 'Failed to update');
                }
                
                const result = await response.json();
                alert('Updated ' + result.updated.length + ' tools to use Orchestration');
                loadToolOrchestration();
            } catch (error) {
                alert('Failed to bulk update: ' + error.message);
            }
        }
        
        async function bulkDisableOrchestration() {
            const category = document.getElementById('bulk-category').value;
            if (!category) {
                alert('Please select a category first');
                return;
            }
            
            try {
                const response = await fetch('/api/settings/tool-orchestration/batch', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        category: category,
                        config: { orchestrationEnabled: false, preferredBackend: 'local' }
                    })
                });
                
                if (!response.ok) {
                    const result = await response.json();
                    throw new Error(result.error || 'Failed to update');
                }
                
                const result = await response.json();
                alert('Updated ' + result.updated.length + ' tools to use Direct LLM');
                loadToolOrchestration();
            } catch (error) {
                alert('Failed to bulk update: ' + error.message);
            }
        }
        
        async function resetAllToolOrchestration() {
            if (!confirm('Reset all tool orchestration settings to defaults?')) return;
            
            try {
                const response = await fetch('/api/settings/tool-orchestration/reset', {
                    method: 'POST'
                });
                
                if (!response.ok) {
                    const result = await response.json();
                    throw new Error(result.error || 'Failed to reset');
                }
                
                loadToolOrchestration();
            } catch (error) {
                alert('Failed to reset: ' + error.message);
            }
        }
        
        // ============================================
        // Model Capabilities Functions
        // ============================================
        
        async function loadModelCapabilities() {
            const modelsList = document.getElementById('models-list');
            modelsList.innerHTML = '<div class="loading">Loading models...</div>';
            
            try {
                const response = await fetch('/api/models');
                const data = await response.json();
                
                renderModelsList(data);
            } catch (error) {
                modelsList.innerHTML = '<div class="error">Failed to load models: ' + error.message + '</div>';
            }
        }
        
        function renderModelsList(data) {
            const modelsList = document.getElementById('models-list');
            let html = '';
            
            // Handle both single backend and multiple backends response
            const backends = typeof data.backendId !== 'undefined' ? { [data.backendId]: data } : data;
            
            for (const [backendId, backendData] of Object.entries(backends)) {
                html += '<div style="margin-bottom: 20px;">';
                html += '<h5 style="margin: 0 0 12px 0; color: #374151;">' + backendId + '</h5>';
                
                if (!backendData.available) {
                    html += '<div class="error">Backend not available: ' + (backendData.error || 'Unknown error') + '</div>';
                } else if (!backendData.models || backendData.models.length === 0) {
                    html += '<div style="color: #6b7280;">No models found</div>';
                } else {
                    backendData.models.forEach(model => {
                        const capColor = model.estimatedCapability === 'advanced' ? '#059669' : 
                                        model.estimatedCapability === 'standard' ? '#f59e0b' : '#dc2626';
                        const isCurrent = backendData.currentModel && backendData.currentModel.id === model.id;
                        
                        html += '<div class="backend-card" style="margin-bottom: 12px;' + (isCurrent ? 'border-left: 3px solid #3b82f6;' : '') + '">';
                        html += '<div style="display: flex; justify-content: space-between; align-items: flex-start;">';
                        html += '<div style="flex: 1;">';
                        html += '<div style="font-weight: 500; font-size: 14px;">' + model.name + (isCurrent ? ' <span style="font-size: 11px; color: #3b82f6;">(Current)</span>' : '') + '</div>';
                        html += '<div style="display: flex; gap: 8px; margin-top: 6px; flex-wrap: wrap;">';
                        
                        // Parameter size badge
                        if (model.parameterSize) {
                            html += '<span style="background: #e0e7ff; color: #3730a3; padding: 2px 8px; border-radius: 12px; font-size: 11px;">' + model.parameterSize + '</span>';
                        }
                        
                        // Code specialized badge
                        if (model.isCodeSpecialized) {
                            html += '<span style="background: #fef3c7; color: #92400e; padding: 2px 8px; border-radius: 12px; font-size: 11px;">Code Model</span>';
                        }
                        
                        // Capability level badge
                        html += '<span style="background: ' + capColor + '20; color: ' + capColor + '; padding: 2px 8px; border-radius: 12px; font-size: 11px;">' + model.estimatedCapability.toUpperCase() + '</span>';
                        
                        // Context length
                        if (model.contextLength) {
                            html += '<span style="background: #f3f4f6; color: #374151; padding: 2px 8px; border-radius: 12px; font-size: 11px;">~' + model.contextLength + ' ctx</span>';
                        }
                        
                        html += '</div>';
                        
                        // Recommended tasks (collapsed by default)
                        html += '<details style="margin-top: 8px;">';
                        html += '<summary style="cursor: pointer; font-size: 12px; color: #6b7280;">Recommended Tasks</summary>';
                        html += '<div style="padding: 8px 0; font-size: 12px;">';
                        html += '<div style="color: #059669; margin-bottom: 4px;"><strong>✓ Recommended:</strong></div>';
                        html += '<div style="margin-left: 12px; color: #374151;">' + model.recommendedTasks.slice(0, 5).join(', ') + '</div>';
                        if (model.cautionTasks && model.cautionTasks.length > 0) {
                            html += '<div style="color: #dc2626; margin-top: 8px; margin-bottom: 4px;"><strong>⚠ Use with Caution:</strong></div>';
                            html += '<div style="margin-left: 12px; color: #374151;">' + model.cautionTasks.slice(0, 3).join(', ') + '</div>';
                        }
                        html += '</div></details>';
                        
                        html += '</div>';
                        html += '</div>';
                        html += '</div>';
                    });
                }
                html += '</div>';
            }
            
            modelsList.innerHTML = html || '<div style="color: #6b7280;">No backends configured</div>';
        }
        
        async function quickAnalyzeModel() {
            const modelName = document.getElementById('quick-model-name').value.trim();
            const resultDiv = document.getElementById('quick-analysis-result');
            
            if (!modelName) {
                alert('Please enter a model name');
                return;
            }
            
            try {
                const response = await fetch('/api/models/quick-analyze?modelName=' + encodeURIComponent(modelName));
                const data = await response.json();
                
                resultDiv.style.display = 'block';
                
                if (data.error) {
                    resultDiv.innerHTML = '<div class="error">' + data.error + '</div>';
                    return;
                }
                
                let html = '<div style="background: white; padding: 12px; border-radius: 6px; border: 1px solid #e5e7eb;">';
                html += '<div style="font-weight: 500;">' + modelName + '</div>';
                html += '<div style="display: flex; gap: 8px; margin-top: 8px;">';
                
                if (data.parameterSize) {
                    html += '<span style="background: #e0e7ff; color: #3730a3; padding: 2px 8px; border-radius: 12px; font-size: 11px;">' + data.parameterSize + '</span>';
                } else {
                    html += '<span style="background: #f3f4f6; color: #6b7280; padding: 2px 8px; border-radius: 12px; font-size: 11px;">Size Unknown</span>';
                }
                
                if (data.isCodeSpecialized) {
                    html += '<span style="background: #fef3c7; color: #92400e; padding: 2px 8px; border-radius: 12px; font-size: 11px;">Code Specialized</span>';
                }
                
                html += '</div></div>';
                resultDiv.innerHTML = html;
            } catch (error) {
                resultDiv.style.display = 'block';
                resultDiv.innerHTML = '<div class="error">Analysis failed: ' + error.message + '</div>';
            }
        }
        
        async function checkTaskSuitability() {
            const modelName = document.getElementById('task-model-name').value.trim();
            const taskType = document.getElementById('task-type-select').value;
            const resultDiv = document.getElementById('task-suitability-result');
            
            if (!modelName) {
                alert('Please enter a model name');
                return;
            }
            
            try {
                const url = '/api/models/task-suitability?modelId=' + encodeURIComponent(modelName) + 
                           '&taskType=' + encodeURIComponent(taskType);
                const response = await fetch(url);
                const data = await response.json();
                
                resultDiv.style.display = 'block';
                
                if (data.error) {
                    resultDiv.innerHTML = '<div class="error">' + data.error + '</div>';
                    return;
                }
                
                const suitableColor = data.suitable ? '#059669' : '#dc2626';
                const confColor = data.confidence === 'high' ? '#059669' : data.confidence === 'medium' ? '#f59e0b' : '#dc2626';
                
                let html = '<div style="background: white; padding: 12px; border-radius: 6px; border: 1px solid ' + suitableColor + ';">';
                html += '<div style="display: flex; justify-content: space-between; align-items: center;">';
                html += '<div style="font-weight: 500;">' + modelName + ' → ' + taskType + '</div>';
                html += '<span style="background: ' + suitableColor + '20; color: ' + suitableColor + '; padding: 4px 12px; border-radius: 12px; font-size: 12px; font-weight: 500;">';
                html += data.suitable ? '✓ Suitable' : '✗ Not Suitable';
                html += '</span>';
                html += '</div>';
                html += '<div style="margin-top: 8px; font-size: 12px; color: #6b7280;">' + data.reason + '</div>';
                html += '<div style="margin-top: 8px;">';
                html += '<span style="background: ' + confColor + '20; color: ' + confColor + '; padding: 2px 8px; border-radius: 12px; font-size: 11px;">Confidence: ' + data.confidence.toUpperCase() + '</span>';
                html += '</div>';
                html += '</div>';
                
                resultDiv.innerHTML = html;
            } catch (error) {
                resultDiv.style.display = 'block';
                resultDiv.innerHTML = '<div class="error">Check failed: ' + error.message + '</div>';
            }
        }
        
        function renderSystemProfile(data) {
            const { profile } = data;
            
            let html = '';
            html += '<div class="profile-item"><span>Operating System</span><span>' + profile.os + '</span></div>';
            html += '<div class="profile-item"><span>CPU Cores</span><span>' + profile.cpu_cores + '</span></div>';
            html += '<div class="profile-item"><span>RAM</span><span>' + profile.ram_gb_bucket + ' GB</span></div>';
            html += '<div class="profile-item"><span>Disk Space</span><span>' + profile.disk_free_gb_bucket + ' GB free</span></div>';
            
            if (profile.gpu && profile.gpu.present) {
                html += '<div class="profile-item"><span>GPU</span><span>' + profile.gpu.vendor + ' (' + profile.gpu.vram_gb_bucket + ' GB VRAM)</span></div>';
            }
            
            document.getElementById('system-profile-content').innerHTML = html;
        }
        
        function renderBackends(backends, defaults, settingsData) {
            // Filter out CLI backends (orchestration tools) from dropdowns
            // CLI backends like opencode/copilot delegate to other LLMs,
            // so they shouldn't appear as selectable backends in the UI
            const cliBackendTypes = ['opencode', 'copilot'];
            const selectableBackends = backends.filter(b => !cliBackendTypes.includes(b.type));
            
            // Populate backend selectors
            const localSelect = document.getElementById('local-backend-select');
            const sotaSelect = document.getElementById('sota-backend-select');
            const localModelSelect = document.getElementById('local-model-select');
            const sotaModelSelect = document.getElementById('sota-model-select');
            
            localSelect.innerHTML = '';
            sotaSelect.innerHTML = '';
            localModelSelect.innerHTML = '<option value="">Auto-select</option>';
            sotaModelSelect.innerHTML = '<option value="">Auto-select</option>';
            
            selectableBackends.forEach(backend => {
                const localOption = document.createElement('option');
                localOption.value = backend.id;
                localOption.textContent = backend.displayName + (backend.available ? '' : ' (Unavailable)');
                localOption.disabled = !backend.available;
                if (backend.id === defaults.localBackendId) localOption.selected = true;
                localSelect.appendChild(localOption);
                
                const sotaOption = document.createElement('option');
                sotaOption.value = backend.id;
                sotaOption.textContent = backend.displayName + (backend.available ? '' : ' (Unavailable)');
                sotaOption.disabled = !backend.available;
                // For SOTA, check if we're in testing mode with local backend
                const isLocalSota = settingsData && settingsData.settings.testing.sotaBackendType === 'local';
                if (isLocalSota && backend.id === settingsData.settings.testing.sotaBackendId) {
                    sotaOption.selected = true;
                } else if (backend.id === defaults.sotaBackendId) {
                    sotaOption.selected = true;
                }
                sotaSelect.appendChild(sotaOption);
            });
            
            // Load models for the selected local and SOTA backends
            const localBackend = selectableBackends.find(b => b.id === defaults.localBackendId);
            const sotaBackend = selectableBackends.find(b => b.id === defaults.sotaBackendId);
            
            if (localBackend && localBackend.available) {
                loadModelsForBackend(localBackend.id, 'local', defaults.localModel);
            }
            
            if (sotaBackend && sotaBackend.available) {
                loadModelsForBackend(sotaBackend.id, 'sota', defaults.sotaModel);
            }
            
            // Render backend list (show ALL backends including CLI for informational purposes)
            let html = '';
            
            for (const backend of backends) {
                html += '<div class="backend-card">';
                html += '<div class="backend-header">';
                html += '<div class="backend-name">' + backend.displayName + ' (' + backend.id + ')</div>';
                html += '<span class="backend-status ' + (backend.available ? 'status-available' : 'status-unavailable') + '">';
                html += backend.available ? 'Available' : 'Unavailable';
                html += '</span>';
                html += '</div>';
                
                if (backend.error) {
                    html += '<div style="color: #dc2626; font-size: 12px; margin-top: 4px;">' + backend.error + '</div>';
                }
                
                // Show installed models for available backends
                if (backend.available) {
                    html += '<div style="margin-top: 8px;">';
                    html += '<button class="btn-small" data-backend-id="' + backend.id + '" style="font-size: 12px; padding: 4px 8px;">Show Installed Models</button>';
                    html += '<div id="models-' + backend.id + '" style="margin-top: 8px;"></div>';
                    html += '</div>';
                }
                
                html += '</div>';
            }
            
            document.getElementById('backends-content').innerHTML = html;
            
            // Attach click handlers after DOM is updated
            document.querySelectorAll('.btn-small[data-backend-id]').forEach(button => {
                button.addEventListener('click', function() {
                    const backendId = this.getAttribute('data-backend-id');
                    loadModels(backendId, this);
                });
            });
        }
        
        async function loadModels(backendId, button) {
            const modelsDiv = document.getElementById('models-' + backendId);
            button.disabled = true;
            button.textContent = 'Loading...';
            
            try {
                const response = await fetch('/api/backends/' + backendId + '/models');
                const models = await response.json();
                
                if (models.length === 0) {
                    modelsDiv.innerHTML = '<div style="color: #6b7280; font-size: 12px; font-style: italic;">No models installed</div>';
                } else {
                    let modelHtml = '<div style="font-size: 12px; color: #374151; font-weight: 500; margin-bottom: 4px;">📦 Installed Models:</div>';
                    modelHtml += '<div class="model-list">';
                    models.forEach(model => {
                        modelHtml += '<span class="model-tag" style="background: #dbeafe; color: #1e40af; font-size: 11px;">' + model + '</span>';
                    });
                    modelHtml += '</div>';
                    modelsDiv.innerHTML = modelHtml;
                }
                
                button.textContent = 'Refresh Models';
                button.disabled = false;
            } catch (error) {
                modelsDiv.innerHTML = '<div style="color: #dc2626; font-size: 12px;">Failed to load models</div>';
                button.textContent = 'Retry';
                button.disabled = false;
            }
        }
        
        let autoRefreshInterval = null;
        
        async function loadLogs(filter = {}) {
            try {
                const params = new URLSearchParams(filter);
                const response = await fetch('/api/logs?' + params.toString());
                const data = await response.json();
                renderLogs(data);
            } catch (error) {
                document.getElementById('logs-content').innerHTML = 
                    '<div class="error">Failed to load logs</div>';
            }
        }
        
        function renderLogs(data) {
            const { logs, total, filtered } = data;
            
            // Get current filter values before re-rendering
            const currentLevel = document.getElementById('level-filter')?.value || '';
            const currentCategory = document.getElementById('category-filter')?.value || '';
            
            let html = '<div style="margin-bottom: 16px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap;">';
            
            // Filters - preserve selected values
            html += '<select id="level-filter" onchange="saveFilters(); filterLogs()" style="padding: 6px; border-radius: 4px; border: 1px solid #d1d5db;">';
            html += '<option value=""' + (currentLevel === '' ? ' selected' : '') + '>All Levels</option>';
            html += '<option value="info"' + (currentLevel === 'info' ? ' selected' : '') + '>Info</option>';
            html += '<option value="warning"' + (currentLevel === 'warning' ? ' selected' : '') + '>Warning</option>';
            html += '<option value="error"' + (currentLevel === 'error' ? ' selected' : '') + '>Error</option>';
            html += '</select>';
            
            html += '<select id="category-filter" onchange="saveFilters(); filterLogs()" style="padding: 6px; border-radius: 4px; border: 1px solid #d1d5db;">';
            html += '<option value=""' + (currentCategory === '' ? ' selected' : '') + '>All Categories</option>';
            html += '<option value="HTTP"' + (currentCategory === 'HTTP' ? ' selected' : '') + '>HTTP</option>';
            html += '<option value="Backend"' + (currentCategory === 'Backend' ? ' selected' : '') + '>Backend</option>';
            html += '<option value="System"' + (currentCategory === 'System' ? ' selected' : '') + '>System</option>';
            html += '<option value="Tool"' + (currentCategory === 'Tool' ? ' selected' : '') + '>Tool</option>';
            html += '</select>';
            
            html += '<button class="btn-small" onclick="loadLogs()">Refresh</button>';
            html += '<button class="btn-small" onclick="clearLogs()">Clear Logs</button>';
            
            html += '<label style="display: flex; align-items: center; gap: 6px; cursor: pointer;">';
            html += '<input type="checkbox" id="auto-refresh" onchange="toggleAutoRefresh(this.checked)">';
            html += '<span style="font-size: 12px;">Auto-refresh (5s)</span>';
            html += '</label>';
            
            html += '<span style="font-size: 12px; color: #6b7280; margin-left: auto;">Showing ' + filtered + ' of ' + total + ' logs</span>';
            html += '</div>';
            
            if (logs.length === 0) {
                html += '<div style="text-align: center; padding: 40px; color: #6b7280;">No logs to display</div>';
            } else {
                html += '<div style="font-family: monospace; font-size: 12px; background: #1f2937; color: #f3f4f6; padding: 16px; border-radius: 6px; max-height: 600px; overflow-y: auto;">';
                
                logs.forEach(log => {
                    const time = new Date(log.timestamp).toLocaleTimeString();
                    const levelColor = log.level === 'error' ? '#ef4444' : log.level === 'warning' ? '#f59e0b' : '#10b981';
                    const levelBadge = log.level.toUpperCase().padEnd(7);
                    
                    html += '<div style="margin-bottom: 8px; border-left: 3px solid ' + levelColor + '; padding-left: 8px;">';
                    html += '<span style="color: #9ca3af;">' + time + '</span> ';
                    html += '<span style="color: ' + levelColor + '; font-weight: bold;">[' + levelBadge + ']</span> ';
                    html += '<span style="color: #60a5fa;">[' + log.category + ']</span> ';
                    html += '<span>' + log.message + '</span>';
                    
                    if (log.details) {
                        html += '<div style="margin-top: 4px; color: #9ca3af; padding-left: 12px;">';
                        html += JSON.stringify(log.details, null, 2).split('\\n').join('<br>');
                        html += '</div>';
                    }
                    
                    html += '</div>';
                });
                
                html += '</div>';
            }
            
            document.getElementById('logs-content').innerHTML = html;
            
            // Restore auto-refresh state from localStorage
            const autoRefreshCheckbox = document.getElementById('auto-refresh');
            const savedAutoRefresh = localStorage.getItem('autoRefreshEnabled');
            const shouldAutoRefresh = savedAutoRefresh === null ? true : savedAutoRefresh === 'true';
            autoRefreshCheckbox.checked = shouldAutoRefresh;
            if (shouldAutoRefresh) {
                toggleAutoRefresh(true);
            }
        }
        
        function saveFilters() {
            const level = document.getElementById('level-filter')?.value || '';
            const category = document.getElementById('category-filter')?.value || '';
            localStorage.setItem('logLevelFilter', level);
            localStorage.setItem('logCategoryFilter', category);
        }
        
        function loadSavedFilters() {
            const savedLevel = localStorage.getItem('logLevelFilter') || '';
            const savedCategory = localStorage.getItem('logCategoryFilter') || '';
            return { level: savedLevel, category: savedCategory };
        }
        
        function filterLogs() {
            const level = document.getElementById('level-filter')?.value || '';
            const category = document.getElementById('category-filter')?.value || '';
            const filter = {};
            if (level) filter.level = level;
            if (category) filter.category = category;
            loadLogs(filter);
        }
        
        function toggleAutoRefresh(enabled) {
            if (autoRefreshInterval) {
                clearInterval(autoRefreshInterval);
                autoRefreshInterval = null;
            }
            
            // Save state to localStorage
            localStorage.setItem('autoRefreshEnabled', enabled.toString());
            
            if (enabled) {
                autoRefreshInterval = setInterval(() => filterLogs(), 5000);
            }
        }
        
        async function clearLogs() {
            if (!confirm('Clear all logs?')) return;
            
            try {
                await fetch('/api/logs', { method: 'DELETE' });
                loadLogs();
            } catch (error) {
                alert('Failed to clear logs');
            }
        }
        
        async function setBackend(role) {
            const selectId = role === 'local' ? 'local-backend-select' : 'sota-backend-select';
            const backendId = document.getElementById(selectId).value;
            
            if (!backendId) return;
            
            try {
                const response = await fetch('/api/config/set-backend', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ role, backendId })
                });
                
                const result = await response.json();
                
                if (response.ok) {
                    alert('Default ' + role + ' backend updated to: ' + backendId + '\\n\\nConfiguration saved to settings file (env.settings / env-automated-tests.settings)');
                    // Reload models for the new backend
                    loadConfig();
                } else {
                    alert('Failed to update backend: ' + result.error);
                    loadConfig(); // Reload to reset selects
                }
            } catch (error) {
                alert('Failed to update backend: ' + error.message);
                loadConfig(); // Reload to reset selects
            }
        }
        
        async function loadModelsForBackend(backendId, role, selectedModel) {
            const selectId = role === 'local' ? 'local-model-select' : 'sota-model-select';
            const modelSelect = document.getElementById(selectId);
            
            try {
                const response = await fetch('/api/backends/' + backendId + '/models');
                const models = await response.json();
                
                modelSelect.innerHTML = '<option value="">Auto-select</option>';
                
                models.forEach(model => {
                    const option = document.createElement('option');
                    option.value = model;
                    option.textContent = model;
                    if (model === selectedModel) option.selected = true;
                    modelSelect.appendChild(option);
                });
            } catch (error) {
                modelSelect.innerHTML = '<option value="">Auto-select (failed to load models)</option>';
            }
        }
        
        async function setModel(role) {
            const selectId = role === 'local' ? 'local-model-select' : 'sota-model-select';
            const model = document.getElementById(selectId).value;
            
            if (!model) return;
            
            try {
                const response = await fetch('/api/config/set-model', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ role, model })
                });
                
                const result = await response.json();
                
                if (response.ok) {
                    alert('Default ' + role + ' model updated to: ' + model + '\\n\\nConfiguration saved to settings file (env.settings / env-automated-tests.settings)');
                } else {
                    alert('Failed to update model: ' + result.error);
                }
            } catch (error) {
                alert('Failed to update model: ' + error.message);
            }
        }
        
        async function runScenario(scenario, buttonElement) {
            const originalText = buttonElement.textContent;
            
            try {
                // Show loading state
                buttonElement.textContent = 'Running...';
                buttonElement.disabled = true;
                
                // Hide previous results
                document.getElementById('scenario-result').style.display = 'none';
                
                const response = await fetch('/api/scenarios/run', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ scenario, parameters: {} })
                });
                
                const result = await response.json();
                
                // Show result in the UI
                const resultDiv = document.getElementById('scenario-result');
                const resultTitle = document.getElementById('result-title');
                const resultStatus = document.getElementById('result-status');
                const resultMessage = document.getElementById('result-message');
                
                resultTitle.textContent = 'Scenario: ' + scenario;
                
                if (response.ok && result.status === 'completed') {
                    resultStatus.innerHTML = '<span style="color: #10b981; font-weight: bold;">✓ Success</span>';
                    // Format object results as JSON, keep strings as-is
                    const resultText = result.result 
                        ? (typeof result.result === 'object' ? JSON.stringify(result.result, null, 2) : result.result)
                        : (result.message || 'Scenario completed successfully');
                    resultMessage.textContent = resultText;
                } else {
                    resultStatus.innerHTML = '<span style="color: #ef4444; font-weight: bold;">✗ Failed</span>';
                    resultMessage.textContent = result.error || result.message || 'Scenario failed';
                }
                
                resultDiv.style.display = 'block';
                
                // Scroll to result
                resultDiv.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                
            } catch (error) {
                // Show error in the UI
                const resultDiv = document.getElementById('scenario-result');
                const resultTitle = document.getElementById('result-title');
                const resultStatus = document.getElementById('result-status');
                const resultMessage = document.getElementById('result-message');
                
                resultTitle.textContent = 'Scenario: ' + scenario;
                resultStatus.innerHTML = '<span style="color: #ef4444; font-weight: bold;">✗ Error</span>';
                resultMessage.textContent = error.message || 'Failed to run scenario';
                
                resultDiv.style.display = 'block';
                resultDiv.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            } finally {
                // Restore button state
                buttonElement.textContent = originalText;
                buttonElement.disabled = false;
            }
        }
    </script>
</body>
</html>
    `;
  }

  async start(): Promise<Server> {
    return new Promise<Server>((resolve, reject) => {
      try {
        const server = this.app.listen(this.port, this.host, () => {
          try {
            const addr = server.address();
            if (addr && typeof addr === 'object' && typeof (addr as any).port === 'number') {
              this.port = (addr as any).port;
            }
          } catch {
            // Ignore address errors
          }
          // Use process.stderr.write for clean output without triggering VS Code warnings
          process.stderr.write(`[MCP] HTTP server on http://${this.host}:${this.port}\n`);
          this.addLog('info', 'System', `HTTP server started on ${this.host}:${this.port}`);
          resolve(server);
        });
        server.on('error', (error: Error) => {
          this.addLog('error', 'System', 'Failed to start HTTP server', { error: error.message });
          reject(error);
        });
      } catch (error) {
        this.addLog('error', 'System', 'Failed to start HTTP server', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        reject(error);
      }
    });
  }
}
