/**
 * Skripty PowerShellu pro scripts/podpis.mjs - zvlášť, ať jde zkontrolovat
 * jejich syntaxe i bez Windows (tests/podpis.test.mjs, když je po ruce pwsh).
 * Nic tajného v nich není: jméno, kód a cesty jdou přes proměnné prostředí.
 */

/**
 * Na začátek každého skriptu: chyba = konec (s čitelnou hláškou na stderr
 * a kódem 1, ne CLIXML), bez ukazatele průběhu, výstup v UTF-8.
 */
export const PRELUDE = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
trap { [Console]::Error.WriteLine([string]$_.Exception.Message); exit 1 }
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}`;

/** Azure Artifact Signing: modul TrustedSigning (jako electron-builder). */
export const AZURE_SETUP = `try { Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -Scope CurrentUser | Out-Null } catch {}
Install-Module -Name TrustedSigning -MinimumVersion 0.5.0 -Force -Repository PSGallery -Scope CurrentUser`;

/** Podpis souborů přes Azure ($env:KINE_SIGN_FILES = cesty oddělené čárkou). */
export const AZURE_SIGN = `Invoke-TrustedSigning -Endpoint $env:AZURE_SIGN_ENDPOINT -CodeSigningAccountName $env:AZURE_SIGN_ACCOUNT -CertificateProfileName $env:AZURE_SIGN_PROFILE -TimestampRfc3161 'http://timestamp.acs.microsoft.com' -TimestampDigest SHA256 -FileDigest SHA256 -Files $env:KINE_SIGN_FILES`;

/** Podpis jednoho souboru ($env:KINE_FILE) -> {Status, Subject}. */
export const FILE_SIGNATURE = `$s = Get-AuthenticodeSignature -LiteralPath $env:KINE_FILE
[pscustomobject]@{ Status = [string]$s.Status; Subject = [string]$s.SignerCertificate.Subject } | ConvertTo-Json -Compress`;

/** Okno SimplySign (přihlašovací nebo jeho hláška). */
const WINDOW_FILTER = `Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -and ($_.MainWindowTitle -like '*SimplySign*' -or $_.ProcessName -like '*SimplySign*') }`;

export const SIMPLYSIGN_WINDOW = `${WINDOW_FILTER} | Select-Object -First 1 -Property Id, ProcessName, MainWindowTitle | ConvertTo-Json -Compress`;

/** Všechna okna s titulkem (jen program + titulek) - do logu, když přihlášení nejde. */
export const WINDOW_LIST = `@(Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object -Property ProcessName, MainWindowTitle) | ConvertTo-Json -Compress`;

export const MINIMIZE_ALL = `(New-Object -ComObject Shell.Application).MinimizeAll()`;

/**
 * Okno SimplySign dopředu (funkce Activate vrací $true, jen když je opravdu
 * v popředí - jinak by klávesy šly jinam) a pak kroky (SendKeys).
 * Kód 3 = okno se nepodařilo dostat dopředu, nic se nenapsalo.
 */
export function typeKeys(steps) {
  return `Add-Type -ErrorAction SilentlyContinue @"
using System;
using System.Runtime.InteropServices;
public static class KinePodpisOkno {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
$shell = New-Object -ComObject WScript.Shell
function Activate {
  for ($i = 0; $i -lt 5; $i++) {
    $p = ${WINDOW_FILTER} | Select-Object -First 1
    if ($p) {
      [void][KinePodpisOkno]::ShowWindow($p.MainWindowHandle, 9)
      [void][KinePodpisOkno]::SetForegroundWindow($p.MainWindowHandle)
      [void]$shell.AppActivate($p.Id)
      Start-Sleep -Milliseconds 400
      $front = [uint32]0
      [void][KinePodpisOkno]::GetWindowThreadProcessId([KinePodpisOkno]::GetForegroundWindow(), [ref]$front)
      if ($front -eq $p.Id) { return $true }
    } else {
      Start-Sleep -Milliseconds 400
    }
  }
  return $false
}
function RequireFront {
  if (-not (Activate)) { [Console]::Error.WriteLine('okno SimplySign neni v popredi'); exit 3 }
}
${steps}`;
}

/** Jméno ($env:KINE_SK_USER, už escapované pro SendKeys), Tab, kód ($env:KINE_SK_CODE), Enter. */
export const TYPE_CREDENTIALS = `RequireFront
$shell.SendKeys('^a'); Start-Sleep -Milliseconds 150
$shell.SendKeys($env:KINE_SK_USER); Start-Sleep -Milliseconds 250
$shell.SendKeys('{TAB}'); Start-Sleep -Milliseconds 250
$shell.SendKeys('^a'); Start-Sleep -Milliseconds 150
$shell.SendKeys($env:KINE_SK_CODE); Start-Sleep -Milliseconds 250
RequireFront
$shell.SendKeys('{ENTER}')`;

/** SimplySign Desktop úplně zavřít (před dalším pokusem o přihlášení a na konci). */
export const KILL_SIMPLYSIGN = `Get-Process | Where-Object { $_.ProcessName -like '*SimplySign*' } | Stop-Process -Force -ErrorAction SilentlyContinue`;

/** Certifikáty uživatele (Cert:\\CurrentUser\\My) -> pole pro pickCertificate. */
export const LIST_CERTIFICATES = `@(Get-ChildItem -Path Cert:\\CurrentUser\\My | ForEach-Object {
  [pscustomobject]@{
    Thumbprint = $_.Thumbprint
    Subject = $_.Subject
    Issuer = $_.Issuer
    HasPrivateKey = $_.HasPrivateKey
    NotAfter = $_.NotAfter.ToString('o')
    Eku = @($_.EnhancedKeyUsageList | ForEach-Object { [string]$_.ObjectId })
  }
}) | ConvertTo-Json -Compress -Depth 4`;

/** Podpisy souborů ze seznamu ($env:KINE_LIST, jeden na řádek) -> pole řádků pro summarizeSignatures. */
export const AUTHENTICODE_LIST = `@(Get-Content -LiteralPath $env:KINE_LIST -Encoding UTF8 | Where-Object { $_ } | ForEach-Object {
  $s = Get-AuthenticodeSignature -LiteralPath $_
  [pscustomobject]@{
    Path = $_
    Status = [string]$s.Status
    Signer = [string]$s.SignerCertificate.Subject
    Thumbprint = [string]$s.SignerCertificate.Thumbprint
    TimeStamped = ($null -ne $s.TimeStamperCertificate)
  }
}) | ConvertTo-Json -Compress -Depth 3`;

/** Konec relace SimplySign: program pryč, certifikáty Certum z úložiště pryč. */
export const LOGOUT = `${KILL_SIMPLYSIGN}
Get-ChildItem -Path Cert:\\CurrentUser\\My | Where-Object { $_.Issuer -like '*Certum*' } | Remove-Item -Force -ErrorAction SilentlyContinue`;

/** Všechny skripty (pro kontrolu syntaxe). */
export const ALL_SCRIPTS = {
  PRELUDE,
  AZURE_SETUP,
  AZURE_SIGN,
  FILE_SIGNATURE,
  SIMPLYSIGN_WINDOW,
  WINDOW_LIST,
  MINIMIZE_ALL,
  TYPE_CREDENTIALS: typeKeys(TYPE_CREDENTIALS),
  KILL_SIMPLYSIGN,
  LIST_CERTIFICATES,
  AUTHENTICODE_LIST,
  LOGOUT,
};
