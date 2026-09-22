import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from './log';

/**
 * Pomocník pro Windows: jeden dlouho běžící PowerShell, který se ptá
 * Windows na věci, ke kterým se Electron nedostane:
 *
 *  - které okno je v popředí (proces, titulek, jestli je přes celou
 *    obrazovku bez rámečku) - podle toho appka pozná, kterou hru hráč
 *    opravdu hraje, když běží víc programů (CS2 vs. Roblox na pozadí);
 *  - které procesy mají vlastní okno;
 *  - stav kláves a tlačítek myši (GetAsyncKeyState) - zkratky z více
 *    kláves ("F8+F9") a boční tlačítka myši, které systémová zkratka
 *    Electronu neumí.
 *
 * Skript se zapíše do userData a spustí jednou; mluví po řádcích JSON na
 * stdout. Když spadne, po chvíli se rozjede znovu; když padá pořád,
 * appka se bez něj obejde (hry podle seznamu a Steamu, jednoduché zkratky).
 */

export type ForegroundInfo = {
  pid: number;
  /** Název programu malými písmeny s .exe, např. "cs2.exe"; prázdné, když ho nejde zjistit. */
  exe: string;
  title: string;
  width: number;
  height: number;
  /** Okno kryje celý monitor a nemá rámeček (borderless / exclusive fullscreen). */
  fullscreen: boolean;
  at: number;
};

type Listener = {
  hotkey?: (index: number) => void;
  foreground?: (info: ForegroundInfo) => void;
  windows?: (exes: Set<string>) => void;
  state?: (running: boolean) => void;
};

const SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
# Vsechno, co se pta Windows, je v C# (zkompiluje se jednou pri startu):
# levne volani API misto Get-Process, ktery pro kazdy proces stavi objekty.
Add-Type -Namespace KineWin -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
[DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfoW(IntPtr hMonitor, ref MONITORINFO info);
[DllImport("user32.dll", EntryPoint = "GetWindowLongW")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, System.Text.StringBuilder text, int count);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
[DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
[DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
[DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool QueryFullProcessImageNameW(IntPtr handle, uint flags, System.Text.StringBuilder name, ref uint size);
[DllImport("psapi.dll")] public static extern bool EnumProcesses([Out] uint[] pids, uint size, out uint needed);
public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
[StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public uint cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }

/* Ovladac (Xbox / XInput): xinput1_4.dll je na Windows 8+, xinput9_1_0.dll vsude jako zaloha. */
[DllImport("xinput1_4.dll", EntryPoint = "XInputGetState")] public static extern uint XInputGetState14(uint index, out XINPUT_STATE state);
[DllImport("xinput9_1_0.dll", EntryPoint = "XInputGetState")] public static extern uint XInputGetState910(uint index, out XINPUT_STATE state);
[StructLayout(LayoutKind.Sequential)] public struct XINPUT_GAMEPAD { public ushort wButtons; public byte bLeftTrigger; public byte bRightTrigger; public short sThumbLX; public short sThumbLY; public short sThumbRX; public short sThumbRY; }
[StructLayout(LayoutKind.Sequential)] public struct XINPUT_STATE { public uint dwPacketNumber; public XINPUT_GAMEPAD Gamepad; }
/* -1 = jeste nevime, 1 = xinput1_4, 0 = xinput9_1_0, -2 = XInput tu neni (zadne dalsi pokusy). */
static int xinputDll = -1;
static bool[] padConnected = new bool[4];

static uint PadState(uint index, out XINPUT_STATE state) {
  if (xinputDll != 0) {
    try { uint rc = XInputGetState14(index, out state); xinputDll = 1; return rc; }
    catch (DllNotFoundException) { if (xinputDll == 1) throw; xinputDll = 0; }
    catch (EntryPointNotFoundException) { if (xinputDll == 1) throw; xinputDll = 0; }
  }
  return XInputGetState910(index, out state);
}

/* Stisknuta tlacitka na vsech pripojenych ovladacich dohromady (maska wButtons; spouste jako 0x10000 / 0x20000).
   Odpojene sloty se zkouseji jen obcas (XInput je u prazdneho slotu pomaly). -1 = XInput neni. */
public static int PadButtons(int tick) {
  if (xinputDll == -2) return -1;
  int result = 0;
  for (uint i = 0; i < 4; i++) {
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

/* Nazev programu (jen soubor, napr. "cs2.exe") - PROCESS_QUERY_LIMITED_INFORMATION staci i na procesy bezici jako spravce. */
public static string ExeName(uint pid) {
  if (pid == 0) return "";
  IntPtr h = OpenProcess(0x1000, false, pid);
  if (h == IntPtr.Zero) return "";
  try {
    System.Text.StringBuilder sb = new System.Text.StringBuilder(1024);
    uint size = 1024;
    if (!QueryFullProcessImageNameW(h, 0, sb, ref size)) return "";
    string path = sb.ToString();
    int i = path.LastIndexOfAny(new char[] { '\\', '/' });
    return i >= 0 ? path.Substring(i + 1) : path;
  } finally { CloseHandle(h); }
}
public static uint[] Pids() {
  uint[] buf = new uint[8192];
  uint needed = 0;
  if (!EnumProcesses(buf, (uint)(buf.Length * 4), out needed)) return new uint[0];
  int count = (int)(needed / 4);
  uint[] result = new uint[count];
  Array.Copy(buf, result, count);
  return result;
}
/* Procesy, ktere maji viditelne okno nahore (misto MainWindowHandle, ktery prochazi okna pro kazdy proces zvlast). */
public static uint[] WindowedPids() {
  System.Collections.Generic.HashSet<uint> pids = new System.Collections.Generic.HashSet<uint>();
  EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
    if (IsWindowVisible(hWnd)) { uint p = 0; GetWindowThreadProcessId(hWnd, out p); if (p != 0) pids.Add(p); }
    return true;
  }, IntPtr.Zero);
  uint[] result = new uint[pids.Count];
  pids.CopyTo(result);
  return result;
}
'@

# Zkratky: "119;17,120" = F8 a Ctrl+F9 (virtual-key kody). Kody od 0x100000 vys
# jsou tlacitka ovladace (0x100000 + maska XInput) - viz shared/hotkeys.ts.
$chords = @()
$usePad = $false
if ($env:KINE_HOTKEYS) {
  foreach ($g in ($env:KINE_HOTKEYS -split ';')) {
    if ($g) {
      $chord = [int[]]($g -split ',')
      $chords += ,$chord
      foreach ($vk in $chord) { if ($vk -ge 0x100000) { $usePad = $true } }
    }
  }
}
$wasDown = New-Object bool[] ([Math]::Max(1, $chords.Count))
$pad = 0

# Rychla smycka (30 ms) jen kdyz je co hlidat - kombinace klaves nebo tlacitka
# mysi. Bez nich staci jedno kolo za sekundu; popredi se hlasi kazdou
# sekundu, seznam procesu kazdych ~5 s. Setri to procesor pri hrani.
$fast = $chords.Count -gt 0
$sleepMs = 1000
$fgEvery = 1
$procEvery = 5
if ($fast) { $sleepMs = 30; $fgEvery = 33; $procEvery = 166 }
$tick = 0
$lastPid = [uint32]0
$lastExe = ''
$names = @{}
Write-Output '{"t":"ready"}'

function KeyDown($vk) {
  if ($vk -ge 0x100000) {
    # Tlacitko ovladace: stav se cte jednou za kolo do $pad (PadButtons); -1 = ovladac tu neni.
    $m = $vk - 0x100000
    return ($script:pad -ge 0) -and (($script:pad -band $m) -eq $m)
  }
  if ($vk -eq 0x5B) {
    return ((([KineWin.Native]::GetAsyncKeyState(0x5B)) -band 0x8000) -ne 0) -or ((([KineWin.Native]::GetAsyncKeyState(0x5C)) -band 0x8000) -ne 0)
  }
  return (([KineWin.Native]::GetAsyncKeyState($vk)) -band 0x8000) -ne 0
}

while ($true) {
  try {
    if ($fast) {
      if ($usePad) { $script:pad = [KineWin.Native]::PadButtons($tick) }
      $down = New-Object bool[] $chords.Count
      for ($i = 0; $i -lt $chords.Count; $i++) {
        $all = $true
        foreach ($vk in $chords[$i]) { if (-not (KeyDown $vk)) { $all = $false; break } }
        $down[$i] = $all
      }
      for ($i = 0; $i -lt $chords.Count; $i++) {
        if ($down[$i] -and -not $wasDown[$i]) {
          # Kdyz je stisknuta i delsi kombinace, ktera tuhle obsahuje (F8 vs Ctrl+F8), vyhrava ta delsi.
          $shadowed = $false
          for ($j = 0; $j -lt $chords.Count; $j++) {
            if ($j -ne $i -and $down[$j] -and $chords[$j].Count -gt $chords[$i].Count) {
              $subset = $true
              foreach ($vk in $chords[$i]) { if ($chords[$j] -notcontains $vk) { $subset = $false; break } }
              if ($subset) { $shadowed = $true; break }
            }
          }
          if (-not $shadowed) { Write-Output ('{"t":"hotkey","i":' + $i + '}') }
        }
        $wasDown[$i] = $down[$i]
      }
    }

    $tick++
    if ($tick % $fgEvery -eq 0) {
      $h = [KineWin.Native]::GetForegroundWindow()
      $fpid = [uint32]0
      [void][KineWin.Native]::GetWindowThreadProcessId($h, [ref]$fpid)
      # Nazev programu jen kdyz se zmenil proces v popredi - jinak z minula.
      if ($fpid -ne $lastPid) { $lastPid = $fpid; $lastExe = [KineWin.Native]::ExeName($fpid) }
      $rect = New-Object KineWin.Native+RECT
      [void][KineWin.Native]::GetWindowRect($h, [ref]$rect)
      $mi = New-Object KineWin.Native+MONITORINFO
      $mi.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($mi)
      $mon = [KineWin.Native]::MonitorFromWindow($h, 2)
      [void][KineWin.Native]::GetMonitorInfoW($mon, [ref]$mi)
      $style = [KineWin.Native]::GetWindowLong($h, -16)
      $caption = ($style -band 0x00C00000) -ne 0
      $w = $rect.Right - $rect.Left
      $hh = $rect.Bottom - $rect.Top
      $mw = $mi.rcMonitor.Right - $mi.rcMonitor.Left
      $mh = $mi.rcMonitor.Bottom - $mi.rcMonitor.Top
      $fs = ($mw -gt 0) -and ($w -ge $mw) -and ($hh -ge $mh) -and (-not $caption)
      $sb = New-Object System.Text.StringBuilder 256
      [void][KineWin.Native]::GetWindowTextW($h, $sb, 256)
      $o = @{ t = 'fg'; pid = [int]$fpid; exe = [string]$lastExe; title = $sb.ToString(); w = [int]$w; h = [int]$hh; fs = [bool]$fs }
      Write-Output ($o | ConvertTo-Json -Compress)
    }
    if ($tick % $procEvery -eq 1) {
      # Bezici programy + ty s oknem + hra podle Steamu - jednou za ~5 s, vsechno
      # z API (zadny tasklist ani Get-Process). Nazvy se pamatuji podle PID.
      $pids = [KineWin.Native]::Pids()
      $seen = @{}
      $exes = New-Object System.Collections.Generic.HashSet[string]
      foreach ($p in $pids) {
        $seen[$p] = $true
        if (-not $names.ContainsKey($p)) { $names[$p] = [KineWin.Native]::ExeName($p) }
        $n = $names[$p]
        if ($n) { [void]$exes.Add($n.ToLowerInvariant()) }
      }
      foreach ($k in @($names.Keys)) { if (-not $seen.ContainsKey($k)) { $names.Remove($k) } }
      $win = New-Object System.Collections.Generic.HashSet[string]
      foreach ($p in [KineWin.Native]::WindowedPids()) {
        $n = $names[$p]
        if (-not $n) { $n = [KineWin.Native]::ExeName($p) }
        if ($n) { [void]$win.Add($n.ToLowerInvariant()) }
      }
      $steam = 0
      try { $steam = [int](Get-ItemProperty -Path 'HKCU:\Software\Valve\Steam' -Name RunningAppID -ErrorAction Stop).RunningAppID } catch {}
      $o = @{ t = 'procs'; exes = [string[]]@($exes); win = [string[]]@($win); steam = $steam }
      Write-Output ($o | ConvertTo-Json -Compress)
    }
  } catch {
    Write-Output ('{"t":"err","m":' + (ConvertTo-Json ([string]$_)) + '}')
  }
  Start-Sleep -Milliseconds $sleepMs
}
`;

export class WinHelper {
  private proc: ChildProcess | null = null;
  private running = false;
  private chords: number[][] = [];
  private listeners = new Set<Listener>();
  private lastForeground: ForegroundInfo | null = null;
  private windowed = new Set<string>();
  /** Běžící programy a hra podle Steamu z pomocníka (jednou za ~5 s) - appka pak nemusí spouštět tasklist ani reg. */
  private procs: Set<string> | null = null;
  private procsAt = 0;
  private steam = 0;
  private failures: number[] = [];
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private buffer = '';

  constructor(private userDataDir: string) {}

  static supported(): boolean {
    return process.platform === 'win32';
  }

  /** Běží pomocník teď? */
  isRunning(): boolean {
    return this.running;
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  foreground(): ForegroundInfo | null {
    // Stará informace je horší než žádná (pomocník spadl, hráč mezitím přepnul).
    if (this.lastForeground && Date.now() - this.lastForeground.at > 8000) return null;
    return this.lastForeground;
  }

  /** Programy, které mají vlastní okno (malými písmeny s .exe). */
  windowedProcesses(): Set<string> {
    return this.windowed;
  }

  /** Všechny běžící programy podle pomocníka, nebo null, když je seznam starý či podezřele krátký (pak se ptá tasklist). */
  processes(): Set<string> | null {
    if (!this.procs || Date.now() - this.procsAt > 15000 || this.procs.size < 5) return null;
    return this.procs;
  }

  /** RunningAppID Steamu z pomocníka (0 = žádná hra), nebo null, když pomocník nic čerstvého nemá. */
  steamAppId(): number | null {
    if (!this.procs || Date.now() - this.procsAt > 15000) return null;
    return this.steam;
  }

  start(): void {
    if (!WinHelper.supported()) return;
    this.stopped = false;
    if (!this.proc) this.spawn();
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.kill();
  }

  /** Zkratky pro pomocníka (virtual-key kódy); změna = restart skriptu (trvá ~1 s). */
  setHotkeys(chords: number[][]): void {
    const same = JSON.stringify(chords) === JSON.stringify(this.chords);
    this.chords = chords;
    if (!WinHelper.supported() || this.stopped) return;
    if (!same || !this.proc) {
      this.failures = [];
      this.kill();
      this.spawn();
    }
  }

  private scriptPath(): string {
    const dir = join(this.userDataDir, 'helper');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'kine-helper.ps1');
    writeFileSync(file, SCRIPT.replace(/\n/g, '\r\n'), 'utf8');
    return file;
  }

  private spawn(): void {
    if (this.proc) return;
    let file: string;
    try {
      file = this.scriptPath();
    } catch (e) {
      log(`pomocník: skript se nepodařilo zapsat: ${(e as Error).message}`);
      return;
    }
    const hotkeys = this.chords.map((c) => c.join(',')).join(';');
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', file], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, KINE_HOTKEYS: hotkeys },
    });
    this.proc = proc;
    this.buffer = '';
    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => this.onData(chunk));
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (chunk: string) => log(`pomocník stderr: ${chunk.trim().slice(0, 300)}`));
    proc.on('error', (e) => {
      log(`pomocník se nespustil: ${e.message}`);
      this.onExit();
    });
    proc.on('exit', (code) => {
      log(`pomocník skončil (${code})`);
      this.onExit();
    });
  }

  private kill(): void {
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      proc.removeAllListeners('exit');
      proc.removeAllListeners('error');
      try {
        proc.kill();
      } catch {
        // už neběží
      }
    }
    this.setRunning(false);
  }

  private onExit(): void {
    this.proc = null;
    this.setRunning(false);
    if (this.stopped) return;
    const now = Date.now();
    this.failures = this.failures.filter((t) => now - t < 120000);
    this.failures.push(now);
    if (this.failures.length > 5) {
      log('pomocník padá pořád - appka pojede bez něj (zkusí to znovu za 10 minut)');
      this.restartTimer = setTimeout(() => {
        this.failures = [];
        this.spawn();
      }, 10 * 60 * 1000);
      return;
    }
    this.restartTimer = setTimeout(() => this.spawn(), 2000 * this.failures.length);
  }

  private setRunning(value: boolean): void {
    if (this.running === value) return;
    this.running = value;
    if (!value) {
      // Bez pomocníka se seznam procesů zase bere z tasklist.
      this.procs = null;
      this.lastForeground = null;
    }
    for (const l of this.listeners) l.state?.(value);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    switch (msg?.t) {
      case 'ready':
        this.setRunning(true);
        break;
      case 'hotkey': {
        const index = Number(msg.i);
        if (Number.isInteger(index)) for (const l of this.listeners) l.hotkey?.(index);
        break;
      }
      case 'fg': {
        const info: ForegroundInfo = {
          pid: Number(msg.pid) || 0,
          exe: normalizeExe(msg.exe),
          title: typeof msg.title === 'string' ? msg.title : '',
          width: Number(msg.w) || 0,
          height: Number(msg.h) || 0,
          fullscreen: Boolean(msg.fs),
          at: Date.now(),
        };
        this.lastForeground = info;
        for (const l of this.listeners) l.foreground?.(info);
        break;
      }
      case 'win': {
        const list = Array.isArray(msg.exes) ? msg.exes : typeof msg.exes === 'string' ? [msg.exes] : [];
        this.windowed = new Set(list.map((x: unknown) => normalizeExe(x)).filter(Boolean));
        for (const l of this.listeners) l.windows?.(this.windowed);
        break;
      }
      case 'procs': {
        // ConvertTo-Json dělá z jednoprvkového pole holý řetězec - proto obojí.
        const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []);
        this.procs = new Set(arr(msg.exes).map((x) => normalizeExe(x)).filter(Boolean));
        this.procsAt = Date.now();
        this.steam = Number.isInteger(msg.steam) ? Number(msg.steam) : 0;
        this.windowed = new Set(arr(msg.win).map((x) => normalizeExe(x)).filter(Boolean));
        for (const l of this.listeners) l.windows?.(this.windowed);
        break;
      }
      case 'err':
        log(`pomocník: ${String(msg.m).slice(0, 300)}`);
        break;
    }
  }
}

/** "Cs2" / "cs2.exe" -> "cs2.exe" (jako tasklist). */
export function normalizeExe(name: unknown): string {
  if (typeof name !== 'string' || !name.trim()) return '';
  const lower = name.trim().toLowerCase();
  return lower.endsWith('.exe') ? lower : `${lower}.exe`;
}
