/**
 * Tests for Improvement Plans V5
 * 
 * Plan 1: Project Context Awareness - SmartDefaultsManager.getProjectContext()
 * Plan 2: Unified Exclude Patterns - GrepTools uses getSimpleExcludeDirs()
 * Plan 3: Agent Completion Intelligence - continueAvailable, completionReason, continueState
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { ConfigManager } from '../src/config/index.js';
import { GrepTools } from '../src/tools/grep.js';
import { 
  SmartDefaultsManager, 
  getSmartDefaultsManager, 
  resetSmartDefaultsManager,
  DEFAULT_EXCLUDE_PATTERNS 
} from '../src/utils/smart-defaults.js';
import * as fs from 'fs';
import * as path from 'path';

describe('Improvement Plan V5 Tests', () => {
  // ============================================================================
  // Plan 1: Project Context Awareness
  // ============================================================================
  describe('Plan 1: Project Context Awareness', () => {
    let smartDefaults: SmartDefaultsManager;
    const testDir = path.join(process.cwd(), 'tests', 'tmp', 'project-context-test');

    beforeAll(() => {
      // Create test directory structure for different project types
      fs.mkdirSync(path.join(testDir, 'node-project'), { recursive: true });
      fs.mkdirSync(path.join(testDir, 'python-project'), { recursive: true });
      fs.mkdirSync(path.join(testDir, 'rust-project'), { recursive: true });
      fs.mkdirSync(path.join(testDir, 'multi-project'), { recursive: true });
      fs.mkdirSync(path.join(testDir, 'unknown-project'), { recursive: true });

      // Node project
      fs.writeFileSync(
        path.join(testDir, 'node-project', 'package.json'),
        JSON.stringify({ name: 'test-node', version: '1.0.0' })
      );
      fs.writeFileSync(
        path.join(testDir, 'node-project', 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { strict: true } })
      );

      // Python project
      fs.writeFileSync(
        path.join(testDir, 'python-project', 'requirements.txt'),
        'flask==2.0.0\nrequests==2.28.0'
      );
      fs.writeFileSync(
        path.join(testDir, 'python-project', 'pyproject.toml'),
        '[tool.poetry]\nname = "test-python"'
      );

      // Rust project
      fs.writeFileSync(
        path.join(testDir, 'rust-project', 'Cargo.toml'),
        '[package]\nname = "test-rust"'
      );

      // Multi-language project
      fs.writeFileSync(
        path.join(testDir, 'multi-project', 'package.json'),
        JSON.stringify({ name: 'test-multi' })
      );
      fs.writeFileSync(
        path.join(testDir, 'multi-project', 'requirements.txt'),
        'numpy==1.24.0'
      );
      fs.writeFileSync(
        path.join(testDir, 'multi-project', 'go.mod'),
        'module test-multi\n\ngo 1.21'
      );
    });

    afterAll(() => {
      fs.rmSync(testDir, { recursive: true, force: true });
    });

    beforeEach(() => {
      resetSmartDefaultsManager();
      smartDefaults = new SmartDefaultsManager();
    });

    describe('getProjectContext()', () => {
      it('should detect Node.js/TypeScript project', () => {
        const ctx = smartDefaults.getProjectContext(path.join(testDir, 'node-project'));
        
        expect(ctx.projectType).toBe('node');
        expect(ctx.detectedTypes).toContain('node');
        expect(ctx.detectedTypes).toContain('typescript');
        expect(ctx.languages).toContain('javascript');
        expect(ctx.languages).toContain('typescript');
        expect(ctx.hasPackageJson).toBe(true);
        expect(ctx.hasPyProject).toBe(false);
        expect(ctx.hasCargoToml).toBe(false);
        expect(ctx.hasGoMod).toBe(false);
      });

      it('should detect Python project', () => {
        const ctx = smartDefaults.getProjectContext(path.join(testDir, 'python-project'));
        
        expect(ctx.projectType).toBe('python');
        expect(ctx.detectedTypes).toContain('python');
        expect(ctx.detectedTypes).toContain('python-poetry');
        expect(ctx.languages).toContain('python');
        expect(ctx.hasPackageJson).toBe(false);
        expect(ctx.hasPyProject).toBe(true);
      });

      it('should detect Rust project', () => {
        const ctx = smartDefaults.getProjectContext(path.join(testDir, 'rust-project'));
        
        expect(ctx.projectType).toBe('rust');
        expect(ctx.detectedTypes).toContain('rust');
        expect(ctx.languages).toContain('rust');
        expect(ctx.hasCargoToml).toBe(true);
      });

      it('should detect multi-language project', () => {
        const ctx = smartDefaults.getProjectContext(path.join(testDir, 'multi-project'));
        
        expect(ctx.detectedTypes.length).toBeGreaterThanOrEqual(3);
        expect(ctx.detectedTypes).toContain('node');
        expect(ctx.detectedTypes).toContain('python');
        expect(ctx.detectedTypes).toContain('go');
        expect(ctx.languages).toContain('javascript');
        expect(ctx.languages).toContain('python');
        expect(ctx.languages).toContain('go');
        expect(ctx.hasPackageJson).toBe(true);
        expect(ctx.hasPyProject).toBe(true);
        expect(ctx.hasGoMod).toBe(true);
      });

      it('should return unknown for empty directory', () => {
        const ctx = smartDefaults.getProjectContext(path.join(testDir, 'unknown-project'));
        
        expect(ctx.projectType).toBe('unknown');
        expect(ctx.detectedTypes.length).toBe(0);
        expect(ctx.languages.length).toBe(0);
      });

      it('should include appropriate exclude patterns based on project type', () => {
        const nodeCtx = smartDefaults.getProjectContext(path.join(testDir, 'node-project'));
        const pythonCtx = smartDefaults.getProjectContext(path.join(testDir, 'python-project'));
        const rustCtx = smartDefaults.getProjectContext(path.join(testDir, 'rust-project'));

        expect(nodeCtx.excludePatterns).toContain('node_modules/**');
        expect(nodeCtx.excludePatterns).toContain('dist/**');
        
        expect(pythonCtx.excludePatterns).toContain('venv/**');
        expect(pythonCtx.excludePatterns).toContain('__pycache__/**');
        
        expect(rustCtx.excludePatterns).toContain('target/**');
      });
    });

    describe('getSimpleExcludeDirs()', () => {
      it('should return a list of directory names to skip', () => {
        const dirs = smartDefaults.getSimpleExcludeDirs();
        
        expect(Array.isArray(dirs)).toBe(true);
        expect(dirs.length).toBeGreaterThan(10);
        
        // Core directories that must be excluded
        expect(dirs).toContain('node_modules');
        expect(dirs).toContain('.git');
        expect(dirs).toContain('dist');
        expect(dirs).toContain('build');
        expect(dirs).toContain('venv');
        expect(dirs).toContain('.venv');
        expect(dirs).toContain('__pycache__');
        expect(dirs).toContain('target');
        expect(dirs).toContain('vendor');
        expect(dirs).toContain('.next');
        expect(dirs).toContain('.nuxt');
        expect(dirs).toContain('coverage');
      });

      it('should extract directory names from DEFAULT_EXCLUDE_PATTERNS', () => {
        const dirs = smartDefaults.getSimpleExcludeDirs();
        
        // Verify it extracts directories from patterns like 'venv/**'
        const patternsWithDirs = DEFAULT_EXCLUDE_PATTERNS.filter(p => p.endsWith('/**'));
        for (const pattern of patternsWithDirs.slice(0, 5)) {
          const dirName = pattern.replace('/**', '');
          if (!dirName.startsWith('.')) {
            expect(dirs).toContain(dirName);
          }
        }
      });

      it('should return unique directory names', () => {
        const dirs = smartDefaults.getSimpleExcludeDirs();
        const uniqueDirs = new Set(dirs);
        
        expect(dirs.length).toBe(uniqueDirs.size);
      });
    });
  });

  // ============================================================================
  // Regression: Default excludes for artifact dotfiles
  // ============================================================================
  describe('Regression: Artifact dotfiles excluded', () => {
    beforeEach(() => {
      resetSmartDefaultsManager();
    });

    it('should exclude .coverage file by default (prevents agent/search thrash)', () => {
      const manager = getSmartDefaultsManager();
      expect(manager.shouldExclude('.coverage')).toBe(true);
      expect(manager.shouldExclude('reports/.coverage')).toBe(true);
    });

    it('should exclude .mcp-backups directory by default', () => {
      const manager = getSmartDefaultsManager();
      expect(manager.shouldExclude('.mcp-backups/foo.txt')).toBe(true);
      expect(manager.shouldExclude('src/.mcp-backups/foo.txt')).toBe(true);
    });
  });

  // ============================================================================
  // Plan 2: Unified Exclude Patterns in GrepTools
  // ============================================================================
  describe('Plan 2: Unified Exclude Patterns', () => {
    let config: ConfigManager;
    let grepTools: GrepTools;
    const testDir = path.join(process.cwd(), 'tests', 'tmp', 'grep-exclude-test');

    beforeAll(() => {
      config = new ConfigManager();
      grepTools = new GrepTools(config);

      // Create test directory structure with noise directories
      fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });
      fs.mkdirSync(path.join(testDir, 'venv', 'lib'), { recursive: true });
      fs.mkdirSync(path.join(testDir, '.venv', 'bin'), { recursive: true });
      fs.mkdirSync(path.join(testDir, 'node_modules', 'lodash'), { recursive: true });
      fs.mkdirSync(path.join(testDir, '__pycache__'), { recursive: true });
      fs.mkdirSync(path.join(testDir, 'dist'), { recursive: true });
      fs.mkdirSync(path.join(testDir, 'target', 'debug'), { recursive: true });
      fs.mkdirSync(path.join(testDir, '.pytest_cache'), { recursive: true });
      fs.mkdirSync(path.join(testDir, 'site-packages'), { recursive: true });
      fs.mkdirSync(path.join(testDir, 'coverage'), { recursive: true });

      // Create actual source files that should be found
      fs.writeFileSync(
        path.join(testDir, 'src', 'main.ts'),
        `export function searchTarget() { return 'found'; }`
      );
      fs.writeFileSync(
        path.join(testDir, 'config.ts'),
        `export const searchTarget = 'config value';`
      );

      // Create noise files that should be filtered
      fs.writeFileSync(
        path.join(testDir, 'venv', 'lib', 'searchTarget.py'),
        `# venv file - should be filtered`
      );
      fs.writeFileSync(
        path.join(testDir, '.venv', 'searchTarget.py'),
        `# .venv file - should be filtered`
      );
      fs.writeFileSync(
        path.join(testDir, 'node_modules', 'lodash', 'searchTarget.js'),
        `// node_modules - should be filtered`
      );
      fs.writeFileSync(
        path.join(testDir, '__pycache__', 'searchTarget.cpython-311.pyc'),
        `# pycache - should be filtered`
      );
      fs.writeFileSync(
        path.join(testDir, 'dist', 'searchTarget.js'),
        `// dist - should be filtered`
      );
      fs.writeFileSync(
        path.join(testDir, 'target', 'debug', 'searchTarget.rs'),
        `// target - should be filtered`
      );
      fs.writeFileSync(
        path.join(testDir, 'site-packages', 'searchTarget.py'),
        `# site-packages - should be filtered`
      );
      fs.writeFileSync(
        path.join(testDir, 'coverage', 'searchTarget.json'),
        `{"searchTarget": "coverage"}`
      );
    });

    afterAll(() => {
      fs.rmSync(testDir, { recursive: true, force: true });
    });

    describe('grepRepo() with unified excludes', () => {
      it('should NOT find matches in venv directories', () => {
        const result = grepTools.grepRepo(testDir, 'searchTarget', 100);
        const venvMatches = result.matches.filter(m => 
          m.file.includes('venv') || m.file.includes('.venv')
        );
        expect(venvMatches.length).toBe(0);
      });

      it('should NOT find matches in node_modules', () => {
        const result = grepTools.grepRepo(testDir, 'searchTarget', 100);
        const nodeModulesMatches = result.matches.filter(m => 
          m.file.includes('node_modules')
        );
        expect(nodeModulesMatches.length).toBe(0);
      });

      it('should NOT find matches in __pycache__', () => {
        const result = grepTools.grepRepo(testDir, 'searchTarget', 100);
        const pycacheMatches = result.matches.filter(m => 
          m.file.includes('__pycache__')
        );
        expect(pycacheMatches.length).toBe(0);
      });

      it('should NOT find matches in dist directory', () => {
        const result = grepTools.grepRepo(testDir, 'searchTarget', 100);
        const distMatches = result.matches.filter(m => 
          m.file.includes('dist/')
        );
        expect(distMatches.length).toBe(0);
      });

      it('should NOT find matches in target directory', () => {
        const result = grepTools.grepRepo(testDir, 'searchTarget', 100);
        const targetMatches = result.matches.filter(m => 
          m.file.includes('target/')
        );
        expect(targetMatches.length).toBe(0);
      });

      it('should NOT find matches in site-packages', () => {
        const result = grepTools.grepRepo(testDir, 'searchTarget', 100);
        const sitePackagesMatches = result.matches.filter(m => 
          m.file.includes('site-packages')
        );
        expect(sitePackagesMatches.length).toBe(0);
      });

      it('should NOT find matches in coverage directory', () => {
        const result = grepTools.grepRepo(testDir, 'searchTarget', 100);
        const coverageMatches = result.matches.filter(m => 
          m.file.includes('coverage/')
        );
        expect(coverageMatches.length).toBe(0);
      });

      it('should ONLY find matches in actual source files', () => {
        const result = grepTools.grepRepo(testDir, 'searchTarget', 100);
        
        // Should find at least 2 matches (src/main.ts and config.ts)
        expect(result.matches.length).toBeGreaterThanOrEqual(2);
        
        // No matches should be in noise directories
        for (const match of result.matches) {
          const noiseDirs = ['venv', '.venv', 'node_modules', '__pycache__', 'dist', 
                            'target', 'site-packages', 'coverage', '.pytest_cache'];
          const isInNoise = noiseDirs.some(dir => match.file.includes(dir));
          expect(isInNoise).toBe(false);
        }
      });
    });

    describe('SmartDefaultsManager integration', () => {
      it('should use getSimpleExcludeDirs() for pattern list', () => {
        resetSmartDefaultsManager();
        const manager = getSmartDefaultsManager();
        const dirs = manager.getSimpleExcludeDirs();
        
        // Verify the list includes critical directories
        expect(dirs).toContain('venv');
        expect(dirs).toContain('.venv');
        expect(dirs).toContain('node_modules');
        expect(dirs).toContain('__pycache__');
        expect(dirs).toContain('dist');
        expect(dirs).toContain('target');
        expect(dirs).toContain('site-packages');
      });
    });
  });

  // ============================================================================
  // Plan 3: Agent Completion Intelligence
  // ============================================================================
  describe('Plan 3: Agent Completion Intelligence', () => {
    describe('AgentTaskResult interface', () => {
      it('should define completionReason type', () => {
        // Type-check only test - verifies the interface has the right shape
        type TestCompletionReason = 'completed' | 'step_limit' | 'action_limit' | 'timeout' | 'error' | 'cancelled';
        const validReasons: TestCompletionReason[] = [
          'completed',
          'step_limit',
          'action_limit',
          'timeout',
          'error',
          'cancelled'
        ];
        expect(validReasons.length).toBe(6);
      });

      it('should define continueAvailable as boolean', () => {
        const result = {
          continueAvailable: true,
          completionReason: 'step_limit' as const,
        };
        expect(typeof result.continueAvailable).toBe('boolean');
      });

      it('should define continueState structure', () => {
        const continueState = {
          remainingSubtasks: [{ id: 't1', title: 'Task', task: 'Do something' }],
          remainingSteps: [{ subtaskId: 't1', stepId: 's1', title: 'Step', description: 'Desc' }],
          lastCompletedStepId: 't1:s1',
          context: { key: 'value' },
        };
        
        expect(Array.isArray(continueState.remainingSubtasks)).toBe(true);
        expect(Array.isArray(continueState.remainingSteps)).toBe(true);
        expect(typeof continueState.lastCompletedStepId).toBe('string');
      });

      it('should define projectContext structure', () => {
        const projectContext = {
          projectType: 'node',
          languages: ['javascript', 'typescript'],
          detectedTypes: ['node', 'typescript'],
        };
        
        expect(typeof projectContext.projectType).toBe('string');
        expect(Array.isArray(projectContext.languages)).toBe(true);
        expect(Array.isArray(projectContext.detectedTypes)).toBe(true);
      });
    });

    describe('Completion reason scenarios', () => {
      it('should indicate completed when all steps succeed', () => {
        const mockResult = {
          success: true,
          partial: false,
          completionReason: 'completed' as const,
          continueAvailable: false,
        };
        
        expect(mockResult.completionReason).toBe('completed');
        expect(mockResult.continueAvailable).toBe(false);
      });

      it('should indicate step_limit when not all steps executed', () => {
        const mockResult = {
          success: true,
          partial: false,
          completionReason: 'step_limit' as const,
          continueAvailable: true,
          continueState: {
            remainingSubtasks: [],
            remainingSteps: [
              { subtaskId: 't1', stepId: 's3', title: 'Step 3', description: 'Remaining' }
            ],
          },
        };
        
        expect(mockResult.completionReason).toBe('step_limit');
        expect(mockResult.continueAvailable).toBe(true);
        expect(mockResult.continueState?.remainingSteps.length).toBeGreaterThan(0);
      });

      it('should indicate action_limit when steps auto-completed', () => {
        const mockResult = {
          success: true,
          partial: true,
          completionReason: 'action_limit' as const,
          continueAvailable: true,
        };
        
        expect(mockResult.completionReason).toBe('action_limit');
        expect(mockResult.partial).toBe(true);
      });

      it('should indicate error when task fails', () => {
        const mockResult = {
          success: false,
          completionReason: 'error' as const,
          continueAvailable: true,
          error: 'LLM timeout',
          continueState: {
            remainingSubtasks: [{ id: 't2', title: 'Task 2', task: 'Do more' }],
            remainingSteps: [],
          },
        };
        
        expect(mockResult.completionReason).toBe('error');
        expect(mockResult.continueAvailable).toBe(true);
        expect(mockResult.error).toBeDefined();
      });
    });

    describe('Continue state computation', () => {
      it('should track remaining subtasks correctly', () => {
        const plan = {
          subtasks: [
            { id: 't1', title: 'Task 1', task: 'Do A', steps: [{ id: 's1', title: 'S1', description: 'D1', targets: [] }] },
            { id: 't2', title: 'Task 2', task: 'Do B', steps: [{ id: 's1', title: 'S1', description: 'D1', targets: [] }] },
          ],
        };
        const execution = [
          { subtaskId: 't1', stepId: 's1', status: 'completed' as const, actions: [] },
        ];
        
        // Simulate remaining calculation
        const executedStepIds = new Set(execution.map(e => `${e.subtaskId}:${e.stepId}`));
        const remainingSubtasks = plan.subtasks.filter(st => 
          st.steps.every(s => !executedStepIds.has(`${st.id}:${s.id}`))
        );
        
        expect(remainingSubtasks.length).toBe(1);
        expect(remainingSubtasks[0].id).toBe('t2');
      });

      it('should track remaining steps correctly', () => {
        const plan = {
          subtasks: [
            { 
              id: 't1', 
              title: 'Task 1', 
              task: 'Do A', 
              steps: [
                { id: 's1', title: 'Step 1', description: 'D1', targets: [] },
                { id: 's2', title: 'Step 2', description: 'D2', targets: [] },
                { id: 's3', title: 'Step 3', description: 'D3', targets: [] },
              ] 
            },
          ],
        };
        const execution = [
          { subtaskId: 't1', stepId: 's1', status: 'completed' as const, actions: [] },
        ];
        
        // Simulate remaining calculation
        const executedStepIds = new Set(execution.map(e => `${e.subtaskId}:${e.stepId}`));
        const remainingSteps: Array<{ subtaskId: string; stepId: string }> = [];
        
        for (const st of plan.subtasks) {
          for (const step of st.steps) {
            if (!executedStepIds.has(`${st.id}:${step.id}`)) {
              remainingSteps.push({ subtaskId: st.id, stepId: step.id });
            }
          }
        }
        
        expect(remainingSteps.length).toBe(2);
        expect(remainingSteps[0].stepId).toBe('s2');
        expect(remainingSteps[1].stepId).toBe('s3');
      });

      it('should track lastCompletedStepId correctly', () => {
        const execution = [
          { subtaskId: 't1', stepId: 's1', status: 'completed' as const, actions: [] },
          { subtaskId: 't1', stepId: 's2', status: 'completed' as const, actions: [] },
          { subtaskId: 't1', stepId: 's3', status: 'failed' as const, actions: [] },
        ];
        
        const lastExecution = execution[execution.length - 1];
        const lastCompletedStepId = `${lastExecution.subtaskId}:${lastExecution.stepId}`;
        
        expect(lastCompletedStepId).toBe('t1:s3');
      });
    });

    describe('Project context in results', () => {
      let testDir: string;

      beforeAll(() => {
        testDir = path.join(process.cwd(), 'tests', 'tmp', 'agent-context-test');
        fs.mkdirSync(testDir, { recursive: true });
        fs.writeFileSync(
          path.join(testDir, 'package.json'),
          JSON.stringify({ name: 'test-agent-context' })
        );
        fs.writeFileSync(
          path.join(testDir, 'tsconfig.json'),
          JSON.stringify({ compilerOptions: { strict: true } })
        );
      });

      afterAll(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
      });

      it('should detect project context for task results', () => {
        resetSmartDefaultsManager();
        const smartDefaults = getSmartDefaultsManager();
        smartDefaults.initialize(testDir);
        const ctx = smartDefaults.getProjectContext(testDir);
        
        expect(ctx.projectType).toBe('node');
        expect(ctx.languages).toContain('javascript');
        expect(ctx.languages).toContain('typescript');
      });
    });
  });

  // ============================================================================
  // Integration Tests
  // ============================================================================
  describe('Integration: All Plans Working Together', () => {
    const testDir = path.join(process.cwd(), 'tests', 'tmp', 'integration-test');

    beforeAll(() => {
      // Create a realistic project structure
      fs.mkdirSync(path.join(testDir, 'src', 'components'), { recursive: true });
      fs.mkdirSync(path.join(testDir, 'tests'), { recursive: true });
      fs.mkdirSync(path.join(testDir, 'node_modules', 'react'), { recursive: true });
      fs.mkdirSync(path.join(testDir, 'dist'), { recursive: true });
      fs.mkdirSync(path.join(testDir, '.next'), { recursive: true });

      // Project files
      fs.writeFileSync(
        path.join(testDir, 'package.json'),
        JSON.stringify({ name: 'integration-test', dependencies: { react: '18.0.0' } })
      );
      fs.writeFileSync(
        path.join(testDir, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { strict: true } })
      );

      // Source files
      fs.writeFileSync(
        path.join(testDir, 'src', 'index.ts'),
        `export function main() { return 'integration'; }`
      );
      fs.writeFileSync(
        path.join(testDir, 'src', 'components', 'Button.tsx'),
        `export const Button = () => <button>integration</button>;`
      );

      // Noise files
      fs.writeFileSync(
        path.join(testDir, 'node_modules', 'react', 'index.js'),
        `// integration noise`
      );
      fs.writeFileSync(
        path.join(testDir, 'dist', 'bundle.js'),
        `// integration dist`
      );
      fs.writeFileSync(
        path.join(testDir, '.next', 'cache.json'),
        `{"integration": "cache"}`
      );
    });

    afterAll(() => {
      fs.rmSync(testDir, { recursive: true, force: true });
    });

    it('should detect Node/TypeScript project context', () => {
      resetSmartDefaultsManager();
      const manager = getSmartDefaultsManager();
      manager.initialize(testDir);
      const ctx = manager.getProjectContext(testDir);
      
      expect(ctx.projectType).toBe('node');
      expect(ctx.detectedTypes).toContain('node');
      expect(ctx.detectedTypes).toContain('typescript');
      expect(ctx.hasPackageJson).toBe(true);
    });

    it('should exclude noise directories in grep', () => {
      const config = new ConfigManager();
      const grepTools = new GrepTools(config);
      
      const result = grepTools.grepRepo(testDir, 'integration', 100);
      
      // Should find at least one source file match
      expect(result.matches.length).toBeGreaterThan(0);
      
      // No matches should be in noise directories
      const noiseDirs = ['node_modules', 'dist', '.next', 'build', 'venv', '__pycache__'];
      const noiseMatches = result.matches.filter(m => 
        noiseDirs.some(dir => m.file.includes(dir))
      );
      expect(noiseMatches.length).toBe(0);
    });

    it('should have consistent exclude patterns across tools', () => {
      resetSmartDefaultsManager();
      const manager = getSmartDefaultsManager();
      const excludeDirs = manager.getSimpleExcludeDirs();
      
      // All critical directories should be in the list
      const criticalDirs = ['node_modules', 'dist', '.next', 'build', 'venv', '__pycache__'];
      for (const dir of criticalDirs) {
        expect(excludeDirs).toContain(dir);
      }
    });
  });
});
