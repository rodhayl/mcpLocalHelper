/**
 * Postinstall Helpers for MCP Local LLM
 * 
 * Ensures users always have the canonical env.settings file after install.
 * Handles: missing files or existing files that differ from the canonical example.
 */

const fs = require('fs');
const path = require('path');

function normalizeContent(value) {
  return value.replace(/\r\n/g, '\n');
}

/**
 * Ensure user has the canonical env.settings file after installation.
 * 
 * @param {string} homeDir - User's home directory (e.g., os.homedir())
 * @param {string} sourceFile - Path to env.settings.example
 * @returns {object} - { action: 'created'|'replaced'|'noop', target, backup? }
 */
function ensureDefaultEnvSettings(homeDir, sourceFile) {
  const configDir = path.join(homeDir, '.mcp-local-llm');
  const targetFile = path.join(configDir, 'env.settings');

  // Ensure directory exists
  if (!fs.existsSync(configDir)) {
    try {
      fs.mkdirSync(configDir, { recursive: true });
    } catch (err) {
      // Silently fail if we can't create directory (permission issues)
      return { action: 'error', error: err.message };
    }
  }

  // Read source file
  let sourceContent;
  try {
    sourceContent = fs.readFileSync(sourceFile, 'utf8');
  } catch (err) {
    return { action: 'error', error: `Cannot read source: ${err.message}` };
  }

  // Case 1: File doesn't exist → create it
  if (!fs.existsSync(targetFile)) {
    try {
      fs.copyFileSync(sourceFile, targetFile);
      return { action: 'created', target: targetFile };
    } catch (err) {
      return { action: 'error', error: `Cannot create: ${err.message}` };
    }
  }

  // Case 2: File exists → check if it needs patching
  let existingContent;
  try {
    existingContent = fs.readFileSync(targetFile, 'utf8');
  } catch (err) {
    return { action: 'error', error: `Cannot read existing: ${err.message}` };
  }

  const normalizedSource = normalizeContent(sourceContent);
  const normalizedExisting = normalizeContent(existingContent);

  // Case 2a: Already matches canonical example → no-op
  if (normalizedSource === normalizedExisting) {
    return { action: 'noop', target: targetFile };
  }

  // Case 2b: Different content → replace with backup
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(configDir, `env.settings.backup-${timestamp}`);

  try {
    // Create timestamped backup
    fs.copyFileSync(targetFile, backupFile);

    // Write atomically (write to temp, then rename)
    const tempFile = targetFile + '.tmp';
    fs.writeFileSync(tempFile, sourceContent, 'utf8');
    fs.renameSync(tempFile, targetFile);

    return { action: 'replaced', target: targetFile, backup: backupFile };
  } catch (err) {
    return { action: 'error', error: `Cannot replace: ${err.message}` };
  }
}

module.exports = {
  ensureDefaultEnvSettings,
};
