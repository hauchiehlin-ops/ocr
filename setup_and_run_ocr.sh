#!/bin/bash
set -Eeuo pipefail

LABEL="com.ocreditor.native-ocr"
INSTALL_DIR="$HOME/Library/Application Support/AI OCR Pro Editor/OCR Server"
VENV_DIR="$INSTALL_DIR/venv"
LOG_DIR="$INSTALL_DIR/logs"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$LAUNCH_AGENTS_DIR/$LABEL.plist"
SERVER_URL="https://raw.githubusercontent.com/hauchiehlin-ops/ocr/main/ocr_server.py"
PYTHON_PKG_URL="https://www.python.org/ftp/python/3.12.10/python-3.12.10-macos11.pkg"
PYTHON_PKG_PATH="/tmp/ai_ocr_python_3_12_10.pkg"

fail() {
  trap - ERR
  printf '\nERROR: %s\n' "$1" >&2
  printf 'Installed files and logs: %s\n' "$INSTALL_DIR" >&2
  exit 1
}

trap 'fail "Setup stopped unexpectedly near line $LINENO."' ERR

find_python() {
  local candidate
  for candidate in \
    "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3" \
    "/opt/homebrew/bin/python3" \
    "/usr/local/bin/python3" \
    "/usr/bin/python3"; do
    if [ -x "$candidate" ] && "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  if command -v python3 >/dev/null 2>&1; then
    candidate="$(command -v python3)"
    if "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; then
      printf '%s' "$candidate"
      return 0
    fi
  fi
  return 1
}

printf '%s\n' "============================================================"
printf '%s\n' "  AI OCR Pro Editor - macOS Native OCR One-Click Setup"
printf '%s\n' "============================================================"
printf 'Install location:\n  %s\n\n' "$INSTALL_DIR"

[ "$(uname -s)" = "Darwin" ] || fail "This installer is for macOS only."
mkdir -p "$INSTALL_DIR" "$LOG_DIR" "$LAUNCH_AGENTS_DIR"

printf '%s\n' "[1/5] Checking Python..."
PYTHON_BIN="$(find_python || true)"
if [ -z "$PYTHON_BIN" ]; then
  printf '%s\n' "Python 3 was not found. Downloading the official universal macOS installer..."
  curl --fail --location --retry 3 "$PYTHON_PKG_URL" --output "$PYTHON_PKG_PATH" \
    || fail "Python could not be downloaded from python.org. Check the network or security software."
  printf '%s\n' "macOS will request an administrator password to install Python."
  /usr/bin/osascript -e "do shell script \"/usr/sbin/installer -pkg '$PYTHON_PKG_PATH' -target /\" with administrator privileges" \
    || fail "Python installation was cancelled or blocked by macOS security."
  rm -f "$PYTHON_PKG_PATH"
  PYTHON_BIN="$(find_python || true)"
  [ -n "$PYTHON_BIN" ] || fail "Python installation completed but python3 could not be located."
fi
printf 'Using Python: %s\n' "$PYTHON_BIN"

printf '%s\n' "[2/5] Downloading the latest OCR server..."
curl --fail --location --retry 3 "$SERVER_URL" --output "$INSTALL_DIR/ocr_server.tmp" \
  || fail "ocr_server.py could not be downloaded from GitHub."
mv -f "$INSTALL_DIR/ocr_server.tmp" "$INSTALL_DIR/ocr_server.py"

printf '%s\n' "[3/5] Preparing the isolated Apple Vision OCR environment..."
if [ ! -x "$VENV_DIR/bin/python" ]; then
  rm -rf "$VENV_DIR"
  "$PYTHON_BIN" -m venv "$VENV_DIR" || fail "The Python virtual environment could not be created."
fi
"$VENV_DIR/bin/python" -m ensurepip --upgrade
"$VENV_DIR/bin/python" -m pip install --disable-pip-version-check --upgrade pip
"$VENV_DIR/bin/python" -m pip install --disable-pip-version-check \
  flask flask-cors Pillow pyobjc-framework-Vision pyobjc-framework-Quartz \
  || fail "OCR dependencies could not be installed from PyPI."

printf '%s\n' "[4/5] Installing the login background service..."
"$VENV_DIR/bin/python" - "$PLIST_PATH" "$LABEL" "$VENV_DIR/bin/python" "$INSTALL_DIR/ocr_server.py" "$INSTALL_DIR" "$LOG_DIR" <<'PY'
import plistlib
import sys

plist_path, label, python_bin, server_path, working_dir, log_dir = sys.argv[1:]
payload = {
    "Label": label,
    "ProgramArguments": [python_bin, server_path],
    "WorkingDirectory": working_dir,
    "RunAtLoad": True,
    "KeepAlive": True,
    "ThrottleInterval": 5,
    "ProcessType": "Background",
    "StandardOutPath": f"{log_dir}/ocr_server.log",
    "StandardErrorPath": f"{log_dir}/ocr_server.err.log",
    "EnvironmentVariables": {"PYTHONUNBUFFERED": "1"},
}
with open(plist_path, "wb") as handle:
    plistlib.dump(payload, handle, sort_keys=False)
PY
chmod 600 "$PLIST_PATH"

launchctl bootout "gui/$UID" "$PLIST_PATH" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$UID" "$PLIST_PATH" \
  || fail "The macOS LaunchAgent could not be registered."
launchctl enable "gui/$UID/$LABEL" >/dev/null 2>&1 || true
launchctl kickstart -k "gui/$UID/$LABEL" \
  || fail "The Apple Vision OCR background service could not be started."

printf '%s\n' "[5/5] Waiting for Apple Vision OCR on http://127.0.0.1:5001..."
READY=0
for _ in $(seq 1 90); do
  if curl --silent --fail --max-time 2 http://127.0.0.1:5001/status \
    | grep -q '"status"[[:space:]]*:[[:space:]]*"running"'; then
    READY=1
    break
  fi
  sleep 1
done
[ "$READY" -eq 1 ] || fail "OCR did not become ready. Check logs/ocr_server.err.log."

printf '\n%s\n' "============================================================"
printf '%s\n' "  macOS Native OCR is installed and ready."
printf '%s\n' "  It will start automatically after macOS login."
printf '%s\n' "  This Terminal window can be closed."
printf '%s\n' "  Return to the web page and click Test Connection."
printf '%s\n' "============================================================"

/usr/bin/osascript -e 'display dialog "macOS Native OCR is installed and ready. Return to the web page and click Test Connection." with title "AI OCR Pro Editor" buttons {"OK"} default button "OK" with icon note' >/dev/null 2>&1 || true
