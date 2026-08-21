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
    [ValidateSet('Install','Uninstall','Status','Run','Test')]
    [string]$Mode = 'Install',

    # Local wall-clock time, 24h. DST-safe by construction (see above).
    [ValidatePattern('^([01][0-9]|2[0-3]):[0-5][0-9]$')]
    [string]$Time = '00:00',

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

    # Countdown before the shutdown; 'shutdown /a' cancels within it.
    [ValidateRange(0,600)]
    [int]$GraceSeconds = 20,

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

$TaskName   = 'A1 Auto Shutdown'
$TaskPath   = '\A1\'
$TestName   = 'A1 Auto Shutdown Verify'
$ScriptPath = $MyInvocation.MyCommand.Path
$ScriptDir  = Split-Path -Parent $ScriptPath
$LogPath    = Join-Path $ScriptDir 'auto-shutdown.log'

# Power setting: Sleep > Allow wake timers. 1 = Enable. (2 = "important timers
# only", which excludes Task Scheduler; 0 = Disable, the default found here.)
$SUB_SLEEP = '238C9FA8-0AAD-41ED-83F4-97BE242C8F20'
$RTCWAKE   = 'BD3B718A-0680-4D9D-8AB2-E1D2B4AC806D'

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
    $a  = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -Mode {1} -Time {2}' -f $ScriptPath, $Mode, $Time
    $a += ' -IdleMinutes {0} -WindowHours {1} -MediaGraceMinutes {2} -GraceSeconds {3} -NoElevate' -f $IdleMinutes, $WindowHours, $MediaGraceMinutes, $GraceSeconds
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
function Get-IdleSeconds {
    if (-not ('A1.Idle' -as [type])) {
        # No -UsingNamespace here: Add-Type already emits a using for
        # System.Runtime.InteropServices, and the duplicate is a warning-as-error.
        Add-Type -Namespace 'A1' -Name 'Idle' -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)]
public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
[DllImport("user32.dll")]
private static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
[DllImport("kernel32.dll")]
private static extern uint GetTickCount();
public static double Seconds() {
    LASTINPUTINFO lii = new LASTINPUTINFO();
    lii.cbSize = (uint)Marshal.SizeOf(lii);
    if (!GetLastInputInfo(ref lii)) { return -1.0; }
    // unchecked uint subtraction stays correct across the 49.7-day tick wrap
    return (double)(GetTickCount() - lii.dwTime) / 1000.0;
}
'@
    }
    [A1.Idle]::Seconds()
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

function New-RunArguments {
    param([string]$Extra = '')
    ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" ' +
     '-Mode Run -Time {1} -IdleMinutes {2} -WindowHours {3} -MediaGraceMinutes {4} -GraceSeconds {5}{6}') -f
        $ScriptPath, $Time, $IdleMinutes, $WindowHours, $MediaGraceMinutes, $GraceSeconds, $Extra
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
    Write-Log "installing '$TaskName' for $Time (idle threshold ${IdleMinutes}m, night window ${WindowHours}h)"

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

    $info = Get-ScheduledTaskInfo -TaskName $TaskName -TaskPath $TaskPath
    Write-Log ('installed: next run {0}' -f $info.NextRunTime) 'ACT'
    Invoke-Status
}

function Invoke-Uninstall {
    Assert-Admin
    foreach ($n in @($TaskName, $TestName)) {
        if (Get-Task $n) {
            Unregister-ScheduledTask -TaskName $n -TaskPath $TaskPath -Confirm:$false
            Write-Log "removed task '$n'" 'ACT'
        }
    }
    Write-Log 'wake timers left enabled (harmless); no other system changes were made'
    0
}

function Get-Decision {
    $idle    = Get-IdleSeconds
    $locked  = Test-SessionLocked
    $display = if ($locked) { $null } else { Get-DisplayRequest }

    # A wake lock means "someone is watching something" only if that someone is
    # still around. Held locks go stale - the League client keeps a Video Wake
    # Lock open for as long as it runs - so honour one only within MediaGrace.
    $mediaHold = $display -and ($idle -lt $MediaGraceMinutes * 60)

    if ($idle -lt 0)                     { $d = 'SKIP';     $why = 'idle time unavailable' }
    elseif ($locked)                     { $d = 'SHUTDOWN'; $why = 'session is locked (asleep, or left locked)' }
    elseif ($mediaHold)                  { $d = 'SKIP';     $why = ('display wake lock held and last input was {0:N0}s ago: {1}' -f $idle, $display) }
    elseif ($idle -lt $IdleMinutes * 60) { $d = 'SKIP';     $why = ('last input {0:N0}s ago, under the {1}m threshold' -f $idle, $IdleMinutes) }
    else {
        $d = 'SHUTDOWN'; $why = ('idle {0:N1}m, at or over the {1}m threshold' -f ($idle/60), $IdleMinutes)
        if ($display) { $why += (' (ignoring a wake lock held with no input for over {0}m: {1})' -f $MediaGraceMinutes, $display) }
    }

    [pscustomobject]@{
        Decision = $d; Reason = $why; IdleSeconds = $idle
        Locked   = $locked; DisplayRequest = $display
    }
}

function Invoke-Run {
    $now = Get-Date
    $tz  = Get-TimeZone
    Write-Log ('run: {0} local | {1} | DST in effect now: {2}' -f $now.ToString('yyyy-MM-dd HH:mm:ss'), $tz.Id, $tz.IsDaylightSavingTime($now))

    # Idle is per-session; session 0 has no input and would look idle forever.
    $sid = [Diagnostics.Process]::GetCurrentProcess().SessionId
    if ($sid -eq 0) {
        Write-Log 'refusing to act from session 0 - user activity cannot be measured there' 'ERROR'
        return 3
    }

    if ($UsedLegacyWindow) {
        Write-Log ('this task still passes the removed -WindowMinutes; ignoring it and using -WindowHours {0}. Re-run install to update the task.' -f $WindowHours) 'WARN'
    }

    # Only ever act in the stretch that starts at $Time. A run before it, or
    # more than $WindowHours after it, is a manual or morning catch-up run.
    $t      = [datetime]::ParseExact($Time, 'HH:mm', $null)
    $target = $now.Date.AddHours($t.Hour).AddMinutes($t.Minute)
    if ($now -lt $target) { $target = $target.AddDays(-1) }
    $sinceH = ($now - $target).TotalHours
    if (-not $Force -and $sinceH -ge $WindowHours) {
        Write-Log ('skip: {0:N1}h past the {1} trigger, outside the {2}h night window' -f $sinceH, $Time, $WindowHours)
        return 0
    }
    if ($sinceH -gt 0.25) {
        Write-Log ('note: running {0:N1}h late - the trigger was deferred, most likely by Modern Standby' -f $sinceH) 'WARN'
    }

    # Self-heal: a power-plan change or reset can turn wake timers back off.
    if (Test-Admin) {
        $w = Get-WakeTimerSetting
        if (-not $w.Enabled) {
            Write-Log ('wake timers were off (AC={0} DC={1}) - re-enabling' -f $w.AC, $w.DC) 'WARN'
            Enable-WakeTimers
        }
    }

    $r = Get-Decision
    Write-Log ('signals: idle={0:N0}s locked={1} display_request={2}' -f $r.IdleSeconds, $r.Locked, $(if ($r.DisplayRequest) { 'yes' } else { 'no' }))

    if ($r.Decision -eq 'SKIP') {
        Write-Log ('skip: PC is in use - {0}' -f $r.Reason) 'ACT'
        return 0
    }
    if ($DryRun) {
        Write-Log ('DRY RUN: would shut down - {0}' -f $r.Reason) 'ACT'
        return 0
    }

    Write-Log ("shutting down - {0} (grace {1}s; 'shutdown /a' cancels)" -f $r.Reason, $GraceSeconds) 'ACT'
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & shutdown.exe /s /f /t $GraceSeconds /c "A1 Auto Shutdown: nightly $Time shutdown. Run 'shutdown /a' to cancel."
        $rc = $LASTEXITCODE
    } finally { $ErrorActionPreference = $old }
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
    Write-Host ('night window   : {0} to {1:HH\:mm} ({2}h) - a deferred run still shuts down, a morning one cannot' -f `
        $Time, ([datetime]::ParseExact($Time,'HH:mm',$null)).AddHours($WindowHours), $WindowHours)
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
}
