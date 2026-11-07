param(
  [Parameter(Mandatory = $true)][int]$Index
)

# One-shot "make the Nth virtual desktop active" (0-based, Task View order from the left).
# Called by the Electron main process when the user clicks a panel tab that layout.json
# binds to a desktop; the resident watcher does not do the switching, it only reports.
#
# We never create a desktop. If this build has fewer desktops than the index asked for,
# the line is "range|..." and the active desktop stays where it is.
#
# stdout is a single ASCII line for the caller to parse:
#   ok|index=N count=C desktop=<guid>   switched
#   noop|index=N                        already there (no desktop animation was triggered)
#   range|count=C want=N                fewer desktops than requested
#   failed|... / unavailable|...        the internal COM call did not work
#
# Exit codes: 0 = ok/noop, 1 = internal COM unavailable, 2 = refused or failed.

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'vdesktop-native.ps1')

$current = ([VDeskProbe.Desks]::Current()).Trim()
# ok|index=0 count=5 desktop=<guid> - one line, space-separated key=value pairs
if ($current -match 'index=(-?\d+)') {
  if ([int]$Matches[1] -eq $Index) {
    Write-Output ('noop|index=' + $Index)
    exit 0
  }
}

$result = ([VDeskProbe.Desks]::Switch($Index)).Trim()
Write-Output $result
switch ($result.Split('|')[0]) {
  'ok' { exit 0 }
  'unavailable' { exit 1 }
  default { exit 2 }
}
