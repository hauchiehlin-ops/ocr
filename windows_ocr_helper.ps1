param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet("start", "wait", "popup", "download", "autostart")]
  [string]$Mode,

  [Parameter(Position = 1)]
  [string]$TargetPath
)

$ErrorActionPreference = "Stop"

switch ($Mode) {
  "download" {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/hauchiehlin-ops/ocr/main/ocr_server.py" -OutFile $TargetPath
    exit 0
  }

  "start" {
    $root = (Get-Location).Path
    $py = Join-Path $root "venv\Scripts\python.exe"
    $logsDir = Join-Path $root "logs"
    if (-not (Test-Path $logsDir)) {
      New-Item -ItemType Directory -Path $logsDir | Out-Null
    }

    $log = Join-Path $logsDir "ocr_server.log"
    $err = Join-Path $logsDir "ocr_server.err.log"
    Start-Process -FilePath $py -ArgumentList "ocr_server.py" -WorkingDirectory $root -RedirectStandardOutput $log -RedirectStandardError $err -WindowStyle Hidden
    exit 0
  }

  "autostart" {
    $root = (Get-Location).Path
    $pythonw = Join-Path $root "venv\Scripts\pythonw.exe"
    $server = Join-Path $root "ocr_server.py"
    $startup = [Environment]::GetFolderPath("Startup")
    $shortcutPath = Join-Path $startup "AI OCR Pro Editor OCR.lnk"

    if (-not (Test-Path $pythonw)) {
      throw "The OCR Python environment is missing."
    }

    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $pythonw
    $shortcut.Arguments = '"' + $server + '"'
    $shortcut.WorkingDirectory = $root
    $shortcut.Description = "AI OCR Pro Editor Windows Native OCR"
    $shortcut.Save()
    exit 0
  }

  "wait" {
    $deadline = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $deadline) {
      try {
        $status = Invoke-RestMethod -UseBasicParsing "http://127.0.0.1:5001/status" -TimeoutSec 3
        if ($status.status -eq "running") {
          exit 0
        }
      } catch {
      }
      Start-Sleep -Seconds 1
    }
    exit 1
  }

  "popup" {
    # Keep this helper strictly ASCII. Windows PowerShell 5.1 interprets a
    # UTF-8 file without a BOM as the active ANSI code page, which can corrupt
    # non-ASCII string literals and cause a parser error before any mode runs.
    $message = "Windows Native OCR is installed and ready. Return to the web page and click Test Connection. The downloaded BAT file can now be deleted."
    try {
      $shell = New-Object -ComObject WScript.Shell
      $null = $shell.Popup($message, 0, "AI OCR Pro Editor", 64)
    } catch {
      Write-Host $message
    }
    exit 0
  }
}
