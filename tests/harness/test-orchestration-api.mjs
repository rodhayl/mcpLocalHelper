/**
 * Quick test script for CLI orchestration API
 */

async function testOrchestrationAPI() {
  const baseUrl = 'http://localhost:3000';
  
  console.log('=== CLI Orchestration API Test ===\n');
  
  // Test 1: Get settings
  console.log('1. Get CLI orchestration settings...');
  try {
    const settingsRes = await fetch(`${baseUrl}/api/settings/cli-orchestration`);
    const settings = await settingsRes.json();
    console.log('Settings:', JSON.stringify(settings, null, 2));
  } catch (error) {
    console.error('Error getting settings:', error.message);
  }
  
  console.log('\n2. Enable CLI orchestration...');
  try {
    const enableRes = await fetch(`${baseUrl}/api/settings/cli-orchestration/enable`, {
      method: 'POST',
    });
    const enableResult = await enableRes.json();
    console.log('Enable result:', JSON.stringify(enableResult, null, 2));
  } catch (error) {
    console.error('Error enabling:', error.message);
  }
  
  console.log('\n3. Select opencode-cli backend...');
  try {
    const backendsRes = await fetch(`${baseUrl}/api/settings/cli-orchestration`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backends: ['opencode-cli'] }),
    });
    const backendsResult = await backendsRes.json();
    console.log('Backends result:', JSON.stringify(backendsResult, null, 2));
  } catch (error) {
    console.error('Error setting backends:', error.message);
  }
  
  console.log('\n4. Probe CLI backends...');
  try {
    const probeRes = await fetch(`${baseUrl}/api/orchestration/probe`);
    const probeResult = await probeRes.json();
    console.log('Probe result:', JSON.stringify(probeResult, null, 2));
  } catch (error) {
    console.error('Error probing:', error.message);
  }
  
  console.log('\n5. Get updated settings...');
  try {
    const settingsRes = await fetch(`${baseUrl}/api/settings/cli-orchestration`);
    const settings = await settingsRes.json();
    console.log('Updated settings:', JSON.stringify(settings, null, 2));
  } catch (error) {
    console.error('Error getting updated settings:', error.message);
  }
  
  console.log('\n=== Test Complete ===');
}

testOrchestrationAPI().catch(console.error);
