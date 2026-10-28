#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
app=${1:?Use: bash ci/deploy.sh roko|bridge [rollback]}
action=${2:-deploy}
# shellcheck source=common.sh
source "$script_dir/common.sh" "$app"
exec 8>"$state_dir/deploy.lock"
flock 8
current=''
[[ ! -L "$state_dir/current" ]] || current=$(readlink -f "$state_dir/current")
if [[ "$action" == rollback ]]; then
  [[ -n "$current" && -L "$state_dir/previous" ]] || { echo 'No previous release is available.' >&2; exit 1; }
  target=$(readlink -f "$state_dir/previous")
elif [[ "$action" == deploy ]]; then
  [[ "${GITHUB_REF_NAME:-}" == main ]] || { echo 'Only main may deploy automatically.' >&2; exit 1; }
  : "${GITHUB_SHA:?Missing commit}" "${GITHUB_RUN_NUMBER:?Missing run number}"
  [[ "$(git rev-parse HEAD)" == "$GITHUB_SHA" ]] || exit 1
  manifest=$(python3 "$script_dir/registry-manifest.py" read "$app")
  mapfile -t fields <<< "$manifest"
  image=${fields[0]}; image_id=${fields[1]}
  if [[ -n "$current" ]]; then
    last_build=$(cat "$current/build_number")
    [[ "$last_build" =~ ^[0-9]{1,12}$ ]] || exit 1
    if ((10#$GITHUB_RUN_NUMBER <= 10#$last_build)); then
      echo 'This pipeline has already deployed or has been superseded; skipping.'
      exit 0
    fi
    project=$(cat "$current/project")
  fi
  # This step runs only after cloud tests/build/publish succeed. Never rebuild.
  docker pull --platform linux/amd64 "$image"
  [[ "$(docker image inspect --format '{{.Id}}' "$image")" == "$image_id" ]] || { echo 'Pulled image does not match the tested image configuration.' >&2; exit 1; }
  [[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" == "$GITHUB_SHA" ]] || exit 1
  [[ "$(docker image inspect --format '{{index .Config.Labels "io.roko.ci.service"}}' "$image")" == "$app" ]] || exit 1
  if [[ -z "$current" ]]; then
    args=(compose --project-directory "$deploy_dir" --env-file "$deploy_dir/.env")
    for file in "${config_files[@]}"; do args+=(-f "$deploy_dir/$file"); done
    cid=$(docker "${args[@]}" ps -q "$service")
    [[ -n "$cid" ]] || { echo 'Start the existing service once before enabling automatic deployment.' >&2; exit 1; }
    project=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$cid")
    old_image=$(docker inspect --format '{{.Image}}' "$cid")
    [[ "$old_image" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 1
    current="$state_dir/releases/bootstrap-${GITHUB_RUN_NUMBER}"
    mkdir "$current"
    for file in "${config_files[@]}"; do cp "$deploy_dir/$file" "$current/$file"; done
    printf '%s\n' "$project" > "$current/project"
    printf '0\n' > "$current/build_number"
    backup_image="local/${app}-rollback:bootstrap-${GITHUB_RUN_NUMBER}"
    docker tag "$old_image" "$backup_image"
    write_override "$current" "$backup_image" "$old_image"
    compose_release "$current" config -q
    link_release current "$current"
  fi
  [[ "$project" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || exit 1
  target="$state_dir/releases/${GITHUB_SHA}-${GITHUB_RUN_NUMBER}"
  mkdir -p "$target"
  # Only deployment definitions are copied. Application source is in the tested image.
  for file in "${config_files[@]}"; do cp "$file" "$target/$file"; done
  printf '%s\n' "$project" > "$target/project"
  printf '%s\n' "$GITHUB_RUN_NUMBER" > "$target/build_number"
  printf '%s\n' "$GITHUB_SHA" > "$target/commit"
  write_override "$target" "$image" "$image_id"
else
  echo 'Unknown action.' >&2; exit 2
fi
check_image "$target"
compose_release "$target" config -q
started=false
function restore_on_failure() {
  local code=$?
  trap - EXIT
  if ((code!=0)) && [[ "$started" == true && -n "$current" ]]; then
    echo 'Deployment failed; restoring the previous image and Compose definitions.' >&2
    if compose_release "$current" up -d --no-deps --no-build --pull never "$service" && wait_healthy "$current"; then
      link_release current "$current"
      echo 'Previous release restored.' >&2
    else
      echo 'Automatic rollback failed. Review the service on the server.' >&2
    fi
  fi
  exit "$code"
}
trap restore_on_failure EXIT
started=true
compose_release "$target" up -d --no-deps --no-build --pull never "$service"
wait_healthy "$target"
[[ -z "$current" ]] || link_release previous "$current"
link_release current "$target"
trap - EXIT
printf 'Deployment of %s completed.\n' "$app"
