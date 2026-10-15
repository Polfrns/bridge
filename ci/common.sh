#!/usr/bin/env bash
# Sourced by deploy.sh and compose.sh; deployment configuration stays on this host.
set -Eeuo pipefail
ci_app=${1:?Missing service name}
case "$ci_app" in
  roko) deploy_dir=${ROKO_DEPLOY_DIR:?Set ROKO_DEPLOY_DIR}; service=api; config_files=(docker-compose.yml docker-compose.override.yml) ;;
  bridge) deploy_dir=${BRIDGE_DEPLOY_DIR:?Set BRIDGE_DEPLOY_DIR}; service=bridge; config_files=(compose.yaml) ;;
  *) echo 'Unknown service.' >&2; exit 2 ;;
esac
[[ -d "$deploy_dir" && -f "$deploy_dir/.env" ]] || { echo 'Deployment directory or private .env is missing.' >&2; exit 1; }
deploy_dir=$(cd "$deploy_dir" && pwd -P)
state_dir="$deploy_dir/.ci-deploy"
mkdir -p "$state_dir/releases"
function compose_release() {
  local release=$1; shift
  local project
  project=$(cat "$release/project")
  [[ "$project" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || return 2
  local args=(compose --project-directory "$deploy_dir" --env-file "$deploy_dir/.env" -p "$project")
  local file
  for file in "${config_files[@]}"; do args+=(-f "$release/$file"); done
  args+=(-f "$release/image.override.json")
  docker "${args[@]}" "$@"
}
function link_release() {
  local name=$1 release=$2
  ln -s "$release" "$state_dir/$name.next"
  mv -Tf "$state_dir/$name.next" "$state_dir/$name"
}
function write_override() {
  local release=$1 image=$2 image_id=$3
  python3 - "$release" "$service" "$image" "$image_id" <<'PY'
import json,sys
from pathlib import Path
root,service,image,image_id=sys.argv[1:]
p=Path(root)
(p/'image.override.json').write_text(json.dumps({'services':{service:{'image':image,'pull_policy':'never'}}}))
(p/'image_id').write_text(image_id+'\n')
PY
}
function check_image() {
  local release=$1 expected
  expected=$(cat "$release/image_id")
  [[ "$expected" =~ ^sha256:[a-f0-9]{64}$ ]] || return 2
  docker image inspect "$expected" >/dev/null
}
function wait_healthy() {
  local release=$1 cid image expected attempt
  local attempts=${CI_HEALTH_ATTEMPTS:-60}
  [[ "$attempts" =~ ^[1-9][0-9]{0,2}$ ]] || return 2
  expected=$(cat "$release/image_id")
  for ((attempt=0; attempt<attempts; attempt++)); do
    cid=$(compose_release "$release" ps -q "$service")
    if [[ -n "$cid" ]]; then
      image=$(docker inspect --format '{{.Image}}' "$cid" 2>/dev/null || true)
      if [[ "$image" == "$expected" ]] && compose_release "$release" exec -T "$service" node -e \
        'const port=process.env.BRIDGE_PORT||process.env.PORT||3080; fetch("http://127.0.0.1:"+port+"/health",{signal:AbortSignal.timeout(3000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))' >/dev/null 2>&1; then
        return 0
      fi
    fi
    sleep 3
  done
  echo 'New container did not become healthy within the deployment window.' >&2
  return 1
}
