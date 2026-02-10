#!/usr/bin/env node
/**
 * E2E Timing Tests - LM Studio vs OpenCode CLI Performance
 * 
 * This test suite measures execution time for:
 * - LM Studio (local LLM): Planning and verification phases
 * - OpenCode CLI: Actual code execution phases
 * 
 * Test Scenarios:
 * 1. Simple Task: Create a single file with basic content
 * 2. Code Generation: Generate a utility function
 * 3. Code Modification: Add a method to existing class
 * 4. Analysis Task: Analyze code structure (read-only)
 * 5. Multi-step Task: Complex task requiring multiple steps
 * 
 * Future Support:
 * - Copilot CLI: Designed to easily switch backends for comparison testing
 */

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';

// Configuration
const SERVER_URL = 'http://localhost:3000';
const TEST_WORKSPACE = 'tests/test-samples/e2e-timing';
const BACKENDS = {
  'opencode-cli': { name: 'OpenCode CLI', model: 'opencode/big-pickle' },
  'copilot-cli': { name: 'GitHub Copilot CLI', model: 'default' }, // Future support
};

// Test scenarios with different complexity levels
const TEST_SCENARIOS = [
  {
    id: 'simple-file',
    name: '1. Simple Task - Create File',
    description: 'Create a simple text file with basic content',
    task: `Create a file named "hello.txt" in ${TEST_WORKSPACE} with the content "Hello, World! This is a test file created by the orchestration system."`,
    expectedFiles: ['hello.txt'],
    complexity: 'simple',
    estimatedSteps: 1,
  },
  {
    id: 'code-generation',
    name: '2. Code Generation - Utility Function',
    description: 'Generate a utility function with TypeScript',
    task: `Create a TypeScript file "${TEST_WORKSPACE}/utils/stringUtils.ts" with a function called "capitalize" that takes a string and returns it with the first letter capitalized. Include proper TypeScript types and JSDoc comments.`,
    expectedFiles: ['utils/stringUtils.ts'],
    complexity: 'medium',
    estimatedSteps: 2,
  },
  {
    id: 'code-modification',
    name: '3. Code Modification - Add Method',
    description: 'Add a new method to an existing class',
    task: `Read the file "${TEST_WORKSPACE}/calculator.ts" and add a new method called "power(base: number, exponent: number): number" that calculates base^exponent. Keep all existing methods intact.`,
    expectedFiles: ['calculator.ts'],
    setupFile: {
      path: 'calculator.ts',
      content: `export class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }

  subtract(a: number, b: number): number {
    return a - b;
  }

  multiply(a: number, b: number): number {
    return a * b;
  }

  divide(a: number, b: number): number {
    if (b === 0) throw new Error('Division by zero');
    return a / b;
  }
}
`,
    },
    complexity: 'medium',
    estimatedSteps: 2,
  },
  {
    id: 'analysis-task',
    name: '4. Analysis Task - Code Review',
    description: 'Analyze code structure without modifications',
    task: `Analyze the code in "${TEST_WORKSPACE}/calculator.ts" and provide a summary of: 1) All public methods, 2) Any potential improvements, 3) Test coverage suggestions. Output to "${TEST_WORKSPACE}/analysis-report.md"`,
    expectedFiles: ['analysis-report.md'],
    complexity: 'medium',
    estimatedSteps: 2,
  },
  {
    id: 'multi-step',
    name: '5. Multi-step Task - Module Creation',
    description: 'Complex task requiring multiple files and dependencies',
    task: `Create a complete logging module in "${TEST_WORKSPACE}/logger/":
1. Create "logger/types.ts" with LogLevel enum (DEBUG, INFO, WARN, ERROR)
2. Create "logger/Logger.ts" with a Logger class that has methods: debug(), info(), warn(), error()
3. Create "logger/index.ts" that exports both the Logger class and LogLevel enum
4. Each file should have proper TypeScript types and JSDoc documentation`,
    expectedFiles: ['logger/types.ts', 'logger/Logger.ts', 'logger/index.ts'],
    complexity: 'complex',
    estimatedSteps: 4,
  },
];

// Results storage
const testResults = [];

/**
 * Call a tool via HTTP API endpoint
 */
async function callTool(name, args) {
  const url = `${SERVER_URL}/api/tools/${encodeURIComponent(name)}/execute`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ arguments: args }),  // API expects { arguments: { ... } }
  });
  
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP error: ${response.status} - ${text}`);
  }
  
  return response.json();
}

/**
 * Setup test workspace
 */
async function setupTestWorkspace() {
  console.log('\n📁 Setting up test workspace...');
  
  const workspacePath = path.resolve(TEST_WORKSPACE);
  
  // Create workspace directory
  await fs.mkdir(workspacePath, { recursive: true });
  
  // Create subdirectories
  await fs.mkdir(path.join(workspacePath, 'utils'), { recursive: true });
  await fs.mkdir(path.join(workspacePath, 'logger'), { recursive: true });
  
  console.log(`   Created: ${workspacePath}`);
  
  return workspacePath;
}

/**
 * Setup files needed for specific tests
 */
async function setupTestFiles(scenario, workspacePath) {
  if (scenario.setupFile) {
    const filePath = path.join(workspacePath, scenario.setupFile.path);
    await fs.writeFile(filePath, scenario.setupFile.content, 'utf8');
    console.log(`   Setup file: ${scenario.setupFile.path}`);
  }
}

/**
 * Clean up test workspace
 */
async function cleanupTestWorkspace() {
  console.log('\n🧹 Cleaning up test workspace...');
  
  try {
    const workspacePath = path.resolve(TEST_WORKSPACE);
    await fs.rm(workspacePath, { recursive: true, force: true });
    console.log('   Cleanup complete');
  } catch {
    console.log('   Nothing to clean up');
  }
}

/**
 * Run a single test scenario
 */
async function runTestScenario(scenario, backend = 'opencode-cli') {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📋 ${scenario.name}`);
  console.log(`   ${scenario.description}`);
  console.log(`   Backend: ${BACKENDS[backend]?.name || backend}`);
  console.log(`   Complexity: ${scenario.complexity}`);
  console.log(`   Expected steps: ${scenario.estimatedSteps}`);
  console.log(`${'='.repeat(60)}`);
  
  const workspacePath = path.resolve(TEST_WORKSPACE);
  
  // Setup any required files for this test
  await setupTestFiles(scenario, workspacePath);
  
  // Record start time
  const startTime = performance.now();
  
  let result = {
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    backend,
    startTime: new Date().toISOString(),
    endTime: '',
    success: false,
    timing: null,
    error: null,
  };
  
  try {
    console.log('\n🚀 Executing orchestration task...');
    console.log(`   Task: ${scenario.task.substring(0, 100)}...`);
    
    // Call the orchestration tool
    const orchestrationResult = await callTool('cli_orchestrate', {
      task: scenario.task,
      backend,
    });
    
    // Extract timing from result
    if (orchestrationResult && orchestrationResult.content) {
      const content = Array.isArray(orchestrationResult.content)
        ? orchestrationResult.content.map(c => c.text || c).join('\n')
        : (typeof orchestrationResult.content === 'string' 
            ? orchestrationResult.content 
            : JSON.stringify(orchestrationResult.content));
      
      // Parse the entire JSON response to get timing
      try {
        const parsed = JSON.parse(content);
        if (parsed.timing) {
          result.timing = parsed.timing;
        }
        result.success = parsed.success === true;
        result.rawContent = content.substring(0, 500);
      } catch {
        // Fallback regex parsing for timing
        const timingMatch = content.match(/"timing"\s*:\s*({[^}]+})/);
        if (timingMatch) {
          try {
            result.timing = JSON.parse(timingMatch[1]);
          } catch {
            console.log('   ⚠️ Could not parse timing from response');
          }
        }
        
        // Check for success indicators
        result.success = content.includes('"success":true') || 
                        (content.includes('success') && !content.includes('"success":false'));
        result.rawContent = content.substring(0, 500);
      }
    }
    
    // If we couldn't get timing from response, calculate manually
    const endTime = performance.now();
    if (!result.timing) {
      result.timing = {
        totalMs: Math.round(endTime - startTime),
        note: 'Timing calculated externally',
      };
    }
    
    result.endTime = new Date().toISOString();
    
  } catch (error) {
    result.error = error.message;
    result.endTime = new Date().toISOString();
    result.timing = {
      totalMs: Math.round(performance.now() - startTime),
      note: 'Error during execution',
    };
  }
  
  // Print results
  printTestResult(result, scenario);
  
  return result;
}

/**
 * Print test result summary
 */
function printTestResult(result, scenario) {
  const timing = result.timing || {};
  
  console.log(`\n📊 Results for: ${scenario.name}`);
  console.log(`${'─'.repeat(50)}`);
  
  if (result.success) {
    console.log('   ✅ Status: SUCCESS');
  } else {
    console.log('   ❌ Status: FAILED');
    if (result.error) {
      console.log(`   Error: ${result.error}`);
    }
  }
  
  console.log('\n   ⏱️  TIMING BREAKDOWN:');
  
  if (timing.llmPlanningMs !== undefined) {
    console.log(`   🧠 LM Studio Planning:        ${timing.llmPlanningMs.toLocaleString().padStart(8)} ms`);
  }
  if (timing.llmVerificationMs !== undefined) {
    console.log(`   🧠 LM Studio Verification:    ${timing.llmVerificationMs.toLocaleString().padStart(8)} ms`);
  }
  if (timing.llmFinalVerificationMs !== undefined) {
    console.log(`   🧠 LM Studio Final Verify:    ${timing.llmFinalVerificationMs.toLocaleString().padStart(8)} ms`);
  }
  if (timing.llmTotalMs !== undefined) {
    console.log(`   🧠 LM Studio TOTAL:           ${timing.llmTotalMs.toLocaleString().padStart(8)} ms (${timing.llmCallCount || 0} calls)`);
  }
  
  console.log('   ─────────────────────────────────────────────');
  
  if (timing.cliExecutionMs !== undefined) {
    console.log(`   🚀 CLI Execution TOTAL:       ${timing.cliExecutionMs.toLocaleString().padStart(8)} ms (${timing.cliCallCount || 0} calls)`);
    if (timing.cliBackendUsed) {
      console.log(`   🚀 CLI Backend: ${timing.cliBackendUsed}`);
    }
  }
  
  console.log('   ─────────────────────────────────────────────');
  console.log(`   ⏱️  TOTAL ORCHESTRATION:       ${(timing.totalMs || 0).toLocaleString().padStart(8)} ms`);
  
  if (timing.stepsExecuted !== undefined) {
    console.log(`   📋 Steps Executed: ${timing.stepsExecuted}`);
  }
  
  // Calculate percentages
  if (timing.llmTotalMs !== undefined && timing.cliExecutionMs !== undefined && timing.totalMs) {
    const llmPercent = ((timing.llmTotalMs / timing.totalMs) * 100).toFixed(1);
    const cliPercent = ((timing.cliExecutionMs / timing.totalMs) * 100).toFixed(1);
    const overheadMs = timing.totalMs - timing.llmTotalMs - timing.cliExecutionMs;
    const overheadPercent = ((overheadMs / timing.totalMs) * 100).toFixed(1);
    
    console.log('\n   📈 TIME DISTRIBUTION:');
    console.log(`   LM Studio:   ${llmPercent.padStart(5)}%  ${'█'.repeat(Math.round(llmPercent / 5))}`);
    console.log(`   CLI:         ${cliPercent.padStart(5)}%  ${'█'.repeat(Math.round(cliPercent / 5))}`);
    console.log(`   Overhead:    ${overheadPercent.padStart(5)}%  ${'░'.repeat(Math.round(overheadPercent / 5))}`);
  }
}

/**
 * Generate summary report
 */
function generateSummaryReport(results) {
  console.log('\n\n');
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║           E2E ORCHESTRATION TIMING SUMMARY REPORT              ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);
  
  console.log(`\n📊 OVERALL RESULTS: ${successful.length}/${results.length} tests passed\n`);
  
  // Aggregate timing stats
  let totalLlmMs = 0;
  let totalCliMs = 0;
  let totalMs = 0;
  let totalLlmCalls = 0;
  let totalCliCalls = 0;
  let totalSteps = 0;
  
  for (const result of results) {
    if (result.timing) {
      totalLlmMs += result.timing.llmTotalMs || 0;
      totalCliMs += result.timing.cliExecutionMs || 0;
      totalMs += result.timing.totalMs || 0;
      totalLlmCalls += result.timing.llmCallCount || 0;
      totalCliCalls += result.timing.cliCallCount || 0;
      totalSteps += result.timing.stepsExecuted || 0;
    }
  }
  
  console.log('┌─────────────────────────────────────────────────────────────────┐');
  console.log('│ AGGREGATE TIMING STATISTICS                                     │');
  console.log('├─────────────────────────────────────────────────────────────────┤');
  console.log(`│ 🧠 LM Studio (Orchestrator) Total:  ${totalLlmMs.toLocaleString().padStart(10)} ms (${totalLlmCalls} calls) │`);
  console.log(`│ 🚀 CLI (Worker) Total:              ${totalCliMs.toLocaleString().padStart(10)} ms (${totalCliCalls} calls) │`);
  console.log(`│ ⏱️  Combined Total:                  ${totalMs.toLocaleString().padStart(10)} ms              │`);
  console.log(`│ 📋 Total Steps Executed:            ${String(totalSteps).padStart(10)}                  │`);
  console.log('└─────────────────────────────────────────────────────────────────┘');
  
  if (totalMs > 0) {
    const llmPercent = ((totalLlmMs / totalMs) * 100).toFixed(1);
    const cliPercent = ((totalCliMs / totalMs) * 100).toFixed(1);
    
    console.log('\n📈 TIME DISTRIBUTION (All Tests):');
    console.log(`   LM Studio (Planning/Verify): ${llmPercent}%`);
    console.log(`   CLI (Actual Work):           ${cliPercent}%`);
    console.log(`   Overhead:                    ${(100 - parseFloat(llmPercent) - parseFloat(cliPercent)).toFixed(1)}%`);
  }
  
  // Per-test breakdown
  console.log('\n┌─────────────────────────────────────────────────────────────────┐');
  console.log('│ PER-TEST BREAKDOWN                                              │');
  console.log('├─────────────────────────────────────────────────────────────────┤');
  
  for (const result of results) {
    const timing = result.timing || {};
    const status = result.success ? '✅' : '❌';
    const name = result.scenarioName.substring(0, 40).padEnd(40);
    const total = (timing.totalMs || 0).toLocaleString().padStart(8);
    
    console.log(`│ ${status} ${name} ${total} ms │`);
    
    if (timing.llmTotalMs !== undefined && timing.cliExecutionMs !== undefined) {
      const llm = timing.llmTotalMs.toLocaleString().padStart(8);
      const cli = timing.cliExecutionMs.toLocaleString().padStart(8);
      console.log(`│    └─ LLM: ${llm}ms  CLI: ${cli}ms                        │`);
    }
  }
  
  console.log('└─────────────────────────────────────────────────────────────────┘');
  
  // Failed tests
  if (failed.length > 0) {
    console.log('\n❌ FAILED TESTS:');
    for (const result of failed) {
      console.log(`   - ${result.scenarioName}: ${result.error || 'Unknown error'}`);
    }
  }
  
  // Future Copilot CLI support note
  console.log('\n📝 NOTES:');
  console.log('   - Current backend: OpenCode CLI with opencode/big-pickle');
  console.log('   - LM Studio model: openai/gpt-oss-20b (local orchestration)');
  console.log('   - Copilot CLI support: Ready for future testing (backend prepared)');
  
  return {
    totalTests: results.length,
    passed: successful.length,
    failed: failed.length,
    timing: {
      llmTotalMs: totalLlmMs,
      cliTotalMs: totalCliMs,
      totalMs,
      llmCalls: totalLlmCalls,
      cliCalls: totalCliCalls,
      stepsExecuted: totalSteps,
    },
    results,
  };
}

/**
 * Save results to JSON file
 */
async function saveResults(report) {
  const reportPath = 'e2e-timing-report.json';
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n💾 Full report saved to: ${reportPath}`);
}

/**
 * Check if server is running
 */
async function checkServerHealth() {
  console.log('🏥 Checking server health...');
  
  try {
    // Check the /api/backends endpoint to verify server is up
    const response = await fetch(`${SERVER_URL}/api/backends`);
    if (response.ok) {
      const backends = await response.json();
      console.log(`   ✅ Server is healthy (${backends.length} backends configured)`);
      return true;
    } else {
      console.log(`   ❌ Server returned error: ${response.status}`);
      return false;
    }
  } catch (error) {
    console.log(`   ❌ Server not responding: ${error.message}`);
    return false;
  }
}

/**
 * Main test runner
 */
async function main() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║       E2E ORCHESTRATION TIMING TESTS - LLM vs CLI              ║');
  console.log('║                                                                ║');
  console.log('║  Measuring: LM Studio (planning) vs OpenCode CLI (execution)   ║');
  console.log('║  Tests: 5 scenarios from simple to complex                     ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  
  // Check server health
  const isHealthy = await checkServerHealth();
  if (!isHealthy) {
    console.log('\n❌ Cannot run tests - server not available');
    console.log('   Please start the server with: npm start');
    process.exit(1);
  }
  
  // Clean up any previous test artifacts
  await cleanupTestWorkspace();
  
  // Setup test workspace
  await setupTestWorkspace();
  
  console.log('\n📋 Running 5 test scenarios...');
  console.log('   Backend: OpenCode CLI (opencode/big-pickle)');
  console.log('   Orchestrator: LM Studio (openai/gpt-oss-20b)');
  
  // Run all test scenarios
  for (const scenario of TEST_SCENARIOS) {
    try {
      const result = await runTestScenario(scenario, 'opencode-cli');
      testResults.push(result);
      
      // Small delay between tests
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      console.log(`\n❌ Error running scenario ${scenario.id}: ${error.message}`);
      testResults.push({
        scenarioId: scenario.id,
        scenarioName: scenario.name,
        backend: 'opencode-cli',
        success: false,
        error: error.message,
        timing: { totalMs: 0 },
      });
    }
  }
  
  // Generate and save summary report
  const report = generateSummaryReport(testResults);
  await saveResults(report);
  
  // Cleanup
  // await cleanupTestWorkspace();  // Uncomment to clean up after tests
  
  console.log('\n✅ E2E timing tests complete!');
  
  // Exit with appropriate code
  process.exit(report.failed > 0 ? 1 : 0);
}

// Run if executed directly
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

