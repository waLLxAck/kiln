#!/bin/bash
set -euo pipefail

version=$(node -p "require('./package.json').version")
case "$(uname -m)" in
  arm64) native=arm64 ;;
  x86_64) native=x64 ;;
  *) echo "Unsupported macOS runner architecture" >&2; exit 1 ;;
esac
for arch in arm64 x64; do
  mount="$RUNNER_TEMP/kiln-$arch"
  hdiutil attach "release/Kiln-$version-$arch.dmg" -nobrowse -readonly -mountpoint "$mount"
  app="$mount/Kiln.app"
  lipo -archs "$app/Contents/MacOS/Kiln"
  codesign -dv --verbose=2 "$app" 2>&1 | tee "$RUNNER_TEMP/codesign-$arch.txt"
  grep -q 'Signature=adhoc' "$RUNNER_TEMP/codesign-$arch.txt"
  codesign --verify --deep --strict --verbose=2 "$app"
  # Not notarized, so Gatekeeper is expected to reject it; print the verdict for the record.
  spctl --assess --type execute --verbose=2 "$app" || true
  # Launch only the native build. An optional Rosetta launch can time out and keep the DMG busy;
  # both architectures still have their binaries and signatures inspected above.
  if [ "$arch" = "$native" ]; then node scripts/smoke-packaged.mjs "$app/Contents/MacOS/Kiln"; fi
  hdiutil detach "$mount"
done
