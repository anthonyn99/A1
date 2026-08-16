<#
  Launches Shield, rebuilding first if the agent's source has changed.

  Called by A1\Shield.cmd. Not usually run directly.

  Design notes:
   · The UI needs no handling here. The agent re-navigates to the live page with
     a cache-buster every launch, so shield.html edits are picked up simply by
     opening it (or tray > Reload UI on an already-running agent).
   · Only the Rust agent needs rebuilding, and only on a PC that has the
     toolchain. Everywhere else this is just "start the installed copy" — which
     is the common case and must never fail because Rust is absent.
   · %LOCALAPPDATA%\Shield\shield-agent.exe is the single canonical location.
     Running the agent from target\release as well is what previously left the
     desktop shortcut launching a stale binary.
#>
[CmdletBinding()]
param([switch]$NoBuild, [switch]$Quiet)

$ErrorActionPreference = 'Continue'
# $PSScriptRoot, not $MyInvocation: the latter is null in several invocation
# contexts, which silently made $root empty and turned the "is the source
# newer?" check into a no-op that always said no.
$root = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$installed = "$env:LOCALAPPDATA\Shield\shield-agent.exe"
$built = "$root\src-tauri\target\release\shield-agent.exe"

function Say($m, $c = 'Gray') { if (-not $Quiet) { Write-Host $m -ForegroundColor $c } }

# ── is the source newer than what is installed? ─────────────────────────────
function Newest-Source {
  $paths = @("$root\src-tauri\src", "$root\src-tauri\Cargo.toml",
             "$root\src-tauri\build.rs", "$root\src-tauri\capabilities",
             "$root\src-tauri\tauri.conf.json")
  $t = [datetime]::MinValue
  foreach ($p in $paths) {
    if (-not (Test-Path $p)) { continue }
    foreach ($f in (Get-ChildItem $p -Recurse -File -ErrorAction SilentlyContinue)) {
      if ($f.LastWriteTime -gt $t) { $t = $f.LastWriteTime }
    }
  }
  return $t
}

$haveCargo = [bool](Get-Command cargo -ErrorAction SilentlyContinue)
if (-not $haveCargo -and (Test-Path "$env:USERPROFILE\.cargo\bin\cargo.exe")) {
  $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
  $haveCargo = $true
}

$needBuild = $false
if (-not $NoBuild -and $haveCargo) {
  $src = Newest-Source
  if (-not (Test-Path $installed)) {
    $needBuild = $true
    Say "Shield is not installed yet - building it." Yellow
  } elseif ($src -gt (Get-Item $installed).LastWriteTime) {
    $needBuild = $true
    Say ("Agent source changed ({0:HH:mm} vs installed {1:HH:mm}) - rebuilding." -f $src, (Get-Item $installed).LastWriteTime) Yellow
  } else {
    Say ("Agent is current (built {0:HH:mm})." -f (Get-Item $installed).LastWriteTime) DarkGray
  }
} elseif (-not $haveCargo) {
  Say "No Rust toolchain here - starting the installed agent as-is." DarkGray
}

if ($needBuild) {
  & "$root\build.ps1" -Update
  if ($LASTEXITCODE -ne 0) {
    Say "Build failed. Starting the existing copy instead." Red
  } else {
    # build.ps1 -Update already restarted it.
    exit 0
  }
}

# ── launch ──────────────────────────────────────────────────────────────────
$exe = if (Test-Path $installed) { $installed } elseif (Test-Path $built) { $built } else { $null }
if (-not $exe) {
  Write-Host ""
  Write-Host "Shield is not installed on this PC." -ForegroundColor Red
  if ($haveCargo) {
    Write-Host "Run:  desktop\shield\build.ps1 -Update"
  } else {
    Write-Host "This PC has no Rust toolchain, so it cannot build the agent." -ForegroundColor Yellow
    Write-Host "Either install Rust + VS Build Tools (see desktop\shield\README.md),"
    Write-Host "or copy Shield_1.0.0_x64-setup.exe from a PC that has built it."
  }
  Write-Host ""
  if (-not $Quiet) { Read-Host "Press Enter to close" }
  exit 1
}

# Starting a second copy is harmless and is in fact how you raise the window:
# the single-instance plugin makes the new process hand off to the running one
# and exit, so this both launches and focuses.
Start-Process $exe
Say "Shield started." Green
exit 0
