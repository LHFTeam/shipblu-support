#!/usr/bin/env bash
#
# Installs the ShipBlu Support extension for WhatsApp Web on an Ubuntu laptop,
# by managed policy: Chrome then installs it, keeps it updated, pins it to the
# toolbar, and does not let it be removed.
#
#   sudo ./install-ubuntu.sh                    # from the production console
#   sudo ./install-ubuntu.sh https://other.host # from another console
#   sudo ./install-ubuntu.sh --remove           # take the policy away again
#
# It writes one file, fetched from the console rather than written here so this
# script never changes when the extension's id or the console's address does:
#
#   /etc/opt/chrome/policies/managed/shipblu-support.json        Google Chrome
#   /etc/chromium/policies/managed/shipblu-support.json          Chromium (.deb)
#   /etc/chromium-browser/policies/managed/shipblu-support.json  Chromium (snap)
#
# Chrome reads policy at start-up, or at once from chrome://policy → "Reload
# policies". If another file in the same directory also sets
# ExtensionSettings, Chrome takes one of the two and ignores the other — merge
# them into one file instead.
set -euo pipefail

ORIGIN="https://shipblu-support.onrender.com"
REMOVE=false
for argument in "$@"; do
  case "$argument" in
    --remove) REMOVE=true ;;
    http://* | https://*) ORIGIN="${argument%/}" ;;
    *)
      echo "usage: sudo $0 [console origin] [--remove]" >&2
      exit 2
      ;;
  esac
done

if [[ $EUID -ne 0 ]]; then
  echo "Run this with sudo: Chrome's managed policy directories belong to root." >&2
  exit 1
fi

FILE="shipblu-support.json"

# Google Chrome always — it is what the laptops run. Chromium only where its
# own configuration directory shows it is installed.
directories=(/etc/opt/chrome/policies/managed)
[[ -d /etc/chromium ]] && directories+=(/etc/chromium/policies/managed)
[[ -d /etc/chromium-browser ]] && directories+=(/etc/chromium-browser/policies/managed)

if $REMOVE; then
  for directory in "${directories[@]}"; do
    rm -f "$directory/$FILE" && echo "removed $directory/$FILE"
  done
  echo "Restart Chrome; the extension is uninstalled with the policy."
  exit 0
fi

policy="$(mktemp)"
trap 'rm -f "$policy"' EXIT

if ! curl --fail --silent --show-error --max-time 30 "$ORIGIN/api/extension/package/policy.json" -o "$policy"; then
  echo "Could not fetch the extension policy from $ORIGIN." >&2
  echo "A 404 means that console has no signed package: EXTENSION_SIGNING_KEY is unset there." >&2
  exit 1
fi

# Refuse anything that is not the policy this script expects, so a proxy's
# error page or a login screen never lands in Chrome's policy directory.
if ! python3 - "$policy" <<'PY'
import json, re, sys
settings = json.load(open(sys.argv[1]))["ExtensionSettings"]
assert len(settings) == 1
(extension_id, entry), = settings.items()
assert re.fullmatch(r"[a-p]{32}", extension_id)
assert entry["installation_mode"] == "force_installed"
assert entry["update_url"].startswith(("https://", "http://localhost"))
print(f"extension {extension_id}, updates from {entry['update_url']}")
PY
then
  echo "The console answered something that is not an extension policy; nothing was written." >&2
  exit 1
fi

for directory in "${directories[@]}"; do
  install -d -m 0755 "$directory"
  install -m 0644 "$policy" "$directory/$FILE"
  echo "wrote $directory/$FILE"
done

echo "Restart Chrome, or open chrome://policy and press \"Reload policies\"."
echo "The ShipBlu icon appears on the toolbar; it opens on web.whatsapp.com."
