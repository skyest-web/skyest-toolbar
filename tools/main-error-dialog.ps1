# Reads the Win32 "A JavaScript error occurred in the main process" dialog that Electron
# shows when the main process throws. The stack appears ONLY in that dialog: stdout/stderr
# stay empty and the CDP HTTP endpoint stops answering, so it looks like the app never started.
# Usage (Git Bash, project dir):
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/main-error-dialog.ps1
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, 'Error')
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
if ($null -eq $win) { Write-Output 'no Error window found'; exit }
$walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
function Dump($el, $depth) {
  $name = $el.Current.Name
  if ($name) { Write-Output ((' ' * $depth) + $el.Current.ControlType.ProgrammaticName + ' :: ' + $name) }
  $child = $walker.GetFirstChild($el)
  while ($null -ne $child) { Dump $child ($depth + 2); $child = $walker.GetNextSibling($child) }
}
Dump $win 0
