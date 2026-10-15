#!/usr/bin/env bash
set -Eeuo pipefail
app=${1:?Use: bash ci/compose.sh roko|bridge <compose arguments>}; shift
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=common.sh
source "$script_dir/common.sh" "$app"
[[ -L "$state_dir/current" ]] || { echo 'There is no CI deployment yet.' >&2; exit 1; }
release=$(readlink -f "$state_dir/current")
compose_release "$release" "$@"
