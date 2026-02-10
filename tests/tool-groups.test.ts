import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, unlinkSync, mkdtempSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ConfigManager, parseEnvSettings } from '../src/config/index.js';
import { DEFAULT_TOOL_GROUPS, DEFAULT_TOOL_MODES } from '../src/types/index.js';
import { writeSettingsFile } from './test-utils/settings.js';

let TEST_DIR = '';
let TEST_SETTINGS_PATH = '';

function baseConfig(overrides?: Partial<any>) {
  return {
    backends: [{ id: 'test-backend', type: 'ollama', base_url: 'http://127.0.0.1:11434' }],
    defaults: { localBackendId: 'test-backend' },
    policy: { allowlistPaths: ['.'], maxFileBytes: 131072 },
    systemProfile: { exposeToLLM: false },
    toolGroups: { activeMode: 'DEVELOPMENT' },
    ...overrides,
  };
}

describe('Tool Groups', () => {
  beforeEach(() => {
    TEST_DIR = mkdtempSync(join(tmpdir(), 'mcp-local-llm-tests-toolgroups-'));
    TEST_SETTINGS_PATH = join(TEST_DIR, 'env.settings');
    writeSettingsFile(TEST_SETTINGS_PATH, baseConfig(), { serverPort: 0, testingEnabled: true });
  });

  afterEach(() => {
    if (existsSync(TEST_SETTINGS_PATH)) unlinkSync(TEST_SETTINGS_PATH);
    if (TEST_DIR && existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('DEFAULT_TOOL_GROUPS', () => {
    it('defines expected tool groups', () => {
      expect(DEFAULT_TOOL_GROUPS['core.summary']).toBeDefined();
      expect(DEFAULT_TOOL_GROUPS['core.chat']).toBeDefined();
      expect(DEFAULT_TOOL_GROUPS['planning']).toBeDefined();
      expect(DEFAULT_TOOL_GROUPS['llm.enhanced']).toBeDefined();
      expect(DEFAULT_TOOL_GROUPS['execution']).toBeDefined();

      expect(DEFAULT_TOOL_GROUPS['verification']).toBeUndefined();
      expect(DEFAULT_TOOL_GROUPS['core.read']).toBeUndefined();
    });

    it('has proper structure for each group', () => {
      Object.entries(DEFAULT_TOOL_GROUPS).forEach(([_id, group]) => {
        expect(group.description).toBeTruthy();
        expect(group.tools).toBeInstanceOf(Array);
        expect(group.tools.length).toBeGreaterThan(0);
        expect(['low', 'medium', 'high']).toContain(group.riskLevel);
      });
    });

    it('llm.enhanced contains LLM-enhanced tools', () => {
      const group = DEFAULT_TOOL_GROUPS['llm.enhanced'];
      expect(group.tools).toContain('analyze_file');
      expect(group.tools).toContain('local_code_review');
      expect(group.tools).toContain('generate_docs');
      expect(group.tools).toContain('suggest_refactoring');
      // generate_tests removed V21 (QA_feedback_8: unreliable output quality)
      expect(group.tools).toContain('suggest_edit');
      expect(group.tools).toContain('draft_file');
      expect(group.riskLevel).toBe('medium');
      expect(group.requiresLocalLLM).toBe(true);
    });

    it('analysis.extended contains workspace tool (consolidated)', () => {
      const group = DEFAULT_TOOL_GROUPS['analysis.extended'];
      expect(group.tools).toContain('workspace');
      expect(group.tools).toContain('search');
      expect(group.tools).toContain('todos');
      expect(group.riskLevel).toBe('medium');
    });

    it('execution contains linter and formatter (consolidated)', () => {
      const group = DEFAULT_TOOL_GROUPS['execution'];
      expect(group.tools).toContain('linter');
      expect(group.tools).toContain('formatter');
      expect(group.tools).not.toContain('execute_script');
      expect(group.tools).not.toContain('run_tests');
      expect(group.tools.length).toBe(2);
    });
  });

  describe('DEFAULT_TOOL_MODES', () => {
    it('defines all expected modes', () => {
      const expectedModes = ['MINIMAL', 'ANALYSIS', 'PLANNING', 'FULL_ANALYSIS', 'DEVELOPMENT'];
      expectedModes.forEach((mode) => {
        expect(DEFAULT_TOOL_MODES[mode]).toBeDefined();
        expect(DEFAULT_TOOL_MODES[mode].groups).toBeInstanceOf(Array);
        expect(DEFAULT_TOOL_MODES[mode].description).toBeTruthy();
      });
    });

    it('MINIMAL includes core.chat, core.summary, and planning', () => {
      const mode = DEFAULT_TOOL_MODES['MINIMAL'];
      expect(mode.groups).toContain('core.chat');
      expect(mode.groups).toContain('core.summary');
      expect(mode.groups).toContain('planning');
      expect(mode.groups.length).toBe(3);
    });

    it('DEVELOPMENT includes all groups', () => {
      const devMode = DEFAULT_TOOL_MODES['DEVELOPMENT'];
      expect(devMode.groups.length).toBeGreaterThan(5);
      expect(devMode.groups).toContain('core.summary');
      expect(devMode.groups).toContain('core.chat');
      expect(devMode.groups).toContain('llm.enhanced');
      expect(devMode.groups).toContain('execution');
      expect(devMode.groups).not.toContain('core.read');
      expect(devMode.groups).not.toContain('edit.safe');
      expect(devMode.groups).not.toContain('edit.advanced');
      expect(devMode.groups).not.toContain('git');
    });

    it('modes have progressively more groups', () => {
      const minimal = DEFAULT_TOOL_MODES['MINIMAL'].groups.length;
      const analysis = DEFAULT_TOOL_MODES['ANALYSIS'].groups.length;
      const development = DEFAULT_TOOL_MODES['DEVELOPMENT'].groups.length;

      expect(analysis).toBeGreaterThan(minimal);
      expect(development).toBeGreaterThan(analysis);
    });
  });

  describe('ConfigManager Tool Group Methods', () => {
    it('exposes tool group helpers', () => {
      const config = new ConfigManager(TEST_SETTINGS_PATH);
      expect(typeof config.getEnabledTools).toBe('function');
      expect(typeof config.isToolEnabled).toBe('function');
      expect(typeof config.setToolGroupMode).toBe('function');
      expect(typeof config.setEnabledGroups).toBe('function');
    });

    it('returns a Set from getEnabledTools', () => {
      const config = new ConfigManager(TEST_SETTINGS_PATH);
      const tools = config.getEnabledTools();
      expect(tools).toBeInstanceOf(Set);
    });

    it('enables tools from default mode (DEVELOPMENT)', () => {
      const config = new ConfigManager(TEST_SETTINGS_PATH);
      const tools = config.getEnabledTools();
      expect(tools.has('summarize')).toBe(true);
      expect(tools.has('analyze_file')).toBe(true);
      expect(tools.has('llm_chat')).toBe(true);
    });

    it('defaults to DEVELOPMENT when toolGroups is present but empty', () => {
      writeSettingsFile(TEST_SETTINGS_PATH, baseConfig({ toolGroups: {} }), { serverPort: 0, testingEnabled: true });
      const config = new ConfigManager(TEST_SETTINGS_PATH);
      const tools = config.getEnabledTools();
      expect(tools.has('llm_chat')).toBe(true);
      expect(tools.has('agent_task')).toBe(true);
      expect(tools.has('mcp_server')).toBe(true);
    });

    it('respects an explicit empty enabled list (disable all tools)', () => {
      writeSettingsFile(
        TEST_SETTINGS_PATH,
        baseConfig({ toolGroups: { enabled: [] as string[] } }),
        { serverPort: 0, testingEnabled: true }
      );
      const config = new ConfigManager(TEST_SETTINGS_PATH);
      const tools = config.getEnabledTools();
      expect(tools.size).toBe(0);
    });

    it('setToolGroupMode changes enabled tools and persists to settings', () => {
      const config = new ConfigManager(TEST_SETTINGS_PATH);
      config.setToolGroupMode('MINIMAL');
      expect(config.isToolEnabled('llm_chat')).toBe(true);
      expect(config.isToolEnabled('analyze_file')).toBe(false);

      const raw = readFileSync(TEST_SETTINGS_PATH, 'utf-8');
      const sections = parseEnvSettings(raw);
      const persisted = JSON.parse((sections.config || {}).CONFIG_JSON as string) as any;
      expect(persisted.toolGroups?.activeMode).toBe('MINIMAL');
    });
  });

  describe('ConfigManager.getToolGroupStatus', () => {
    it('returns status object with expected properties', () => {
      const config = new ConfigManager(TEST_SETTINGS_PATH);
      const status = config.getToolGroupStatus();
      expect(status).toHaveProperty('activeMode');
      expect(status).toHaveProperty('enabledGroups');
      expect(status).toHaveProperty('enabledTools');
    });

    it('shows DEVELOPMENT as default mode', () => {
      const config = new ConfigManager(TEST_SETTINGS_PATH);
      const status = config.getToolGroupStatus();
      expect(status.activeMode).toBe('DEVELOPMENT');
    });

    it('enabledTools is an array', () => {
      const config = new ConfigManager(TEST_SETTINGS_PATH);
      const status = config.getToolGroupStatus();
      expect(status.enabledTools).toBeInstanceOf(Array);
      expect(status.enabledTools.length).toBeGreaterThan(0);
    });

    it('mode change affects getToolGroupStatus', () => {
      const config = new ConfigManager(TEST_SETTINGS_PATH);
      config.setToolGroupMode('MINIMAL');
      const status = config.getToolGroupStatus();
      expect(status.activeMode).toBe('MINIMAL');
      expect(status.enabledGroups).toContain('core.chat');
      expect(status.enabledGroups).toContain('core.summary');
      expect(status.enabledGroups).not.toContain('llm.enhanced');
    });
  });
});

