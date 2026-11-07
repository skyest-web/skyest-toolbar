param(
  [string]$TitleMatch = 'Toolbar',
  [switch]$TryMove,
  [switch]$SelfTest,
  [switch]$Poll,
  [switch]$List,
  [switch]$Current
)

# Self-check for the "toolbar follows the active virtual desktop" feature.
# Reads state only unless -TryMove is passed. Exit codes:
#   0 = every COM call returned S_OK
#   1 = the COM object is unavailable on this build
#   2 = the API resolved but at least one call failed (HRESULT is printed)
#
# -Poll runs the exact one-shot read the watcher uses, so the follow path can be
# exercised without opening a second virtual desktop.
#
# -List / -Current read the INTERNAL interface (the one that can actually switch
# desktops) and are the gate before the panel<->desktop binding is wired up:
#   -List      prints count/list/current/currentId plus one "desk|I|guid|current"
#              line per desktop, and cross-checks currentId against the public
#              API's answer for the foreground window ("cross=match" is the pass).
#   -Current   prints the 0-based index of the active desktop, which is what the
#              watcher reports back to the main process.

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'vdesktop-native.ps1')

if ($SelfTest) {
  $result = [VDeskProbe.Probe]::SelfTest()
} elseif ($Poll) {
  $line = [VDeskProbe.Probe]::Poll([IntPtr]0, $TitleMatch)
  $parts = $line.Split('|', 2)
  Write-Output ("poll|state=" + $parts[0] + " detail=" + $parts[1])
  if ($parts[0] -eq 'on' -or $parts[0] -eq 'off') { exit 0 }
  exit 2
} elseif ($List) {
  $result = [VDeskProbe.Desks]::List()
} elseif ($Current) {
  $result = [VDeskProbe.Desks]::Current()
} else {
  $result = [VDeskProbe.Probe]::Run($TitleMatch, [bool]$TryMove)
}

$parts = $result.Split('|', 2)
Write-Output $parts[1]
switch ($parts[0]) {
  'ok' { exit 0 }
  'unavailable' { exit 1 }
  default { exit 2 }
}
