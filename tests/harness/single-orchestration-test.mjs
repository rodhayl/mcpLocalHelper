#!/usr/bin/env node
/**
 * Single Orchestration Test - Minimal test for debugging hangs
 */

const SERVER_URL = 'http://localhost:3000';

async function main() {
  console.log('🧪 Single Orchestration Test');
  console.log('============================');
  
  // 1. Check server health
  console.log('\n1. Checking server health...');
  try {
    const healthRes = await fetch(`${SERVER_URL}/health`);
    if (!healthRes.ok) throw new Error(`Health check failed: ${healthRes.status}`);
    console.log('   ✅ Server is healthy');
  } catch (e) {
    console.error(`   ❌ Server not reachable: ${e.message}`);
    console.error('   Start the server with: npm start');
    process.exit(1);
  }
  
  // 2. Check backends
  console.log('\n2. Checking available backends...');
  try {
    const backendsRes = await fetch(`${SERVER_URL}/api/backends`);
    const backends = await backendsRes.json();
    console.log('   Available backends:', JSON.stringify(backends, null, 2));
  } catch (e) {
    console.warn(`   ⚠️ Could not fetch backends: ${e.message}`);
  }
  
  // 3. Enable CLI orchestration
  console.log('\n3. Enabling CLI orchestration...');
  try {
    const enableRes = await fetch(`${SERVER_URL}/api/settings/cli-orchestration`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: true,
        backends: ['opencode-cli'],
        autoVerify: false,
        scoreThreshold: 7,
        maxIterations: 1,
      }),
    });
    if (!enableRes.ok) throw new Error(`Enable failed: ${enableRes.status}`);
    console.log('   ✅ CLI orchestration enabled');
  } catch (e) {
    console.error(`   ❌ Failed to enable: ${e.message}`);
  }
  
  // 4. Run simple orchestration task
  console.log('\n4. Running simple orchestration task (60s timeout)...');
  const task = 'Create a file named "test-output.txt" with content "Hello from orchestration test"';
  
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  
  const startMs = performance.now();
  try {
    const res = await fetch(`${SERVER_URL}/api/tools/cli_orchestrate/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ arguments: { task } }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    
    const elapsedMs = Math.round(performance.now() - startMs);
    console.log(`   Response received in ${elapsedMs}ms`);
    
    const result = await res.json();
    console.log('\n   📊 Result:');
    console.log(JSON.stringify(result, null, 2));
    
    if (result.timing) {
      console.log('\n   ⏱️ Timing breakdown:');
      console.log(`      LLM Planning:    ${result.timing.llmPlanningMs}ms`);
      console.log(`      LLM Verification: ${result.timing.llmVerificationMs}ms`);
      console.log(`      CLI Execution:    ${result.timing.cliExecutionMs}ms`);
      console.log(`      Total:            ${result.timing.totalMs}ms`);
    } else {
      console.log('\n   ⚠️ No timing data in result');
    }
  } catch (e) {
    clearTimeout(timeout);
    const elapsedMs = Math.round(performance.now() - startMs);
    if (e.name === 'AbortError') {
      console.error(`   ❌ TIMEOUT after ${elapsedMs}ms - orchestration hung!`);
    } else {
      console.error(`   ❌ Error after ${elapsedMs}ms: ${e.message}`);
    }
    process.exit(1);
  }
  
  console.log('\n✅ Test complete!');
}

main().catch(console.error);
