#!/usr/bin/env bash
set -euo pipefail

# Directory containing this script (secbits/leancrypto/)
SB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Configurable via environment
EMCC_BIN="${EMCC_BIN:-/usr/lib/emscripten/emcc}"
LC_VERSION="${LC_VERSION:-v1.7.1}"
LC_SRC="${LC_SRC:-/tmp/leancrypto-wasm-build}"
OUT_JS="${OUT_JS:-$SB_DIR/leancrypto.js}"
OUT_WASM="${OUT_WASM:-$SB_DIR/leancrypto.wasm}"

EMCC_FLAGS=(
  -O3
  -s WASM=1
  -s MODULARIZE=1
  -s EXPORT_NAME="leancrypto"
  -s EXPORT_ALL=1
  -s ALLOW_MEMORY_GROWTH=1
  -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","getValue","setValue"]'
)

if [[ -n "${EM_CACHE:-}" ]]; then
  export EM_CACHE
fi

# 1 — Clone leancrypto source
echo "==> Cloning leancrypto $LC_VERSION -> $LC_SRC"
if [[ -d "$LC_SRC/.git" ]]; then
  echo "    Already cloned, skipping"
else
  git clone --branch "$LC_VERSION" --depth 1 \
    https://github.com/smuellerDD/leancrypto.git "$LC_SRC"
fi

# 2 — Patch source tree with secbits-specific files
echo "==> Patching source tree"
cp "$SB_DIR/meson.build" "$LC_SRC/meson.build"
cp "$SB_DIR/wasm-cross.ini" "$LC_SRC/wasm-cross.ini"
cp "$SB_DIR/seeded_rng_wasm.c" "$LC_SRC/drng/src/seeded_rng_wasm.c"

# 3 — Configure with meson + build static library
echo "==> Configuring with meson"
MESON_EXTRA=()
if [[ -d "$LC_SRC/build-wasm" ]]; then
  MESON_EXTRA=(--wipe)
fi
pushd "$LC_SRC" >/dev/null
meson setup build-wasm "${MESON_EXTRA[@]}" \
  --cross-file wasm-cross.ini \
  -Ddisable-asm=true -Defi=disabled -Dtests=disabled

echo "==> Building static library with ninja"
ninja -C build-wasm

# 4 — Link to WASM module
echo "==> Linking WASM module"
"$EMCC_BIN" \
  "${EMCC_FLAGS[@]}" \
  -I drng/src \
  -I internal/api \
  drng/src/seeded_rng_wasm.c \
  -Wl,--whole-archive build-wasm/libleancrypto.a -Wl,--no-whole-archive \
  -Wl,--export-all \
  -Wl,--no-gc-sections \
  -o "$OUT_JS"

# emcc generates the wasm file next to the JS; move if names differ
if [[ "$OUT_WASM" != "${OUT_JS%.js}.wasm" ]]; then
  mv -f "${OUT_JS%.js}.wasm" "$OUT_WASM"
fi

# emcc sets +x on output files; strip it — these are data files, not executables
chmod 644 "$OUT_JS" "$OUT_WASM"

popd >/dev/null

echo "==> Cleaning up $LC_SRC"
rm -rf "$LC_SRC"

echo "Done: $OUT_JS  $OUT_WASM"
