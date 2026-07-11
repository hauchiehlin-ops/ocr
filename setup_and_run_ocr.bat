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
if exist "venv\Scripts\python.exe" goto :verify_environment
if exist "venv" (
  echo Removing an incomplete Python environment from a previous attempt...
  rmdir /s /q "venv"
)

echo [1/3] Preparing an isolated Python environment...
py -3 -c "import sys; assert sys.version_info.major == 3; print(sys.executable)" >nul 2>nul
if not errorlevel 1 goto :create_with_py

python -c "import sys; assert sys.version_info.major == 3; print(sys.executable)" >nul 2>nul
if not errorlevel 1 goto :create_with_python
goto :python_missing

:create_with_py
echo Found Python through the Windows py launcher.
py -3 -m venv venv
if exist "venv\Scripts\python.exe" goto :environment_ready
echo The py launcher could not create venv; trying python.exe...

:create_with_python
python -m venv venv
if exist "venv\Scripts\python.exe" goto :environment_ready
goto :venv_failed

:environment_ready
"venv\Scripts\python.exe" -m ensurepip --upgrade
if errorlevel 1 goto :venv_failed

echo [2/3] Installing the Windows OCR bridge and web server...
"venv\Scripts\python.exe" -m pip install --disable-pip-version-check --upgrade pip
if errorlevel 1 goto :setup_failed
"venv\Scripts\python.exe" -m pip install --disable-pip-version-check flask flask-cors Pillow winocr
if errorlevel 1 goto :setup_failed
goto :run_server

:verify_environment
echo [1/3] Checking the existing Python environment...
"venv\Scripts\python.exe" -c "import flask, flask_cors, PIL, winocr" >nul 2>nul
if not errorlevel 1 goto :run_server
echo Existing environment is missing required packages; repairing it now...
goto :environment_ready

:run_server
echo [3/3] Starting Windows OCR in the background on http://127.0.0.1:5001
echo.
"venv\Scripts\python.exe" -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5001/status', timeout=2).read()" >nul 2>nul
if not errorlevel 1 goto :server_ready

if not exist "logs" mkdir "logs" >nul 2>nul
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $root=(Get-Location).Path; $py=Join-Path $root 'venv\Scripts\python.exe'; $log=Join-Path $root 'logs\ocr_server.log'; $err=Join-Path $root 'logs\ocr_server.err.log'; Start-Process -FilePath $py -ArgumentList 'ocr_server.py' -WorkingDirectory $root -RedirectStandardOutput $log -RedirectStandardError $err -WindowStyle Hidden"
if errorlevel 1 goto :server_failed

echo Waiting for Windows OCR to become ready...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$deadline=(Get-Date).AddSeconds(90); $ok=$false; while((Get-Date) -lt $deadline){ try { $s=Invoke-RestMethod -UseBasicParsing 'http://127.0.0.1:5001/status' -TimeoutSec 3; if($s.status -eq 'running'){ $ok=$true; break } } catch {}; Start-Sleep -Seconds 1 }; if(-not $ok){ exit 1 }"
if errorlevel 1 goto :server_failed

:server_ready
echo.
echo ============================================================
echo   Windows Native OCR is ready.
echo   You can close this window now; OCR will keep running.
echo   Return to the web page and click "Test Connection".
echo ============================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$message='Windows 原生 OCR 已啟動。您可以關閉這個視窗；OCR 會在背景繼續執行。請回到網頁點擊「測試連接」。'; try { $shell=New-Object -ComObject WScript.Shell; $null=$shell.Popup($message, 0, 'AI OCR Pro Editor', 64) } catch { Write-Host $message }"
echo Press any key to close this setup window.
pause >nul
goto :end

:python_missing
echo ERROR: Python 3 was not found.
echo.
echo Copy and run this command in Command Prompt:
echo   winget install -e --id Python.Python.3.12
echo.
echo Then CLOSE this window, open setup_and_run_ocr.bat again, and retry.
echo If winget is unavailable, install from https://www.python.org/downloads/windows/
echo and enable "Add python.exe to PATH" in the installer.
goto :fail

:venv_failed
echo ERROR: Python exists, but it could not create a virtual environment.
echo.
echo 1. Delete the venv folder beside this BAT file if it still exists.
echo 2. Repair/install standard Python with:
echo      winget install -e --id Python.Python.3.12 --force
echo 3. Close this window and run setup_and_run_ocr.bat again.
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
echo ERROR: The OCR server could not be started or did not become ready in time.
echo.
echo Check logs\ocr_server.err.log for details.
echo If port 5001 is already in use, close the other OCR server and retry.

:fail
echo.
pause
exit /b 1

:end
endlocal
