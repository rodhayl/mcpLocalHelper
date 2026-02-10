/**
 * MCP Client Manager
 *
 * Manages connections to external MCP servers, allowing the local LLM
 * to call tools from other MCP servers (like chrome-devtools).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpServerConfig, McpServersConfig, TimeoutsConfig } from '../types/index.js';
import { debug } from './debug-logger.js';
import { execFile } from 'node:child_process';

// Default timeout values (used when no config provided)
const DEFAULT_MCP_TIMEOUTS = {
  mcpClientLock: 30000,
  mcpClientConnect: 15000,
  mcpClientCall: 30000,
};

interface McpTool {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, object>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

interface ConnectedServer {
  client: Client;
  transport: StdioClientTransport;
  tools: McpTool[];
  serverName: string;
}

export interface McpCallResult {
  success: boolean;
  content: unknown;
  isError?: boolean;
  error?: string;
  meta?: {
    strippedArgs?: string[];
    coercedArgs?: string[];
  };
}

export class McpClientManager {
  private servers: Map<string, ConnectedServer> = new Map();
  private config: McpServersConfig;
  private timeoutsGetter: (() => Partial<TimeoutsConfig>) | null = null;
  private connecting: Map<string, Promise<void>> = new Map();
  private disconnecting: Map<string, Promise<void>> = new Map();
  // Simplified lock: single promise chain per server to prevent interleaved operations
  private serverLocks: Map<string, Promise<void>> = new Map();
  // Generation counter for safe lock cleanup - incremented each time a lock is acquired
  private lockGenerations: Map<string, number> = new Map();
  // Track active lock holders per server for debugging
  private activeLockHolders: Map<string, number> = new Map();
  // Track connection state to avoid redundant operations
  private connectionStates: Map<
    string,
    'connecting' | 'connected' | 'disconnecting' | 'disconnected'
  > = new Map();
  // Track last lock cleanup time for periodic cleanup
  private lastLockCleanupTime = 0;
  private readonly lockCleanupIntervalMs = 60000; // Cleanup stale locks every 60 seconds

  constructor(mcpServersConfig?: McpServersConfig, timeoutsGetter?: () => Partial<TimeoutsConfig>) {
    this.config = mcpServersConfig || {};
    this.timeoutsGetter = timeoutsGetter || null;
  }

  private getLockTimeoutMs(): number {
    return this.timeoutsGetter?.()?.mcpClientLock ?? DEFAULT_MCP_TIMEOUTS.mcpClientLock;
  }

  private getConnectTimeoutMs(): number {
    return this.timeoutsGetter?.()?.mcpClientConnect ?? DEFAULT_MCP_TIMEOUTS.mcpClientConnect;
  }

  private getCallTimeoutMs(): number {
    return this.timeoutsGetter?.()?.mcpClientCall ?? DEFAULT_MCP_TIMEOUTS.mcpClientCall;
  }

  private withTimeout<T>(
    label: string,
    promise: Promise<T>,
    timeoutMs: number,
    onTimeout: () => void
  ): Promise<T> {
    const ms = Math.max(1, Math.floor(timeoutMs));
    return new Promise<T>((resolve, reject) => {
      let settled = false;

      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          onTimeout();
        } catch {
          // ignore
        }
        reject(new Error(`${label} timed out after ${ms}ms`));
      }, ms);

      promise.then(
        (v) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          resolve(v);
        },
        (e) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          reject(e);
        }
      );
    });
  }

  private resolveServerName(input: string): string {
    const name = String(input || '').trim();
    if (!name) return name;
    if (name in this.config) return name;
    const lower = name.toLowerCase();
    const match = Object.keys(this.config).find((k) => k.toLowerCase() === lower);
    return match || name;
  }

  /**
   * Periodically cleanup any stale lock state to prevent memory leaks
   */
  private cleanupStaleLocks(): void {
    const now = Date.now();
    if (now - this.lastLockCleanupTime < this.lockCleanupIntervalMs) {
      return;
    }
    this.lastLockCleanupTime = now;

    // Clean up lock state for servers that have no active holders
    // and are in a stable state (connected or disconnected)
    for (const [name, holders] of this.activeLockHolders.entries()) {
      if (holders === 0) {
        const state = this.connectionStates.get(name);
        if (state === 'connected' || state === 'disconnected' || state === undefined) {
          this.serverLocks.delete(name);
          this.lockGenerations.delete(name);
          this.activeLockHolders.delete(name);
        }
      }
    }
  }

  private async withServerLock<T>(serverName: string, fn: () => Promise<T>): Promise<T> {
    const name = serverName;

    // Trigger periodic cleanup
    this.cleanupStaleLocks();

    // Get current lock chain (or resolved promise if none)
    const previous = this.serverLocks.get(name) ?? Promise.resolve();

    // Increment generation counter atomically
    const currentGen = (this.lockGenerations.get(name) ?? 0) + 1;
    this.lockGenerations.set(name, currentGen);

    // Track active lock holders for debugging and cleanup
    const currentHolders = this.activeLockHolders.get(name) ?? 0;
    this.activeLockHolders.set(name, currentHolders + 1);

    // Create a new promise that will be resolved when our operation completes
    let resolveOurLock: (() => void) | undefined;
    let lockReleased = false;
    const ourLockPromise = new Promise<void>((resolve) => {
      resolveOurLock = () => {
        if (!lockReleased) {
          lockReleased = true;
          resolve();
        }
      };
    });

    // Chain our lock onto the previous one
    const chainedPromise = previous
      .catch(() => {}) // Ignore errors from previous operations
      .then(() => ourLockPromise);

    this.serverLocks.set(name, chainedPromise);

    // Wait for previous operation to complete with timeout
    let timeoutId: NodeJS.Timeout | undefined;
    const lockTimeoutMs = this.getLockTimeoutMs();
    const timeoutPromise = new Promise<void>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Lock acquisition timeout for ${name} after ${lockTimeoutMs}ms`));
      }, lockTimeoutMs);
    });

    try {
      await Promise.race([previous.catch(() => {}), timeoutPromise]);
    } catch (e) {
      // On timeout, release our lock and update holder count
      resolveOurLock?.();
      const holders = this.activeLockHolders.get(name) ?? 0;
      this.activeLockHolders.set(name, Math.max(0, holders - 1));
      throw e;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }

    try {
      return await fn();
    } finally {
      // Release our lock
      resolveOurLock?.();

      // Update holder count
      const holders = this.activeLockHolders.get(name) ?? 0;
      this.activeLockHolders.set(name, Math.max(0, holders - 1));

      // Clean up only if:
      // 1. Our generation is still the latest
      // 2. No other holders are active
      // This prevents premature cleanup when multiple operations are chained
      if (
        this.lockGenerations.get(name) === currentGen &&
        (this.activeLockHolders.get(name) ?? 0) === 0
      ) {
        this.serverLocks.delete(name);
        this.lockGenerations.delete(name);
        this.activeLockHolders.delete(name);
      }
    }
  }

  private async connectUnlocked(name: string): Promise<void> {
    // Quick check if already connected (shouldn't happen due to caller checks, but defensive)
    if (this.servers.has(name)) {
      this.connectionStates.set(name, 'connected');
      return;
    }

    const serverConfig = this.config[name];
    if (!serverConfig) {
      const configuredServers = Object.keys(this.config);
      const hint =
        configuredServers.length > 0
          ? `Configured servers: ${configuredServers.join(', ')}. Check spelling or add '${name}' under mcpServers in your settings file (env.settings / env-automated-tests.settings).`
          : `No external MCP servers configured. Add servers under mcpServers in your settings file (env.settings / env-automated-tests.settings).`;
      throw new Error(`MCP server '${name}' not found in configuration. ${hint}`);
    }

    // State should already be 'connecting' from connect() - log for debugging
    debug.info('client', `Connecting to ${name}...`);
    const resolvedArgs = this.resolveArgs(serverConfig);
    debug.debug('client', `Spawn: ${serverConfig.command} ${resolvedArgs.join(' ') || ''}`);

    try {
      await this.withRetries(`connect(${name})`, async () => {
        const transport = new StdioClientTransport({
          command: serverConfig.command,
          args: resolvedArgs,
          env: serverConfig.env,
        });

        const client = new Client(
          { name: 'mcp-local-llm', version: '1.0.0' },
          { capabilities: {} }
        );

        try {
          const pid = transport.pid;
          const timeoutMs = this.getConnectTimeoutMs();
          const stop = () => {
            void transport.close().catch(() => undefined);
            void this.ensureChildProcessStopped(pid, name).catch(() => undefined);
          };

          await this.withTimeout(`connect(${name})`, client.connect(transport), timeoutMs, stop);

          const toolsResult = await this.withTimeout(
            `listTools(${name})`,
            client.listTools(),
            timeoutMs,
            stop
          );
          const tools = toolsResult.tools as McpTool[];

          this.servers.set(name, {
            client,
            transport,
            tools,
            serverName: name,
          });

          this.connectionStates.set(name, 'connected');
          debug.info('client', `Connected to ${name}`, { tools: tools.length });
          return;
        } catch (error) {
          const pid = transport.pid;
          try {
            await transport.close();
          } catch {
            // Intentionally empty - transport close errors handled by ensureChildProcessStopped
          }
          await this.ensureChildProcessStopped(pid, name).catch(() => undefined);
          throw error;
        }
      });
    } catch (error) {
      this.connectionStates.set(name, 'disconnected');
      throw error;
    }
  }

  private async disconnectUnlocked(name: string): Promise<void> {
    const state = this.connectionStates.get(name);
    if (state === 'disconnected') {
      return;
    }

    const server = this.servers.get(name);
    if (!server) {
      this.connectionStates.set(name, 'disconnected');
      return;
    }

    this.connectionStates.set(name, 'disconnecting');
    const pid = server.transport.pid;
    await this.ensureChildProcessStopped(pid, name).catch(() => undefined);
    try {
      await server.transport.close();
    } catch (error) {
      debug.warn('client', `Error closing transport for ${name}`, { error: String(error) });
    } finally {
      this.servers.delete(name);
      this.connectionStates.set(name, 'disconnected');
    }
    debug.info('client', `Disconnected from ${name}`);
  }

  private getRetryConfig(): { retries: number; delayMs: number; backoff: number } {
    const retriesRaw = process.env.MCP_CLIENT_RETRIES;
    const delayRaw = process.env.MCP_CLIENT_RETRY_DELAY_MS;
    const backoffRaw = process.env.MCP_CLIENT_RETRY_BACKOFF;

    const retries = retriesRaw ? Math.max(0, Number.parseInt(retriesRaw, 10)) : 3;
    const delayMs = delayRaw ? Math.max(0, Number.parseInt(delayRaw, 10)) : 200;
    const backoff = backoffRaw ? Math.max(1, Number.parseFloat(backoffRaw)) : 1.8;

    return {
      retries: Number.isFinite(retries) ? retries : 3,
      delayMs: Number.isFinite(delayMs) ? delayMs : 200,
      backoff: Number.isFinite(backoff) ? backoff : 1.8,
    };
  }

  private async sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise((r) => setTimeout(r, ms));
  }

  private isPidAlive(pid: number): boolean {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private async waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (Date.now() < deadline) {
      if (!this.isPidAlive(pid)) return true;
      await this.sleep(50);
    }
    return !this.isPidAlive(pid);
  }

  private async ensureChildProcessStopped(pid: number | null, serverName: string): Promise<void> {
    if (!pid || pid <= 0) return;

    debug.debug('client', `Ensuring MCP server process is stopped: ${serverName}`, { pid });

    // On Windows, killing the parent process does NOT reliably terminate child processes.
    // Use taskkill /T to terminate the full tree while we still have the root PID.
    if (process.platform === 'win32') {
      debug.debug('client', `Terminating MCP server process tree (taskkill): ${serverName}`, {
        pid,
      });
      await new Promise<void>((resolve) => {
        execFile(
          'taskkill',
          ['/PID', String(pid), '/T', '/F'],
          { windowsHide: true },
          (error, _stdout, stderr) => {
            if (error) {
              // PID might already be gone; only warn if it still appears alive.
              const stillAlive = this.isPidAlive(pid);
              const level = stillAlive ? 'warn' : 'debug';
              debug[level](
                'client',
                `taskkill ${stillAlive ? 'failed' : 'no-op'} for ${serverName}`,
                {
                  pid,
                  error: String(error),
                  stderr: String(stderr || ''),
                }
              );
            }
            resolve();
          }
        );
      });
      await this.waitForPidExit(pid, 800);
      return;
    }

    // Give the SDK transport a short grace period to shut down cleanly.
    if (await this.waitForPidExit(pid, 800)) {
      debug.debug('client', `MCP server process already exited: ${serverName}`, { pid });
      return;
    }

    // Best-effort terminate the process (and its children on Windows).
    debug.debug('client', `Sending SIGTERM to MCP server process: ${serverName}`, { pid });
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Intentionally empty - process may already be terminated
    }

    if (await this.waitForPidExit(pid, 800)) return;

    {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Intentionally empty - process may already be terminated
      }
    }

    if (!(await this.waitForPidExit(pid, 800)) && this.isPidAlive(pid)) {
      debug.warn('client', `Child process for ${serverName} still alive after shutdown attempts`, {
        pid,
      });
    }
  }

  private isTransientError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    return (
      msg.includes('Connection closed') ||
      msg.includes('ECONNRESET') ||
      msg.includes('EPIPE') ||
      msg.includes('timed out') ||
      msg.includes('spawn') ||
      msg.includes('ENOENT')
    );
  }

  private async withRetries<T>(label: string, fn: (attempt: number) => Promise<T>): Promise<T> {
    const { retries, delayMs, backoff } = this.getRetryConfig();
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fn(attempt);
      } catch (e) {
        lastError = e;
        const transient = this.isTransientError(e);
        if (attempt >= retries || !transient) {
          throw e;
        }
        const wait = Math.round(delayMs * Math.pow(backoff, attempt));
        debug.warn('client', `${label} failed, retrying`, {
          attempt: attempt + 1,
          maxAttempts: retries + 1,
          error: String(e),
          waitMs: wait,
        });
        await this.sleep(wait);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private resolveArgs(serverConfig: McpServerConfig): string[] {
    let args = serverConfig.args ? [...serverConfig.args] : [];

    // If using npx, default to "-y" to avoid interactive prompts that break stdio MCP.
    const cmd = serverConfig.command.toLowerCase();
    const isNpx =
      cmd === 'npx' ||
      cmd.endsWith('\\npx.cmd') ||
      cmd.endsWith('/npx') ||
      cmd.endsWith('/npx.cmd');
    if (isNpx) {
      const hasYes = args.some((a) => a === '-y' || a === '--yes');
      if (!hasYes) {
        args = ['-y', ...args];
      }
    }

    const commandHasChrome = serverConfig.command.toLowerCase().includes('chrome-devtools-mcp');
    const argsHaveChrome = args.some((a) => a.toLowerCase().includes('chrome-devtools-mcp'));
    if (!(commandHasChrome || argsHaveChrome)) {
      return args;
    }

    const hasIsolated = args.some((a) => a === '--isolated');
    const hasProfileDir = args.some(
      (a) => a.startsWith('--profile-dir') || a.startsWith('--user-data-dir')
    );
    if (hasIsolated || hasProfileDir) {
      return args;
    }

    debug.info('client', 'Detected chrome-devtools-mcp without isolation; adding --isolated');
    return [...args, '--isolated'];
  }

  /**
   * Connect to an MCP server by name
   */
  async connect(serverName: string): Promise<void> {
    const name = this.resolveServerName(serverName);

    // Fast path: already connected (check both state and server existence)
    const state = this.connectionStates.get(name);
    if (state === 'connected' && this.servers.has(name)) {
      debug.debug('client', `Already connected to ${name}`);
      return;
    }

    // Fast path: connection already in progress - reuse that promise
    if (state === 'connecting') {
      const inflight = this.connecting.get(name);
      if (inflight) {
        return inflight;
      }
    }

    // Mark as connecting before creating promise to prevent race conditions
    this.connectionStates.set(name, 'connecting');

    const connectPromise = this.withServerLock(name, async () => {
      // Double-check after acquiring lock - state might have changed
      const currentState = this.connectionStates.get(name);
      if (currentState === 'connected' && this.servers.has(name)) {
        return;
      }
      // Reset state in case it was changed during lock acquisition
      this.connectionStates.set(name, 'connecting');
      await this.connectUnlocked(name);
    })
      .catch((error) => {
        // On error, reset state to disconnected
        this.connectionStates.set(name, 'disconnected');
        throw error;
      })
      .finally(() => {
        this.connecting.delete(name);
      });

    this.connecting.set(name, connectPromise);
    return connectPromise;
  }

  /**
   * Disconnect from an MCP server
   */
  async disconnect(serverName: string): Promise<void> {
    const name = this.resolveServerName(serverName);
    const state = this.connectionStates.get(name);

    // Fast path: already disconnected or not connected
    if (
      state === 'disconnected' ||
      (state !== 'connected' && state !== 'connecting' && !this.servers.has(name))
    ) {
      return;
    }

    // Fast path: disconnection already in progress - reuse that promise
    if (state === 'disconnecting') {
      const inflight = this.disconnecting.get(name);
      if (inflight) return inflight;
    }

    // Mark as disconnecting before creating promise
    this.connectionStates.set(name, 'disconnecting');

    const disconnectPromise = this.withServerLock(name, async () => {
      await this.disconnectUnlocked(name);
    }).finally(() => {
      this.disconnecting.delete(name);
      // Ensure state is set to disconnected even if disconnectUnlocked threw
      if (this.connectionStates.get(name) === 'disconnecting') {
        this.connectionStates.set(name, 'disconnected');
      }
    });

    this.disconnecting.set(name, disconnectPromise);
    return disconnectPromise;
  }

  /**
   * Disconnect from all MCP servers
   */
  async disconnectAll(): Promise<void> {
    const disconnectPromises = Array.from(this.servers.keys()).map((name) => this.disconnect(name));
    await Promise.all(disconnectPromises);
  }

  /**
   * Check if connected to a server
   */
  isConnected(serverName: string): boolean {
    const name = this.resolveServerName(serverName);
    // Use state machine for accurate connection status
    return this.connectionStates.get(name) === 'connected' && this.servers.has(name);
  }

  /**
   * Get list of configured servers
   */
  getConfiguredServers(): string[] {
    return Object.keys(this.config);
  }

  /**
   * Get list of connected servers
   */
  getConnectedServers(): string[] {
    return Array.from(this.servers.keys());
  }

  /**
   * Get available tools from a connected server
   */
  getTools(serverName: string): McpTool[] {
    const name = this.resolveServerName(serverName);
    const server = this.servers.get(name);
    if (!server) {
      return [];
    }
    return server.tools;
  }

  /**
   * Get all available tools from all connected servers
   */
  getAllTools(): { serverName: string; tool: McpTool }[] {
    const allTools: { serverName: string; tool: McpTool }[] = [];
    for (const [serverName, server] of this.servers) {
      for (const tool of server.tools) {
        allTools.push({ serverName, tool });
      }
    }
    return allTools;
  }

  /**
   * Call a tool on a connected MCP server
   */
  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown> = {}
  ): Promise<McpCallResult> {
    const name = this.resolveServerName(serverName);

    // Check connection state before attempting to connect
    const state = this.connectionStates.get(name);

    if (state === 'connecting') {
      // Wait for in-flight connection to complete
      const connectingPromise = this.connecting.get(name);
      if (connectingPromise) {
        try {
          await connectingPromise;
        } catch (error) {
          return {
            success: false,
            content: null,
            isError: true,
            error: error instanceof Error ? error.message : 'Connection failed while waiting',
          };
        }
      }
    } else if (state !== 'connected' || !this.servers.has(name)) {
      // Not connected and not connecting - attempt connection
      try {
        await this.connect(name);
      } catch (error) {
        return {
          success: false,
          content: null,
          isError: true,
          error: error instanceof Error ? error.message : 'Failed to connect',
        };
      }
    }

    return this.withServerLock(name, async () => {
      // Re-validate connection state after acquiring lock (may have changed)
      const currentState = this.connectionStates.get(name);
      if (currentState !== 'connected' || !this.servers.has(name)) {
        return {
          success: false,
          content: null,
          isError: true,
          error: `Connection to MCP server '${name}' was lost during operation (state: ${currentState || 'unknown'}).`,
        };
      }

      let server = this.servers.get(name);
      if (!server) {
        return {
          success: false,
          content: null,
          isError: true,
          error: `Not connected to MCP server '${name}'.`,
        };
      }

      // Verify the tool exists
      const tool = server.tools.find((t) => t.name === toolName);
      if (!tool) {
        const availableTools = server.tools.map((t) => t.name).join(', ');
        return {
          success: false,
          content: null,
          isError: true,
          error: `Tool '${toolName}' not found on server '${name}'. Available tools: ${availableTools}`,
        };
      }

      const { sanitized, strippedKeys, coercedKeys } = this.sanitizeArgsForTool(tool, args);
      const timeoutMs = this.getCallTimeoutMs();

      try {
        const result = await this.withRetries(`callTool(${name}:${toolName})`, async () => {
          try {
            const activeServer = server;
            if (!activeServer) {
              throw new Error(`Not connected to MCP server '${name}'.`);
            }
            return await activeServer.client.callTool(
              {
                name: toolName,
                arguments: sanitized,
              },
              undefined,
              { timeout: timeoutMs }
            );
          } catch (e) {
            // If the connection died, do a best-effort reconnect before retrying.
            if (this.isTransientError(e)) {
              debug.warn('client', `Transient error calling ${name}:${toolName}; reconnecting`, {
                error: String(e),
              });
              await this.disconnectUnlocked(name).catch(() => undefined);
              await this.connectUnlocked(name);
              const refreshed = this.servers.get(name);
              if (refreshed) server = refreshed;
            }
            throw e;
          }
        });

        // Extract content from the result
        let content: unknown = result;
        if ('content' in result && Array.isArray((result as any).content)) {
          // Combine text content
          content = (result as any).content
            .filter((c: any): c is { type: 'text'; text: string } => c.type === 'text')
            .map((c: any) => c.text)
            .join('\n');
        }

        const isError = (result as any).isError === true;
        return {
          success: !isError,
          content,
          isError,
          error: isError && typeof content === 'string' && content.trim() ? content : undefined,
          meta:
            strippedKeys.length || coercedKeys.length
              ? { strippedArgs: strippedKeys, coercedArgs: coercedKeys }
              : undefined,
        };
      } catch (error) {
        debug.error('client', `Tool call failed: ${name}:${toolName}`, {
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          success: false,
          content: null,
          isError: true,
          error: error instanceof Error ? error.message : 'Unknown error',
          meta:
            strippedKeys.length || coercedKeys.length
              ? { strippedArgs: strippedKeys, coercedArgs: coercedKeys }
              : undefined,
        };
      }
    });
  }

  /**
   * Auto-connect to servers marked with autoConnect: true
   */
  async autoConnect(): Promise<void> {
    for (const [serverName, config] of Object.entries(this.config)) {
      if (config.autoConnect) {
        try {
          await this.connect(serverName);
        } catch (error) {
          debug.warn('client', `Auto-connect failed for ${serverName}`, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  /**
   * Get server configuration
   */
  getServerConfig(serverName: string): McpServerConfig | undefined {
    const name = this.resolveServerName(serverName);
    return this.config[name];
  }

  /**
   * Update configuration (for runtime changes)
   */
  updateConfig(newConfig: McpServersConfig): void {
    this.config = newConfig;
  }

  private sanitizeArgsForTool(
    tool: McpTool,
    args: Record<string, unknown>
  ): { sanitized: Record<string, unknown>; strippedKeys: string[]; coercedKeys: string[] } {
    const schema: any = tool?.inputSchema;
    const props: any = schema?.properties;

    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return { sanitized: {}, strippedKeys: [], coercedKeys: [] };
    }

    const additionalProperties = schema?.additionalProperties;
    if (additionalProperties !== false) {
      // No strict schema: pass through unchanged.
      return { sanitized: { ...args }, strippedKeys: [], coercedKeys: [] };
    }

    if (!props || typeof props !== 'object' || Array.isArray(props)) {
      // Strict schema but missing properties: avoid stripping everything.
      return { sanitized: { ...args }, strippedKeys: [], coercedKeys: [] };
    }

    const allowed = new Set(Object.keys(props));
    const strippedKeys: string[] = [];
    const coercedKeys: string[] = [];

    for (const k of Object.keys(args)) {
      if (!allowed.has(k)) strippedKeys.push(k);
    }

    const sanitized: Record<string, unknown> = {};
    for (const k of allowed) {
      if (!(k in args)) continue;
      const v = (args as any)[k];
      const propSchema: any = props[k];

      const type = propSchema?.type;
      const types = Array.isArray(type) ? type : type ? [type] : [];

      if ((types.includes('number') || types.includes('integer')) && typeof v === 'string') {
        const trimmed = v.trim();
        const n = types.includes('integer')
          ? Number.parseInt(trimmed, 10)
          : Number.parseFloat(trimmed);
        if (Number.isFinite(n) && trimmed !== '') {
          sanitized[k] = n;
          coercedKeys.push(k);
          continue;
        }
      }

      if (types.includes('boolean') && typeof v === 'string') {
        const trimmed = v.trim().toLowerCase();
        if (trimmed === 'true' || trimmed === 'false') {
          sanitized[k] = trimmed === 'true';
          coercedKeys.push(k);
          continue;
        }
      }

      sanitized[k] = v;
    }

    return { sanitized, strippedKeys, coercedKeys };
  }
}
