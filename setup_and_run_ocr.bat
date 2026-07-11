@echo off
setlocal EnableExtensions
title AI OCR Pro Editor - Windows OCR Installer

set "INSTALL_DIR=%LOCALAPPDATA%\AI OCR Pro Editor\OCR Server"
set "HELPER_URL=https://raw.githubusercontent.com/hauchiehlin-ops/ocr/main/windows_ocr_helper.ps1?download=1"
set "PYTHON_URL_X64=https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe"
set "PYTHON_URL_ARM64=https://www.python.org/ftp/python/3.12.10/python-3.12.10-arm64.exe"

echo ============================================================
echo   AI OCR Pro Editor - Windows Native OCR One-Click Setup
echo ============================================================
echo.
echo Install location:
echo   %INSTALL_DIR%
echo.

if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
if errorlevel 1 goto :install_dir_failed
cd /d "%INSTALL_DIR%"

echo [0/4] Downloading the latest OCR components...
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri '%HELPER_URL%' -OutFile 'windows_ocr_helper.tmp'"
if errorlevel 1 goto :helper_download_failed
powershell -NoProfile -ExecutionPolicy Bypass -Command "[void][scriptblock]::Create([IO.File]::ReadAllText('windows_ocr_helper.tmp', [Text.Encoding]::ASCII))"
if errorlevel 1 goto :helper_download_failed
move /y "windows_ocr_helper.tmp" "windows_ocr_helper.ps1" >nul
if errorlevel 1 goto :helper_download_failed

powershell -NoProfile -ExecutionPolicy Bypass -File "%INSTALL_DIR%\windows_ocr_helper.ps1" download "ocr_server.tmp"
if errorlevel 1 goto :server_download_failed
move /y "ocr_server.tmp" "ocr_server.py" >nul
if errorlevel 1 goto :server_download_failed

:prepare_environment
if exist "venv\Scripts\python.exe" goto :verify_environment

echo [1/4] Looking for Python 3...
call :find_python
if defined PYTHON_EXE goto :create_environment

echo Python 3 was not found. Installing Python 3.12 automatically...
where winget >nul 2>nul
if errorlevel 1 goto :install_python_official

winget install --exact --id Python.Python.3.12 --scope user --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
call :find_python
if defined PYTHON_EXE goto :create_environment
echo winget did not complete the Python installation. Trying the official installer...

:install_python_official
set "PYTHON_INSTALLER=%TEMP%\ai_ocr_python_3_12_10.exe"
set "PYTHON_URL=%PYTHON_URL_X64%"
if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "PYTHON_URL=%PYTHON_URL_ARM64%"
echo Downloading the official Python installer from python.org...
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri '%PYTHON_URL%' -OutFile '%PYTHON_INSTALLER%'"
if errorlevel 1 goto :python_download_failed
echo Installing Python for the current Windows user...
start "" /wait "%PYTHON_INSTALLER%" /quiet InstallAllUsers=0 PrependPath=1 Include_launcher=1 Include_pip=1 Include_test=0 Shortcuts=0
set "PYTHON_INSTALL_RESULT=%ERRORLEVEL%"
del /q "%PYTHON_INSTALLER%" >nul 2>nul
if not "%PYTHON_INSTALL_RESULT%"=="0" goto :python_install_failed
call :find_python
if not defined PYTHON_EXE goto :python_install_failed

:create_environment
echo [2/4] Preparing an isolated OCR environment...
if exist "venv" rmdir /s /q "venv"
"%PYTHON_EXE%" -m venv "venv"
if not exist "venv\Scripts\python.exe" goto :venv_failed

:environment_ready
"venv\Scripts\python.exe" -m ensurepip --upgrade
if errorlevel 1 goto :venv_failed
"venv\Scripts\python.exe" -m pip install --disable-pip-version-check --upgrade pip
if errorlevel 1 goto :setup_failed
"venv\Scripts\python.exe" -m pip install --disable-pip-version-check flask flask-cors Pillow winocr
if errorlevel 1 goto :setup_failed
goto :configure_startup

:verify_environment
echo [1/4] Checking the installed OCR environment...
"venv\Scripts\python.exe" -c "import flask, flask_cors, PIL, winocr" >nul 2>nul
if not errorlevel 1 goto :configure_startup
echo Repairing missing OCR packages...
goto :environment_ready

:configure_startup
echo [3/4] Enabling automatic startup after Windows sign-in...
powershell -NoProfile -ExecutionPolicy Bypass -File "%INSTALL_DIR%\windows_ocr_helper.ps1" autostart
if errorlevel 1 goto :autostart_failed

echo [4/4] Starting Windows OCR in the background...
"venv\Scripts\python.exe" -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5001/status', timeout=2).read()" >nul 2>nul
if not errorlevel 1 goto :server_ready
powershell -NoProfile -ExecutionPolicy Bypass -File "%INSTALL_DIR%\windows_ocr_helper.ps1" start
if errorlevel 1 goto :server_failed
powershell -NoProfile -ExecutionPolicy Bypass -File "%INSTALL_DIR%\windows_ocr_helper.ps1" wait
if errorlevel 1 goto :server_failed

:server_ready
echo.
echo ============================================================
echo   Windows Native OCR is installed and ready.
echo   It will start automatically after Windows sign-in.
echo   Return to the web page and click "Test Connection".
echo.
echo   The downloaded setup_and_run_ocr.bat can now be deleted.
echo   Keep the installed files under LocalAppData.
echo ============================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%INSTALL_DIR%\windows_ocr_helper.ps1" popup
echo Press any key to close this installer window.
pause >nul
goto :end

:find_python
set "PYTHON_EXE="
for /f "usebackq delims=" %%I in (`py -3 -c "import sys; print(sys.executable)" 2^>nul`) do set "PYTHON_EXE=%%I"
if defined PYTHON_EXE goto :eof
for /f "usebackq delims=" %%I in (`python -c "import sys; print(sys.executable)" 2^>nul`) do set "PYTHON_EXE=%%I"
if defined PYTHON_EXE goto :eof
if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" set "PYTHON_EXE=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
goto :eof

:install_dir_failed
echo ERROR: Windows did not allow creation of the local application folder.
echo Allow this BAT file in Windows Security, then run it again.
goto :fail

:helper_download_failed
if exist "windows_ocr_helper.tmp" del /q "windows_ocr_helper.tmp" >nul 2>nul
if exist "windows_ocr_helper.ps1" (
  echo WARNING: Unable to update the helper; using the installed copy.
  goto :download_server_with_existing_helper
)
echo ERROR: The OCR helper could not be downloaded from GitHub.
echo Allow raw.githubusercontent.com in the firewall or download the complete project ZIP.
goto :fail

:download_server_with_existing_helper
powershell -NoProfile -ExecutionPolicy Bypass -File "%INSTALL_DIR%\windows_ocr_helper.ps1" download "ocr_server.tmp"
if errorlevel 1 goto :server_download_failed
move /y "ocr_server.tmp" "ocr_server.py" >nul
if errorlevel 1 goto :server_download_failed
goto :prepare_environment

:server_download_failed
if exist "ocr_server.tmp" del /q "ocr_server.tmp" >nul 2>nul
echo ERROR: ocr_server.py could not be downloaded from GitHub.
echo Check the internet connection, firewall, proxy, or antivirus history.
goto :fail

:python_download_failed
echo ERROR: Python could not be downloaded automatically from python.org.
echo Allow python.org in the firewall, then run this BAT file again.
echo Manual fallback: winget install -e --id Python.Python.3.12
goto :fail

:python_install_failed
echo ERROR: Windows blocked or cancelled the automatic Python installation.
echo Open Windows Security Protection History and allow the installer, then retry.
echo Manual fallback: winget install -e --id Python.Python.3.12
goto :fail

:venv_failed
echo ERROR: Python was installed, but the isolated OCR environment could not be created.
echo Delete "%INSTALL_DIR%\venv" and run this BAT file again.
goto :fail

:setup_failed
echo ERROR: OCR packages could not be installed from PyPI.
echo Allow python.exe and pypi.org in the firewall, then run this BAT file again.
goto :fail

:autostart_failed
echo ERROR: Windows did not allow creation of the Startup shortcut.
echo Check Windows Security Protection History, allow the action, and retry.
goto :fail

:server_failed
echo ERROR: The OCR server did not become ready.
echo Check "%INSTALL_DIR%\logs\ocr_server.err.log" for details.
echo If port 5001 is in use, restart Windows and run this BAT file again.

:fail
echo.
echo Installation files kept for repair at:
echo   %INSTALL_DIR%
echo.
pause
exit /b 1

:end
endlocal
