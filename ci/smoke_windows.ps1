# Smoke test the built Windows bundle the way a person receives the portable
# zip: every library stamped with the mark of the web. Three things must hold,
# in order, or the build is wrong:
#
#   1. With the mark kept (a CI-only knob), the app cannot start. This is the
#      control run: it reproduces the 1.9.5 launch crash, so the passing run
#      after it is evidence rather than luck.
#   2. Allowed to clear its own mark, the app starts, the embedded server
#      answers, the real page loads and the home view renders (search box and
#      content present). A screenshot is taken while it holds the window open.
#   3. The mark is gone from the runtime library afterwards.
#
# Usage: pwsh ci/smoke_windows.ps1 [path\to\Zimi.exe]
# Writes zimi-windows-smoke.png next to the logs for the workflow to upload.
param([string]$Exe = "dist/Zimi/Zimi.exe")
$ErrorActionPreference = "Stop"
$runtimeDll = Join-Path (Split-Path $Exe) "_internal/pythonnet/runtime/Python.Runtime.dll"

function Stamp-Mark {
  $n = 0
  Get-ChildItem -Path (Split-Path $Exe) -Recurse -Include *.dll,*.exe | ForEach-Object {
    Set-Content -Path $_.FullName -Stream Zone.Identifier -Value "[ZoneTransfer]`r`nZoneId=3"; $n++
  }
  Write-Host "stamped $n libraries with the mark of the web"
}

function Start-Smoke([string]$label) {
  $out = "smoke_$label.out.log"; $err = "smoke_$label.err.log"
  $p = Start-Process -FilePath $Exe -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
  return @{ proc = $p; out = $out; err = $err }
}

function Finish-Smoke($run, [string]$label, [int]$timeoutMs) {
  if (-not $run.proc.WaitForExit($timeoutMs)) { try { $run.proc.Kill() } catch {}; Write-Host "${label}: timed out"; $code = 124 }
  else { $code = [int]$run.proc.ExitCode }
  Write-Host "--- $label stdout ---"; Get-Content $run.out -ErrorAction SilentlyContinue | Out-Host
  Write-Host "--- $label stderr ---"; Get-Content $run.err -ErrorAction SilentlyContinue | Out-Host
  return $code
}

function Save-Screenshot([string]$path) {
  # Evidence, not a gate: a runner without a desktop must not fail a build
  # the app has already passed.
  try {
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Windows.Forms
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host "screenshot: $path ($($b.Width)x$($b.Height))"
  } catch { Write-Host "screenshot not taken: $_" }
}

# 1. Control: the marked bundle must fail to start.
Stamp-Mark
$env:ZIMI_DESKTOP_SMOKE = '1'
$env:ZIMI_DESKTOP_KEEP_MARK = '1'
$control = Finish-Smoke (Start-Smoke "marked") "marked" 120000
Remove-Item Env:ZIMI_DESKTOP_KEEP_MARK
if ($control -eq 0) { throw "control run: the marked bundle started anyway, so this test proves nothing" }
if (-not (Get-Item $runtimeDll -Stream Zone.Identifier -ErrorAction SilentlyContinue)) { throw "control run cleared the mark; the knob is not being honoured" }
Write-Host "control run failed as expected (exit $control) with the mark kept"

# 2. The real thing: the app clears the mark, starts, and renders its home view.
$env:ZIMI_DESKTOP_SMOKE = 'app'
$env:ZIMI_DESKTOP_SMOKE_DWELL = '10'
$run = Start-Smoke "app"
# The app's own budget is up to 60s for the server, 10s for the page and
# 60s for the view, so the watcher waits longer than that and the verdict
# is re-read from the log after exit rather than latched mid-way.
$deadline = (Get-Date).AddSeconds(150)
$rendered = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 500
  if (Select-String -Path $run.out -Pattern 'SMOKE: app rendered' -Quiet -ErrorAction SilentlyContinue) { $rendered = $true; break }
  if ($run.proc.HasExited) { break }
}
if ($rendered) { Start-Sleep -Seconds 2 }
# Either way: the picture of a failure is the point of taking one.
Save-Screenshot (Join-Path (Get-Location) "zimi-windows-smoke.png")
$code = Finish-Smoke $run "app" 60000
if (-not $rendered) { $rendered = [bool](Select-String -Path $run.out -Pattern 'SMOKE: app rendered' -Quiet -ErrorAction SilentlyContinue) }
if (-not $rendered) { throw "the app never reported a rendered home view (exit $code)" }
if ($code -ne 0) { throw "the app rendered but exited $code" }
if (Get-Item $runtimeDll -Stream Zone.Identifier -ErrorAction SilentlyContinue) { throw "the mark is still on Python.Runtime.dll after a successful start" }
Write-Host "a marked portable bundle clears its own mark, starts, and renders its home view"
