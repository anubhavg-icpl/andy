#!/usr/bin/env bash
# install.sh — one-line installer for Andy.
#
#   curl -fsSL https://raw.githubusercontent.com/anubhavg-icpl/andy/main/install.sh | bash
#
# Clones Andy into ~/.local/share/andy, installs its dependencies with npm and
# builds the CLI bundle there, then drops an `andy` launcher into ~/.local/bin.
# After this the operator never runs npm by hand: `andy` finds its own
# node_modules and runs from any directory.
#
# The dependencies are built here, on this machine, rather than shipped —
# node_modules is not portable (native bits and package layout assume the
# machine that runs them), so the only way to hand someone a working install
# is to `npm install` where it will run. That is what this does.
#
# Idempotent: re-run it any time to update an existing install. The launcher it
# writes refreshes node_modules itself when package.json changes, so this only
# needs to run once.
#
# Environment overrides (all optional):
#   ANDY_REPO              git URL to install from
#                          (default https://github.com/anubhavg-icpl/andy.git)
#   ANDY_INSTALL_DIR       where the checkout and node_modules live
#                          (default ${XDG_DATA_HOME:-~/.local/share}/andy)
#   ANDY_BIN_DIR           where the `andy` launcher is written
#                          (default ~/.local/bin)
#   ANDY_SKIP_DEPS=1       lay the files down but do not install dependencies
#   ANDY_SKIP_SETUP=1      do not run setup.sh at the end
#
# This is meant to be run from a pipe (`curl … | bash`), where standard input
# is the script itself — so nothing here may read stdin. External commands get
# </dev/null, and the one prompt (setup.sh asking for a key) is reconnected to
# the controlling terminal explicitly.

set -euo pipefail

REPO="${ANDY_REPO:-https://github.com/anubhavg-icpl/andy.git}"
INSTALL_DIR="${ANDY_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/andy}"
BIN_DIR="${ANDY_BIN_DIR:-$HOME/.local/bin}"
ANDY_HOME="${ANDY_HOME:-$HOME/.andy}"
PROFILE="$ANDY_HOME/logfare/source"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
step() { printf '\n\033[36m▸\033[0m \033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m⚠\033[0m %s\n' "$*" >&2; }
die()  { printf '\n\033[31m✖ %s\033[0m\n' "$*" >&2; exit 1; }
note() { printf '      \033[36m%s\033[0m\n' "$*" >&2; }

# Animate while a command runs, then report it exactly like ok() would have.
#
# The command's output is captured and replayed only if it fails, so a spinner
# never interleaves with npm or git mid-line — and on failure the real error
# lands right above the ✖ that explains it. When stdout is not a terminal (a
# pipe, a redirect, CI, the test harness) this falls back to plain execution
# and emits no control characters, so the log stays byte-clean.
spin() {
  local msg="$1"; shift
  local rc=0

  if [[ ! -t 1 ]]; then
    "$@" || rc=$?
    if [[ $rc -eq 0 ]]; then ok "$msg"; fi
    return "$rc"
  fi

  if [[ -z "$SPIN_LOG" ]]; then
    SPIN_LOG="$(mktemp "${TMPDIR:-/tmp}/andy-install.XXXXXX")"
  fi
  : > "$SPIN_LOG"
  "$@" >"$SPIN_LOG" 2>&1 &

  # A braille spinner, plus the elapsed seconds once a step drags — the
  # dependency install is a minute or two and wants a heartbeat.
  local -a frames=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏)
  local pid=$! i=0 start=$SECONDS el
  while kill -0 "$pid" 2>/dev/null; do
    el=$((SECONDS - start))
    printf '\r\033[K  \033[36m%s\033[0m %s' "${frames[i++ % ${#frames[@]}]}" "$msg"
    if (( el > 0 )); then printf ' \033[2m%ds\033[0m' "$el"; fi
    sleep 0.08
  done
  wait "$pid" || rc=$?
  printf '\r\033[K'

  if [[ $rc -eq 0 ]]; then
    ok "$msg"
  elif [[ -s "$SPIN_LOG" ]]; then
    cat "$SPIN_LOG" >&2
  fi
  return "$rc"
}

# The spinner's scratch file, created on first use and removed on any exit.
SPIN_LOG=""
trap 'if [[ -n "$SPIN_LOG" ]]; then rm -f "$SPIN_LOG"; fi' EXIT

# The hash the launcher also uses to decide whether node_modules is stale. Same
# algorithm in both places, so the stamp written here is honoured there.
hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    return 1
  fi
}

bold "╭──────────────────────────────────────────────╮"
bold "│  ANDY · install                             │"
bold "╰──────────────────────────────────────────────╯"

# --- 0. preconditions --------------------------------------------------------

step "Checking prerequisites"
command -v git >/dev/null 2>&1 || die "git is required."

NODE="$(command -v node || true)"
[[ -n "$NODE" ]] || die "node not found — install Node 22 or newer."
"$NODE" -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' \
  || die "Node 22+ is required; $NODE is $("$NODE" -p process.versions.node)."
ok "git and node $("$NODE" -p process.versions.node)"

# --- 1. get the source -------------------------------------------------------

step "Fetching Andy"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  # An existing install. Fast-forward only — never merge, never touch local
  # edits; a failed pull is a warning, not a stop, because the launcher's own
  # update check will report the same thing at run time.
  spin "updated $INSTALL_DIR" \
    git -C "$INSTALL_DIR" pull --ff-only --quiet </dev/null \
    || warn "could not update $INSTALL_DIR (local changes or offline) — using what is there"
elif [[ -e "$INSTALL_DIR" ]]; then
  die "$INSTALL_DIR exists but is not a git checkout — move it aside and re-run."
else
  mkdir -p "$(dirname -- "$INSTALL_DIR")"
  # A full clone, not --depth 1: the launcher's update check counts how far
  # behind the checkout is and fast-forwards it, and both want real history.
  # The repository is a couple of MB, so there is nothing to save by shallow.
  spin "cloned into $INSTALL_DIR" \
    git clone --quiet "$REPO" "$INSTALL_DIR" </dev/null \
    || die "could not clone $REPO"
fi

# --- 2. dependencies ---------------------------------------------------------

if [[ "${ANDY_SKIP_DEPS:-0}" == "1" ]]; then
  warn "ANDY_SKIP_DEPS=1 — skipping the dependencies (the launcher will not run yet)"
else
  step "Installing dependencies (a minute or two the first time)"
  # One spinner covers the whole step — npm install and then the build —
  # because together they are the wait worth animating.
  #
  # Run from the checkout: npm resolves the install against the current
  # directory. Under `curl | bash` the cwd is wherever the operator happened
  # to be.
  _install_deps() {
    ( cd "$INSTALL_DIR" && \
      npm install --silent --no-fund --no-audit </dev/null && \
      npm run build </dev/null )
  }
  spin "dependencies installed and built (node_modules + dist)" _install_deps \
    || die "could not install the dependencies — see the npm output above."
  # Stamp the manifest hash so the launcher's incremental refresh sees a
  # matching tree and does nothing on the first launch.
  if _h="$(hash_file "$INSTALL_DIR/package.json")"; then
    printf '%s' "$_h" > "$INSTALL_DIR/node_modules/.deps.sha"
  fi
fi

# --- 3. the launcher on PATH -------------------------------------------------

step "Installing the launcher"
mkdir -p "$BIN_DIR"
# A tiny shim, not the launcher itself: it pins ANDY_ROOT to the checkout
# so the real launcher (which lives in packaging/) finds the dependencies and
# the profile no matter where `andy` is invoked from. Written fresh each run so
# a moved install re-points itself.
{
  printf '#!/usr/bin/env bash\n'
  printf '# andy — installed launcher (written by install.sh).\n'
  printf '# Pins the checkout and hands every argument to the real launcher.\n'
  printf 'export ANDY_ROOT=%q\n' "$INSTALL_DIR"
  printf 'exec %q "$@"\n' "$INSTALL_DIR/packaging/andy"
} > "$BIN_DIR/andy"
chmod 755 "$BIN_DIR/andy"
ok "$BIN_DIR/andy"

case ":$PATH:" in
  *":$BIN_DIR:"*) ok "$BIN_DIR is on PATH" ;;
  *)
    warn "$BIN_DIR is not on your PATH — add it, then open a new shell:"
    note "echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.bashrc"
    ;;
esac

# --- 4. the credential -------------------------------------------------------

if [[ "${ANDY_SKIP_SETUP:-0}" == "1" ]]; then
  warn "ANDY_SKIP_SETUP=1 — not configuring the route"
elif [[ -r "$PROFILE" ]]; then
  step "Route already configured"
  ok "$PROFILE exists"
elif [[ -r /dev/tty ]]; then
  # setup.sh prompts for the key. Reconnect its stdin to the terminal: under
  # `curl | bash` this script's own stdin is the pipe, so a bare `read` would
  # eat the rest of the script instead of waiting for the operator.
  step "Configuring the Logfare route"
  "$INSTALL_DIR/setup.sh" </dev/tty \
    || warn "setup did not finish — run $INSTALL_DIR/setup.sh when you have your key"
else
  warn "no terminal available to prompt for a key"
  note "run: $INSTALL_DIR/setup.sh"
fi

# --- done --------------------------------------------------------------------

printf '\n'
bold "╭──────────────────────────────────────────────╮"
bold "│  installed.                                  │"
bold "╰──────────────────────────────────────────────╯"
printf '\n'
printf '    \033[36mandy\033[0m                     # launch, from anywhere\n'
printf '    \033[36mandy -C ~/proj\033[0m           # run against another directory\n'
printf '    \033[36mandy --mode andy\033[0m          # full auto, follows AGENTS.md\n\n'
printf '  Re-run this installer to update:  %s/install.sh\n' "$INSTALL_DIR"
printf '  It keeps its own node_modules, so nothing to activate and nothing to install by hand.\n\n'
