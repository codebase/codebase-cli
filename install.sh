#!/bin/sh
set -e

# Codebase CLI installer
# Usage: curl -sSL https://raw.githubusercontent.com/codebase-foundation/codebase-cli/main/install.sh | sh

REPO="codebase-foundation/codebase-cli"
BINARY="codebase"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"

# Detect OS
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$OS" in
  linux)  OS="linux" ;;
  darwin) OS="darwin" ;;
  *)      echo "Unsupported OS: $OS"; exit 1 ;;
esac

# Detect architecture
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64)  ARCH="amd64" ;;
  aarch64|arm64)  ARCH="arm64" ;;
  *)              echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

# Get latest release tag
echo "Finding latest release..."
TAG=$(curl -sSf "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | head -1 | cut -d'"' -f4)
if [ -z "$TAG" ]; then
  echo "Error: Could not find latest release. Check https://github.com/${REPO}/releases"
  exit 1
fi
echo "Latest version: $TAG"

# Download
ARCHIVE="${BINARY}_${OS}_${ARCH}.tar.gz"
URL="https://github.com/${REPO}/releases/download/${TAG}/${ARCHIVE}"

echo "Downloading ${URL}..."
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

curl -sSfL "$URL" -o "${TMP}/${ARCHIVE}"
tar -xzf "${TMP}/${ARCHIVE}" -C "$TMP"

# Install
if [ -w "$INSTALL_DIR" ]; then
  mv "${TMP}/${BINARY}" "${INSTALL_DIR}/${BINARY}"
else
  echo "Installing to ${INSTALL_DIR} (requires sudo)..."
  sudo mv "${TMP}/${BINARY}" "${INSTALL_DIR}/${BINARY}"
fi

chmod +x "${INSTALL_DIR}/${BINARY}"

echo ""
echo "Installed ${BINARY} ${TAG} to ${INSTALL_DIR}/${BINARY}"
echo ""
echo "Quick start:"
echo "  export OPENAI_API_KEY=sk-..."
echo "  cd your-project"
echo "  codebase"
echo ""
echo "Or use any OpenAI-compatible provider:"
echo "  export OPENAI_BASE_URL=https://api.groq.com/openai/v1"
echo "  export OPENAI_API_KEY=gsk-..."
echo "  export OPENAI_MODEL=llama-3.3-70b-versatile"
echo "  codebase"
