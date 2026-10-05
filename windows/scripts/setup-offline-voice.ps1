# Sets up offline speech recognition: downloads whisper.cpp (the engine) and a
# speech model into the folder the app looks in, so voice keeps working with no
# internet and no audio ever leaves your computer.
#
#   powershell -ExecutionPolicy Bypass -File scripts\setup-offline-voice.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\setup-offline-voice.ps1 -Model small
#
# Models, smallest to most accurate (and slowest): tiny, base, small.
# The ".en" versions are English-only and a little faster and more accurate for English.

param(
  [ValidateSet("tiny", "tiny.en", "base", "base.en", "small", "small.en")]
  [string]$Model = "base",
  [string]$Dest = (Join-Path $env:APPDATA "Jimmy\voice")
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # the progress bar makes downloads much slower
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }

New-Item -ItemType Directory -Force -Path $Dest | Out-Null
$binDir = Join-Path $Dest "bin"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

# ── 1. The engine: whisper.cpp for Windows ────────────────────────────────────

$existing = Get-ChildItem -Path $binDir -Recurse -Filter "whisper-cli.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($existing) {
  Step "whisper.cpp is already installed: $($existing.FullName)"
} else {
  Step "Finding the newest whisper.cpp Windows build"
  # The "latest" release (v1.x.y) carries no files: the Windows builds are attached to
  # the separate build releases (b5130, ...). So take the newest release that has one.
  $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=30" `
    -Headers @{ "User-Agent" = "jimmy-setup" }
  $release = $null
  $asset = $null
  foreach ($r in $releases) {
    $a = $r.assets | Where-Object { $_.name -eq "whisper-bin-x64.zip" } | Select-Object -First 1
    if ($a) { $release = $r; $asset = $a; break }
  }
  if (-not $asset) {
    throw ("No release with whisper-bin-x64.zip found. Download a Windows build by hand from " +
           "https://github.com/ggml-org/whisper.cpp/releases and unzip it into $binDir")
  }
  $zip = Join-Path $env:TEMP "whisper-bin-x64.zip"
  Step "Downloading $($asset.name) ($($release.tag_name))"
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing
  Step "Unpacking into $binDir"
  Expand-Archive -Path $zip -DestinationPath $binDir -Force
  Remove-Item $zip -Force
  $existing = Get-ChildItem -Path $binDir -Recurse -Filter "whisper-cli.exe" | Select-Object -First 1
  if (-not $existing) {
    throw "whisper-cli.exe was not in the download. Older releases call it main.exe: look in $binDir and set the path in Settings > Voice."
  }
}
$cli = $existing.FullName

# ── 2. The model ──────────────────────────────────────────────────────────────

$modelFile = Join-Path $Dest "ggml-$Model.bin"
if (Test-Path $modelFile) {
  Step "Model already downloaded: $modelFile"
} else {
  Step "Downloading the '$Model' speech model (this is the big one, 75 MB to 470 MB)"
  $url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$Model.bin"
  $part = "$modelFile.part"
  Invoke-WebRequest -Uri $url -OutFile $part -UseBasicParsing
  Move-Item -Force $part $modelFile
}

# ── 3. Check it starts ────────────────────────────────────────────────────────

Step "Checking that the engine starts"
try {
  & $cli --help *> $null
  Write-Host "whisper.cpp starts fine." -ForegroundColor Green
} catch {
  Write-Host "whisper.cpp did not start: $_" -ForegroundColor Yellow
  Write-Host "If a DLL is missing, install the Microsoft Visual C++ Redistributable (x64) and run this again."
}

Write-Host "`nDone. Offline voice is ready:" -ForegroundColor Green
Write-Host "  engine: $cli"
Write-Host "  model:  $modelFile"
Write-Host "`nOpen Settings > Voice and press 'Test microphone' to try it (set Engines to 'Offline only' to be sure)."
