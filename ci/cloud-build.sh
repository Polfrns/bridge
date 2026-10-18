#!/usr/bin/env bash
# Runs on Atlassian Cloud. The VM is scheduled only after this step succeeds.
set -Eeuo pipefail
umask 077
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
app=${1:?Use: bash ci/cloud-build.sh roko|bridge [test|publish]}
mode=${2:-test}
[[ "$app" == roko || "$app" == bridge ]] || exit 2
[[ "$mode" == test || "$mode" == publish ]] || exit 2
rm -f ci-result.json ci-result.json.tmp
if [[ "$mode" == publish ]]; then
  [[ "${BITBUCKET_BRANCH:-}" == main ]] || { echo 'Only main may publish a deployment image.' >&2; exit 1; }
  repository=$(python3 "$script_dir/registry-manifest.py" repository "$app")
  registry=${repository%%/*}
  if [[ "$registry" == crg.apkg.io && -n "${BITBUCKET_PACKAGES_USERNAME:-}" && -n "${BITBUCKET_PACKAGES_TOKEN:-}" ]]; then
    push_user=$BITBUCKET_PACKAGES_USERNAME
    push_token=$BITBUCKET_PACKAGES_TOKEN
  else
    : "${CI_REGISTRY_PUSH_USER:?Set in the image-publish deployment environment}"
    : "${CI_REGISTRY_PUSH_TOKEN:?Set in the image-publish deployment environment}"
    push_user=$CI_REGISTRY_PUSH_USER
    push_token=$CI_REGISTRY_PUSH_TOKEN
  fi
fi
bash "$script_dir/build.sh" "$app"
if [[ "$mode" == test ]]; then
  rm -f ci-result.json
  exit 0
fi
manifest=$(python3 "$script_dir/manifest.py" read "$app")
mapfile -t fields <<< "$manifest"
image=${fields[0]}; image_id=${fields[1]}
rm -f ci-result.json
registry_config=$(mktemp -d)
export DOCKER_CONFIG="$registry_config"
function cleanup_registry() { rm -rf "$registry_config"; }
trap cleanup_registry EXIT
printf '%s' "$push_token" |
  docker login "$registry" --username "$push_user" --password-stdin >/dev/null
remote_tag="${repository}:${BITBUCKET_COMMIT}-${BITBUCKET_BUILD_NUMBER}"
docker tag "$image" "$remote_tag"
docker push "$remote_tag"
# Docker Hub may normalize away docker.io; the manifest helper checks this alias.
docker image inspect --format '{{json .RepoDigests}}' "$remote_tag" |
  python3 "$script_dir/registry-manifest.py" publish "$app" "$image_id" > ci-result.json.tmp
mv ci-result.json.tmp ci-result.json
printf 'Cloud tests/build and registry publication completed for %s.\n' "$app"
