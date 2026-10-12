// Pomocník Kine pro Windows (kine-helper.exe).
//
// Dělá totéž co PowerShell skript v src/main/winHelper.ts (okno v popředí,
// běžící programy a hra podle Steamu, zkratky z více kláves, tlačítka myši
// a ovladače), jen jako samostatný program. Důvod: Inteligentní řízení
// aplikací (Smart App Control) ve Windows pouští jen podepsaný kód a
// PowerShell tam běží v omezeném režimu, kde Add-Type nejde - podepsaný
// kine-helper.exe projde. Do instalátoru se dává jen v podepsaném sestavení
// (scripts/podpis.mjs); jinak appka používá PowerShell jako dřív.
//
// Mluví stejně jako skript - řádky JSON na stdout:
//   {"t":"ready"}  {"t":"hotkey","i":N}  {"t":"fg",...}  {"t":"procs",...}  {"t":"err","m":"..."}
// Nastavení z prostředí: KINE_HOTKEYS ("119;17,120" = F8 a Ctrl+F9),
// KINE_FAST_MS, KINE_FG_MS, KINE_PROC_S (časy podle nastavení výkonu).
// Skončí sám, když appka zavře stdin (appka skončila nebo spadla) nebo když
// už nejde psát na stdout - nezůstane viset na pozadí.
//
// Překlad: csc.exe z .NET Framework 4 (je v každých Windows 10/11), C# 5.

using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32;

[assembly: AssemblyTitle("Kine helper")]
[assembly: AssemblyDescription("Kine helper: foreground window, running games and hotkeys")]
[assembly: AssemblyProduct("Kine")]
[assembly: AssemblyCompany("Kine")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

namespace KineHelper
{
    /// <summary>Volání Windows (stejná jako v PowerShell skriptu).</summary>
    public static class Native
    {
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
        [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfoW(IntPtr hMonitor, ref MONITORINFO info);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
        [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
        [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool QueryFullProcessImageNameW(IntPtr handle, uint flags, StringBuilder name, ref uint size);
        [DllImport("psapi.dll")] public static extern bool EnumProcesses([Out] uint[] pids, uint size, out uint needed);
        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
        [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public uint cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }

        // Ovladač (Xbox / XInput): xinput1_4.dll je na Windows 8+, xinput9_1_0.dll všude jako záloha.
        [DllImport("xinput1_4.dll", EntryPoint = "XInputGetState")] public static extern uint XInputGetState14(uint index, out XINPUT_STATE state);
        [DllImport("xinput9_1_0.dll", EntryPoint = "XInputGetState")] public static extern uint XInputGetState910(uint index, out XINPUT_STATE state);
        [StructLayout(LayoutKind.Sequential)] public struct XINPUT_GAMEPAD { public ushort wButtons; public byte bLeftTrigger; public byte bRightTrigger; public short sThumbLX; public short sThumbLY; public short sThumbRX; public short sThumbRY; }
        [StructLayout(LayoutKind.Sequential)] public struct XINPUT_STATE { public uint dwPacketNumber; public XINPUT_GAMEPAD Gamepad; }

        // -1 = ještě nevíme, 1 = xinput1_4, 0 = xinput9_1_0, -2 = XInput tu není (žádné další pokusy).
        static int xinputDll = -1;
        static readonly bool[] padConnected = new bool[4];

        static uint PadState(uint index, out XINPUT_STATE state)
        {
            if (xinputDll != 0)
            {
                try { uint rc = XInputGetState14(index, out state); xinputDll = 1; return rc; }
                catch (DllNotFoundException) { if (xinputDll == 1) throw; xinputDll = 0; }
                catch (EntryPointNotFoundException) { if (xinputDll == 1) throw; xinputDll = 0; }
            }
            return XInputGetState910(index, out state);
        }

        /// <summary>
        /// Stisknutá tlačítka všech připojených ovladačů dohromady (maska wButtons; spouště
        /// jako 0x10000 / 0x20000). Odpojené sloty se zkoušejí jen občas (XInput je u prázdného
        /// slotu pomalý). -1 = XInput tu není.
        /// </summary>
        public static int PadButtons(int tick)
        {
            if (xinputDll == -2) return -1;
            int result = 0;
            for (uint i = 0; i < 4; i++)
            {
                if (!padConnected[i] && (tick % 66) != 0) continue;
                XINPUT_STATE st;
                uint rc;
                try { rc = PadState(i, out st); }
                catch (Exception) { xinputDll = -2; return -1; }
                if (rc != 0) { padConnected[i] = false; continue; }
                padConnected[i] = true;
                result |= st.Gamepad.wButtons;
                if (st.Gamepad.bLeftTrigger > 100) result |= 0x10000;
                if (st.Gamepad.bRightTrigger > 100) result |= 0x20000;
            }
            return result;
        }

        /// <summary>Název programu (jen soubor, např. "cs2.exe"); PROCESS_QUERY_LIMITED_INFORMATION stačí i na procesy správce.</summary>
        public static string ExeName(uint pid)
        {
            if (pid == 0) return "";
            IntPtr h = OpenProcess(0x1000, false, pid);
            if (h == IntPtr.Zero) return "";
            try
            {
                StringBuilder sb = new StringBuilder(1024);
                uint size = 1024;
                if (!QueryFullProcessImageNameW(h, 0, sb, ref size)) return "";
                string path = sb.ToString();
                int i = path.LastIndexOfAny(new char[] { '\\', '/' });
                return i >= 0 ? path.Substring(i + 1) : path;
            }
            finally { CloseHandle(h); }
        }

        public static uint[] Pids()
        {
            uint[] buf = new uint[8192];
            uint needed = 0;
            if (!EnumProcesses(buf, (uint)(buf.Length * 4), out needed)) return new uint[0];
            int count = (int)(needed / 4);
            uint[] result = new uint[count];
            Array.Copy(buf, result, count);
            return result;
        }

        /// <summary>Procesy, které mají viditelné okno nahoře.</summary>
        public static uint[] WindowedPids()
        {
            HashSet<uint> pids = new HashSet<uint>();
            EnumWindowsProc callback = delegate(IntPtr hWnd, IntPtr lParam)
            {
                if (IsWindowVisible(hWnd)) { uint p = 0; GetWindowThreadProcessId(hWnd, out p); if (p != 0) pids.Add(p); }
                return true;
            };
            EnumWindows(callback, IntPtr.Zero);
            GC.KeepAlive(callback);
            uint[] result = new uint[pids.Count];
            pids.CopyTo(result);
            return result;
        }

        /// <summary>RunningAppID Steamu (0 = žádná hra).</summary>
        public static int SteamAppId()
        {
            try
            {
                using (RegistryKey k = Registry.CurrentUser.OpenSubKey(@"Software\Valve\Steam"))
                {
                    if (k == null) return 0;
                    object v = k.GetValue("RunningAppID");
                    if (v == null) return 0;
                    return Convert.ToInt32(v);
                }
            }
            catch (Exception) { return 0; }
        }
    }

    /// <summary>Čistá logika (testuje se v tests/helper/KineHelperTests.cs i bez Windows).</summary>
    public static class Logic
    {
        /// <summary>"119;17,120" -> [[119], [17, 120]]; neplatné kusy se přeskočí.</summary>
        public static int[][] ParseChords(string spec)
        {
            List<int[]> chords = new List<int[]>();
            if (string.IsNullOrEmpty(spec)) return chords.ToArray();
            foreach (string group in spec.Split(';'))
            {
                if (group.Trim().Length == 0) continue;
                List<int> keys = new List<int>();
                bool valid = true;
                foreach (string part in group.Split(','))
                {
                    int vk;
                    if (int.TryParse(part.Trim(), out vk) && vk > 0) keys.Add(vk);
                    else { valid = false; break; }
                }
                if (valid && keys.Count > 0) chords.Add(keys.ToArray());
            }
            return chords.ToArray();
        }

        /// <summary>Kódy od 0x100000 výš jsou tlačítka ovladače (0x100000 + maska XInput) - viz shared/hotkeys.ts.</summary>
        public static bool UsesPad(int[][] chords)
        {
            foreach (int[] chord in chords) foreach (int vk in chord) if (vk >= 0x100000) return true;
            return false;
        }

        /// <summary>Číslo z prostředí: chybí / nejde přečíst = výchozí; menší než minimum = minimum.</summary>
        public static int EnvInt(string value, int fallback, int minimum)
        {
            int v;
            if (string.IsNullOrEmpty(value) || !int.TryParse(value.Trim(), out v)) v = fallback;
            return Math.Max(minimum, v);
        }

        /// <summary>
        /// Rychlá smyčka jen když je co hlídat (zkratky): krok fastMs, jinak fgMs.
        /// Vrací [krok ms, okno v popředí každých N kol, seznam procesů každých N kol].
        /// </summary>
        public static int[] Timing(bool fast, int fastMs, int fgMs, int procS)
        {
            int sleepMs = fast ? fastMs : fgMs;
            int fgEvery = Math.Max(1, (int)Math.Round((double)fgMs / sleepMs));
            int procEvery = Math.Max(1, (int)Math.Round((procS * 1000.0) / sleepMs));
            return new int[] { sleepMs, fgEvery, procEvery };
        }

        /// <summary>Kolo, kdy se posílá seznam procesů (první už v 1. kole; při N = 1 každé kolo).</summary>
        public static bool ProcTick(int tick, int procEvery)
        {
            return procEvery <= 1 || tick % procEvery == 1;
        }

        /// <summary>
        /// Které zkratky se právě stiskly (náběžná hrana). Když je stisknutá i delší
        /// kombinace, která tuhle obsahuje (F8 vs Ctrl+F8), vyhrává ta delší.
        /// wasDown se rovnou přepíše na nový stav.
        /// </summary>
        public static List<int> NewlyPressed(bool[] down, bool[] wasDown, int[][] chords)
        {
            List<int> fired = new List<int>();
            for (int i = 0; i < chords.Length; i++)
            {
                if (down[i] && !wasDown[i])
                {
                    bool shadowed = false;
                    for (int j = 0; j < chords.Length && !shadowed; j++)
                    {
                        if (j == i || !down[j] || chords[j].Length <= chords[i].Length) continue;
                        bool subset = true;
                        foreach (int vk in chords[i]) { if (Array.IndexOf(chords[j], vk) < 0) { subset = false; break; } }
                        if (subset) shadowed = true;
                    }
                    if (!shadowed) fired.Add(i);
                }
                wasDown[i] = down[i];
            }
            return fired;
        }

        /// <summary>Okno kryje celý monitor a nemá titulek (borderless / exclusive fullscreen).</summary>
        public static bool IsFullscreen(int w, int h, int monitorW, int monitorH, int style)
        {
            bool caption = (style & 0x00C00000) != 0;
            return monitorW > 0 && w >= monitorW && h >= monitorH && !caption;
        }

        /// <summary>Řetězec jako JSON.</summary>
        public static string Str(string s)
        {
            if (s == null) return "\"\"";
            StringBuilder sb = new StringBuilder(s.Length + 2);
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }

        static string StrArray(string[] items)
        {
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < items.Length; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append(Str(items[i]));
            }
            return sb.Append(']').ToString();
        }

        public static string FgJson(uint pid, string exe, string title, int w, int h, bool fs)
        {
            return "{\"t\":\"fg\",\"pid\":" + pid + ",\"exe\":" + Str(exe) + ",\"title\":" + Str(title) +
                ",\"w\":" + w + ",\"h\":" + h + ",\"fs\":" + (fs ? "true" : "false") + "}";
        }

        public static string ProcsJson(string[] exes, string[] windowed, int steam)
        {
            return "{\"t\":\"procs\",\"exes\":" + StrArray(exes) + ",\"win\":" + StrArray(windowed) + ",\"steam\":" + steam + "}";
        }

        public static string ErrJson(string message)
        {
            return "{\"t\":\"err\",\"m\":" + Str(message) + "}";
        }

        /// <summary>Množina názvů -> seřazené pole (stejné pořadí pokaždé, ať jde porovnat).</summary>
        public static string[] Sorted(HashSet<string> set)
        {
            string[] arr = new string[set.Count];
            set.CopyTo(arr);
            Array.Sort(arr, StringComparer.Ordinal);
            return arr;
        }
    }

    public static class Program
    {
        static TextWriter output;
        static readonly object writeLock = new object();

        /// <summary>Řádek na stdout; když už nejde psát (appka skončila), pomocník končí.</summary>
        static void Send(string line)
        {
            try
            {
                // Celý řádek jedním zápisem - kdyby appka pomocníka zabila mezi dvěma, zbyl by půlřádek.
                lock (writeLock) { output.Write(line + "\n"); output.Flush(); }
            }
            catch (Exception)
            {
                Environment.Exit(0);
            }
        }

        static bool KeyDown(int vk, int pad)
        {
            if (vk >= 0x100000)
            {
                // Tlačítko ovladače: stav se čte jednou za kolo (PadButtons); -1 = ovladač tu není.
                int m = vk - 0x100000;
                return pad >= 0 && (pad & m) == m;
            }
            if (vk == 0x5B) return (Native.GetAsyncKeyState(0x5B) & 0x8000) != 0 || (Native.GetAsyncKeyState(0x5C) & 0x8000) != 0;
            return (Native.GetAsyncKeyState(vk) & 0x8000) != 0;
        }

        /// <summary>Konec stdin = appka skončila (nebo spadla) -> konec pomocníka.</summary>
        static void WatchStdin()
        {
            if (!Console.IsInputRedirected) return;
            Thread t = new Thread(delegate()
            {
                try
                {
                    Stream input = Console.OpenStandardInput();
                    byte[] buf = new byte[256];
                    while (input.Read(buf, 0, buf.Length) > 0) { }
                }
                catch (Exception) { }
                Environment.Exit(0);
            });
            t.IsBackground = true;
            t.Start();
        }

        public static int Main(string[] args)
        {
            // Spuštěný z konzole bez přesměrování nemá komu psát - hned konec. (Po dvojkliku
            // .NET hlásí výstup jako přesměrovaný, ale stdin je prázdný a WatchStdin ho hned ukončí.)
            if (!Console.IsOutputRedirected) return 2;
            // Vlastní zapisovač: UTF-8 bez BOM. (Console.OutputEncoding by v programu
            // bez konzole spadl.)
            StreamWriter writer = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            writer.AutoFlush = true;
            output = writer;
            WatchStdin();

            int[][] chords = Logic.ParseChords(Environment.GetEnvironmentVariable("KINE_HOTKEYS"));
            bool usePad = Logic.UsesPad(chords);
            bool[] wasDown = new bool[chords.Length];
            int pad = 0;
            bool fast = chords.Length > 0;
            int[] timing = Logic.Timing(
                fast,
                Logic.EnvInt(Environment.GetEnvironmentVariable("KINE_FAST_MS"), 30, 5),
                Logic.EnvInt(Environment.GetEnvironmentVariable("KINE_FG_MS"), 1000, 100),
                Logic.EnvInt(Environment.GetEnvironmentVariable("KINE_PROC_S"), 5, 1));
            int sleepMs = timing[0];
            int fgEvery = timing[1];
            int procEvery = timing[2];

            int tick = 0;
            uint lastPid = 0;
            string lastExe = "";
            Dictionary<uint, string> names = new Dictionary<uint, string>();
            // Posílá se jen změna (okno v popředí, seznam procesů) + občas "pořád stejné",
            // ať appka ví, že pomocník žije.
            string lastFgKey = "";
            DateTime lastFgAt = DateTime.MinValue;
            string lastProcKey = "";
            DateTime lastProcAt = DateTime.MinValue;
            Send("{\"t\":\"ready\"}");

            while (true)
            {
                try
                {
                    if (fast)
                    {
                        if (usePad) pad = Native.PadButtons(tick);
                        bool[] down = new bool[chords.Length];
                        for (int i = 0; i < chords.Length; i++)
                        {
                            bool all = true;
                            foreach (int vk in chords[i]) { if (!KeyDown(vk, pad)) { all = false; break; } }
                            down[i] = all;
                        }
                        foreach (int i in Logic.NewlyPressed(down, wasDown, chords)) Send("{\"t\":\"hotkey\",\"i\":" + i + "}");
                    }

                    tick++;
                    if (tick % fgEvery == 0)
                    {
                        IntPtr h = Native.GetForegroundWindow();
                        uint fpid = 0;
                        Native.GetWindowThreadProcessId(h, out fpid);
                        // Název programu jen když se změnil proces v popředí - jinak z minula.
                        if (fpid != lastPid) { lastPid = fpid; lastExe = Native.ExeName(fpid); }
                        Native.RECT rect;
                        if (!Native.GetWindowRect(h, out rect)) rect = new Native.RECT();
                        Native.MONITORINFO mi = new Native.MONITORINFO();
                        mi.cbSize = (uint)Marshal.SizeOf(typeof(Native.MONITORINFO));
                        IntPtr mon = Native.MonitorFromWindow(h, 2);
                        Native.GetMonitorInfoW(mon, ref mi);
                        int style = Native.GetWindowLong(h, -16);
                        int w = rect.Right - rect.Left;
                        int hh = rect.Bottom - rect.Top;
                        bool fs = Logic.IsFullscreen(w, hh, mi.rcMonitor.Right - mi.rcMonitor.Left, mi.rcMonitor.Bottom - mi.rcMonitor.Top, style);
                        StringBuilder sb = new StringBuilder(256);
                        Native.GetWindowTextW(h, sb, 256);
                        string title = sb.ToString();
                        string fgKey = fpid + "|" + w + "|" + hh + "|" + fs + "|" + title;
                        DateTime nowFg = DateTime.UtcNow;
                        if (fgKey != lastFgKey || (nowFg - lastFgAt).TotalSeconds >= 4)
                        {
                            lastFgKey = fgKey;
                            lastFgAt = nowFg;
                            Send(Logic.FgJson(fpid, lastExe, title, w, hh, fs));
                        }
                    }

                    if (Logic.ProcTick(tick, procEvery))
                    {
                        // Běžící programy + ty s oknem + hra podle Steamu; názvy se pamatují podle PID.
                        uint[] pids = Native.Pids();
                        HashSet<uint> seen = new HashSet<uint>();
                        HashSet<string> exes = new HashSet<string>(StringComparer.Ordinal);
                        foreach (uint p in pids)
                        {
                            seen.Add(p);
                            string n;
                            if (!names.TryGetValue(p, out n)) { n = Native.ExeName(p); names[p] = n; }
                            if (n.Length > 0) exes.Add(n.ToLowerInvariant());
                        }
                        List<uint> gone = new List<uint>();
                        foreach (uint k in names.Keys) if (!seen.Contains(k)) gone.Add(k);
                        foreach (uint k in gone) names.Remove(k);
                        HashSet<string> win = new HashSet<string>(StringComparer.Ordinal);
                        foreach (uint p in Native.WindowedPids())
                        {
                            string n;
                            if (!names.TryGetValue(p, out n) || n.Length == 0) n = Native.ExeName(p);
                            if (n.Length > 0) win.Add(n.ToLowerInvariant());
                        }
                        int steam = Native.SteamAppId();
                        string[] exeArr = Logic.Sorted(exes);
                        string[] winArr = Logic.Sorted(win);
                        string procKey = string.Join(",", exeArr) + "|" + string.Join(",", winArr) + "|" + steam;
                        DateTime nowProc = DateTime.UtcNow;
                        if (procKey != lastProcKey || (nowProc - lastProcAt).TotalSeconds >= 9)
                        {
                            lastProcKey = procKey;
                            lastProcAt = nowProc;
                            Send(Logic.ProcsJson(exeArr, winArr, steam));
                        }
                    }
                }
                catch (Exception e)
                {
                    Send(Logic.ErrJson(e.GetType().Name + ": " + e.Message));
                }
                Thread.Sleep(sleepMs);
            }
        }
    }
}
