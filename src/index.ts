#!/usr/bin/env node
/**
 * This file exports Input and helpers for safe foo handling.
 * Note: This top-of-file comment documents the module's purpose.
 */

import { McpServer } from './server/mcp.js';
import { HttpServer } from './server/http.js';
import { ConfigManager } from './config/index.js';
import { Server } from 'http';
import { format } from 'util';

// SAFETY NET: Redirect all console.log/warn to stderr to prevent MCP protocol violation.
// This is critical because any text written to stdout will break the JSON-RPC communication.
// const originalConsoleLog = console.log;
// const originalConsoleWarn = console.warn;

console.log = (...args: any[]) => {
  process.stderr.write(format(...args) + '\n');
};

console.warn = (...args: any[]) => {
  process.stderr.write(format(...args) + '\n');
};

// Store server references for graceful shutdown
let httpServerInstance: Server | null = null;
let mcpServerInstance: McpServer | null = null;
let isShuttingDown = false;
const shutdownOnStdin = process.env.MCP_STDIN_SHUTDOWN !== '0';

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  // Use process.stderr.write for shutdown messages to avoid MCP protocol interference
  process.stderr.write(`\n[MCP] Received ${signal}, shutting down gracefully...\n`);

  // 1. Stop health monitor first (prevents new checks during shutdown)
  try {
    const { getHealthMonitor } = await import('./utils/health-monitor.js');
    const monitor = getHealthMonitor();
    if (monitor) {
      monitor.stop();
      process.stderr.write('[MCP] Health monitor stopped\n');
    }
  } catch {
    // Health monitor may not be initialized
  }

  // 2. Save cache before shutdown
  try {
    const { saveCacheOnShutdown } = await import('./utils/llm-cache.js');
    saveCacheOnShutdown();
    process.stderr.write('[MCP] Cache saved\n');
  } catch {
    // Cache persistence may not be initialized
  }

  // 3. Disconnect ALL external MCP servers (prevents orphaned child processes)
  if (mcpServerInstance) {
    try {
      await mcpServerInstance.disconnectAllMcpClients();
      process.stderr.write('[MCP] External MCP servers disconnected\n');
    } catch (error) {
      process.stderr.write(`[MCP] Error disconnecting MCP clients: ${error}\n`);
    }
  }

  // 4. Close HTTP server
  if (httpServerInstance) {
    httpServerInstance.close(() => {
      process.stderr.write('[MCP] HTTP server closed\n');
    });
  }

  // Give a longer timeout for cleanup to complete, then force exit
  setTimeout(() => {
    process.stderr.write('[MCP] Shutdown complete\n');
    process.exit(0);
  }, 1000);
}

// Register signal handlers for graceful shutdown
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));

// Process-level error handlers to prevent crashes during concurrent execution
process.on('uncaughtException', (error: Error) => {
  process.stderr.write(`[MCP] UNCAUGHT EXCEPTION: ${error.message}\n`);
  process.stderr.write(`[MCP] Stack: ${error.stack}\n`);
  // Don't exit - try to keep serving other requests
  // But log clearly for debugging
});

process.on('unhandledRejection', (reason: unknown, _promise: Promise<unknown>) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : '';
  process.stderr.write(`[MCP] UNHANDLED REJECTION: ${msg}\n`);
  if (stack) process.stderr.write(`[MCP] Stack: ${stack}\n`);
  // Don't exit - try to keep serving other requests
});

// V17: Parent-PID monitoring for IDE-managed scenarios
// Addresses QA feedback: "ensure IDE-launched servers self-terminate when parent stops"
let parentPidWatchInterval: ReturnType<typeof setInterval> | null = null;

function startParentPidWatch(parentPid: number) {
  // Check every 2 seconds if parent process is still alive
  parentPidWatchInterval = setInterval(() => {
    try {
      // process.kill(pid, 0) returns true if process exists, throws if not
      process.kill(parentPid, 0);
    } catch {
      // Parent process gone - trigger graceful shutdown
      process.stderr.write(`[MCP] Parent process ${parentPid} terminated, shutting down...\n`);
      if (parentPidWatchInterval) {
        clearInterval(parentPidWatchInterval);
        parentPidWatchInterval = null;
      }
      gracefulShutdown('parent-pid-exit');
    }
  }, 2000);
}

if (shutdownOnStdin) {
  // Handle stdin close (VS Code closing the MCP connection)
  process.stdin.on('close', () => {
    if (!isShuttingDown) {
      gracefulShutdown('stdin close');
    }
  });

  // Handle stdin end
  process.stdin.on('end', () => {
    if (!isShuttingDown) {
      gracefulShutdown('stdin end');
    }
  });
}

async function main() {
  try {
    // Parse CLI arguments for workspace path
    // VS Code mcp.json supports ${workspaceFolder} in args but NOT in env
    // Accept: --workspace=/path or --workspace /path or just /path as first arg
    let configPath: string | undefined;
    let workspacePath: string | undefined;
    let parentPid: number | undefined;

    for (let i = 2; i < process.argv.length; i++) {
      const arg = process.argv[i];
      if (arg.startsWith('--workspace=')) {
        workspacePath = arg.substring('--workspace='.length);
      } else if (arg === '--workspace' && process.argv[i + 1]) {
        workspacePath = process.argv[++i];
      } else if (arg.startsWith('--settings=')) {
        configPath = arg.substring('--settings='.length);
      } else if (arg === '--settings' && process.argv[i + 1]) {
        configPath = process.argv[++i];
      } else if (arg.startsWith('--config=')) {
        configPath = arg.substring('--config='.length);
      } else if (arg === '--config' && process.argv[i + 1]) {
        configPath = process.argv[++i];
      } else if (arg.startsWith('--mcp-parent-pid=')) {
        // V17: Parent-PID for IDE-managed scenarios
        parentPid = parseInt(arg.substring('--mcp-parent-pid='.length), 10);
      } else if (arg === '--mcp-parent-pid' && process.argv[i + 1]) {
        parentPid = parseInt(process.argv[++i], 10);
      } else if (!configPath && !arg.startsWith('-')) {
        // Backwards compatibility: first non-flag arg is config path
        configPath = arg;
      }
    }

    // V17: Start parent-PID monitoring if provided via CLI or env
    const envParentPid = process.env.MCP_PARENT_PID
      ? parseInt(process.env.MCP_PARENT_PID, 10)
      : undefined;
    const effectiveParentPid = parentPid || envParentPid;
    if (effectiveParentPid && !isNaN(effectiveParentPid)) {
      process.stderr.write(
        `[MCP] Monitoring parent process ${effectiveParentPid} for IDE-managed shutdown\n`
      );
      startParentPidWatch(effectiveParentPid);
    }

    // If workspace was provided via CLI arg, set WORKSPACE_ROOT env var
    // This allows VS Code's ${workspaceFolder} to work via args
    if (workspacePath && !process.env.WORKSPACE_ROOT) {
      process.env.WORKSPACE_ROOT = workspacePath;
      process.stderr.write(`[MCP] Workspace from CLI: ${workspacePath}\n`);
    }

    configPath =
      configPath || process.env.MCP_LOCAL_LLM_SETTINGS_PATH || process.env.MCP_LOCAL_LLM_CONFIG;

    // Create config manager
    const config = new ConfigManager(configPath);

    // Intentionally not mounting external health router here to avoid coupling to
    // optional modules not present in all environments. Health is served by the
    // dedicated health controller in the HTTP server path.

    // Debug: Log workspace configuration
    process.stderr.write(`[MCP] Settings: ${configPath || 'auto-detected'}\n`);
    process.stderr.write(`[MCP] cwd: ${process.cwd()}\n`);
    process.stderr.write(`[MCP] WORKSPACE_ROOT: ${process.env.WORKSPACE_ROOT || '(not set)'}\n`);
    process.stderr.write(`[MCP] Active workspace: ${config.getDefaultWorkspaceRoot()}\n`);

    // Create and start MCP server (share ConfigManager with HTTP UI)
    const mcpServer = new McpServer(config);
    mcpServerInstance = mcpServer; // Store reference for graceful shutdown

    // Start MCP server in background (non-blocking)
    mcpServer.run().catch((error) => {
      process.stderr.write(`[MCP] Server error: ${error}\n`);
      process.exit(1);
    });

    // Create and start HTTP server
    const backendManager = new (await import('./adapters/factory.js')).BackendManager(
      config.getConfig().backends
    );

    // Initialize health monitor for proactive backend health checking
    const { initHealthMonitor } = await import('./utils/health-monitor.js');
    const healthMonitor = initHealthMonitor(backendManager, {
      checkIntervalMs: 30000, // Check every 30 seconds
      cacheTtlMs: 15000, // Cache valid for 15 seconds
    });
    healthMonitor.start();

    // Initialize cache persistence for LLM response caching
    const { initCachePersistence } = await import('./utils/llm-cache.js');
    initCachePersistence({
      autoSaveIntervalMs: 300000, // Auto-save every 5 minutes
    });

    const httpServer = new HttpServer(config, backendManager, {
      onMcpServersChanged: () => mcpServer.refreshExternalServers(),
      onBackendsChanged: () => mcpServer.refreshBackends(),
      toolProvider: {
        listLocalTools: (options) => mcpServer.getLocalToolManifest(options),
        getLocalToolSchema: (toolName) => mcpServer.getLocalToolSchema(toolName),
        executeTool: (toolName, args, onProgress) =>
          mcpServer.executeTool(toolName, args, onProgress),
      },
    });
    httpServerInstance = await httpServer.start();

    // Minimal startup message
    if (httpServerInstance) {
      const serverHost = config.getConfig().server?.host ?? '127.0.0.1';
      const configuredPort = config.getConfig().server?.port ?? 3000;
      const addr = httpServerInstance.address();
      const boundPort =
        addr && typeof addr === 'object' && typeof (addr as any).port === 'number'
          ? (addr as any).port
          : configuredPort;
      process.stderr.write(`[MCP] Server ready - Web UI: http://${serverHost}:${boundPort}\n`);
    } else {
      process.stderr.write(`[MCP] Server ready - Web UI: (Deferred to existing instance)\n`);
    }
  } catch (error) {
    process.stderr.write(`[MCP] Failed to start: ${error}\n`);
    process.exit(1);
  }
}

// Run if this is the main module
// Public API: refactoring helpers for input validation
export type Input = { foo: string };
export type DoThingResult = { ok: true; value: string } | { ok: false; error: string };
export function getValidatedFoo(input?: Input, defaultValue?: string): string {
  if (!input) {
    if (defaultValue !== undefined) return defaultValue;
    return '';
  }
  // input is defined; extra guard against undefined foo for safety
  if (input.foo === undefined) {
    return defaultValue !== undefined ? defaultValue : '';
  }
  // input.foo is a string
  const foo = input.foo;
  return foo;
}
export function doThing(input?: Input, defaultValue?: string): string {
  return getValidatedFoo(input, defaultValue);
}
export function doThingSafe(input?: Input, defaultValue?: string): DoThingResult {
  if (!input) {
    if (defaultValue !== undefined) return { ok: true, value: defaultValue };
    return { ok: false, error: 'doThingSafe: input is undefined and no defaultValue provided' };
  }
  const foo = input.foo;
  return { ok: true, value: foo };
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[MCP] Unhandled error: ${error}\n`);
    process.exit(1);
  });
}
