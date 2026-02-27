#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

EMCC_BIN="${EMCC_BIN:-/usr/lib/emscripten/emcc}"
OUT_JS="${OUT_JS:-leancrypto.js}"
OUT_WASM="${OUT_WASM:-leancrypto.wasm}"

EMCC_FLAGS=(
  -O3
  -s WASM=1
  -s MODULARIZE=1
  -s EXPORT_NAME="leancrypto"
  -s EXPORT_ALL=1
  -s ALLOW_MEMORY_GROWTH=1
  -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","getValue","setValue"]'
)

# If EM_CACHE is set by caller, preserve it. Otherwise use tool default.
if [[ -n "${EM_CACHE:-}" ]]; then
  export EM_CACHE
fi

pushd "$ROOT_DIR" >/dev/null

"$EMCC_BIN" \
  "${EMCC_FLAGS[@]}" \
  -I drng/src \
  -I internal/api \
  drng/src/seeded_rng_wasm.c \
  -Wl,--whole-archive build-wasm/libleancrypto.a -Wl,--no-whole-archive \
  -Wl,--export-all \
  -Wl,--no-gc-sections \
  -o "$OUT_JS"

# emcc generates the wasm file next to JS; keep caller-specified name if needed.
if [[ "$OUT_WASM" != "${OUT_JS%.js}.wasm" ]]; then
  mv -f "${OUT_JS%.js}.wasm" "$OUT_WASM"
fi

popd >/dev/null

echo "Built $OUT_JS and ${OUT_WASM}"
