#!/usr/bin/env bash
# Install script for opencode-swarm-skill
# Usage: curl -fsSL https://raw.githubusercontent.com/mnk-works/opencode-swarm-skill/main/scripts/install.sh | bash

set -euo pipefail

REPO="mnk-works/opencode-swarm-skill"
BRANCH="main"
INSTALL_DIR="${HOME}/.opencode/skill/opencode-swarm"

echo "Installing opencode-swarm-skill from ${REPO}@${BRANCH}..."

# Check for opencode
if ! command -v opencode &> /dev/null; then
    echo "Error: opencode not found. Install OpenCode first: https://opencode.ai"
    exit 1
fi

# Check for python (for MCP server)
if ! command -v python3 &> /dev/null; then
    echo "Error: python3 not found. Required for MCP server."
    exit 1
fi

# Check for mcp package
if ! python3 -c "import mcp" 2>/dev/null; then
    echo "Installing mcp package..."
    pip3 install mcp --quiet
fi

# Create skill directory
mkdir -p "${INSTALL_DIR}"

# Download skill files
echo "Downloading skill files..."
TMP_DIR=$(mktemp -d)
cd "${TMP_DIR}"

# Use gh if available, otherwise curl
if command -v gh &> /dev/null; then
    gh api repos/${REPO}/tarball/${BRANCH} | tar xz --strip-components=1
else
    curl -fsSL "https://github.com/${REPO}/archive/${BRANCH}.tar.gz" | tar xz --strip-components=1
fi

# Copy to install dir
cp -r . "${INSTALL_DIR}/"

# Cleanup
cd /
rm -rf "${TMP_DIR}"

# Make command executable
chmod +x "${INSTALL_DIR}/commands/swarm.js"

echo ""
echo "✅ Installed to ${INSTALL_DIR}"
echo ""
echo "Next steps:"
echo "  1. In your project: opencode swarm init"
echo "  2. Edit .opencode/swarm.yaml if needed"
echo "  3. Run: opencode swarm start"
echo ""
echo "The skill is now available globally. Run 'opencode swarm --help' for commands."