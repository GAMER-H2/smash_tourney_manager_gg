<#
.SYNOPSIS
    Checks the per-user OBS Virtual Camera registration the same way the app's
    webview does, without needing the app built or OBS's UI in front of you.

.DESCRIPTION
    Three checks, in the order they can fail:

      1. The HKCU registration exists and COM can create the filter from it.
      2. The filter appears in the DirectShow video capture category - this is
         the exact enumeration Chromium/WebView2 does with Media Foundation
         capture disabled, so if the camera shows up here it shows up in the
         app.
      3. The filter's output pin offers video formats. It only does that while
         OBS has the virtual camera *started*, so this is also how you confirm
         OBS is actually publishing.

    Needs no elevation and changes nothing.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\test-obs-virtualcam.ps1
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$FilterClsid = '{A3FCE0F5-3493-419F-958A-ABA1250EC20B}'

Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

[StructLayout(LayoutKind.Sequential)]
public struct VCamMediaType {
    public Guid majorType, subType;
    [MarshalAs(UnmanagedType.Bool)] public bool bFixedSizeSamples;
    [MarshalAs(UnmanagedType.Bool)] public bool bTemporalCompression;
    public int lSampleSize;
    public Guid formatType;
    public IntPtr pUnk;
    public int cbFormat;
    public IntPtr pbFormat;
}

[StructLayout(LayoutKind.Sequential)]
public struct VCamPinInfo {
    public IntPtr filter;
    public int dir;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string name;
}

[ComImport, Guid("29840822-5B84-11D0-BD3B-00A0C911CE86"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ICreateDevEnum {
    [PreserveSig] int CreateClassEnumerator([In] ref Guid pType, [Out] out IEnumMoniker ppEnumMoniker, [In] int dwFlags);
}

[ComImport, Guid("55272A00-42CB-11CE-8135-00AA004BB851"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPropertyBag {
    [PreserveSig] int Read([In, MarshalAs(UnmanagedType.LPWStr)] string name,
                           [In, Out, MarshalAs(UnmanagedType.Struct)] ref object val, IntPtr err);
    [PreserveSig] int Write([In, MarshalAs(UnmanagedType.LPWStr)] string name,
                            [In, MarshalAs(UnmanagedType.Struct)] ref object val);
}

[ComImport, Guid("56a86895-0ad4-11ce-b03a-0020af0ba770"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IBaseFilter {
    [PreserveSig] int GetClassID(out Guid id);
    [PreserveSig] int Stop();
    [PreserveSig] int Pause();
    [PreserveSig] int Run(long tStart);
    [PreserveSig] int GetState(int ms, out int state);
    [PreserveSig] int SetSyncSource(IntPtr clock);
    [PreserveSig] int GetSyncSource(out IntPtr clock);
    [PreserveSig] int EnumPins(out IEnumPins ppEnum);
    [PreserveSig] int FindPin([MarshalAs(UnmanagedType.LPWStr)] string id, out IPin pin);
    [PreserveSig] int QueryFilterInfo(IntPtr info);
    [PreserveSig] int JoinFilterGraph(IntPtr graph, [MarshalAs(UnmanagedType.LPWStr)] string name);
    [PreserveSig] int QueryVendorInfo([MarshalAs(UnmanagedType.LPWStr)] out string vendor);
}

[ComImport, Guid("56a86892-0ad4-11ce-b03a-0020af0ba770"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IEnumPins {
    [PreserveSig] int Next(int c, [Out, MarshalAs(UnmanagedType.LPArray)] IPin[] pins, IntPtr fetched);
    [PreserveSig] int Skip(int c);
    [PreserveSig] int Reset();
    [PreserveSig] int Clone(out IEnumPins e);
}

[ComImport, Guid("56a86891-0ad4-11ce-b03a-0020af0ba770"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPin {
    [PreserveSig] int Connect(IPin p, IntPtr mt);
    [PreserveSig] int ReceiveConnection(IPin p, IntPtr mt);
    [PreserveSig] int Disconnect();
    [PreserveSig] int ConnectedTo(out IPin p);
    [PreserveSig] int ConnectionMediaType(IntPtr mt);
    [PreserveSig] int QueryPinInfo(out VCamPinInfo info);
    [PreserveSig] int QueryDirection(out int dir);
    [PreserveSig] int QueryId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int QueryAccept(IntPtr mt);
    [PreserveSig] int EnumMediaTypes(out IntPtr e);
    [PreserveSig] int QueryInternalConnections(IntPtr p, ref int n);
    [PreserveSig] int EndOfStream();
    [PreserveSig] int BeginFlush();
    [PreserveSig] int EndFlush();
    [PreserveSig] int NewSegment(long s, long e, double r);
}

[ComImport, Guid("C6E13340-30AC-11d0-A18C-00A0C9118956"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAMStreamConfig {
    [PreserveSig] int SetFormat(IntPtr mt);
    [PreserveSig] int GetFormat(out IntPtr mt);
    [PreserveSig] int GetNumberOfCapabilities(out int count, out int size);
    [PreserveSig] int GetStreamCaps(int i, out IntPtr mt, IntPtr scc);
}

public static class VCamCheck {
    static readonly Guid CLSID_SystemDeviceEnum = new Guid("62BE5D10-60EB-11d0-BD3B-00A0C911CE86");
    static readonly Guid CLSID_VideoInputDeviceCategory = new Guid("860BB310-5D01-11d0-BD3B-00A0C911CE86");
    static readonly Guid IID_IBaseFilter = new Guid("56a86895-0ad4-11ce-b03a-0020af0ba770");
    static readonly Guid IID_IPropertyBag = new Guid("55272A00-42CB-11CE-8135-00AA004BB851");

    // Every DirectShow camera on this account, as "<name>|<clsid>|<bind result>".
    public static string[] Cameras() {
        var results = new System.Collections.Generic.List<string>();
        var devEnum = (ICreateDevEnum)Activator.CreateInstance(Type.GetTypeFromCLSID(CLSID_SystemDeviceEnum));
        IEnumMoniker em;
        Guid cat = CLSID_VideoInputDeviceCategory;
        if (devEnum.CreateClassEnumerator(ref cat, out em, 0) != 0 || em == null) return results.ToArray();
        var mons = new IMoniker[1];
        while (em.Next(1, mons, IntPtr.Zero) == 0) {
            string name = "(unnamed)", clsid = "(none)", bind = "ok";
            try {
                object bagObj;
                Guid iid = IID_IPropertyBag;
                mons[0].BindToStorage(null, null, ref iid, out bagObj);
                var bag = (IPropertyBag)bagObj;
                object v = null;
                if (bag.Read("FriendlyName", ref v, IntPtr.Zero) == 0) name = v as string;
                object c = null;
                if (bag.Read("CLSID", ref c, IntPtr.Zero) == 0) clsid = c as string;
            } catch (Exception e) { name = "(property bag failed: " + e.Message + ")"; }
            try {
                object filter;
                Guid iidf = IID_IBaseFilter;
                mons[0].BindToObject(null, null, ref iidf, out filter);
                if (filter == null) bind = "returned null";
                else Marshal.ReleaseComObject(filter);
            } catch (Exception e) { bind = "FAILED 0x" + Marshal.GetHRForException(e).ToString("X8"); }
            results.Add(name + "|" + clsid + "|" + bind);
            Marshal.ReleaseComObject(mons[0]);
        }
        return results.ToArray();
    }

    // Formats the filter's output pin advertises, as "<w>x<h> @ <fps> <subtype>".
    public static string[] Formats(string clsid) {
        var results = new System.Collections.Generic.List<string>();
        object o = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid(clsid)));
        try {
            var f = (IBaseFilter)o;
            IEnumPins ep;
            f.EnumPins(out ep);
            var pins = new IPin[1];
            while (ep.Next(1, pins, IntPtr.Zero) == 0) {
                var sc = pins[0] as IAMStreamConfig;
                if (sc != null) {
                    int count, size;
                    if (sc.GetNumberOfCapabilities(out count, out size) == 0) {
                        for (int i = 0; i < count; i++) {
                            IntPtr pmt;
                            IntPtr scc = Marshal.AllocCoTaskMem(size);
                            if (sc.GetStreamCaps(i, out pmt, scc) == 0 && pmt != IntPtr.Zero) {
                                var mt = (VCamMediaType)Marshal.PtrToStructure(pmt, typeof(VCamMediaType));
                                int w = 0, h = 0;
                                long frameTime = 0;
                                // VIDEOINFOHEADER: AvgTimePerFrame at 40, BITMAPINFOHEADER at 48.
                                if (mt.cbFormat >= 60 && mt.pbFormat != IntPtr.Zero) {
                                    frameTime = Marshal.ReadInt64(mt.pbFormat, 40);
                                    w = Marshal.ReadInt32(mt.pbFormat, 52);
                                    h = Marshal.ReadInt32(mt.pbFormat, 56);
                                }
                                double fps = frameTime > 0 ? 10000000.0 / frameTime : 0;
                                results.Add(w + "x" + h + " @ " + fps.ToString("0.##") + "fps  " + FourCc(mt.subType));
                            }
                            Marshal.FreeCoTaskMem(scc);
                        }
                    }
                }
                Marshal.ReleaseComObject(pins[0]);
            }
        } finally { Marshal.ReleaseComObject(o); }
        return results.ToArray();
    }

    // DirectShow video subtype GUIDs start with the FOURCC of the pixel format.
    static string FourCc(Guid subtype) {
        var b = subtype.ToByteArray();
        var s = "" + (char)b[0] + (char)b[1] + (char)b[2] + (char)b[3];
        foreach (char c in s) if (c < 32 || c > 126) return subtype.ToString();
        return s;
    }
}
'@

function Write-Check {
    param([bool] $Ok, [string] $Message)
    $mark = if ($Ok) { '[ ok ]' } else { '[FAIL]' }
    $colour = if ($Ok) { 'Green' } else { 'Red' }
    Write-Host "$mark $Message" -ForegroundColor $colour
}

Write-Host ''
Write-Host 'OBS Virtual Camera - per-user registration check'
Write-Host '------------------------------------------------'

# 1. Registration.
$views = @(
    @{ Bits = 64; Key = "HKCU:\Software\Classes\CLSID\$FilterClsid\InprocServer32" }
    @{ Bits = 32; Key = "HKCU:\Software\Classes\Wow6432Node\CLSID\$FilterClsid\InprocServer32" }
)
$any64 = $false
foreach ($view in $views) {
    $path = (Get-ItemProperty -LiteralPath $view.Key -ErrorAction SilentlyContinue).'(default)'
    if ($path) {
        $exists = Test-Path -LiteralPath $path
        Write-Check $exists "$($view.Bits)-bit module registered: $path$(if (-not $exists) { '  (FILE MISSING)' })"
        if ($view.Bits -eq 64 -and $exists) { $any64 = $true }
    } else {
        Write-Check $false "$($view.Bits)-bit module not registered under HKCU."
    }
}

if (-not $any64) {
    Write-Host ''
    Write-Host 'Run scripts\register-obs-virtualcam-peruser.ps1 first.' -ForegroundColor Yellow
    exit 1
}

# 2. Enumeration - what the app's webview will see.
$cameras = [VCamCheck]::Cameras()
Write-Host ''
Write-Host "DirectShow cameras visible to this account ($($cameras.Count)):"
$found = $false
foreach ($camera in $cameras) {
    $parts = $camera -split '\|'
    $isObs = $parts[1] -eq $FilterClsid
    if ($isObs) { $found = $true }
    $tag = if ($isObs) { '  <- OBS Virtual Camera' } else { '' }
    Write-Host "  - $($parts[0])  [bind: $($parts[2])]$tag"
}
Write-Host ''
Write-Check $found 'OBS Virtual Camera is enumerated as a capture device.'

if (-not $found) {
    Write-Host ''
    Write-Host 'The filter is registered but not enumerating. Re-run the registration' -ForegroundColor Yellow
    Write-Host 'script; if that does not help, use the capture-card fallback.' -ForegroundColor Yellow
    exit 1
}

# 3. Formats - only present while OBS is publishing.
$formats = [VCamCheck]::Formats($FilterClsid)
Write-Host ''
if ($formats.Count -gt 0) {
    Write-Check $true "OBS is publishing - $($formats.Count) format(s) offered:"
    foreach ($format in $formats) { Write-Host "    $format" }
    Write-Host ''
    Write-Host 'Everything on this side is ready. Pick "OBS Virtual Camera" in the'
    Write-Host 'app preview panel.'
} else {
    Write-Check $false 'The filter offers no video formats.'
    Write-Host ''
    Write-Host 'That means OBS is not publishing to it. In OBS, Controls dock ->' -ForegroundColor Yellow
    Write-Host 'Start Virtual Camera, then run this script again.' -ForegroundColor Yellow
    exit 1
}
