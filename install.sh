#!/bin/sh
set -e

REPO="denoland/clawssh"
INSTALL_DIR="${CLAWSSH_INSTALL_DIR:-/usr/local/bin}"

OS=$(uname -s)
ARCH=$(uname -m)

case "$OS" in
  Darwin) os="macos" ;;
  Linux)  os="linux" ;;
  *) echo "Unsupported OS: $OS" >&2; exit 1 ;;
esac

case "$ARCH" in
  x86_64|amd64)  arch="x64" ;;
  aarch64|arm64) arch="arm64" ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

BINARY="clawssh-${os}-${arch}"

if [ -n "$1" ]; then
  TAG="$1"
else
  TAG=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | cut -d'"' -f4)
fi

URL="https://github.com/${REPO}/releases/download/${TAG}/${BINARY}"

echo "Installing clawssh ${TAG} (${os}/${arch})..."
curl -fsSL "$URL" -o clawssh
chmod +x clawssh

if [ -w "$INSTALL_DIR" ]; then
  mv clawssh "$INSTALL_DIR/clawssh"
else
  sudo mv clawssh "$INSTALL_DIR/clawssh"
fi

echo "Installed to ${INSTALL_DIR}/clawssh"
