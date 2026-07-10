#!/bin/bash
cd "$(dirname "$0")"
echo "=== OCR Local Server Starter (macOS/Linux) ==="

# Use the project environment when available. Homebrew/system Python may reject
# the server's dependency installer under PEP 668.
if [ -x "./venv/bin/python" ]; then
  PYTHON="./venv/bin/python"
else
  PYTHON="$(command -v python3 || command -v python)"
fi

exec "$PYTHON" ocr_server.py
