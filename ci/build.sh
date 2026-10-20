#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
app=${1:?Use: bash ci/build.sh roko|bridge}
[[ "$app" == roko || "$app" == bridge ]] || exit 2
: "${CI_COMMIT_SHA:?Missing CI_COMMIT_SHA}"
: "${CI_BUILD_NUMBER:?Missing CI_BUILD_NUMBER}"
[[ "$CI_COMMIT_SHA" =~ ^[a-f0-9]{40}$ && "$CI_BUILD_NUMBER" =~ ^[0-9]+$ ]] || exit 2
[[ "$(git rev-parse HEAD)" == "$CI_COMMIT_SHA" ]] || { echo 'Clone does not match the requested commit.' >&2; exit 1; }
lock_dir=${CI_LOCK_DIR:-${HOME}/.cache/roko-bridge-ci}
mkdir -p "$lock_dir"
exec 9>"$lock_dir/build.lock"
flock 9
build_args=()
if [[ "$app" == roko ]]; then
  build_args+=(--build-arg "NODE_MAX_OLD_SPACE_SIZE=${CI_NODE_MAX_OLD_SPACE_SIZE:-4096}")
fi
image="local/${app}-tested:${CI_COMMIT_SHA}-${CI_BUILD_NUMBER}"
# The production stage depends on ci: a failed RUN stops the build.
docker build --pull --platform linux/amd64 --progress=plain --target production \
  --build-arg "BUILD_COMMIT=$CI_COMMIT_SHA" \
  --build-arg "BUILD_BRANCH=${CI_BRANCH:-}" \
  --label "org.opencontainers.image.revision=$CI_COMMIT_SHA" \
  --label "io.roko.ci.service=$app" \
  "${build_args[@]}" -t "$image" .
image_id=$(docker image inspect --format '{{.Id}}' "$image")
python3 ci/manifest.py write "$app" "$image" "$image_id" > ci-result.json
printf 'Tests and image build completed for %s at %s.\n' "$app" "$CI_COMMIT_SHA"
