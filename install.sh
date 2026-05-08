#!/bin/sh
set -e

# Codebase CLI installer (Linux / macOS).
# Usage:
#   curl -fsSL https://codebase.design/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/codebase-foundation/codebase-cli/main/install.sh | sh
#
# What this does:
#   1. Detects an existing v1 (Go) binary and offers to remove it.
#   2. Verifies Node.js >= 20 is available (or prints a one-line install hint).
#   3. Installs @codebase-foundation/cli globally via npm.
#   4. Preserves ~/.codebase/ data (sessions, projects, memory, OAuth
#      credentials) — sign-in carries over from v1 with no re-auth.

PKG="@codebase-foundation/cli"
BIN_NAME="codebase"
NODE_MIN_MAJOR=20

# ─── helpers ───────────────────────────────────────────────────────────────
say()  { printf "\033[1m%s\033[0m\n" "$1"; }
warn() { printf "\033[33m! %s\033[0m\n" "$1"; }
fail() { printf "\033[31m✗ %s\033[0m\n" "$1" >&2; exit 1; }
ok()   { printf "\033[32m✓ %s\033[0m\n" "$1"; }

prompt_yn() {
	# $1 = question, $2 = default (Y or N). Returns 0 for yes, 1 for no.
	default="${2:-Y}"
	if [ "$default" = "Y" ]; then hint="[Y/n]"; else hint="[y/N]"; fi
	# If stdin is not a tty (curl|sh), accept the default to avoid hanging.
	if [ ! -t 0 ]; then
		[ "$default" = "Y" ] && return 0 || return 1
	fi
	printf "%s %s " "$1" "$hint"
	read -r ans
	case "$(printf "%s" "$ans" | tr '[:upper:]' '[:lower:]')" in
		y|yes) return 0 ;;
		n|no)  return 1 ;;
		"")    [ "$default" = "Y" ] && return 0 || return 1 ;;
		*)     [ "$default" = "Y" ] && return 0 || return 1 ;;
	esac
}

# ─── detect existing v1 (Go) binary ────────────────────────────────────────
say "Checking for an existing codebase install…"

V1_PATH=""
if command -v "$BIN_NAME" >/dev/null 2>&1; then
	candidate="$(command -v "$BIN_NAME")"
	# Heuristic: the v1 Go binary is a static ELF/Mach-O executable, not a
	# Node shim. The npm-installed v2 lives under a node_modules path. If
	# the resolved binary is NOT inside a node_modules tree, treat it as v1.
	resolved="$(readlink -f "$candidate" 2>/dev/null || echo "$candidate")"
	case "$resolved" in
		*/node_modules/*) V1_PATH="" ;;
		*)
			# Detect by file type: Go binaries are real executables, not text.
			if [ -f "$resolved" ] && ! head -c 4 "$resolved" 2>/dev/null | grep -q "#!" ; then
				V1_PATH="$candidate"
			fi
			;;
	esac
fi

if [ -n "$V1_PATH" ]; then
	warn "Detected v1 (Go) binary at: $V1_PATH"
	echo "  v2 is a Node-based rewrite. Your data carries over untouched:"
	echo "    ~/.codebase/credentials.json  (OAuth tokens — no re-auth needed)"
	echo "    ~/.codebase/sessions/         (resume past conversations)"
	echo "    ~/.codebase/projects/         (per-project memory + state)"
	echo ""
	if prompt_yn "Remove the old v1 binary now?" Y; then
		if [ -w "$V1_PATH" ]; then
			rm -f "$V1_PATH"
		else
			sudo rm -f "$V1_PATH"
		fi
		ok "Removed $V1_PATH"
	else
		warn "Keeping v1 binary. The npm-installed v2 may not take precedence."
		warn "If 'codebase --version' still reports v1 after install, remove it manually:"
		warn "  sudo rm $V1_PATH"
	fi
fi

# ─── verify node >= 20 ─────────────────────────────────────────────────────
NODE_OK=0
if command -v node >/dev/null 2>&1; then
	NODE_VER="$(node -v 2>/dev/null | sed 's/^v//')"
	NODE_MAJOR="${NODE_VER%%.*}"
	if [ -n "$NODE_MAJOR" ] && [ "$NODE_MAJOR" -ge "$NODE_MIN_MAJOR" ] 2>/dev/null; then
		NODE_OK=1
		ok "Node.js v${NODE_VER} (>= ${NODE_MIN_MAJOR}.0)"
	else
		warn "Node.js v${NODE_VER} is too old (need >= ${NODE_MIN_MAJOR}.0)"
	fi
fi

if [ "$NODE_OK" -eq 0 ]; then
	cat <<EOF

Node.js >= ${NODE_MIN_MAJOR} is required.

Install one of:
  • Volta:  curl https://get.volta.sh | bash && volta install node@${NODE_MIN_MAJOR}
  • fnm:    curl -fsSL https://fnm.vercel.app/install | bash && fnm install ${NODE_MIN_MAJOR}
  • nvm:    https://github.com/nvm-sh/nvm
  • System: https://nodejs.org/

Then re-run:
  curl -fsSL https://codebase.design/install.sh | sh

EOF
	exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
	fail "npm is missing. Reinstall Node.js (npm ships with it)."
fi

# ─── install ───────────────────────────────────────────────────────────────
say "Installing ${PKG}…"

# Prefer the user's npm prefix to avoid sudo when possible. If the prefix
# directory isn't writable, fall back to sudo.
NPM_PREFIX="$(npm prefix -g 2>/dev/null)"
NPM_BIN="${NPM_PREFIX}/bin"

if [ -w "$NPM_PREFIX" ] || [ ! -d "$NPM_PREFIX" ]; then
	npm install -g "$PKG"
else
	warn "npm prefix ${NPM_PREFIX} requires sudo to write."
	sudo npm install -g "$PKG"
fi

# ─── post-install verification ─────────────────────────────────────────────
if ! command -v "$BIN_NAME" >/dev/null 2>&1; then
	cat <<EOF

Install completed but '${BIN_NAME}' is not on your PATH.

Add npm's global bin directory to PATH:
  export PATH="${NPM_BIN}:\$PATH"

Append that to ~/.zshrc, ~/.bashrc, or your shell rc file, then restart
the terminal.

EOF
	exit 1
fi

INSTALLED_VER="$($BIN_NAME --version 2>/dev/null || echo "(unknown)")"
ok "Installed ${BIN_NAME} ${INSTALLED_VER}"
ok "Run '${BIN_NAME}' in any project directory to get started."

# Hint at sign-in if the user has no credentials yet.
if [ ! -f "${HOME}/.codebase/credentials.json" ] \
	&& [ -z "$ANTHROPIC_API_KEY" ] \
	&& [ -z "$OPENAI_API_KEY" ]; then
	echo ""
	echo "First time? Sign in for free Claude usage:"
	echo "  ${BIN_NAME} auth login"
fi
