# Shared Win32 + IVirtualDesktopManager bindings for the virtual-desktop scripts.
# Dot-sourced by vdesktop-check.ps1 and vdesktop-watch.ps1 so the fragile COM
# declaration lives in exactly one place.
#
# Every COM call has to sit inside C#: PowerShell binds to the concrete RCW class
# (ClassInterface None) and would report the interface methods as "MethodNotFound".

if ('VDeskProbe.Probe' -as [type]) { return }

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace VDeskProbe
{
    [ComImport]
    [Guid("aa509086-5ca9-4c25-8f95-589d3c07b48a")]
    [ClassInterface(ClassInterfaceType.None)]
    public class VirtualDesktopManagerRcw { }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("a5cd92ff-29be-454c-8d04-d82879fb3f1b")]
    public interface IVirtualDesktopManager
    {
        [PreserveSig]
        int IsWindowOnCurrentVirtualDesktop(IntPtr topLevelWindow,
            [MarshalAs(UnmanagedType.Bool)] out bool onCurrentDesktop);

        [PreserveSig]
        int GetWindowDesktopId(IntPtr topLevelWindow, out Guid desktopId);

        [PreserveSig]
        int MoveWindowToDesktop(IntPtr topLevelWindow, ref Guid desktopId);
    }

    public static class Probe
    {
        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);

        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool IsWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        private const uint WS_POPUP = 0x80000000;
        private const string CLASS_NAME = "VDeskSelfTestClass";
        private static Delegate _keepAlive;

        private delegate IntPtr WndProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

        [StructLayout(LayoutKind.Sequential)]
        private struct WNDCLASSEX
        {
            public uint cbSize;
            public uint style;
            public IntPtr lpfnWndProc;
            public int cbClsExtra;
            public int cbWndExtra;
            public IntPtr hInstance;
            public IntPtr hIcon;
            public IntPtr hCursor;
            public IntPtr hbrBackground;
            [MarshalAs(UnmanagedType.LPStr)] public string lpszMenuName;
            [MarshalAs(UnmanagedType.LPStr)] public string lpszClassName;
            public IntPtr hIconSm;
        }

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr RegisterClassEx(ref WNDCLASSEX wcex);

        [DllImport("user32.dll", CharSet = CharSet.Ansi, SetLastError = true)]
        private static extern IntPtr CreateWindowEx(uint exStyle, string className, string windowText,
            uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);

        [DllImport("user32.dll")]
        private static extern bool DestroyWindow(IntPtr hWnd);

        [DllImport("user32.dll", CharSet = CharSet.Ansi)]
        private static extern bool UnregisterClass(string className, IntPtr instance);

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        private static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter,
            int x, int y, int width, int height, uint flags);

        [DllImport("user32.dll")]
        private static extern IntPtr DefWindowProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

        [DllImport("kernel32.dll", CharSet = CharSet.Ansi)]
        private static extern IntPtr GetModuleHandle(string name);

        private static IVirtualDesktopManager Manager()
        {
            object rcw = new VirtualDesktopManagerRcw();
            return (IVirtualDesktopManager)rcw;
        }

        private static List<IntPtr> FindByTitle(string needle)
        {
            List<IntPtr> hits = new List<IntPtr>();
            StringBuilder sb = new StringBuilder(512);
            EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
            {
                if (!IsWindowVisible(hWnd)) return true;
                sb.Length = 0;
                GetWindowText(hWnd, sb, sb.Capacity);
                if (sb.ToString().IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) hits.Add(hWnd);
                return true;
            }, IntPtr.Zero);
            return hits;
        }

        // Exact title wins; substring is only a fallback. Keeps a browser tab that
        // happens to contain the word from being mistaken for our toolbar.
        private static IntPtr FirstByTitle(string needle)
        {
            List<IntPtr> hits = FindByTitle(needle);
            if (hits.Count == 0) return IntPtr.Zero;
            StringBuilder sb = new StringBuilder(512);
            foreach (IntPtr hWnd in hits)
            {
                sb.Length = 0;
                GetWindowText(hWnd, sb, sb.Capacity);
                if (string.Equals(sb.ToString(), needle, StringComparison.OrdinalIgnoreCase)) return hWnd;
            }
            return hits[0];
        }

        // One read-only poll for the watcher. hWnd may be stale (the toolbar window is
        // destroyed and recreated when it follows a desktop switch), so fall back to the
        // title and let the caller pick the new handle up from the reply.
        //   on|hwnd / off|hwnd / gone|0 / err|hr=XXXXXXXX hwnd=N / unavailable|message
        public static string Poll(IntPtr hWnd, string needle)
        {
            IVirtualDesktopManager manager;
            try { manager = Manager(); }
            catch (Exception e) { return "unavailable|" + e.GetType().Name + ": " + e.Message; }

            IntPtr target = (hWnd != IntPtr.Zero && IsWindow(hWnd)) ? hWnd : FirstByTitle(needle);
            if (target == IntPtr.Zero) return "gone|0";

            bool onCurrent;
            int hr = manager.IsWindowOnCurrentVirtualDesktop(target, out onCurrent);
            if (hr != 0) return "err|hr=" + hr.ToString("X8") + " hwnd=" + target.ToInt64().ToString();
            return (onCurrent ? "on|" : "off|") + target.ToInt64().ToString();
        }

        // Returns "ok" / "unavailable" / "failed" plus one report line per window found.
        public static string Run(string needle, bool tryMove)
        {
            StringBuilder outp = new StringBuilder();
            IVirtualDesktopManager manager;
            try { manager = Manager(); }
            catch (Exception e) { return "unavailable|" + e.GetType().Name + ": " + e.Message; }
            outp.Append("COM_OK|IVirtualDesktopManager instantiated\n");

            IntPtr foreground = GetForegroundWindow();
            Guid fgId;
            int fgHr = manager.GetWindowDesktopId(foreground, out fgId);
            outp.Append("foreground|hwnd=" + foreground.ToInt64().ToString() +
                " hr=" + fgHr.ToString("X8") + " desktop=" + fgId.ToString() + "\n");

            List<IntPtr> targets = FindByTitle(needle);
            if (targets.Count == 0)
            {
                outp.Append("NO_WINDOW|no visible top-level window title contains '" + needle + "'\n");
                return "failed|" + outp.ToString();
            }

            bool anyFailure = false;
            foreach (IntPtr hWnd in targets)
            {
                bool onCurrent;
                int hrOn = manager.IsWindowOnCurrentVirtualDesktop(hWnd, out onCurrent);
                Guid id;
                int hrId = manager.GetWindowDesktopId(hWnd, out id);
                StringBuilder line = new StringBuilder();
                line.Append("window|hwnd=" + hWnd.ToInt64().ToString() +
                    " hr.is=" + hrOn.ToString("X8") + " onCurrent=" + onCurrent +
                    " hr.id=" + hrId.ToString("X8") + " desktop=" + id.ToString());
                if (hrOn != 0 || hrId != 0) anyFailure = true;

                if (tryMove)
                {
                    if (hrId == 0 && fgHr == 0 && id != fgId)
                    {
                        Guid dest = fgId;
                        int hrMove = manager.MoveWindowToDesktop(hWnd, ref dest);
                        line.Append(" hr.move=" + hrMove.ToString("X8"));
                        if (hrMove != 0) anyFailure = true;
                    }
                    else
                    {
                        line.Append(" hr.move=SKIPPED(same desktop or id unavailable)");
                    }
                }
                outp.Append(line.ToString() + "\n");
            }
            return (anyFailure ? "failed|" : "ok|") + outp.ToString();
        }

        // Creates a window owned by THIS process on the CURRENT desktop and tries to move it
        // to the foreground window's desktop. This is the decisive test for the documented
        // rule that MoveWindowToDesktop only accepts windows owned by the calling process.
        public static string SelfTest()
        {
            IVirtualDesktopManager manager;
            try { manager = Manager(); }
            catch (Exception e) { return "unavailable|" + e.GetType().Name + ": " + e.Message; }

            IntPtr foreground = GetForegroundWindow();
            Guid fgId;
            int fgHr = manager.GetWindowDesktopId(foreground, out fgId);

            WndProc proc = delegate(IntPtr h, uint m, IntPtr w, IntPtr l) { return DefWindowProc(h, m, w, l); };
            _keepAlive = proc;
            WNDCLASSEX wc = new WNDCLASSEX();
            wc.cbSize = (uint)Marshal.SizeOf(typeof(WNDCLASSEX));
            wc.lpfnWndProc = Marshal.GetFunctionPointerForDelegate(proc);
            wc.hInstance = GetModuleHandle(null);
            wc.lpszClassName = CLASS_NAME;
            if (RegisterClassEx(ref wc) == IntPtr.Zero) return "failed|RegisterClassEx error " + Marshal.GetLastWin32Error();

            IntPtr hWnd = CreateWindowEx(0, CLASS_NAME, "VDeskSelfTest", WS_POPUP,
                -32000, -32000, 80, 80, IntPtr.Zero, IntPtr.Zero, wc.hInstance, IntPtr.Zero);
            if (hWnd == IntPtr.Zero) return "failed|CreateWindowEx error " + Marshal.GetLastWin32Error();

            // A window that was never shown has no desktop attribution yet (GetWindowDesktopId
            // fails), so show it off-screen before asking. SWP_NOACTIVATE keeps it from stealing focus.
            ShowWindow(hWnd, 8);   // SW_SHOW
            SetWindowPos(hWnd, IntPtr.Zero, -32000, -32000, 80, 80, 0x0010 | 0x0004);  // NOACTIVATE|SHOWWINDOW

            StringBuilder sb = new StringBuilder();
            Guid ownId;
            int hrOwn = manager.GetWindowDesktopId(hWnd, out ownId);
            sb.Append("self|hwnd=" + hWnd.ToInt64() + " hr.id=" + hrOwn.ToString("X8") + " desktop=" + ownId);

            Guid dest = fgId;
            int hrMove = manager.MoveWindowToDesktop(hWnd, ref dest);
            sb.Append(" hr.move.own=" + hrMove.ToString("X8") + " (target desktop=" + fgId + ", foreground hr=" + fgHr.ToString("X8") + ")");

            DestroyWindow(hWnd);
            UnregisterClass(CLASS_NAME, wc.hInstance);
            bool ok = hrMove == 0;
            return (ok ? "ok|" : "failed|") + sb.ToString() + "\n";
        }
    }

    // ---------------------------------------------------------------------
    // INTERNAL (undocumented) virtual desktop surface.
    //
    // The public IVirtualDesktopManager above can only read; switching to a
    // desktop by index needs IVirtualDesktopManagerInternal, which Microsoft
    // ships without a header. The GUIDs and the method order below are the
    // Windows 11 24H2 ones (cross-checked against MScholtes/VirtualDesktop's
    // VirtualDesktop11-24H2.cs, and they still resolve on build 26300 -
    // vdesktop-check.ps1 -List proves it by comparing the current desktop's
    // GUID against the public API's answer).
    //
    // Slot order IS the contract: declaring a method in the wrong position
    // makes the CLR call a different vtable entry. Everything here is
    // PreserveSig so a wrong guess shows up as an HRESULT in our own output
    // instead of a managed exception, and nothing is declared past the slots
    // we actually call.
    //
    // It lives in the same Add-Type unit as Probe because it calls the public
    // IVirtualDesktopManager above, and two separately compiled anonymous
    // assemblies cannot see each other.
    // ---------------------------------------------------------------------
    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("372e1d3b-38d3-42e4-a15b-8ab2b178f513")]
    internal interface IApplicationView { }   // only ever passed around, never called

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("3f07f4be-b107-441a-af0f-39d82529072c")]
    internal interface IVirtualDesktop
    {
        [PreserveSig] int IsViewVisible(IApplicationView view,
            [MarshalAs(UnmanagedType.Bool)] out bool visible);
        [PreserveSig] int GetId(out Guid desktopId);
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("92ca9dcd-5622-4bba-a805-5e9f541bd8c9")]
    internal interface IObjectArray
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetAt(int index, ref Guid riid,
            [MarshalAs(UnmanagedType.Interface)] out IVirtualDesktop desktop);    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("53f5ca0b-158f-4124-900c-057158060b27")]
    internal interface IVirtualDesktopManagerInternal
    {
        [PreserveSig] int GetCount(out int count);                                                   // slot 3
        [PreserveSig] int MoveViewToDesktop(IApplicationView view, IVirtualDesktop desktop);         // 4
        [PreserveSig] int CanViewMoveDesktops(IApplicationView view,
            [MarshalAs(UnmanagedType.Bool)] out bool canMove);                                       // 5
        [PreserveSig] int GetCurrentDesktop(out IVirtualDesktop desktop);                            // 6
        [PreserveSig] int GetDesktops([MarshalAs(UnmanagedType.Interface)] out IObjectArray desktops);                            // 7
        [PreserveSig] int GetAdjacentDesktop(IVirtualDesktop from, int direction,
            out IVirtualDesktop desktop);                                                            // 8
        [PreserveSig] int SwitchDesktop(IVirtualDesktop desktop);                                    // 9
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("6d5140c1-7436-11ce-8034-00aa006009fa")]
    internal interface IServiceProvider10
    {
        [return: MarshalAs(UnmanagedType.IUnknown)]
        object QueryService(ref Guid service, ref Guid riid);
    }

    public static class Desks
    {
        private static readonly Guid CLSID_ImmersiveShell = new Guid("C2F03A33-21F5-47FA-B4BB-156362A2F239");
        private static readonly Guid CLSID_ManagerInternal = new Guid("C5E0CDCA-7B6E-41B2-9FC4-D93975CC467B");
        private static readonly Guid IID_ManagerInternal = new Guid("53F5CA0B-158F-4124-900C-057158060B27");
        private static readonly Guid IID_VirtualDesktop = new Guid("3F07F4BE-B107-441A-AF0F-39D82529072C");

        private static IVirtualDesktopManagerInternal _cached;

        // The internal manager is stateless - it answers "which desktop is current" on
        // every call - so the resident watcher reuses one instance instead of paying a
        // CoCreateInstance + QueryService every poll. Callers reset the cache when a
        // call fails, because a cached pointer also goes stale when explorer.exe dies.
        private static IVirtualDesktopManagerInternal Manager()
        {
            if (_cached != null) return _cached;
            object shell = Activator.CreateInstance(Type.GetTypeFromCLSID(CLSID_ImmersiveShell));
            IServiceProvider10 provider = (IServiceProvider10)shell;
            Guid service = CLSID_ManagerInternal;
            Guid riid = IID_ManagerInternal;
            _cached = (IVirtualDesktopManagerInternal)provider.QueryService(ref service, ref riid);
            return _cached;
        }

        public static void Reset() { _cached = null; }

        // Index of the desktop the internal API calls "current", or -1. Also reports
        // the current GUID and the desktop count back to the caller.
        private static int CurrentIndexOf(IVirtualDesktopManagerInternal manager,
            out Guid currentId, out int count)
        {
            currentId = Guid.Empty;
            count = 0;
            IVirtualDesktop current;
            if (manager.GetCurrentDesktop(out current) != 0 || current == null) return -1;
            if (current.GetId(out currentId) != 0) return -1;

            IObjectArray array;
            if (manager.GetDesktops(out array) != 0 || array == null) return -1;
            if (array.GetCount(out count) != 0) return -1;

            Guid iid = IID_VirtualDesktop;
            for (int i = 0; i < count; i++)
            {
                IVirtualDesktop desk;
                if (array.GetAt(i, ref iid, out desk) != 0 || desk == null) continue;
                Guid id;
                if (desk.GetId(out id) != 0) continue;
                if (id == currentId) return i;
            }
            return -1;
        }

        // Read-only dump for vdesktop-check.ps1 -List:
        //   ok|count=N current=I cross=match|differ|nodata\n desk|I|<guid>|<current>
        //   unavailable|<exception>   failed|<why>
        public static string List()
        {
            IVirtualDesktopManagerInternal manager;
            try { manager = Manager(); }
            catch (Exception e) { return "unavailable|" + e.GetType().Name + ": " + e.Message; }
            if (manager == null) return "unavailable|QueryService returned null";

            int count;
            int hrCount = manager.GetCount(out count);
            if (hrCount != 0) return "failed|GetCount hr=" + hrCount.ToString("X8");

            Guid currentId;
            int listCount;
            int index = CurrentIndexOf(manager, out currentId, out listCount);

            StringBuilder sb = new StringBuilder();
            sb.Append("count=" + count + " list=" + listCount + " current=" + index + " currentId=" + currentId.ToString());

            // Cross-check against the PUBLIC API: the desktop the foreground window
            // lives on must be the same one the internal interface calls "current".
            // If the two agree, the GUIDs and the slot order are right for this build.
            try
            {
                IVirtualDesktopManager publicManager = (IVirtualDesktopManager)new VirtualDesktopManagerRcw();
                Guid fgId;
                int hrFg = publicManager.GetWindowDesktopId(GetForegroundWindow(), out fgId);
                if (hrFg != 0) sb.Append(" cross=nodata(hr=" + hrFg.ToString("X8") + ")");
                else sb.Append(" cross=" + (fgId == currentId ? "match" : "differ(" + fgId.ToString() + ")"));
            }
            catch (Exception e) { sb.Append(" cross=nodata(" + e.GetType().Name + ")"); }
            sb.Append("\n");

            Guid iid = IID_VirtualDesktop;
            IObjectArray array;
            if (manager.GetDesktops(out array) == 0 && array != null)
            {
                int items;
                if (array.GetCount(out items) == 0)
                {
                    for (int i = 0; i < items; i++)
                    {
                        IVirtualDesktop desk;
                        if (array.GetAt(i, ref iid, out desk) != 0 || desk == null) continue;
                        Guid id;
                        desk.GetId(out id);
                        sb.Append("desk|" + i + "|" + id.ToString() + "|" + (i == index ? "current" : "") + "\n");
                    }
                }
            }
            return "ok|" + sb.ToString();
        }

        // The only mutating call in this file. index is 0-based, in Task View order.
        public static string Switch(int index)
        {
            IVirtualDesktopManagerInternal manager;
            try { manager = Manager(); }
            catch (Exception e) { return "unavailable|" + e.GetType().Name + ": " + e.Message; }
            if (manager == null) return "unavailable|QueryService returned null";

            int count;
            if (manager.GetCount(out count) != 0) return "failed|GetCount";
            if (index < 0 || index >= count) return "range|count=" + count + " want=" + index;

            IObjectArray array;
            if (manager.GetDesktops(out array) != 0 || array == null) return "failed|GetDesktops";
            Guid iid = IID_VirtualDesktop;
            IVirtualDesktop desk;
            if (array.GetAt(index, ref iid, out desk) != 0 || desk == null) return "failed|GetAt " + index;

            Guid id;
            desk.GetId(out id);
            int hr = manager.SwitchDesktop(desk);
            if (hr != 0) return "failed|hr=" + hr.ToString("X8") + " desktop=" + id.ToString();
            return "ok|index=" + index + " count=" + count + " desktop=" + id.ToString() + "\n";
        }

        // Which desktop is active right now, 0-based. Used by the resident watcher so
        // the main process can map "desktop N" back to the panel bound to it.
        //   ok|index=I count=N desktop=<guid> / unavailable|... / failed|...
        public static string Current()
        {
            IVirtualDesktopManagerInternal manager;
            try { manager = Manager(); }
            catch (Exception e) { return "unavailable|" + e.GetType().Name + ": " + e.Message; }
            if (manager == null) return "unavailable|QueryService returned null";
            Guid currentId;
            int count;
            int index = CurrentIndexOf(manager, out currentId, out count);
            if (index < 0) return "failed|current desktop not in the list (count=" + count + " id=" + currentId + ")";
            return "ok|index=" + index + " count=" + count + " desktop=" + currentId.ToString() + "\n";
        }

        // The resident watcher's per-poll read: the 0-based active desktop, or -1 when
        // the internal API is not usable right now. Cheap enough to call every round -
        // the manager is cached, so a normal round is two COM calls.
        public static int CurrentIndex(out int count)
        {
            count = 0;
            try
            {
                IVirtualDesktopManagerInternal manager = Manager();
                if (manager == null) { Reset(); return -1; }
                Guid id;
                int index = CurrentIndexOf(manager, out id, out count);
                // A stale pointer (explorer restarted) shows up as the current desktop
                // missing from the list; drop the cache so the next round re-resolves it.
                if (index < 0) Reset();
                return index;
            }
            catch (Exception)
            {
                Reset();
                return -1;
            }
        }

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();
    }
}
'@
