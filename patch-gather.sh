#!/bin/bash
# patch-gather.sh — Wrap GatherV2 to always expose CDP on localhost:9222
# Run once after install, and again after each Gather update.

set -e

APP="/Applications/GatherV2.app/Contents/MacOS"
REAL="$APP/GatherV2.bin"
WRAPPER="$APP/GatherV2"

# If the real binary is still named GatherV2 (fresh install or post-update), rename it
if [ -f "$WRAPPER" ] && [ ! -L "$WRAPPER" ] && [ ! -f "$REAL" ]; then
  echo "Renaming original binary → GatherV2.bin"
  mv "$WRAPPER" "$REAL"
elif [ -f "$WRAPPER" ] && [ -f "$REAL" ]; then
  echo "Wrapper already exists, replacing it"
  rm "$WRAPPER"
fi

if [ ! -f "$REAL" ]; then
  echo "ERROR: GatherV2.bin not found. Is GatherV2 installed at /Applications/GatherV2.app?" >&2
  exit 1
fi

echo "Writing wrapper script"
cat > "$WRAPPER" << 'EOF'
#!/bin/bash
exec "$(dirname "$0")/GatherV2.bin" --remote-debugging-port=9222 "$@"
EOF
chmod +x "$WRAPPER"

echo "Re-signing app bundle (ad-hoc)"
codesign --sign - --force --deep /Applications/GatherV2.app

echo ""
echo "Done. GatherV2 will now expose CDP on localhost:9222 on every launch."
echo "If macOS shows a security warning on first launch, go to:"
echo "  System Settings → Privacy & Security → Open Anyway"
