#!/bin/sh
set -eu
umask 077
exec node /app/scripts/container-cli.mjs "$@"
