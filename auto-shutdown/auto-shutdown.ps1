#Requires -Version 5.1
<#
.SYNOPSIS
    A1 Auto Shutdown - nightly PC shutdown that never interrupts an active user.

.DESCRIPTION
    One self-contained file that is both the installer and the runtime.

        .\auto-shutdown.ps1                  # install / repair (idempotent)
        .\auto-shutdown.ps1 -Mode Status     # health report + live decision preview
        .\auto-shutdown.ps1 -Mode Test       # end-to-end: fire the task for real, dry-run
        .\auto-shutdown.ps1 -Mode Uninstall  # remove the task
        .\auto-shutdown.ps1 -Mode Run        # what the scheduled task itself calls

    Install registers the scheduled task \A1\A1 Auto Shutdown and enables
    "Allow wake timers" on every power scheme (Windows 11 ships it Disabled on
    this machine, which silently stops any scheduled task from waking the PC).

    HOW THE TIME IS HANDLED
    Task Scheduler triggers are local and DST-aware only when the trigger's
    StartBoundary carries no UTC offset. New-ScheduledTaskTrigger writes one
    (e.g. ...T00:00:00-06:00), which pins the task to that fixed offset and makes
    it fire an hour early once DST ends. So the task is registered from raw XML
    with a naive <StartBoundary>, which Windows re-evaluates against local time
    every night. Nothing here stores or computes a UTC offset.

    WHAT IT DOES AT THE SCHEDULED TIME
      session locked ......................... shut down (nobody is at the PC)
      display wake lock + recent presence .... skip (a video is playing)
      user input more recent than IdleMinutes  skip
      otherwise .............................. shut down

    The wake-lock check is deliberately bounded by -MediaGraceMinutes. The
    League client holds a Video Wake Lock for its whole lifetime, so an
    unbounded check would leave this PC running every night it was left open.

    Asleep counts as "shut down": in Modern Standby or classic sleep the wake
    timer runs the task, and by then the session is locked and/or the last input
    is old, so both leading signals agree. Works with the lid closed - the task
    needs no display.

    MODERN STANDBY, AND WHY THE WINDOW IS ASYMMETRIC
    This is an S0 Low Power Idle (Modern Standby) laptop with connected standby
    disabled, and it does not reliably honour an RTC wake once it has been in
    DRIPS for hours. Measured on 2026-08-21: the PC entered Modern Standby at
    22:47 and stayed there; the 23:59:31 wake timer never fired; Task Scheduler
    deferred the 00:00 trigger and only retried at 03:08:15, the moment the
    machine next surfaced - and that launch was refused (0x800710E0) because the
    system was entering sleep 0.1s later. A 5-minute standby test the next day
    fired both an InteractiveToken and a SYSTEM task on time, so the plumbing
    works; it is prolonged DRIPS that suppresses the wake.

    HITTING $Time EXACTLY: -KeepAwakeFrom
    The only dependable way to shut down at $Time on this laptop is for it to
    still be awake at $Time. With -KeepAwakeFrom set, an arm task disables the
    lid-close sleep action and the idle sleep timer that evening, so closing the
    lid turns the screen off without sleeping; at $Time the PC is simply on, and
    the shutdown is an ordinary shutdown that has never failed. A disarm task
    restores both settings, and runs at logon as well as $Time+15m so normal
    sleep can never be left disabled.

    The cost is real: the PC runs, lid closed, from when you close it until
    $Time. On AC that is free. On battery it is a few hours of idle drain, and
    the machine should not be in a bag while it happens. Uninstall disarms too.

    Without -KeepAwakeFrom the lock trigger below is used instead.

    WHY THE LOCK TRIGGER IS THE FALLBACK MECHANISM
    Four nights of evidence say a shutdown cannot be made to work from Modern
    Standby on battery. The decisive measurement is 2026-08-25: the shutdown was
    issued at 01:12:17, a full two seconds BEFORE the hibernate at 01:12:19, and
    Windows hibernated anyway and deferred the shutdown to the next resume - it
    ran at 06:44 when the lid was opened. Being faster does not help, because
    this is not a race; a shutdown request simply does not preempt a
    battery-budget hibernate.

    So the shutdown is taken while the PC is still awake. A second task fires on
    session lock - measured at 0.9s from lock to trigger - and shuts down if the
    clock is inside the night window. Closing the lid locks the session, so that
    is the moment this laptop is both finished for the night and still able to
    shut down. There is deliberately no delay on that trigger: the lid sleeps
    the machine within seconds, and anything deferred past that point lands back
    in the broken path.

    The nightly $Time task is kept for the case where the PC is awake at $Time,
    and it now refuses to act if it has only just surfaced from standby, so it
    can no longer leave a queued shutdown that ambushes the next boot.

    THE FOUR-SECOND BUDGET
    On battery this laptop does not merely stay in Modern Standby overnight. It
    burns through its standby battery budget and then hibernates, and the only
    moment it surfaces is that transition. 2026-08-24, on battery since 21:21:

      21:44:25  506  entered Modern Standby
      01:44:37  507  surfaced; Task Scheduler ran the catch-up instance
      01:44:41  42   "Hibernate from Sleep - Standby Battery Budget Exceeded"
      01:44:42       shutdown issued - one second too late, so it only queued
      06:32:04  13   the queued shutdown ran, when the lid was opened

    So a run gets roughly four seconds, once a night, and PowerShell's own
    startup is inside that. Hence the fast lane in Invoke-Run: a locked session
    decides the outcome on its own, so it is decided on that one cheap signal
    and shutdown.exe is called before any Add-Type, powercfg, timezone lookup
    or log write. Those all still happen - just afterwards.

    A run on AC has no such deadline; the budget only applies on battery.

    THE SHUTDOWN ITSELF MUST BE IMMEDIATE
    A second night, 2026-08-23, got all the way to the end and still failed:

      01:50:41  507  exited Modern Standby, task launched, result 0
      01:50:45       decided SHUTDOWN (locked, idle 4.4h), ran shutdown /t 20
      01:50:45  42   system entering sleep, the same second
      08:09:28  13   OS finally shut down - after the lid was opened and the
                     pending warning dialog was clicked

    The countdown never elapsed, because a Modern Standby machine suspends it;
    the shutdown sat pending all night. Hence: no countdown when the session is
    locked, and a system power request held for the whole run so the PC cannot
    slide back into standby between the decision and the shutdown.

    So the design does not depend on waking at exactly $Time:
      - WakeToRun still asks for the wake, and takes it when it is granted.
      - The run is valid from $Time until $Time + $WindowHours, so a trigger
        deferred to 03:00 still shuts the PC down that night.
      - StartWhenAvailable and RestartOnFailure retry a deferred or refused
        launch instead of giving up until tomorrow.

    SAFETY RAILS
      - Run never acts before $Time or more than $WindowHours after it, so a
        catch-up run in the morning can never shut the PC down mid-use.
      - Run refuses to act from session 0, where user idle cannot be measured
        and therefore every PC looks idle.

    Logs to auto-shutdown.log beside this script (gitignored by *.log).

.NOTES
    Repair: re-run with no arguments. Install is idempotent and re-asserts both
    the task definition and the wake-timer power setting.
#>
[CmdletBinding()]
param(
    [ValidateSet('Install','Uninstall','Status','Run','Test','Arm','Disarm')]
    [string]$Mode = 'Install',

    # The reliable way to hit $Time exactly. From this time, closing the lid
    # stops sleeping the PC (screen still goes off) and the idle sleep timer is
    # disabled, so the PC is still awake at $Time and can simply shut down -
    # the one path that has never failed. Disarm restores both settings.
    # Empty string disables this and uses the lock trigger instead.
    [ValidatePattern('^$|^([01][0-9]|2[0-3]):[0-5][0-9]$')]
    [string]$KeepAwakeFrom = '',

    # Local wall-clock time, 24h. DST-safe by construction (see above).
    [ValidatePattern('^([01][0-9]|2[0-3]):[0-5][0-9]$')]
    [string]$Time = '00:00',

    # Which trigger invoked this run. 'Lock' is the reliable path: the user has
    # just locked or closed the lid, so the PC is awake and can actually shut
    # down. 'Schedule' is the nightly $Time trigger.
    [ValidateSet('Schedule','Lock')]
    [string]$Trigger = 'Schedule',

    # Locking after this time counts as "done for the night". Locks before it
    # are ignored, so locking your screen during the day is never a shutdown.
    [ValidatePattern('^([01][0-9]|2[0-3]):[0-5][0-9]$')]
    [string]$NightStart = '21:00',

    # Input more recent than this means "actively being used" -> do nothing.
    [ValidateRange(0,720)]
    [int]$IdleMinutes = 3,

    # How long after $Time a run may still shut down. Deliberately asymmetric:
    # Modern Standby defers a deferred trigger to whenever the machine next
    # surfaces, which can be hours. A run is allowed from $Time until
    # $Time + $WindowHours, and never before $Time or after it - so a deferred
    # 03:00 run still shuts the PC down, but a catch-up run at 09:00 cannot.
    [ValidateRange(1,12)]
    [int]$WindowHours = 6,

    # A display wake lock only protects the PC while the user has been present
    # this recently. Apps such as the League client hold one forever, so an
    # unbounded check would mean the PC never shuts down. See Get-Decision.
    [ValidateRange(0,1440)]
    [int]$MediaGraceMinutes = 60,

    # Countdown before the shutdown, for the awake-and-unlocked case only.
    # Defaults to 0: a countdown cannot elapse while the PC is in Modern
    # Standby, and a locked session forces 0 regardless of what is passed here.
    [ValidateRange(0,600)]
    [int]$GraceSeconds = 0,

    # Decide and log, but do not shut down.
    [switch]$DryRun,

    # Skip the wall-clock window check (used by -Mode Test).
    [switch]$Force,

    # Internal: set on the elevated relaunch to stop a UAC loop.
    [switch]$NoElevate,

    # Deprecated, ignored. A task registered before the night-window change
    # still passes -WindowMinutes; without this the run would die on a
    # parameter-binding error instead of shutting the PC down. Reinstall to
    # drop it. See -WindowHours for the replacement.
    [int]$WindowMinutes = 0
)

$ErrorActionPreference = 'Stop'

# Capture at script scope: inside a function $PSBoundParameters is the
# function's own, so the legacy-parameter check has to be hoisted here.
$UsedLegacyWindow = $PSBoundParameters.ContainsKey('WindowMinutes')

$TaskName       = 'A1 Auto Shutdown'
$LockTaskName   = 'A1 Auto Shutdown (lock)'
$ArmTaskName    = 'A1 Auto Shutdown (arm)'
$DisarmTaskName = 'A1 Auto Shutdown (disarm)'
$TaskPath       = '\A1\'
$TestName   = 'A1 Auto Shutdown Verify'
$ScriptPath = $MyInvocation.MyCommand.Path
$ScriptDir  = Split-Path -Parent $ScriptPath
$LogPath    = Join-Path $ScriptDir 'auto-shutdown.log'

# Power setting: Sleep > Allow wake timers. 1 = Enable. (2 = "important timers
# only", which excludes Task Scheduler; 0 = Disable, the default found here.)
$SUB_SLEEP = '238C9FA8-0AAD-41ED-83F4-97BE242C8F20'
$RTCWAKE   = 'BD3B718A-0680-4D9D-8AB2-E1D2B4AC806D'
# Sleep > Sleep after, and Power buttons and lid > Lid close action. LIDACTION
# is hidden from powercfg /q on this machine but still writable.
$STANDBYIDLE = '29f6c1db-86da-48c5-9fdb-f2b67b1f44da'
$SUB_BUTTONS = '4f971e89-eebd-4455-a8de-9e59040e7347'
$LIDACTION   = '5ca83367-6e45-459f-a27b-476b1d01c936'
# What Arm saves, so Disarm can put things back exactly as they were.
$StateDir  = Join-Path $env:LOCALAPPDATA 'A1\auto-shutdown'
$StatePath = Join-Path $StateDir 'power-state.json'

function Write-Log {
    param([string]$Message, [ValidateSet('INFO','WARN','ERROR','ACT')][string]$Level = 'INFO')
    $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    try {
        if ((Test-Path $LogPath) -and (Get-Item $LogPath).Length -gt 512KB) {
            Move-Item $LogPath ($LogPath + '.1') -Force
        }
        Add-Content -Path $LogPath -Value $line -Encoding ASCII
    } catch { }
    Write-Host $line
}

# PowerShell 5.1 turns native stderr into ErrorRecords when it is redirected,
# which throws under ErrorActionPreference=Stop. Capture with Stop relaxed.
function Invoke-Native {
    param([string]$Exe, [string[]]$Arguments)
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & $Exe @Arguments 2>&1 | ForEach-Object { [string]$_ }
    } finally {
        $ErrorActionPreference = $old
    }
    ($out -join "`n")
}

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal $id).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Registering a HighestAvailable task and writing power settings both need admin.
function Assert-Admin {
    if (Test-Admin) { return }
    if ($NoElevate) { throw 'Administrator rights are required and elevation was declined.' }
    Write-Log "not elevated: relaunching '$Mode' via UAC"
    # Every parameter has to be forwarded. Dropping one here silently installs
    # something other than what was asked for - -KeepAwakeFrom went missing this
    # way and quietly installed the lock strategy instead.
    $a  = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -Mode {1} -Time {2} -Trigger {3}' -f $ScriptPath, $Mode, $Time, $Trigger
    $a += ' -NightStart {0} -IdleMinutes {1} -WindowHours {2} -MediaGraceMinutes {3} -GraceSeconds {4} -NoElevate' -f `
            $NightStart, $IdleMinutes, $WindowHours, $MediaGraceMinutes, $GraceSeconds
    if ($KeepAwakeFrom) { $a += ' -KeepAwakeFrom {0}' -f $KeepAwakeFrom }
    if ($DryRun) { $a += ' -DryRun' }
    if ($Force)  { $a += ' -Force' }
    $p = Start-Process -FilePath 'powershell.exe' -ArgumentList $a -Verb RunAs -WindowStyle Hidden -PassThru -Wait
    exit $p.ExitCode
}

# --------------------------------------------------------------------------
# Activity signals
# --------------------------------------------------------------------------

# Seconds since the last keyboard/mouse input in THIS session. Only meaningful
# from an interactive session, which is why the task runs as InteractiveToken.
# One Add-Type for every P/Invoke here. Compiling C# costs a second or two, and
# in the window that matters that latency is the difference between the
# shutdown landing and the machine sliding back into standby first.
function Initialize-Native {
    if ('A1.Native' -as [type]) { return }
    # No -UsingNamespace here: Add-Type already emits a using for
    # System.Runtime.InteropServices, and the duplicate is a warning-as-error.
    Add-Type -Namespace 'A1' -Name 'Native' -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)]
public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
[DllImport("user32.dll")]
private static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
[DllImport("kernel32.dll")]
private static extern uint GetTickCount();
[DllImport("kernel32.dll", SetLastError=true)]
private static extern uint SetThreadExecutionState(uint esFlags);
public static double IdleSeconds() {
    LASTINPUTINFO lii = new LASTINPUTINFO();
    lii.cbSize = (uint)Marshal.SizeOf(lii);
    if (!GetLastInputInfo(ref lii)) { return -1.0; }
    // unchecked uint subtraction stays correct across the 49.7-day tick wrap
    return (double)(GetTickCount() - lii.dwTime) / 1000.0;
}
// ES_CONTINUOUS 0x80000000 | ES_SYSTEM_REQUIRED 0x00000001
public static void KeepAwake(bool hold) {
    SetThreadExecutionState(hold ? 0x80000001u : 0x80000000u);
}
'@
}

function Get-IdleSeconds { Initialize-Native; [A1.Native]::IdleSeconds() }

# Holds a system power request for as long as this run lasts. Without it the PC
# can slide back into Modern Standby mid-run: on 2026-08-23 it woke at 01:50:41
# and was entering sleep again at 01:50:45 - the same second the shutdown was
# issued - which left the shutdown pending until someone opened the lid.
function Set-KeepAwake {
    param([switch]$Release)
    Initialize-Native
    [A1.Native]::KeepAwake(-not $Release)
}

# True while the wall clock is inside [NightStart, $Time + $WindowHours),
# which normally wraps midnight (21:00 -> 06:00).
function Test-NightWindow {
    param([datetime]$Now)
    $s   = [datetime]::ParseExact($NightStart, 'HH:mm', $null)
    $e   = [datetime]::ParseExact($Time, 'HH:mm', $null).AddHours($WindowHours)
    $m   = $Now.Hour * 60 + $Now.Minute
    $beg = $s.Hour * 60 + $s.Minute
    $end = $e.Hour * 60 + $e.Minute
    if ($end -le $beg) { return ($m -ge $beg) -or ($m -lt $end) }   # wraps midnight
    ($m -ge $beg) -and ($m -lt $end)
}

# True if the PC only just came out of Modern Standby. A shutdown issued in that
# state does not run: Windows defers it to the next resume, so it ambushes the
# next boot instead. Measured 2026-08-25 - the shutdown was issued two seconds
# BEFORE the hibernate and still lost, so this is not a race that can be won.
function Test-JustSurfaced {
    param([int]$Seconds = 90)
    try {
        $e = Get-WinEvent -FilterHashtable @{
            LogName = 'System'; ProviderName = 'Microsoft-Windows-Kernel-Power'; Id = 507
        } -MaxEvents 1 -ErrorAction Stop
        ((Get-Date) - $e.TimeCreated).TotalSeconds -lt $Seconds
    } catch { $false }
}

# The deferral problem is specific to battery: the standby battery budget is
# what makes Windows hibernate rather than shut down. On AC there is no budget,
# so a wake at $Time can act normally and must not be refused.
function Test-OnBattery {
    try {
        $b = @(Get-CimInstance Win32_Battery -ErrorAction Stop)[0]
        if (-not $b) { return $false }   # no battery at all
        return ($b.BatteryStatus -eq 1)  # 1 = discharging, 2 = on AC
    } catch { $false }
}

function Test-SessionLocked {
    $sid = [Diagnostics.Process]::GetCurrentProcess().SessionId
    @(Get-Process -Name 'LogonUI' -ErrorAction SilentlyContinue |
        Where-Object { $_.SessionId -eq $sid }).Count -gt 0
}

# A held DISPLAY/AWAYMODE request means something is deliberately keeping the
# screen alive - a video, a presentation. Treat that as "in use".
function Get-DisplayRequest {
    $out = Invoke-Native 'powercfg.exe' @('/requests')
    if ($out -match 'requires administrator') { return $null }
    $watch = $false
    $held  = @()
    foreach ($line in ($out -split "`r?`n")) {
        if ($line -match '^([A-Z]+):\s*$') {
            $watch = $Matches[1] -in @('DISPLAY','AWAYMODE')
            continue
        }
        if ($watch) {
            $t = $line.Trim()
            if (-not $t -or $t -eq 'None.') { continue }
            # "[PROCESS] \Device\HarddiskVolume3\...\LeagueClientUx.exe" -> "[PROCESS] LeagueClientUx.exe"
            $held += ($t -replace '^\[(\w+)\]\s+\\Device\\HarddiskVolume\d+\\.*\\', '[$1] ')
        }
    }
    if (-not $held.Count) { return $null }
    # one app can hold the same lock dozens of times over
    $u = @($held | Select-Object -Unique)
    $s = ($u | Select-Object -First 4) -join ' | '
    if ($u.Count -gt 4) { $s += (' (+{0} more)' -f ($u.Count - 4)) }
    $s
}

# --------------------------------------------------------------------------
# Wake timers
# --------------------------------------------------------------------------

function Get-WakeTimerSetting {
    $out = Invoke-Native 'powercfg.exe' @('/q','SCHEME_CURRENT',$SUB_SLEEP,$RTCWAKE)
    $ac = if ($out -match 'Current AC Power Setting Index:\s*0x([0-9a-fA-F]+)') { [Convert]::ToInt32($Matches[1],16) } else { -1 }
    $dc = if ($out -match 'Current DC Power Setting Index:\s*0x([0-9a-fA-F]+)') { [Convert]::ToInt32($Matches[1],16) } else { -1 }
    [pscustomobject]@{ AC = $ac; DC = $dc; Enabled = ($ac -eq 1 -and $dc -eq 1) }
}

# Applied to every scheme, so switching power plans cannot silently break waking.
function Enable-WakeTimers {
    $schemes = @()
    foreach ($line in ((Invoke-Native 'powercfg.exe' @('/list')) -split "`r?`n")) {
        if ($line -match 'GUID:\s*([0-9a-fA-F-]{36})') { $schemes += $Matches[1] }
    }
    if (-not $schemes.Count) { $schemes = @('SCHEME_CURRENT') }
    foreach ($s in $schemes) {
        Invoke-Native 'powercfg.exe' @('/setacvalueindex',$s,$SUB_SLEEP,$RTCWAKE,'1') | Out-Null
        Invoke-Native 'powercfg.exe' @('/setdcvalueindex',$s,$SUB_SLEEP,$RTCWAKE,'1') | Out-Null
    }
    # re-activating the current scheme is what makes the change take effect now
    $act = Invoke-Native 'powercfg.exe' @('/getactivescheme')
    if ($act -match 'GUID:\s*([0-9a-fA-F-]{36})') {
        Invoke-Native 'powercfg.exe' @('/setactive',$Matches[1]) | Out-Null
    }
    Write-Log ('wake timers enabled on {0} power scheme(s)' -f $schemes.Count)
}

# --------------------------------------------------------------------------
# Task definition
# --------------------------------------------------------------------------

# Without this log there is no record of why a run did or did not happen -
# Windows ships it disabled, which made the first failure undiagnosable.
function Enable-TaskSchedulerLog {
    $n = 'Microsoft-Windows-TaskScheduler/Operational'
    try {
        $cfg = New-Object System.Diagnostics.Eventing.Reader.EventLogConfiguration $n
        if ($cfg.IsEnabled) { return $true }
        $cfg.IsEnabled = $true
        $cfg.SaveChanges()
        Write-Log 'enabled the TaskScheduler/Operational event log (was off)'
        $true
    } catch { Write-Log "could not enable $n : $_" 'WARN'; $false }
}

function Test-TaskSchedulerLog {
    try { (New-Object System.Diagnostics.Eventing.Reader.EventLogConfiguration 'Microsoft-Windows-TaskScheduler/Operational').IsEnabled }
    catch { $false }
}

# --------------------------------------------------------------------------
# Keep-awake: the only way to hit $Time exactly on this laptop
# --------------------------------------------------------------------------

function Set-PowerValue {
    param([string]$Sub, [string]$Setting, [int]$AC, [int]$DC)
    Invoke-Native 'powercfg.exe' @('/setacvalueindex','SCHEME_CURRENT',$Sub,$Setting,"$AC") | Out-Null
    Invoke-Native 'powercfg.exe' @('/setdcvalueindex','SCHEME_CURRENT',$Sub,$Setting,"$DC") | Out-Null
    $act = Invoke-Native 'powercfg.exe' @('/getactivescheme')
    if ($act -match 'GUID:\s*([0-9a-fA-F-]{36})') {
        Invoke-Native 'powercfg.exe' @('/setactive',$Matches[1]) | Out-Null
    }
}

function Get-SleepAfter {
    $out = Invoke-Native 'powercfg.exe' @('/q','SCHEME_CURRENT',$SUB_SLEEP,$STANDBYIDLE)
    $ac = if ($out -match 'Current AC Power Setting Index:\s*0x([0-9a-fA-F]+)') { [Convert]::ToInt32($Matches[1],16) } else { 600 }
    $dc = if ($out -match 'Current DC Power Setting Index:\s*0x([0-9a-fA-F]+)') { [Convert]::ToInt32($Matches[1],16) } else { 600 }
    [pscustomobject]@{ AC = $ac; DC = $dc }
}

function Invoke-Arm {
    Assert-Admin
    # Save what we are about to change. LIDACTION is hidden and unset by
    # default here, so 1 (Sleep) is the value to restore to.
    if (-not (Test-Path $StateDir)) { New-Item -ItemType Directory -Path $StateDir -Force | Out-Null }
    $s = Get-SleepAfter
    if ($s.AC -eq 0 -and $s.DC -eq 0) {
        Write-Log 'already armed (sleep timers are 0) - leaving the saved state alone' 'WARN'
    } else {
        [pscustomobject]@{ SleepAC = $s.AC; SleepDC = $s.DC; LidAC = 1; LidDC = 1 } |
            ConvertTo-Json | Set-Content -Path $StatePath -Encoding ASCII
    }
    Set-PowerValue $SUB_SLEEP   $STANDBYIDLE 0 0   # never sleep on idle
    Set-PowerValue $SUB_BUTTONS $LIDACTION   0 0   # lid close does nothing
    Write-Log ("armed: lid close and idle sleep disabled until $Time. Saved sleep-after AC={0}s DC={1}s" -f $s.AC, $s.DC) 'ACT'
    0
}

function Invoke-Disarm {
    Assert-Admin
    $sleepAC = 600; $sleepDC = 600
    if (Test-Path $StatePath) {
        try {
            $st = Get-Content $StatePath -Raw | ConvertFrom-Json
            if ($st.SleepAC -gt 0) { $sleepAC = [int]$st.SleepAC }
            if ($st.SleepDC -gt 0) { $sleepDC = [int]$st.SleepDC }
        } catch { Write-Log "could not read $StatePath, restoring defaults" 'WARN' }
    }
    Set-PowerValue $SUB_SLEEP   $STANDBYIDLE $sleepAC $sleepDC
    Set-PowerValue $SUB_BUTTONS $LIDACTION   1 1      # lid close sleeps again
    Remove-Item $StatePath -Force -ErrorAction SilentlyContinue
    Write-Log ('disarmed: lid close sleeps again, idle sleep back to AC={0}s DC={1}s' -f $sleepAC, $sleepDC) 'ACT'
    0
}

function Test-Armed {
    $s = Get-SleepAfter
    ($s.AC -eq 0 -and $s.DC -eq 0)
}

function ConvertTo-XmlText { param([string]$s) [Security.SecurityElement]::Escape($s) }

function New-TaskXml {
    param([string]$TriggerXml, [string]$Arguments, [string]$Description)
    $sid = ([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
    $ps  = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
@"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>A1 auto-shutdown</Author>
    <Description>$(ConvertTo-XmlText $Description)</Description>
  </RegistrationInfo>
  <Triggers>
$TriggerXml
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$sid</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <RestartOnFailure>
      <Interval>PT5M</Interval>
      <Count>6</Count>
    </RestartOnFailure>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <DisallowStartOnRemoteAppSession>false</DisallowStartOnRemoteAppSession>
    <WakeToRun>true</WakeToRun>
    <ExecutionTimeLimit>PT5M</ExecutionTimeLimit>
    <Priority>4</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$(ConvertTo-XmlText $ps)</Command>
      <Arguments>$(ConvertTo-XmlText $Arguments)</Arguments>
      <WorkingDirectory>$(ConvertTo-XmlText $ScriptDir)</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@
}

function New-DailyTrigger {
    param([string]$At)
@"
    <CalendarTrigger>
      <StartBoundary>$((Get-Date).ToString('yyyy-MM-dd'))T$($At):00</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>
"@
}

function New-ModeArguments {
    param([string]$M)
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Mode {1} -Time {2} -KeepAwakeFrom {3}' -f
        $ScriptPath, $M, $Time, $KeepAwakeFrom
}

function New-RunArguments {
    param([string]$Extra = '', [string]$TriggerKind = 'Schedule')
    ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" ' +
     '-Mode Run -Trigger {1} -Time {2} -NightStart {3} -IdleMinutes {4} -WindowHours {5} ' +
     '-MediaGraceMinutes {6} -GraceSeconds {7}{8}') -f
        $ScriptPath, $TriggerKind, $Time, $NightStart, $IdleMinutes, $WindowHours,
        $MediaGraceMinutes, $GraceSeconds, $Extra
}

function Get-Task {
    param([string]$Name = $TaskName)
    Get-ScheduledTask -TaskName $Name -TaskPath $TaskPath -ErrorAction SilentlyContinue
}

# Export-ScheduledTask declares encoding="UTF-16"; XmlDocument.LoadXml rejects
# that on a .NET string, so drop the declaration before casting.
function Get-TaskXml {
    param([string]$Name = $TaskName)
    [xml](((Export-ScheduledTask -TaskName $Name -TaskPath $TaskPath) -replace '^\s*<\?xml.*?\?>', ''))
}

# --------------------------------------------------------------------------
# Modes
# --------------------------------------------------------------------------

function Invoke-Install {
    Assert-Admin
    $endTime = ([datetime]::ParseExact($Time, 'HH:mm', $null).AddHours($WindowHours)).ToString('HH:mm')
    Write-Log "installing '$TaskName' for $Time (idle ${IdleMinutes}m; night window $NightStart-$endTime)"

    Enable-WakeTimers
    Enable-TaskSchedulerLog | Out-Null

    # Naive StartBoundary == local time, re-evaluated nightly => DST-correct.
    $trigger = @"
    <CalendarTrigger>
      <StartBoundary>$((Get-Date).ToString('yyyy-MM-dd'))T$($Time):00</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>
"@
    $desc = "Shuts this PC down every night at $Time local time, unless it is in use. May wake the PC from sleep. Repair: powershell -File `"$ScriptPath`""
    $xml  = New-TaskXml -TriggerXml $trigger -Arguments (New-RunArguments) -Description $desc

    Register-ScheduledTask -Xml $xml -TaskName $TaskName -TaskPath $TaskPath -Force | Out-Null

    $sid = ([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value

    foreach ($n in @($LockTaskName, $ArmTaskName, $DisarmTaskName)) {
        if (Get-Task $n) { Unregister-ScheduledTask -TaskName $n -TaskPath $TaskPath -Confirm:$false }
    }

    if ($KeepAwakeFrom) {
        # Keep-awake strategy: stay awake through the evening so that at $Time
        # the PC is simply on and can shut down normally. Nothing here has to
        # win a race or survive Modern Standby.
        $armXml = New-TaskXml -TriggerXml (New-DailyTrigger $KeepAwakeFrom) -Arguments (New-ModeArguments 'Arm') `
            -Description "From $KeepAwakeFrom, stops the lid and the idle timer putting this PC to sleep, so the $Time shutdown can actually run. Undone by '$DisarmTaskName'."
        Register-ScheduledTask -Xml $armXml -TaskName $ArmTaskName -TaskPath $TaskPath -Force | Out-Null

        # Two triggers, because normal sleep behaviour must always come back:
        # 15 minutes after $Time for the night the PC stayed up, and at every
        # logon for the night it shut down.
        $disarmTriggers = (New-DailyTrigger ([datetime]::ParseExact($Time,'HH:mm',$null).AddMinutes(15).ToString('HH:mm'))) + @"

    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>$sid</UserId>
    </LogonTrigger>
"@
        $disarmXml = New-TaskXml -TriggerXml $disarmTriggers -Arguments (New-ModeArguments 'Disarm') `
            -Description "Restores normal lid-close and idle sleep after '$ArmTaskName'. Runs at every logon so sleep is never left disabled."
        Register-ScheduledTask -Xml $disarmXml -TaskName $DisarmTaskName -TaskPath $TaskPath -Force | Out-Null
        Write-Log "installed keep-awake: arm at $KeepAwakeFrom, shut down at $Time, disarm at logon and $Time+15m" 'ACT'
    } else {
        # Lock strategy: shut down when the session locks during the night
        # window, because the PC is still awake at that moment.
        $lockTrigger = @"
    <SessionStateChangeTrigger>
      <Enabled>true</Enabled>
      <UserId>$sid</UserId>
      <StateChange>SessionLock</StateChange>
    </SessionStateChangeTrigger>
"@
        $lockXml = New-TaskXml -TriggerXml $lockTrigger -Arguments (New-RunArguments -TriggerKind 'Lock') `
            -Description "Shuts this PC down when you lock it or close the lid between $NightStart and $endTime."
        Register-ScheduledTask -Xml $lockXml -TaskName $LockTaskName -TaskPath $TaskPath -Force | Out-Null
        Write-Log "installed '$LockTaskName' (fires on session lock, acts only $NightStart-$endTime)" 'ACT'
    }

    $info = Get-ScheduledTaskInfo -TaskName $TaskName -TaskPath $TaskPath
    Write-Log ('installed: next scheduled run {0}' -f $info.NextRunTime) 'ACT'
    Invoke-Status
}

function Invoke-Uninstall {
    Assert-Admin
    foreach ($n in @($TaskName, $LockTaskName, $ArmTaskName, $DisarmTaskName, $TestName)) {
        if (Get-Task $n) {
            Unregister-ScheduledTask -TaskName $n -TaskPath $TaskPath -Confirm:$false
            Write-Log "removed task '$n'" 'ACT'
        }
    }
    # Never leave sleep disabled behind us.
    if (Test-Armed) { Invoke-Disarm | Out-Null }
    Write-Log 'wake timers left enabled (harmless); sleep behaviour restored'
    0
}

function Get-Decision {
    # Lock state first and alone. It is the overnight case, it decides on its
    # own, and returning here skips the idle P/Invoke and the powercfg call -
    # latency that competes directly with the PC returning to standby.
    if (Test-SessionLocked) {
        return [pscustomobject]@{
            Decision = 'SHUTDOWN'; Reason = 'session is locked (asleep, or left locked)'
            IdleSeconds = -1; Locked = $true; DisplayRequest = $null
        }
    }

    $idle    = Get-IdleSeconds
    $display = Get-DisplayRequest

    # A wake lock means "someone is watching something" only if that someone is
    # still around. Held locks go stale - the League client keeps a Video Wake
    # Lock open for as long as it runs - so honour one only within MediaGrace.
    $mediaHold = $display -and ($idle -lt $MediaGraceMinutes * 60)

    if ($idle -lt 0)                     { $d = 'SKIP';     $why = 'idle time unavailable' }
    elseif ($mediaHold)                  { $d = 'SKIP';     $why = ('display wake lock held and last input was {0:N0}s ago: {1}' -f $idle, $display) }
    elseif ($idle -lt $IdleMinutes * 60) { $d = 'SKIP';     $why = ('last input {0:N0}s ago, under the {1}m threshold' -f $idle, $IdleMinutes) }
    else {
        $d = 'SHUTDOWN'; $why = ('idle {0:N1}m, at or over the {1}m threshold' -f ($idle/60), $IdleMinutes)
        if ($display) { $why += (' (ignoring a wake lock held with no input for over {0}m: {1})' -f $MediaGraceMinutes, $display) }
    }

    [pscustomobject]@{
        Decision = $d; Reason = $why; IdleSeconds = $idle
        Locked   = $false; DisplayRequest = $display
    }
}

# Issues the shutdown and hands back shutdown.exe's exit code. Deliberately
# tiny: on the fast lane, every millisecond spent before this call is a
# millisecond the hibernate can win.
function Start-Shutdown {
    param([int]$Grace)
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & shutdown.exe /s /f /t $Grace /c "A1 Auto Shutdown: nightly $Time shutdown."
        $LASTEXITCODE
    } finally { $ErrorActionPreference = $old }
}

function Invoke-Run {
    $now = Get-Date

    # Idle is per-session; session 0 has no input and would look idle forever.
    if ([Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) {
        Write-Log 'refusing to act from session 0 - user activity cannot be measured there' 'ERROR'
        return 3
    }

    # Only ever act in the stretch that starts at $Time. A run before it, or
    # more than $WindowHours after it, is a manual or morning catch-up run.
    $t      = [datetime]::ParseExact($Time, 'HH:mm', $null)
    $target = $now.Date.AddHours($t.Hour).AddMinutes($t.Minute)
    if ($now -lt $target) { $target = $target.AddDays(-1) }
    $sinceH = ($now - $target).TotalHours
    $late   = (-not $Force) -and ($sinceH -ge $WindowHours)
    $endTxt = ([datetime]::ParseExact($Time, 'HH:mm', $null).AddHours($WindowHours)).ToString('HH:mm')

    # ----------------------------- FAST LANE -----------------------------
    # On battery this machine surfaces from Modern Standby only to hibernate
    # ("Standby Battery Budget Exceeded"), and commits to that sleep about four
    # seconds in. On 2026-08-24 the shutdown was issued at +5s and lost by one.
    # A locked session already decides the outcome on its own, so decide on that
    # single cheap signal and issue the shutdown before anything else: no
    # Add-Type, no powercfg, no timezone lookup, and no log write - the log
    # lives in OneDrive and is not something to touch on the critical path.
    # Everything worth recording is written immediately afterwards.
    # ---------------------------- LOCK PATH ------------------------------
    # The reliable one. The user has just locked or closed the lid, so the PC is
    # awake, warm and able to shut down - measured at 0.9s from lock to trigger.
    # No countdown and no delay: closing the lid sleeps the machine within
    # seconds, and anything deferred past that point lands in the broken path.
    if ($Trigger -eq 'Lock') {
        $started = [Diagnostics.Process]::GetCurrentProcess().StartTime
        if (-not (Test-NightWindow $now)) {
            Write-Log ('run: {0} local | lock trigger' -f $now.ToString('yyyy-MM-dd HH:mm:ss'))
            Write-Log ('skip: locked at {0}, outside the {1}-{2} night window' -f $now.ToString('HH:mm'), $NightStart, $endTxt)
            return 0
        }
        if (-not (Test-SessionLocked)) {
            Write-Log ('run: {0} local | lock trigger' -f $now.ToString('yyyy-MM-dd HH:mm:ss'))
            Write-Log 'skip: already unlocked again - you came back' 'ACT'
            return 0
        }
        if ($DryRun) {
            Write-Log ('DRY RUN: lock path would shut down now ({0:N2}s after process start)' -f `
                ((Get-Date) - $started).TotalSeconds) 'ACT'
            return 0
        }
        $rc      = Start-Shutdown 0
        $elapsed = ((Get-Date) - $started).TotalSeconds
        Write-Log ('run: {0} local | lock trigger | night window {1}-{2}' -f $now.ToString('yyyy-MM-dd HH:mm:ss'), $NightStart, $endTxt)
        if ($rc -eq 0) {
            Write-Log ('lock path: locked for the night - shutdown issued {0:N2}s after process start' -f $elapsed) 'ACT'
            return 0
        }
        if ($rc -eq 1190) { Write-Log 'a shutdown was already pending' 'WARN'; return 0 }
        Write-Log ('lock path: shutdown.exe failed with exit code {0}' -f $rc) 'ERROR'
        return 3
    }

    # -------------------------- SCHEDULE PATH ----------------------------
    # Only useful while the PC is genuinely awake. If it has just surfaced from
    # Modern Standby, a shutdown cannot complete and would only queue up to
    # ambush the next boot, so refuse rather than leave that trap.
    # ...but only on battery. Refusing on AC would block the one configuration
    # where a midnight wake can actually work.
    if ((-not $Force) -and (Test-JustSurfaced) -and (Test-OnBattery)) {
        Write-Log ('run: {0} local | schedule trigger' -f $now.ToString('yyyy-MM-dd HH:mm:ss'))
        Write-Log 'skip: on battery and only just surfaced from Modern Standby. A shutdown issued now would not run - Windows would defer it and fire it at your next boot. The lock trigger covers this case instead.' 'WARN'
        return 0
    }
    # ---------------------------------------------------------------------

    $tz = Get-TimeZone
    Write-Log ('run: {0} local | {1} | DST in effect now: {2}' -f $now.ToString('yyyy-MM-dd HH:mm:ss'), $tz.Id, $tz.IsDaylightSavingTime($now))

    if ($UsedLegacyWindow) {
        Write-Log ('this task still passes the removed -WindowMinutes; ignoring it and using -WindowHours {0}. Re-run install to update the task.' -f $WindowHours) 'WARN'
    }

    if ($late) {
        Write-Log ('skip: {0:N1}h past the {1} trigger, outside the {2}h night window' -f $sinceH, $Time, $WindowHours)
        return 0
    }
    if ($sinceH -gt 0.25) {
        Write-Log ('note: running {0:N1}h late - the trigger was deferred, most likely by Modern Standby or hibernate' -f $sinceH) 'WARN'
    }

    $r = Get-Decision
    $idleTxt = if ($r.IdleSeconds -lt 0) { 'not measured (locked)' } else { '{0:N0}s' -f $r.IdleSeconds }
    Write-Log ('signals: idle={0} locked={1} display_request={2}' -f $idleTxt, $r.Locked, $(if ($r.DisplayRequest) { 'yes' } else { 'no' }))

    if ($r.Decision -eq 'SKIP') {
        Write-Log ('skip: PC is in use - {0}' -f $r.Reason) 'ACT'
        # Self-heal only on the path where the PC keeps running: a power-plan
        # change can turn wake timers back off. Skipped before a shutdown,
        # where the powercfg call would only add latency.
        if (Test-Admin) {
            $w = Get-WakeTimerSetting
            if (-not $w.Enabled) {
                Write-Log ('wake timers were off (AC={0} DC={1}) - re-enabling' -f $w.AC, $w.DC) 'WARN'
                Enable-WakeTimers
            }
        }
        return 0
    }
    # A countdown does not elapse while the PC is in Modern Standby - the
    # shutdown just sits pending, with its warning dialog, until someone opens
    # the lid. So no countdown when nobody could see it anyway, which is every
    # case where the session is locked. See the header for the 2026-08-23 trace.
    # Computed before the dry-run exit so a dry run reports the real grace.
    $grace = if ($r.Locked) { 0 } else { $GraceSeconds }
    if ($GraceSeconds -gt 0 -and $grace -eq 0) {
        Write-Log ('ignoring -GraceSeconds {0}: a countdown cannot elapse while the PC is asleep' -f $GraceSeconds)
    }

    if ($DryRun) {
        Write-Log ('DRY RUN: would shut down with grace {0}s - {1}' -f $grace, $r.Reason) 'ACT'
        return 0
    }

    # Awake-but-idle path only. Holding the system awake is worth it here,
    # where a countdown may have to elapse; on the fast lane it is not, because
    # the Add-Type it needs costs more time than the request buys.
    Set-KeepAwake
    Write-Log ("shutting down - {0} (grace {1}s)" -f $r.Reason, $grace) 'ACT'
    $rc = Start-Shutdown $grace
    if ($rc -ne 0) { Write-Log "shutdown.exe failed with exit code $rc" 'ERROR'; return 3 }
    0
}

function Invoke-Status {
    Write-Host ''
    Write-Host '=== A1 Auto Shutdown ===' -ForegroundColor Cyan
    if (-not (Get-Task)) {
        Write-Host "task           : NOT INSTALLED - repair with: powershell -File `"$ScriptPath`"" -ForegroundColor Red
        return 1
    }
    $task = Get-Task
    $info = Get-ScheduledTaskInfo -TaskName $TaskName -TaskPath $TaskPath
    $xml  = Get-TaskXml
    $ns   = @{ t = 'http://schemas.microsoft.com/windows/2004/02/mit/task' }
    $sb   = (Select-Xml -Xml $xml -Namespace $ns -XPath '//t:StartBoundary').Node.InnerText
    $tz   = Get-TimeZone
    $w    = Get-WakeTimerSetting
    $tzOk = $sb -notmatch '(Z|[+-]\d{2}:\d{2})$'

    Write-Host ('task           : {0}  ({1}{2})' -f $task.State, $task.TaskPath, $task.TaskName)
    Write-Host ('trigger        : daily at {0}  StartBoundary={1}' -f $sb.Substring(11,5), $sb)
    Write-Host ('local time     : {0} | DST now: {1} | DST-safe trigger: {2}' -f `
        $tz.Id, $tz.IsDaylightSavingTime((Get-Date)), $(if ($tzOk) { 'YES (no UTC offset stored)' } else { 'NO - reinstall' })) `
        -ForegroundColor $(if ($tzOk) { 'Green' } else { 'Red' })
    Write-Host ('next run       : {0}' -f $info.NextRunTime)
    Write-Host ('last run       : {0}  result=0x{1:X}' -f $info.LastRunTime, $info.LastTaskResult)
    # Task Scheduler drops any setting that equals its default, so an absent
    # node is not missing config - it is the documented default.
    $wanted = [ordered]@{
        WakeToRun                  = 'true'   # may wake the PC from sleep to run
        DisallowStartIfOnBatteries = 'false'  # must still run on battery
        StopIfGoingOnBatteries     = 'false'
        StartWhenAvailable         = 'true'   # retry a deferred/missed trigger...
        RunOnlyIfIdle              = 'false'
    }
    # ...which is safe only because Run enforces the night window itself.
    foreach ($k in $wanted.Keys) {
        $node = (Select-Xml -Xml $xml -Namespace $ns -XPath "//t:Settings/t:$k").Node
        $v    = if ($node) { $node.InnerText } else { 'false (default)' }
        $ok   = $v -like ($wanted[$k] + '*')
        Write-Host ('  {0,-27}: {1}{2}' -f $k, $v, $(if ($ok) { '' } else { '   <-- UNEXPECTED' })) `
            -ForegroundColor $(if ($ok) { 'Gray' } else { 'Red' })
    }
    Write-Host ('wake timers    : AC={0} DC={1} -> {2}' -f $w.AC, $w.DC, $(if ($w.Enabled) { 'ENABLED' } else { 'DISABLED - re-run install' })) `
        -ForegroundColor $(if ($w.Enabled) { 'Green' } else { 'Red' })
    if (Test-Admin) {
        Write-Host '  armed wake timer:'
        Write-Host (((Invoke-Native 'powercfg.exe' @('/waketimers')).Trim()) -replace '(?m)^', '    ')
    } else {
        Write-Host '  armed wake timer: (run as admin to list)'
    }
    # The retry settings are what cover a launch refused during a sleep
    # transition (0x800710E0), so a silent regression here must be visible.
    $rof = (Select-Xml -Xml $xml -Namespace $ns -XPath '//t:Settings/t:RestartOnFailure').Node
    Write-Host ('  {0,-27}: {1}' -f 'RestartOnFailure', $(if ($rof) { 'every {0}, up to {1} times' -f $rof.Interval, $rof.Count } else { 'NOT SET   <-- re-run install' })) `
        -ForegroundColor $(if ($rof) { 'Gray' } else { 'Red' })
    $endTime = ([datetime]::ParseExact($Time, 'HH:mm', $null).AddHours($WindowHours)).ToString('HH:mm')
    if ((Get-Task $ArmTaskName) -or (Get-Task $DisarmTaskName)) {
        Write-Host ('strategy       : KEEP AWAKE - arm {0}, shut down {1}, disarm at logon and {1}+15m' -f `
            $(if (Get-Task $ArmTaskName) { (Get-Task $ArmTaskName).State } else { 'MISSING' }), $Time) -ForegroundColor Green
        Write-Host ('  arm task     : {0}' -f $(if (Get-Task $ArmTaskName) { 'Ready' } else { 'MISSING - re-run install' }))
        Write-Host ('  disarm task  : {0}' -f $(if (Get-Task $DisarmTaskName) { 'Ready' } else { 'MISSING - re-run install' }))
        $armed = Test-Armed
        Write-Host ('  armed now    : {0}' -f $(if ($armed) { 'YES - lid close and idle sleep are disabled right now' } else { 'no - normal sleep behaviour' })) `
            -ForegroundColor $(if ($armed) { 'Yellow' } else { 'Gray' })
    } else {
        $lockTask = Get-Task $LockTaskName
        Write-Host ('lock task      : {0}' -f $(if ($lockTask) { "$($lockTask.State)  - fires on session lock, acts $NightStart-$endTime" } else { 'NOT INSTALLED' })) `
            -ForegroundColor $(if ($lockTask) { 'Green' } else { 'Red' })
        Write-Host ('night window   : {0} to {1}' -f $NightStart, $endTime)
    }
    Write-Host ('task event log : {0}' -f $(if (Test-TaskSchedulerLog) { 'enabled' } else { 'DISABLED - re-run install' })) `
        -ForegroundColor $(if (Test-TaskSchedulerLog) { 'Gray' } else { 'Red' })
    $r = Get-Decision
    Write-Host ('if it ran now  : {0} - {1}' -f $r.Decision, $r.Reason) -ForegroundColor Yellow
    Write-Host ('log            : {0}' -f $LogPath)
    Write-Host ''
    0
}

# Registers a throwaway copy of the task 90s out, in dry-run, and reports what
# Task Scheduler actually did. Proves the trigger/principal/session plumbing
# works without shutting anything down.
function Invoke-Test {
    Assert-Admin
    if (-not (Get-Task)) { Write-Log 'main task is not installed - run install first' 'ERROR'; return 1 }

    $fireAt  = (Get-Date).AddSeconds(90)
    $trigger = @"
    <TimeTrigger>
      <StartBoundary>$($fireAt.ToString('yyyy-MM-ddTHH:mm:ss'))</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
"@
    # -Force skips the wall-clock window so the decision logic itself runs.
    $xml = New-TaskXml -TriggerXml $trigger -Arguments (New-RunArguments -Extra ' -DryRun -Force') `
        -Description 'Temporary end-to-end check for A1 Auto Shutdown. Safe to delete.'

    $mark = if (Test-Path $LogPath) { (Get-Item $LogPath).Length } else { 0 }
    Register-ScheduledTask -Xml $xml -TaskName $TestName -TaskPath $TaskPath -Force | Out-Null
    Write-Log ('test task registered, fires at {0} - waiting...' -f $fireAt.ToString('HH:mm:ss')) 'ACT'

    try {
        $deadline = (Get-Date).AddSeconds(200)
        do {
            Start-Sleep -Seconds 5
            $ti = Get-ScheduledTaskInfo -TaskName $TestName -TaskPath $TaskPath
            $st = (Get-Task $TestName).State
        } while ((Get-Date) -lt $deadline -and ($ti.LastRunTime -lt $fireAt.AddSeconds(-5) -or $st -eq 'Running'))

        if ($ti.LastRunTime -lt $fireAt.AddSeconds(-5)) {
            Write-Log 'FAILED: Task Scheduler never ran the test task' 'ERROR'
            return 1
        }
        Write-Log ('test task ran at {0}, exit 0x{1:X}' -f $ti.LastRunTime, $ti.LastTaskResult) 'ACT'

        Write-Host '--- what that run logged ---' -ForegroundColor Cyan
        $fs = [IO.File]::Open($LogPath, 'Open', 'Read', 'ReadWrite')
        try {
            $fs.Seek($mark, 'Begin') | Out-Null
            $sr = New-Object IO.StreamReader($fs)
            Write-Host $sr.ReadToEnd().Trim()
        } finally { $fs.Close() }
        Write-Host '----------------------------' -ForegroundColor Cyan

        if ($ti.LastTaskResult -ne 0) {
            Write-Log ('FAILED: task exited 0x{0:X}' -f $ti.LastTaskResult) 'ERROR'
            return 1
        }
        Write-Log 'PASS: Task Scheduler ran the script in the user session and it reached a decision' 'ACT'
        return 0
    } finally {
        Unregister-ScheduledTask -TaskName $TestName -TaskPath $TaskPath -Confirm:$false -ErrorAction SilentlyContinue
        Write-Log 'test task removed'
    }
}

switch ($Mode) {
    'Install'   { exit (Invoke-Install) }
    'Uninstall' { exit (Invoke-Uninstall) }
    'Status'    { exit (Invoke-Status) }
    'Test'      { exit (Invoke-Test) }
    'Run'       { exit (Invoke-Run) }
    'Arm'       { exit (Invoke-Arm) }
    'Disarm'    { exit (Invoke-Disarm) }
}
