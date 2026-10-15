<#
.SYNOPSIS
    Registers the OBS Virtual Camera DirectShow filter for the current user
    only, with no administrator rights.

.DESCRIPTION
    OBS Virtual Camera is not a kernel driver - it is a DirectShow filter in
    obs-virtualcam-module64.dll. OBS's own virtualcam-install.bat registers it
<<<<<<< Updated upstream
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
=======
    machine-wide under HKLM via regsvr32, which needs elevation and is why
    portable OBS on a locked-down tournament account has no virtual camera.

    A COM in-process server is just a handful of registry values, and
    HKEY_CLASSES_ROOT is a merged view of HKLM\Software\Classes and
    HKCU\Software\Classes. Writing those values under HKCU ourselves gives the
    filter a per-user registration that every DirectShow client resolves
    normally - no elevation, nothing outside this user account.

    We write the keys directly rather than calling regsvr32. regsvr32 cannot be
    talked into a per-user registration here: the DLL's DllRegisterServer comes
    from strmbase, which *deletes* HKCR\CLSID\{filter} before recreating it. The
    delete removes any key pre-created under HKCU, so the recreate falls through
    to HKLM, is denied, and the whole call fails with E_FAIL - regsvr32 exit
    code 5. See docs\no-admin-obs-virtual-camera.md.

    By default the module DLLs are copied to
    %LOCALAPPDATA%\MainTourneyManager\virtualcam and registered from there, so
    the registration does not depend on a mapped network drive (a roaming
    Z:\ home drive is not visible to every process that loads the filter).

    Run this once per Windows account, from the account that will run OBS, and
    before starting OBS - OBS decides whether to enable "Start Virtual Camera"
    when it launches. Re-run it if OBS is moved or updated.

.PARAMETER ObsDirectory
    Root of the portable OBS install - the folder containing bin\ and
    obs-plugins\. Defaults to a running OBS instance, then the usual portable
    locations.

.PARAMETER InPlace
    Register the DLLs where they sit inside the OBS folder instead of copying
    them to %LOCALAPPDATA%. Only do this if OBS lives on a local drive.
>>>>>>> Stashed changes

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
<<<<<<< Updated upstream
=======
    [switch] $InPlace,
>>>>>>> Stashed changes
    [switch] $Unregister
)

$ErrorActionPreference = 'Stop'

# The OBS Virtual Camera source filter, and the DirectShow video capture
# category it has to appear under for apps to enumerate it as a camera.
<<<<<<< Updated upstream
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
=======
$FilterClsid  = '{A3FCE0F5-3493-419F-958A-ABA1250EC20B}'
$CaptureClsid = '{860BB310-5D01-11d0-BD3B-00A0C911CE86}'
$FilterName   = 'OBS Virtual Camera'

# Where a copy of the module lives when we are not registering it in place.
$LocalModuleDir = Join-Path $env:LOCALAPPDATA 'MainTourneyManager\virtualcam'

# 64-bit COM reads HKCU\Software\Classes; 32-bit COM reads the Wow6432Node
# fork of it. Registering both means 32-bit DirectShow apps see the camera too.
$ClassRoots = @(
    [pscustomobject]@{ Bits = 64; Path = 'HKCU:\Software\Classes\CLSID';             Module = 'obs-virtualcam-module64.dll' }
    [pscustomobject]@{ Bits = 32; Path = 'HKCU:\Software\Classes\Wow6432Node\CLSID'; Module = 'obs-virtualcam-module32.dll' }
)

function Get-ObsRoot {
    param([string] $Explicit)

    if ($Explicit) {
        if (-not (Test-Path -LiteralPath $Explicit)) {
            throw "No such folder: $Explicit"
        }
        return (Resolve-Path -LiteralPath $Explicit).Path
    }

    # A running OBS is the most reliable answer, and costs nothing to ask.
    $running = Get-Process -Name 'obs64', 'obs32' -ErrorAction SilentlyContinue |
        Where-Object { $_.Path } | Select-Object -First 1
    if ($running) {
        # ...\bin\64bit\obs64.exe -> ...
        $root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $running.Path))
        if (Test-Path -LiteralPath (Join-Path $root 'data\obs-plugins\win-dshow')) {
            return $root
        }
    }

    $candidates = @(
        (Join-Path $HOME 'Documents\obs-studio'),
        (Join-Path $HOME 'Documents\OBS'),
        (Join-Path $HOME 'Documents\stream_setup\obs'),
        (Join-Path $HOME 'Desktop\obs-studio'),
        (Join-Path $HOME 'obs-studio'),
        'C:\Program Files\obs-studio'
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath (Join-Path $candidate 'data\obs-plugins\win-dshow')) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
>>>>>>> Stashed changes
    }

    return $null
}

<<<<<<< Updated upstream
if ($Unregister) {
    foreach ($key in @($InstanceKey, $FilterKey)) {
        if (Test-Path -LiteralPath $key) {
            Remove-Item -LiteralPath $key -Recurse -Force
            Write-Host "Removed $key"
        } else {
            Write-Host "Not present: $key"
=======
function Set-Value {
    param([string] $Key, [string] $Name, [string] $Value)

    if (-not (Test-Path -LiteralPath $Key)) { New-Item -Path $Key -Force | Out-Null }
    New-ItemProperty -LiteralPath $Key -Name $Name -Value $Value -PropertyType String -Force | Out-Null
}

function Test-FilterCreatable {
    # The registration is only real if COM can actually build the filter out of
    # it, so ask COM rather than trusting that the values look right.
    try {
        $type = [Type]::GetTypeFromCLSID([Guid] $FilterClsid, $false)
        if (-not $type) { return $false }
        $obj = [Activator]::CreateInstance($type)
        if (-not $obj) { return $false }
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($obj)
        return $true
    } catch {
        Write-Verbose "CoCreateInstance failed: $($_.Exception.Message)"
        return $false
    }
}

if ($Unregister) {
    foreach ($root in $ClassRoots) {
        foreach ($key in @("$($root.Path)\$CaptureClsid\Instance\$FilterClsid", "$($root.Path)\$FilterClsid")) {
            if (Test-Path -LiteralPath $key) {
                Remove-Item -LiteralPath $key -Recurse -Force
                Write-Host "Removed $key"
            }
        }
    }
    if (Test-Path -LiteralPath $LocalModuleDir) {
        try {
            Remove-Item -LiteralPath $LocalModuleDir -Recurse -Force
            Write-Host "Removed $LocalModuleDir"
        } catch {
            # Something still has the filter loaded (OBS, a browser, the app).
            # The registration is already gone, which is what matters.
            Write-Warning "Could not delete $LocalModuleDir - it is still in use. Delete it by hand after closing OBS and anything that opened the camera."
>>>>>>> Stashed changes
        }
    }
    Write-Host ''
    Write-Host 'Per-user OBS Virtual Camera registration removed. Restart OBS and'
    Write-Host 'Main Tourney Manager for the change to take effect.'
    return
}

<<<<<<< Updated upstream
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
=======
$obsRoot = Get-ObsRoot -Explicit $ObsDirectory
if (-not $obsRoot) {
    throw @'
Could not find the portable OBS folder.

Pass it explicitly, for example:
  -ObsDirectory "$HOME\Documents\obs-studio"

That folder is the one containing bin\ and obs-plugins\. Starting OBS first
also works - this script will find a running instance on its own.
'@
}

$sourceDir = Join-Path $obsRoot 'data\obs-plugins\win-dshow'
if (-not (Test-Path -LiteralPath (Join-Path $sourceDir 'obs-virtualcam-module64.dll'))) {
    throw "No obs-virtualcam-module64.dll under $sourceDir - is $obsRoot really an OBS install?"
}

Write-Host "OBS install: $obsRoot"

if ($InPlace) {
    $moduleDir = $sourceDir
} else {
    # Copy the module (and the placeholder image it shows when OBS is not
    # feeding it) somewhere local and always reachable.
    if (-not (Test-Path -LiteralPath $LocalModuleDir)) {
        New-Item -ItemType Directory -Path $LocalModuleDir -Force | Out-Null
    }
    foreach ($name in @('obs-virtualcam-module64.dll', 'obs-virtualcam-module32.dll', 'placeholder.png')) {
        $src = Join-Path $sourceDir $name
        if (-not (Test-Path -LiteralPath $src)) { continue }
        $dst = Join-Path $LocalModuleDir $name
        # A copy that is already current cannot be overwritten while something
        # has the filter loaded, and does not need to be.
        if ((Test-Path -LiteralPath $dst) -and
            (Get-FileHash -LiteralPath $src).Hash -eq (Get-FileHash -LiteralPath $dst).Hash) {
            continue
        }
        try {
            Copy-Item -LiteralPath $src -Destination $LocalModuleDir -Force
        } catch {
            throw "Could not update $dst - it is in use. Stop the virtual camera in OBS, close Main Tourney Manager and any browser that opened the camera, then re-run this script."
        }
    }
    $locale = Join-Path $sourceDir 'locale'
    if (Test-Path -LiteralPath $locale) {
        Copy-Item -LiteralPath $locale -Destination $LocalModuleDir -Recurse -Force
    }
    $moduleDir = $LocalModuleDir
    Write-Host "Copied virtual camera module to: $moduleDir"
}

$registered = @()
foreach ($root in $ClassRoots) {
    $module = Join-Path $moduleDir $root.Module
    if (-not (Test-Path -LiteralPath $module)) {
        Write-Host "Skipping $($root.Bits)-bit registration - $($root.Module) not present."
        continue
    }

    $filterKey   = "$($root.Path)\$FilterClsid"
    $instanceKey = "$($root.Path)\$CaptureClsid\Instance\$FilterClsid"

    Set-Value -Key $filterKey                     -Name '(default)'     -Value $FilterName
    Set-Value -Key "$filterKey\InprocServer32"    -Name '(default)'     -Value $module
    Set-Value -Key "$filterKey\InprocServer32"    -Name 'ThreadingModel' -Value 'Both'
    Set-Value -Key $instanceKey                   -Name 'CLSID'         -Value $FilterClsid
    Set-Value -Key $instanceKey                   -Name 'FriendlyName'  -Value $FilterName

    Write-Host "Registered $($root.Bits)-bit: $module"
    $registered += $root.Bits
}

if ($registered -notcontains 64) {
    throw 'The 64-bit module was not registered; nothing useful was done.'
}

if (-not (Test-FilterCreatable)) {
    throw @'
The registry values were written but COM could not create the filter from
them. Usually that means the DLL path is unreachable (a network drive that is
not mapped in every session - try again without -InPlace) or the file was
blocked by Windows after being downloaded.

Fall back to the capture-card preview mode in Main Tourney Manager.
>>>>>>> Stashed changes
'@
}

Write-Host ''
<<<<<<< Updated upstream
Write-Host "Registered for this user only: $registeredPath"
Write-Host ''
Write-Host 'Next steps:'
Write-Host '  1. Start portable OBS and click Start Virtual Camera.'
Write-Host '  2. Start Main Tourney Manager and pick "OBS Virtual Camera" in the'
=======
Write-Host "Registered for this user only, and COM can instantiate it."
Write-Host ''
Write-Host 'Next steps:'
Write-Host '  1. Start portable OBS (start it *after* this script - OBS decides at'
Write-Host '     launch whether to enable the virtual camera) and click'
Write-Host '     Start Virtual Camera.'
Write-Host '  2. Check it with:  .\scripts\test-obs-virtualcam.ps1'
Write-Host '  3. Start Main Tourney Manager and pick "OBS Virtual Camera" in the'
>>>>>>> Stashed changes
Write-Host '     preview panel dropdown. Click Refresh if it is not listed yet.'
Write-Host ''
Write-Host 'Nothing was written outside your own user account, and nothing was'
Write-Host 'installed as a service. Re-run with -Unregister to undo.'
