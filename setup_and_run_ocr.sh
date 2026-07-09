#!/bin/bash
cd "$(dirname "$0")"
echo "=== OCR Local Server Starter (macOS/Linux) ==="
python3 ocr_server.py || python ocr_server.py
