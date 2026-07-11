@echo off
setlocal
cd /d "%~dp0"
title AI OCR Pro Editor - Windows OCR Server

echo ============================================================
echo   AI OCR Pro Editor - Windows Native OCR Server
echo ============================================================
echo.

if exist "ocr_server.py" goto :server_source_ready
echo [0/3] Downloading the official OCR server component...
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/hauchiehlin-ops/ocr/main/ocr_server.py' -OutFile 'ocr_server.py'"
if errorlevel 1 goto :download_failed

:server_source_ready
if exist "venv\Scripts\python.exe" goto :run_server

echo [1/3] Preparing an isolated Python environment...
where py >nul 2>nul
if not errorlevel 1 (
  py -3 -m venv venv
) else (
  where python >nul 2>nul
  if errorlevel 1 goto :python_missing
  python -m venv venv
)
if errorlevel 1 goto :setup_failed

echo [2/3] Installing the Windows OCR bridge and web server...
"venv\Scripts\python.exe" -m pip install --disable-pip-version-check --upgrade pip
if errorlevel 1 goto :setup_failed
"venv\Scripts\python.exe" -m pip install --disable-pip-version-check flask flask-cors Pillow winocr
if errorlevel 1 goto :setup_failed

:run_server
echo [3/3] Starting Windows OCR on http://127.0.0.1:5001
echo Keep this window open while using the web editor.
echo Press Ctrl+C to stop the server.
echo.
"venv\Scripts\python.exe" ocr_server.py
if errorlevel 1 goto :server_failed
goto :end

:python_missing
echo ERROR: Python 3 was not found.
echo Install Python from https://www.python.org/downloads/windows/
echo IMPORTANT: enable "Add python.exe to PATH" in the installer.
goto :fail

:download_failed
echo ERROR: Unable to download ocr_server.py from the official GitHub repository.
echo Check the network connection or download the complete project instead.
goto :fail

:setup_failed
echo ERROR: Unable to prepare the OCR environment or install dependencies.
echo Check the messages above and verify that this PC can access PyPI.
goto :fail

:server_failed
echo ERROR: The OCR server stopped unexpectedly.
echo If port 5001 is already in use, close the other OCR server and retry.

:fail
echo.
pause
exit /b 1

:end
endlocal
