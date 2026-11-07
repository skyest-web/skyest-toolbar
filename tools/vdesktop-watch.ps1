param(
  [long]$Hwnd = 0,
  [string]$TitleMatch = 'Toolbar',
  [int]$IntervalMs = 800,
  [switch]$PretendOff,
  [int]$PretendAfterS = 5,
  [int]$PretendDesk = -1,
  [int]$PretendDeskAfterS = 5
)

# Watcher for "the toolbar follows the active virtual desktop".
#
# It only ever READS: IsWindowOnCurrentVirtualDesktop works cross-process, while
# MoveWindowToDesktop on a window owned by another process returns E_ACCESSDENIED.
# So the decision and the fix live in the Electron main process, which reacts to the
# "off" line by destroying and recreating the window (a fresh window lands on whatever
# desktop is active).
#
# stdout protocol, one ASCII line per event:
#   start|...              handshake
#   on|hwnd / off|hwnd     the toolbar window is / is not on the current desktop
#   hwnd|hwnd              the handle changed (the window was recreated) - info only
#   gone|0                 no toolbar window at all (it is mid-recreation)
#   desk|N count=C         the active virtual desktop is the Nth (0-based, Task View
#                          order) - only emitted when the internal API answers, and only
#                          on change; this is what lets a desktop switch move the panel
#   err|hr=XXXXXXXX ...    the COM read failed this round (transient)
#   fatal|...              give up; the caller should stop watching
#
# Events are emitted on state *changes* only, so one desktop switch produces exactly
# one "off" no matter how long the recreation takes.

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'vdesktop-native.ps1')

function Emit([string]$line) {
  [Console]::Out.WriteLine($line)
  [Console]::Out.Flush()
}

Emit ("start|hwnd=" + $Hwnd + " title=" + $TitleMatch + " interval=" + $IntervalMs + " pretend=" + [bool]$PretendOff)

$pretendAt = (Get-Date).AddSeconds($PretendAfterS)
$pretendDone = $false
$pretendDeskAt = (Get-Date).AddSeconds($PretendDeskAfterS)
$lastState = ''
$lastDetail = ''
# -2 so the very first real reading always reports, even when desktop 0 is active.
$lastDeskIndex = -2

while ($true) {
  $line = [VDeskProbe.Probe]::Poll([IntPtr]$Hwnd, $TitleMatch)
  $parts = $line.Split('|', 2)
  $state = $parts[0]
  $detail = if ($parts.Length -gt 1) { $parts[1] } else { '' }

  if ($state -eq 'unavailable') {
    Emit ("fatal|" + $detail)
    exit 1
  }

  # Once the title fallback resolves a live handle, latch onto it: the cheap
  # IsWindow path is restored and later polls stop walking every top-level window.
  if ($state -eq 'on' -or $state -eq 'off') {
    $resolved = [long]$detail.Trim()
    if ($resolved -ne $Hwnd) {
      $Hwnd = $resolved
      Emit ("hwnd|" + $resolved)
    }
  }

  if ($PretendOff -and -not $pretendDone -and (Get-Date) -ge $pretendAt) {
    $pretendDone = $true
    Emit ("off|" + $detail + " pretend=1")
    $lastState = 'off'
    $lastDetail = $detail
  }
  elseif (($state -ne $lastState) -or ($detail -ne $lastDetail)) {
    $lastState = $state
    $lastDetail = $detail
    Emit ($state + '|' + $detail)
  }

  # Which desktop is active. The internal API is the only thing that can answer this,
  # and it is the same one the panel->desktop switch uses; when it says -1 (a Windows
  # update moved the vtable, explorer is mid-restart) we simply stop reporting desktops
  # and the follow half above keeps working.
  $deskCount = 0
  $deskIndex = [VDeskProbe.Desks]::CurrentIndex([ref]$deskCount)
  # -PretendDesk N: from PretendDeskAfterS on, keep reporting "desktop N is active"
  # without touching the real desktops, so the desktop->panel half of the binding can
  # be exercised on its own. It sticks (rather than firing once) because the app is
  # supposed to land on that panel and stay there.
  if ($PretendDesk -ge 0 -and (Get-Date) -ge $pretendDeskAt) { $deskIndex = $PretendDesk }
  if ($deskIndex -ge 0 -and $deskIndex -ne $lastDeskIndex) {
    $lastDeskIndex = $deskIndex
    Emit ('desk|' + $deskIndex + ' count=' + $deskCount)
  }

  Start-Sleep -Milliseconds $IntervalMs
}
