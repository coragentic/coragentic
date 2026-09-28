#!/usr/bin/env sh
set -eu
exec node "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)/src/http.mjs"
