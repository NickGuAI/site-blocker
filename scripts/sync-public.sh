#!/usr/bin/env bash
# Full release pipeline: build DMG → create/sync public repo → GitHub release.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ELECTRON_DIR="$SCRIPT_DIR/.."
PROJECT_DIR="$ELECTRON_DIR/.."
RELEASE_DIR="/Users/yugu/Desktop/gehirn/product-releases/site-blocker"
GITHUB_REPO="NickGuAI/site-blocker"
VERSION=$(node -p "require('$ELECTRON_DIR/package.json').version")
DMG="$ELECTRON_DIR/dist/Site Blocker-$VERSION-arm64.dmg"
DMG_BLOCKMAP="$DMG.blockmap"

echo "=== Site Blocker v$VERSION Release ==="

# --- 1. Build signed, notarized DMG ---
echo ""
echo "--- Building DMG ---"
cd "$PROJECT_DIR" && make dist-macos

if [ ! -f "$DMG" ]; then
  echo "ERROR: DMG not found at $DMG"
  exit 1
fi

RELEASE_ASSETS=("$DMG")
if [ -f "$DMG_BLOCKMAP" ]; then
  RELEASE_ASSETS+=("$DMG_BLOCKMAP")
fi

# --- 2. Create or verify public release repo ---
echo ""
echo "--- Preparing release repo ---"
if [ ! -d "$RELEASE_DIR/.git" ]; then
  echo "Creating release repo at $RELEASE_DIR..."
  mkdir -p "$RELEASE_DIR"
  cd "$RELEASE_DIR"
  git init
  git commit --allow-empty -m "Initial commit"
  gh repo create "$GITHUB_REPO" --public --source=. --push
  echo "Created https://github.com/$GITHUB_REPO"
else
  echo "Release repo exists at $RELEASE_DIR"
fi

# --- 3. Sync source, strip PII ---
echo ""
echo "--- Syncing source (stripping PII) ---"
rsync -av \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='.env' \
  --exclude='.DS_Store' \
  --exclude='*.dmg' \
  --delete \
  "$ELECTRON_DIR/" \
  "$RELEASE_DIR/"

# Strip teamId from package.json
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('$RELEASE_DIR/package.json', 'utf8'));
pkg.build.mac.notarize = false;
fs.writeFileSync('$RELEASE_DIR/package.json', JSON.stringify(pkg, null, 2) + '\n');
"
echo "Stripped notarize.teamId from package.json"

# --- 4. Commit, push, create GitHub release ---
echo ""
echo "--- Publishing release ---"
cd "$RELEASE_DIR"

# Skip if nothing changed
if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  echo "No source changes to commit."
else
  git add -A
  git commit -m "Release Site Blocker v$VERSION"
  git push origin main
fi

# Create release (or update assets if tag already exists)
if gh release view "v$VERSION" --repo "$GITHUB_REPO" > /dev/null 2>&1; then
  echo "Release v$VERSION already exists, replacing DMG assets."
  gh release upload "v$VERSION" "${RELEASE_ASSETS[@]}" \
    --repo "$GITHUB_REPO" \
    --clobber
else
  gh release create "v$VERSION" "${RELEASE_ASSETS[@]}" \
    --repo "$GITHUB_REPO" \
    --title "Site Blocker v$VERSION" \
    --generate-notes
fi

echo ""
echo "=== Done: https://github.com/$GITHUB_REPO/releases/tag/v$VERSION ==="
