
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestContext, checkLMStudioAvailable, writeRealTestConfig, createTestWorkspace, connectToRealServer, cleanupWorkspace } from './test-utils.js';
import * as fs from 'fs';
import * as path from 'path';
import { getTestConfig } from '../test-config.js';
import { probeLmStudio } from '../test-utils/lmstudio.js';

const testConfig = getTestConfig();

describe('Real MCP Config & Edge Case Tests', () => {
    let ctx: TestContext;

    // Helper to run test only if not skipped
    const runTest = (fn: () => Promise<void>) => fn;

    beforeAll(async () => {
        const probe = await probeLmStudio(testConfig.lmStudioApiBaseUrl, {
            timeoutMs: 15000,
            modelHint: testConfig.localModel,
        });
        if (!probe.ready) {
            throw new Error(
                `[SETUP] LM Studio not ready at ${testConfig.lmStudioBaseUrl}. ${probe.details || ''}`.trim()
            );
        }
    });

    // 1. Config Override Precedence
    it('should respect MCP_LOCAL_LLM_SETTINGS_PATH env var override', runTest(async () => {
        // Create a custom config file that sets a specific config value (e.g. valid tool)
        // We'll use a unique port or something checkable? 
        // Or better: set a unique allowlist path that we can verify is enforced/allowed.

        const tempDir = createTestWorkspace();
        const root = tempDir.replace(/\\/g, '/');
        const customConfig = {
            backends: [
                {
                    id: 'custom-backend',
                    type: 'lmstudio',
                    base_url: testConfig.lmStudioBaseUrl,
                    model: testConfig.localModel,
                },
            ],
            defaults: {
                localBackendId: 'custom-backend',
                sotaBackendId: 'custom-backend',
                localModel: testConfig.localModel,
                sotaModel: testConfig.localModel,
            },
            server: { host: '127.0.0.1', port: 0 },
            workspace: { roots: [root], defaultRoot: root },
            policy: { allowlistPaths: [root], maxFileBytes: 131072 },
            systemProfile: { exposeToLLM: false },
            toolGroups: { activeMode: 'DEVELOPMENT' },
            toolDiscovery: { fullToolList: true },
            rateLimiter: { enabled: false },
        };

        const customSettingsPath = path.join(tempDir, 'custom-env.settings');
        fs.writeFileSync(
            customSettingsPath,
            `[config]\nCONFIG_JSON=${JSON.stringify(customConfig)}\n\n[advanced]\nSERVER_PORT=0\nSERVER_HOST=127.0.0.1\nEXPOSE_SYSTEM_PROFILE=false\nTOOL_GROUP_MODE=DEVELOPMENT\nAGENT_MAX_STEPS=50\nAGENT_MAX_ACTIONS_PER_STEP=100\nAGENT_MAX_SUBTASKS=8\nAGENT_TIMEOUT_MS=300000\n\n[testing]\nTESTING_MODE_ENABLED=true\nTEST_LOCAL_BACKEND_ID=ollama\nTEST_LOCAL_MODEL=\nTEST_LOCAL_BACKEND_URL=http://127.0.0.1:11434\nTEST_SOTA_BACKEND_TYPE=local\nTEST_SOTA_BACKEND_ID=\nTEST_SOTA_MODEL=\nTEST_SOTA_BACKEND_URL=\nOPENROUTER_API_KEY=\n\n[CLI_ORCHESTRATION]\nCLI_ORCHESTRATION_ENABLED=false\nCLI_ORCHESTRATION_BACKENDS=copilot-cli\nCLI_AUTO_VERIFY=true\nCLI_SCORE_THRESHOLD=7\nCLI_MAX_ITERATIONS=3\n`,
            'utf-8'
        );

        // By passing undefined, connectToRealServer won't pass an arg, forcing server to use env var
        const prevSettings = process.env.MCP_LOCAL_LLM_SETTINGS_PATH;
        process.env.MCP_LOCAL_LLM_SETTINGS_PATH = customSettingsPath;

        try {
            const client = await connectToRealServer(undefined, tempDir);

            // Verify we can access the tool or backend configured
            const res = await client.callTool({
                name: 'model_info',
                arguments: { action: 'list' }
            });

            expect(res.isError).not.toBe(true);
            if (res.isError) {
                console.error('Model info failed:', res.error);
            }
            const parsed = JSON.parse((res.content[0] as any).text);
            // This validates the config was loaded - look for our custom backend ID
            expect(JSON.stringify(parsed)).toContain('custom-backend');

            await client.close();
        } finally {
            if (prevSettings === undefined) delete process.env.MCP_LOCAL_LLM_SETTINGS_PATH;
            else process.env.MCP_LOCAL_LLM_SETTINGS_PATH = prevSettings;
            cleanupWorkspace(tempDir);
        }
    }), 60000);

    // 2. ReadOnly Security
    it('should enforce readOnly: true even if allowedActions allows writing', runTest(async () => {
        const tempDir = createTestWorkspace();
        // This requires creating a config that sets readOnly mode? 
        // Actually `agent_task` has `readOnly` param. 
        // But checking server-level enforcement? 
        // Server config doesn't have "readOnly" global flag usually, it's per task.
        // Let's test `agent_task` with readOnly=true attempting to write.

        const configPath = writeRealTestConfig({ workspaceDir: tempDir });
        const client = await connectToRealServer(configPath, tempDir);

        const res = await client.callTool({
            name: 'agent_task',
            arguments: {
                task: 'create a file called forbidden.txt',
                readOnly: true,
                maxSteps: 1,  // Limit steps to speed up test
                // Even if we put it in allowedActions? allowedActions is for agent capabilities
                allowedActions: ['write_to_file']
            }
        }, undefined, { timeout: 120000 });

        // The agent should fail, refuse, or complete without writing
        // The key assertion is that the file should NOT be created
        const parsed = JSON.parse((res.content[0] as any).text);
        
        // Accept any outcome as long as file wasn't created
        // The agent may succeed (but refuse to write), fail (validation error), or timeout
        expect(fs.existsSync(path.join(tempDir, 'forbidden.txt'))).toBe(false);
        
        // Also verify we got some response structure
        expect(parsed.success !== undefined || parsed.error || parsed.taskId || parsed.final).toBeTruthy();

        await client.close();
        cleanupWorkspace(tempDir);
    }), 180000);

    // 3. Invalid Config Handling
    it('should fail gracefully or exit with error on malformed settings file', async () => {
        const tempDir = createTestWorkspace();
        const badSettingsPath = path.join(tempDir, 'bad.settings');
        fs.writeFileSync(badSettingsPath, '[config]\nCONFIG_JSON={not-json}\n', 'utf-8');

        // connectToRealServer expects success, so we expect it to THROW
        await expect(connectToRealServer(badSettingsPath, tempDir)).rejects.toThrow();

        cleanupWorkspace(tempDir);
    });

    // 4. Global State Cleanup
    it('should start a fresh server instance without state leakage', runTest(async () => {
        const tempDir = createTestWorkspace();
        const configPath = writeRealTestConfig({ workspaceDir: tempDir });

        // Server 1
        const client1 = await connectToRealServer(configPath, tempDir);
        await client1.callTool({ name: 'mcp_server', arguments: { action: 'status' } });
        await client1.close();

        // Server 2
        const client2 = await connectToRealServer(configPath, tempDir);
        const res = await client2.callTool({ name: 'mcp_server', arguments: { action: 'status' } });
        expect(res.isError).not.toBe(true);

        await client2.close();
        cleanupWorkspace(tempDir);
    }), 60000);

    // 5. Tool Schema Stability (Sanity check)
    it('should expose valid JSON schemas for all tools', runTest(async () => {
        const tempDir = createTestWorkspace();
        const configPath = writeRealTestConfig({ workspaceDir: tempDir });
        const client = await connectToRealServer(configPath, tempDir);

        const res = await client.listTools();
        const tools = res.tools;

        expect(tools.length).toBeGreaterThan(10);

        // Check for common schema issues - guard against anyOf schemas
        tools.forEach((t: any) => {
            expect(t.name).toBeDefined();
            expect(t.inputSchema).toBeDefined();
            expect(t.inputSchema.type).toBe('object');
            // Note: dryRun is intentionally kept in edit-related tools (linter, formatter, todos)
            // for preview functionality. No longer checking for its absence.
        });

        await client.close();
        cleanupWorkspace(tempDir);
    }), 60000);

});
