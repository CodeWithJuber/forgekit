#!/usr/bin/env bash
# Actions sources the resulting environment file. The same commands work on Linux x86-64.
set -euo pipefail
dest=${1:?pass a cache directory outside the checkout}
mkdir -p "$dest"
dest=$(cd "$dest" && pwd)
asset() {
  local url=$1 file=$2 checksum=$3
  if ! echo "$checksum  $file" | sha256sum -c --status 2>/dev/null; then
    curl --fail --show-error --location --retry 3 --output "$file.new" "$url"
    echo "$checksum  $file.new" | sha256sum --check
    mv "$file.new" "$file"
  fi
}
font_pkg=$dest/dejavu.deb
browser_pkg=$dest/chromium.tgz
asset 'https://deb.debian.org/debian/pool/main/f/fonts-dejavu/fonts-dejavu-core_2.37-8_all.deb' "$font_pkg" 86635b3d25b3655fc11cb3ecc3af59f0bf19643b02b94f2de48bd10253cdba12
asset 'https://registry.npmjs.org/@sparticuz/chromium/-/chromium-153.0.0.tgz' "$browser_pkg" 20e5656fcdcf4118ede85edfb9d6bb9cc1bbb7ffb8b75622fffbcf36a835c3c0
asset 'https://deb.debian.org/debian/pool/main/f/fonts-dejavu/fonts-dejavu-mono_2.37-8_all.deb' "$dest/dejavu-mono.deb" 3003e98a5debfdeadc7040a7f715fe9fe6fb67f68deacf6049b54e30f07fc014
dpkg-deb --extract "$font_pkg" "$dest/fonts"
dpkg-deb --extract "$dest/dejavu-mono.deb" "$dest/fonts"
tar -xzOf "$browser_pkg" package/bin/chromium.br |
  node --input-type=module -e 'import {createBrotliDecompress} from "node:zlib"; import {pipeline} from "node:stream/promises"; await pipeline(process.stdin,createBrotliDecompress(),process.stdout)' > "$dest/headless-shell"
chmod 755 "$dest/headless-shell"
# Browser metrics and font fallback must not depend on a runner's system fonts.
cat > "$dest/fonts.conf" <<'FONTS'
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <dir prefix="relative">fonts/usr/share/fonts/truetype/dejavu</dir>
  <cachedir prefix="xdg">fontconfig</cachedir>
  <alias><family>sans-serif</family><prefer><family>DejaVu Sans</family></prefer></alias>
  <alias><family>serif</family><prefer><family>DejaVu Serif</family></prefer></alias>
  <alias><family>monospace</family><prefer><family>DejaVu Sans Mono</family></prefer></alias>
</fontconfig>
FONTS
XDG_CACHE_HOME="$dest/cache" FONTCONFIG_FILE="$dest/fonts.conf" fc-cache --force
python3 -m venv "$dest/venv"
"$dest/venv/bin/python" -m pip install --only-binary=:all: --no-deps --require-hashes -r scripts/docs-media/requirements.txt
{
  echo "FORGE_DEMO_FONTS=$dest/fonts/usr/share/fonts/truetype/dejavu"
  echo "FORGE_MEDIA_PYTHON=$dest/venv/bin/python"
  echo "ARCHIFY_CHROME=$dest/headless-shell"
  echo "FONTCONFIG_FILE=$dest/fonts.conf"
  echo "XDG_CACHE_HOME=$dest/cache"
} > "$dest/env"
