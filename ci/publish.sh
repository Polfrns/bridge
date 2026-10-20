#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
app=${1:?Use: bash ci/publish.sh roko|bridge}
[[ "$app" == roko || "$app" == bridge ]] || exit 2
rm -f ci-result.json ci-result.json.tmp
bash "$script_dir/build.sh" "$app"
manifest=$(python3 "$script_dir/manifest.py" read "$app")
mapfile -t fields <<< "$manifest"
image=${fields[0]}; image_id=${fields[1]}
repository=$(python3 "$script_dir/registry-manifest.py" repository "$app")
registry=${repository%%/*}
: "${CI_REGISTRY_PUSH_USER:?Set CI_REGISTRY_PUSH_USER}"
: "${CI_REGISTRY_PUSH_TOKEN:?Set CI_REGISTRY_PUSH_TOKEN}"
registry_config=$(mktemp -d)
export DOCKER_CONFIG="$registry_config"
function cleanup_registry() { rm -rf "$registry_config"; }
trap cleanup_registry EXIT
printf '%s' "$CI_REGISTRY_PUSH_TOKEN" |
  docker login "$registry" --username "$CI_REGISTRY_PUSH_USER" --password-stdin >/dev/null
remote_tag="${repository}:${CI_COMMIT_SHA}-${CI_BUILD_NUMBER}"
docker tag "$image" "$remote_tag"
docker push "$remote_tag"
docker image inspect --format '{{json .RepoDigests}}' "$remote_tag" |
  python3 "$script_dir/registry-manifest.py" publish "$app" "$image_id" > ci-result.json.tmp
mv ci-result.json.tmp ci-result.json
printf 'CI tests, build and registry publication completed for %s.\n' "$app"
