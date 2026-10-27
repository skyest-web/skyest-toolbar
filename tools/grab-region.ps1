# Grab a screen rectangle (physical pixels) into a PNG. ASCII-only on purpose:
# Windows PowerShell 5.1 mis-decodes UTF-8-without-BOM scripts and the parser blows up.
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\grab-region.ps1 -X 1707 -Y 0 -W 1920 -H 550 -Out samples\shot.png
param(
  [int]$X = 0,
  [int]$Y = 0,
  [int]$W = 800,
  [int]$H = 600,
  [string]$Out = "shot.png"
)

Add-Type -AssemblyName System.Drawing

# PowerShell starts as DPI-unaware, so Windows virtualizes the coordinates on a scaled
# primary monitor and the grabbed rect lands in the wrong place. Declaring ourselves
# DPI-aware makes our pixels match Electron's DIPs on a 1x display.
if (-not ('Win32.Dpi' -as [type])) {
  Add-Type -Namespace Win32 -Name Dpi -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
}
[void][Win32.Dpi]::SetProcessDPIAware()

$target = $Out
if (-not [System.IO.Path]::IsPathRooted($target)) {
  $target = Join-Path (Get-Location) $Out
}
$parent = Split-Path -Parent $target
if ($parent -and -not (Test-Path $parent)) {
  New-Item -ItemType Directory -Path $parent | Out-Null
}

$bitmap = New-Object System.Drawing.Bitmap $W, $H
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($X, $Y, 0, 0, (New-Object System.Drawing.Size $W, $H))
$graphics.Dispose()
$bitmap.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()

Write-Output $target
