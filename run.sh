#!/usr/bin/env bash
# run.sh — run andy straight from the checkout.
#
# The real launcher lives in packaging/; it needs ANDY_ROOT to point at the
# checkout (its own directory is packaging/). This shim does exactly that, so
# `./run.sh` starts the proxy and the harness for you. The launcher then runs
# the checkout's own dependencies (./node_modules, from `npm install`), so
# there is nothing to activate:
#
#   npm install
#   ./setup.sh                          # verify the route end-to-end
#   ./run.sh                            # launch
#
# If you installed with install.sh, an `andy` command is already on your PATH
# and this shim is not needed.
#
# See packaging/andy for the configuration knobs.

set -euo pipefail

_self_dir="$(cd -- "$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")" && pwd -P)"
export ANDY_ROOT="$_self_dir"
exec "$_self_dir/packaging/andy" "$@"
