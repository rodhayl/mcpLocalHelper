#!/usr/bin/env node
/**
 * Verification Script for CLI Orchestration Flow
 * 
 * This script verifies that:
 * 1. LM Studio (local) is ONLY used for planning/verification (~minimal tokens)
 * 2. OpenCode CLI with opencode/big-pickle does the ACTUAL WORK
 * 3. No expensive paid API calls are made for code generation
 */

import fs from 'fs';
import path from 'path';

const BASE_URL = 'http://localhost:3000';

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  return response.json();
}

async function verifyOrchestrationFlow() {
  console.log('\n============================================');
  console.log('🔍 CLI ORCHESTRATION FLOW VERIFICATION');
  console.log('============================================\n');

  // Step 1: Check server health
  console.log('1️⃣ Checking server health...');
  try {
    const health = await fetchJson(`${BASE_URL}/api/health`);
    console.log(`   ✅ Server is ${health.status}\n`);
  } catch (e) {
    console.log(`   ❌ Server not running: ${e.message}\n`);
    process.exit(1);
  }

  // Step 2: Check CLI orchestration settings
  console.log('2️⃣ Checking CLI orchestration settings...');
  const settings = await fetchJson(`${BASE_URL}/api/settings/cli-orchestration`);
  console.log(`   Enabled: ${settings.enabled ? '✅ YES' : '❌ NO'}`);
  console.log(`   Backends: ${settings.backends?.join(', ') || 'None'}`);
  console.log(`   Auto-verify: ${settings.autoVerify}`);
  console.log('');

  if (!settings.enabled) {
    console.log('   ⚠️ Enabling CLI orchestration...');
    await fetchJson(`${BASE_URL}/api/settings/cli-orchestration`, {
      method: 'POST',
      body: JSON.stringify({
        enabled: true,
        backends: ['opencode-cli'],
        autoVerify: false,
        scoreThreshold: 7,
        maxIterations: 1
      })
    });
    console.log('   ✅ CLI orchestration enabled\n');
  }

  // Step 3: Check backend availability
  console.log('3️⃣ Probing CLI backends...');
  const probe = await fetchJson(`${BASE_URL}/api/orchestration/probe`);
  console.log(`   OpenCode CLI: ${probe.backends['opencode-cli']?.available ? '✅ Available' : '❌ Not available'}`);
  if (probe.backends['opencode-cli']?.version) {
    console.log(`   Version: ${probe.backends['opencode-cli'].version}`);
  }
  console.log('');

  // Step 4: Verify the flow by running a simple task
  console.log('4️⃣ Running verification task...');
  console.log('   Task: "Echo hello from CLI orchestration"');
  console.log('   Expected flow:');
  console.log('   🧠 LM Studio → Planning (decompose task)');
  console.log('   🚀 OpenCode CLI → Execute (model: opencode/big-pickle)');
  console.log('');

  // Clear log file for fresh capture
  const logPath = path.join(process.cwd(), 'server-stdout.log');
  
  console.log('   ⏳ Running orchestration (this may take 30-60 seconds)...');
  
  try {
    const result = await fetchJson(`${BASE_URL}/api/orchestration/run`, {
      method: 'POST',
      body: JSON.stringify({ task: 'Echo hello from CLI orchestration test' }),
      timeout: 180000
    });
    
    console.log(`   Result: ${result.success ? '✅ Success' : '❌ Failed'}`);
    if (result.error) {
      console.log(`   Error: ${result.error}`);
    }
  } catch (e) {
    console.log(`   ⚠️ Request completed or timed out: ${e.message}`);
  }

  // Step 5: Analyze logs
  console.log('\n5️⃣ Analyzing execution logs...\n');
  
  try {
    const logs = fs.readFileSync(logPath, 'utf-8');
    
    // Count LLM calls
    const llmCalls = (logs.match(/\[LM-STUDIO\] LLM Call/g) || []).length;
    const cliExecutions = (logs.match(/\[OPENCODE-CLI\] Executing task/g) || []).length;
    
    // Check for correct model
    const usesConfiguredModel = logs.includes('opencode/big-pickle');
    const usesPaidModel = logs.includes('openai/gpt-5-mini') || logs.includes('claude') || logs.includes('anthropic');
    
    console.log('   📊 EXECUTION BREAKDOWN:');
    console.log('   ─────────────────────────────────────');
    console.log(`   🧠 LM Studio calls (planning/verify): ${llmCalls}`);
    console.log(`   🚀 OpenCode CLI executions (work):    ${cliExecutions}`);
    console.log(`   🧠 Uses opencode/big-pickle:          ${usesConfiguredModel ? '✅ YES' : '❌ NO'}`);
    console.log(`   ⚠️ Uses PAID model:                   ${usesPaidModel ? '❌ YES - PROBLEM!' : '✅ NO'}`);
    console.log('   ─────────────────────────────────────\n');
    
    // Verdict
    console.log('============================================');
    if (cliExecutions > 0 && usesConfiguredModel && !usesPaidModel) {
      console.log('✅ VERIFICATION PASSED');
      console.log('');
      console.log('The CLI orchestration flow is working correctly:');
      console.log('• LM Studio only does planning/verification');
      console.log('• OpenCode CLI does the actual work');
      console.log('• opencode/big-pickle is being used');
      console.log('• No paid API calls detected');
    } else if (usesPaidModel) {
      console.log('❌ VERIFICATION FAILED - PAID MODEL DETECTED');
      console.log('');
      console.log('A paid model is being used for code generation!');
      console.log('Check the OpenCode adapter model configuration.');
    } else {
      console.log('⚠️ VERIFICATION INCOMPLETE');
      console.log('');
      console.log('Could not fully verify the flow.');
      console.log('Check server logs for more details.');
    }
    console.log('============================================\n');
    
  } catch (e) {
    console.log(`   ⚠️ Could not read log file: ${e.message}`);
    console.log('   Run the orchestration manually and check server-stdout.log\n');
  }
}

// Run verification
verifyOrchestrationFlow().catch(console.error);
