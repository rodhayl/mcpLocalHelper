#!/bin/bash
# Setup OpenCode to auto-approve all permissions
# Run this script before using OpenCode as a backend

set -e

OPENCODE_CONFIG_DIR="${HOME}/.config/opencode"
OPENCODE_CONFIG_FILE="${OPENCODE_CONFIG_DIR}/opencode.json"

echo "Setting up OpenCode auto-approval configuration..."

# Create config directory if it doesn't exist
mkdir -p "$OPENCODE_CONFIG_DIR"

# Create config file with auto-approval enabled
cat > "$OPENCODE_CONFIG_FILE" << 'EOF'
{
  "autoApprove": true,
  "allowedTools": [
    "bash",
    "glob", 
    "grep",
    "view",
    "write",
    "edit",
    "patch",
    "fetch",
    "agent",
    "sourcegraph",
    "diagnostics"
  ],
  "theme": "dark",
  "model": "glm-4"
}
EOF

echo "Created OpenCode configuration at: $OPENCODE_CONFIG_FILE"
echo ""
echo "Configuration summary:"
echo "  - autoApprove: true"
echo "  - allowedTools: bash, glob, grep, view, write, edit, patch, fetch, agent, sourcegraph, diagnostics"
echo ""
echo "You can now use OpenCode CLI without permission prompts."
