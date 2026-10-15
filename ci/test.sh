#!/bin/sh
set -eu
script_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$script_root"
export LANGFUSE_TRACING_ENABLED=false
export FILE_TEST_PYTHON=${FILE_TEST_PYTHON:-$script_root/runtime-tools/bin/python}
node --test --test-concurrency=1 --test-timeout=120000 test/*.test.mjs
"$FILE_TEST_PYTHON" -m unittest -v test/file_tools_test.py
