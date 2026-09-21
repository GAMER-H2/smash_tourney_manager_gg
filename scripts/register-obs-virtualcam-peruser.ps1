<#
.SYNOPSIS
    Registers the OBS Virtual Camera DirectShow filter for the current user
    only, with no administrator rights.

.DESCRIPTION
    OBS Virtual Camera is not a kernel driver - it is a DirectShow filter in
    obs-virtualcam-module64.dll. OBS's own virtualcam-install.bat registers it
    machine-wide under HKLM, which needs elevation and is why portable OBS on a
    locked-down tournament account has no virtual camera.

    COM registration goes through HKEY_CLASSES_ROOT, which is a merged view of
    HKLM\Software\Classes and HKCU\Software\Classes. Writes to HKCR normally
    land in HKLM, but when a key already exists under HKCU\Software\Classes,
    HKCR resolves to the per-user copy and the write lands there instead. So
    pre-creating the filter's keys under HKCU and then running regsvr32 gets a
    per-user registration out of an installer that was never written for one.

    Run this once per Windows account, from the account that will run OBS. It
    needs no elevation. Re-run it if OBS is moved or updated.

.PARAMETER ObsDirectory
    Root of the portable OBS install - the folder containing bin\ and
    obs-plugins\. Defaults to searching the usual portable locations.

.PARAMETER Unregister
    Remove the per-user registration instead of creating it.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\register-obs-virtualcam-peruser.ps1 -ObsDirectory "$HOME\Documents\obs-studio"

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\register-obs-virtualcam-peruser.ps1 -Unregister
#>

[CmdletBinding()]
param(
    [string] $ObsDirectory,
    [switch] $Unregister
)

$ErrorActionPreference = 'Stop'

# The OBS Virtual Camera source filter, and the DirectShow video capture
# category it has to appear under for apps to enumerate it as a camera.
$FilterClsid   = '{A3FCE0F5-3493-419F-958A-ABA1250EC20B}'
$CaptureClsid  = '{860BB310-5D01-11d0-BD3B-00A0C911CE86}'

$ClassesRoot   = 'HKCU:\Software\Classes'
$FilterKey     = "$ClassesRoot\CLSID\$FilterClsid"
$InstanceKey   = "$ClassesRoot\CLSID\$CaptureClsid\Instance\$FilterClsid"

function Find-VirtualCamModule {
    param([string] $Root)

    $candidates = @()
    if ($Root) {
        $candidates += $Root
    } else {
        $candidates += @(
            (Join-Path $HOME 'Documents\obs-studio'),
            (Join-Path $HOME 'Documents\OBS'),
            (Join-Path $HOME 'Desktop\obs-studio'),
            (Join-Path $HOME 'obs-studio'),
            'C:\Program Files\obs-studio'
        )
    }

    foreach ($candidate in $candidates) {
        if (-not (Test-Path -LiteralPath $candidate)) { continue }
        $module = Get-ChildItem -LiteralPath $candidate -Recurse -Filter 'obs-virtualcam-module64.dll' `
            -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($module) { return $module.FullName }
    }

    return $null
}

if ($Unregister) {
    foreach ($key in @($InstanceKey, $FilterKey)) {
        if (Test-Path -LiteralPath $key) {
            Remove-Item -LiteralPath $key -Recurse -Force
            Write-Host "Removed $key"
        } else {
            Write-Host "Not present: $key"
        }
    }
    Write-Host ''
    Write-Host 'Per-user OBS Virtual Camera registration removed. Restart OBS and'
    Write-Host 'Main Tourney Manager for the change to take effect.'
    return
}

$module = Find-VirtualCamModule -Root $ObsDirectory
if (-not $module) {
    throw @'
Could not find obs-virtualcam-module64.dll.

Pass the portable OBS folder explicitly, for example:
  -ObsDirectory "$HOME\Documents\obs-studio"

That folder is the one containing bin\ and obs-plugins\.
'@
}

Write-Host "Using virtual camera module: $module"

# Pre-creating these under HKCU is the whole trick: it is what makes
# regsvr32's HKCR writes resolve to the per-user hive instead of failing
# against HKLM without elevation.
foreach ($key in @($FilterKey, $InstanceKey)) {
    if (-not (Test-Path -LiteralPath $key)) {
        New-Item -Path $key -Force | Out-Null
        Write-Host "Created $key"
    }
}

# /n suppresses DllRegisterServer, /i:"1" calls DllInstall the same way OBS's
# own virtualcam-install.bat does.
$regsvr = Join-Path $env:SystemRoot 'System32\regsvr32.exe'
$process = Start-Process -FilePath $regsvr `
    -ArgumentList @('/s', '/n', '/i:"1"', "`"$module`"") `
    -Wait -PassThru -NoNewWindow

if ($process.ExitCode -ne 0) {
    throw "regsvr32 failed with exit code $($process.ExitCode). The DLL path or the OBS build may not support DllInstall."
}

$registeredPath = (Get-ItemProperty -LiteralPath "$FilterKey\InprocServer32" -ErrorAction SilentlyContinue).'(default)'
if (-not $registeredPath) {
    throw @'
regsvr32 reported success but nothing was written under HKCU. The registration
most likely went to HKLM (and was silently dropped) - this OBS build's
DllInstall may not honour the per-user path. Fall back to the capture-card
preview mode in Main Tourney Manager.
'@
}

Write-Host ''
Write-Host "Registered for this user only: $registeredPath"
Write-Host ''
Write-Host 'Next steps:'
Write-Host '  1. Start portable OBS and click Start Virtual Camera.'
Write-Host '  2. Start Main Tourney Manager and pick "OBS Virtual Camera" in the'
Write-Host '     preview panel dropdown. Click Refresh if it is not listed yet.'
Write-Host ''
Write-Host 'Nothing was written outside your own user account, and nothing was'
Write-Host 'installed as a service. Re-run with -Unregister to undo.'
