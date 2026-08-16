<#
  Builds the Shield agent and (optionally) installs it.

  Prerequisites, checked below:
    · Rust (MSVC toolchain)   — https://rustup.rs
    · VS Build Tools 2022 with "Desktop development with C++"
    · WebView2 runtime        — already present on Windows 11
    · Node 18+                — only to regenerate the icons

  Usage:
      .\build.ps1 -Update      # ← the everyday one: rebuild, replace the
                               #   installed copy, restart. Your desktop
                               #   shortcut then runs the new build.
      .\build.ps1              # build a release bundle only
      .\build.ps1 -Dev         # run against the live page with a console
      .\build.ps1 -Install     # build, then run the NSIS installer
      .\build.ps1 -Autostart   # start the INSTALLED copy at logon

  Note there is only ONE place the agent should ever run from:
  %LOCALAPPDATA%\Shield\shield-agent.exe. That is what the desktop and Start
  shortcuts point at. Running it out of target\release as well means the
  shortcut silently launches a stale binary while you keep rebuilding — which
  is exactly what happened once. -Update and -Autostart both keep that single
  location authoritative.
#>
[CmdletBinding()]
param(
  [switch]$Dev,
  [switch]$Install,
  [switch]$Autostart,
  [switch]$Update
)

# NOT 'Stop'. Windows PowerShell wraps every line a native exe writes to stderr
# in an ErrorRecord, and cargo reports ordinary build progress there — so 'Stop'
# aborts a perfectly healthy build on its first "Compiling" line. Native failures
# are detected by checking $LASTEXITCODE explicitly instead.
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Have($name) { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }

Write-Host "== Shield agent ==" -ForegroundColor Cyan

# ── prerequisites ───────────────────────────────────────────────────────────
$missing = @()
if (-not (Have 'cargo'))  { $missing += 'Rust (cargo). Install: winget install Rustlang.Rustup' }
if (-not (Have 'node'))   { $missing += 'Node 18+ (only needed to regenerate icons)' }

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$hasMsvc = $false
if (Test-Path $vswhere) {
  $vc = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
  if ($vc) { $hasMsvc = $true }
}
if (-not $hasMsvc) {
  $missing += 'MSVC C++ build tools. Install: winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"'
}

if ($missing.Count) {
  Write-Host "`nMissing prerequisites:" -ForegroundColor Yellow
  $missing | ForEach-Object { Write-Host "  - $_" }
  Write-Host "`nInstall those, open a NEW terminal (so PATH refreshes), then re-run.`n"
  exit 1
}

# ── icons ───────────────────────────────────────────────────────────────────
if (-not (Test-Path "$root\src-tauri\icons\icon.ico")) {
  Write-Host "Generating icons..." -ForegroundColor DarkGray
  node "$root\tools\make-icon.js"
}

# ── tauri-cli ───────────────────────────────────────────────────────────────
# Installed as a cargo binary rather than through npm, so the agent needs no
# node_modules and no package.json anywhere in this repo.
if (-not (Have 'cargo-tauri')) {
  Write-Host "Installing tauri-cli (one-time, a few minutes)..." -ForegroundColor DarkGray
  cargo install tauri-cli --version "^2" --locked
}

Set-Location "$root\src-tauri"

if ($Dev) {
  Write-Host "Running in dev mode. Close the window or use tray > Quit to stop." -ForegroundColor Green
  cargo tauri dev
  exit $LASTEXITCODE
}

# Another build already in flight? cargo blocks on the target-directory lock
# with a bare "Blocking waiting for file lock", which looks like a hang. Say so.
$otherBuild = @(Get-CimInstance Win32_Process -Filter "Name='cargo.exe' OR Name='cargo-tauri.exe'" -ErrorAction SilentlyContinue |
                Where-Object { $_.ProcessId -ne $PID })
if ($otherBuild.Count) {
  Write-Host "Another Shield build is already running - this one will wait for it." -ForegroundColor Yellow
  Write-Host "(cargo serialises on the target directory; nothing is wrong.)" -ForegroundColor DarkGray
}

# Build BEFORE touching the running agent.
#
# Stopping it first meant Shield was down for the whole compile - minutes with
# no tray icon and no hotkeys, on a tool whose entire purpose is being there the
# moment you need it. The agent runs from %LOCALAPPDATA%, not from
# target\release, so the build does not need it stopped at all. Downtime is now
# the second or two it takes to swap the file.
Write-Host "Building release bundle (first build takes several minutes)..." -ForegroundColor Green
cargo tauri build
if ($LASTEXITCODE -ne 0) {
  # The one case that does need it stopped: someone is running the agent
  # straight out of target\release, so cargo cannot replace its own output.
  $fromBuildDir = @(Get-Process -Name 'shield-agent' -ErrorAction SilentlyContinue |
                    Where-Object { $_.Path -like "*\target\release\*" })
  if ($fromBuildDir.Count) {
    Write-Host "An agent is running from the build directory - stopping it and retrying." -ForegroundColor Yellow
    $fromBuildDir | Stop-Process -Force
    Start-Sleep -Milliseconds 1000
    cargo tauri build
  }
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$exe = Get-ChildItem "$root\src-tauri\target\release\shield-agent.exe" -ErrorAction SilentlyContinue
$nsis = Get-ChildItem "$root\src-tauri\target\release\bundle\nsis\*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1

# The single location the agent is supposed to run from — what the desktop and
# Start-menu shortcuts point at.
$installed = "$env:LOCALAPPDATA\Shield\shield-agent.exe"

Write-Host ""
if ($exe)  { Write-Host "  exe:       $($exe.FullName)" }
if ($nsis) { Write-Host "  installer: $($nsis.FullName)" }

if ($Update -and $exe) {
  Write-Host "`nUpdating the installed copy..." -ForegroundColor Green
  # Already stopped above, before the build. Catch a copy that started since.
  Get-Process -Name 'shield-agent' -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Milliseconds 800
  New-Item -ItemType Directory -Force (Split-Path $installed) | Out-Null
  Copy-Item $exe.FullName $installed -Force
  Write-Host "  replaced: $installed"

  # Keep autostart pointed at the installed copy, never at target\release —
  # otherwise the shortcut and the logon entry run two different binaries.
  $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  $cur = (Get-ItemProperty $key -Name 'Shield' -ErrorAction SilentlyContinue).Shield
  if ($cur -and $cur -notlike "*$installed*") {
    New-ItemProperty -Path $key -Name 'Shield' -Value "`"$installed`"" -PropertyType String -Force | Out-Null
    Write-Host "  autostart repointed at the installed copy" -ForegroundColor Yellow
  }

  Start-Process $installed
  Write-Host "  restarted" -ForegroundColor Green
  Write-Host "`nYour desktop shortcut now runs this build." -ForegroundColor Green
}

if ($Install -and $nsis) {
  Write-Host "`nLaunching the installer. SmartScreen will warn: the build is unsigned." -ForegroundColor Yellow
  Start-Process $nsis.FullName
}

if ($Autostart -and $exe) {
  # HKCU only. Shield never writes to HKLM, never installs a service, and never
  # asks for admin — a process-killing tray app that did all three would be
  # indistinguishable from something you would not want on your machine.
  #
  # Points at the INSTALLED copy, so the logon entry and the shortcuts can never
  # diverge into two different builds.
  $target = if (Test-Path $installed) { $installed } else { $exe.FullName }
  $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  New-ItemProperty -Path $key -Name 'Shield' -Value "`"$target`"" -PropertyType String -Force | Out-Null
  Write-Host "`nRegistered to start at logon: $target" -ForegroundColor Green
  Write-Host "Remove with: Remove-ItemProperty -Path '$key' -Name 'Shield'"
}
