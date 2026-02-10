#!/usr/bin/env node
/* eslint-disable no-console */
const { execSync } = require('child_process');

function parsePackDryRunJson() {
  const raw = execSync('npm pack --dry-run --json', {
    encoding: 'utf8',
  }).trim();

  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('Unexpected npm pack --dry-run --json output.');
  }

  const files = parsed[0] && Array.isArray(parsed[0].files) ? parsed[0].files : [];
  return files.map((entry) => String(entry.path || ''));
}

function main() {
  const packedFiles = parsePackDryRunJson();
  const packedSet = new Set(packedFiles);

  const requiredPaths = ['dist/index.js', 'README.md', 'env.settings.example', 'mcp.json.example'];
  const forbiddenPrefixes = ['_backup_dedup/', 'TEST_PROMPTS/', 'tests/', 'src/', 'test-results/'];
  const forbiddenExact = [
    'Requirements.md',
    'SCRIPTS_GUIDE.md',
    'run_all_tests_ALL.py',
    'wrapSuccessResponse-analysis.json',
    'wrapSuccessResponse_search_result.json',
  ];

  const missingRequired = requiredPaths.filter((item) => !packedSet.has(item));
  const forbiddenFound = packedFiles.filter(
    (path) =>
      forbiddenExact.includes(path) || forbiddenPrefixes.some((prefix) => path.startsWith(prefix))
  );

  if (missingRequired.length > 0 || forbiddenFound.length > 0) {
    console.error('[pack:check] Package contents validation failed.');
    if (missingRequired.length > 0) {
      console.error(`Missing required paths: ${missingRequired.join(', ')}`);
    }
    if (forbiddenFound.length > 0) {
      console.error(`Forbidden paths found: ${forbiddenFound.join(', ')}`);
    }
    process.exit(1);
  }

  console.log(`[pack:check] OK (${packedFiles.length} files).`);
}

main();
