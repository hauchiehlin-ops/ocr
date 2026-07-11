param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet("start", "wait", "popup", "download")]
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
    $message = "Windows 原生 OCR 已啟動。您可以關閉這個視窗；OCR 會在背景繼續執行。請回到網頁點擊「測試連接」。"
    try {
      $shell = New-Object -ComObject WScript.Shell
      $null = $shell.Popup($message, 0, "AI OCR Pro Editor", 64)
    } catch {
      Write-Host $message
    }
    exit 0
  }
}
