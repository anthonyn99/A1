<#
  Builds the Shield agent and (optionally) installs it.

  Prerequisites, checked below:
    · Rust (MSVC toolchain)   — https://rustup.rs
    · VS Build Tools 2022 with "Desktop development with C++"
    · WebView2 runtime        — already present on Windows 11
    · Node 18+                — only to regenerate the icons

  Usage:
      .\build.ps1              # check prerequisites, build a release bundle
      .\build.ps1 -Dev         # run against the live page with a console
      .\build.ps1 -Install     # build, then run the NSIS installer
      .\build.ps1 -Autostart   # register the built exe to start at logon
#>
[CmdletBinding()]
param(
  [switch]$Dev,
  [switch]$Install,
  [switch]$Autostart
)

$ErrorActionPreference = 'Stop'
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

Write-Host "Building release bundle (first build takes several minutes)..." -ForegroundColor Green
cargo tauri build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$exe = Get-ChildItem "$root\src-tauri\target\release\shield-agent.exe" -ErrorAction SilentlyContinue
$nsis = Get-ChildItem "$root\src-tauri\target\release\bundle\nsis\*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1

Write-Host ""
if ($exe)  { Write-Host "  exe:       $($exe.FullName)" }
if ($nsis) { Write-Host "  installer: $($nsis.FullName)" }

if ($Install -and $nsis) {
  Write-Host "`nLaunching the installer. SmartScreen will warn: the build is unsigned." -ForegroundColor Yellow
  Start-Process $nsis.FullName
}

if ($Autostart -and $exe) {
  # HKCU only. Shield never writes to HKLM, never installs a service, and never
  # asks for admin — a process-killing tray app that did all three would be
  # indistinguishable from something you would not want on your machine.
  $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  New-ItemProperty -Path $key -Name 'Shield' -Value "`"$($exe.FullName)`"" -PropertyType String -Force | Out-Null
  Write-Host "`nRegistered to start at logon (HKCU\...\Run\Shield)." -ForegroundColor Green
  Write-Host "Remove with: Remove-ItemProperty -Path '$key' -Name 'Shield'"
}
