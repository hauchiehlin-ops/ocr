@echo off
cd /d "%~dp0"
echo === OCR Local Server Starter (Windows) ===
if exist "venv\Scripts\python.exe" (
  venv\Scripts\python.exe ocr_server.py
) else (
  python ocr_server.py
)
pause
