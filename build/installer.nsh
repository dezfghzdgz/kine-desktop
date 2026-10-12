; Doplněk k instalátoru (electron-builder ho přibalí sám).
;
; Hlavně bezpečná aktualizace. electron-builder při aktualizaci nejdřív
; odinstaluje starou verzi a teprve potom rozbalí novou. Když se nová
; nerozbalí (Windows Smart App Control nebo antivir zablokuje část
; instalátoru - "Část této aplikace byla zablokována"), zůstane hráč bez
; appky a se zástupcem, který ukazuje do prázdna ("Problém se
; zástupcem"). Proto tady:
;
;  1. nová verze se rozbalí a zkontroluje DŘÍV, než se stará smaže; když
;     to nejde, stará verze zůstane, znovu se spustí a appka po startu řekne
;     proč (výsledek v %LOCALAPPDATA%\<appka>-updater\installer-result.txt),
;  2. když starou verzi nejde odinstalovat (soubor drží jiný program),
;     zůstane a spustí se znovu (místo tichého konce bez appky),
;  3. po instalaci se zkontroluje, že appka opravdu je na disku,
;  4. zástupci, kteří před aktualizací byli a během ní zmizeli (Windows
;     nabídne smazat zástupce, na kterého někdo klikne zrovna ve chvíli,
;     kdy se soubory vyměňují), se vytvoří znovu.
;
; Pozor: electron-builder překládá s -WX (varování = chyba) - žádné
; nepoužité proměnné ani funkce. Instalátor je jen anglicky, proto
; anglické hlášky. Vyzkoušené pod wine (README, Novinky 0.9.9).

; Vlastní kontrola běžící appky (níž) vypne v šabloně tyhle dvě věci - doplnit.
!include "getProcessInfo.nsh"
Var pid

!ifndef BUILD_UNINSTALLER
  Var kineTmp
  Var kineOutDir
  Var kineHadDesktopLink
  Var kineHadStartMenuLink
!endif

; Výsledek pro appku: result=ok | blocked | in-use | files-missing
!macro kineWriteResult RESULT
  CreateDirectory "$LOCALAPPDATA\${APP_PACKAGE_NAME}-updater"
  ClearErrors
  FileOpen $kineTmp "$LOCALAPPDATA\${APP_PACKAGE_NAME}-updater\installer-result.txt" w
  ${ifNot} ${Errors}
    FileWrite $kineTmp "result=${RESULT}$\r$\nversion=${VERSION}$\r$\n"
    FileClose $kineTmp
  ${endIf}
  ClearErrors
!macroend

; Po volání pluginu: ze zásobníku pryč všechno až po značku. Když Windows
; DLL pluginu zablokuje, jeho parametry na zásobníku zůstanou a rozhodily
; by další Pop.
!macro kineDropToMark
  ${Do}
    ClearErrors
    Pop $kineTmp
    ${If} ${Errors}
      ${ExitDo}
    ${EndIf}
  ${LoopUntil} $kineTmp == "kine-stack-mark"
  ClearErrors
!macroend

; Aktualizace se nepovedla a stará verze je celá na disku: nechat ji a
; skončit. Když si hráč aktualizaci vyžádal (--force-run = tlačítko
; Aktualizovat), dozví se proč a appka se mu zase spustí; tichá instalace
; po ukončení appky (bez --force-run) appku znovu nespouští.
!macro kineKeepOld RESULT MESSAGE
  DetailPrint "Kine: update stopped (${RESULT}), the installed version is kept"
  !insertmacro kineWriteResult "${RESULT}"
  RMDir /r "$PLUGINSDIR\7z-out"
  ${ifNot} ${Silent}
  ${orIf} ${isForceRun}
    MessageBox MB_OK|MB_ICONEXCLAMATION "${MESSAGE}"
  ${endIf}
  ${if} ${isForceRun}
    Exec '"$appExe"'
  ${endIf}
  SetErrorLevel 2
  Quit
!macroend

; Zapamatovat si zástupce před aktualizací (setLinkVars už proběhlo).
!macro kineRememberShortcuts
  StrCpy $kineHadDesktopLink "0"
  ${if} ${FileExists} "$oldDesktopLink"
  ${orIf} ${FileExists} "$newDesktopLink"
    StrCpy $kineHadDesktopLink "1"
  ${endIf}
  StrCpy $kineHadStartMenuLink "0"
  ${if} ${FileExists} "$oldStartMenuLink"
  ${orIf} ${FileExists} "$newStartMenuLink"
    StrCpy $kineHadStartMenuLink "1"
  ${endIf}
!macroend

; Nové soubory se rozbalí do $PLUGINSDIR\7z-out (tam, kam je pak rozbalí
; i electron-builder) a zkontrolují - ještě než se stará verze odinstaluje.
!macro kinePrepareNewFiles
  !ifdef APP_64
  !ifndef ZIP_COMPRESSION
  !ifndef APP_PACKAGE_URL
    InitPluginsDir
    !ifdef COMPRESS
      SetCompress off
    !endif
    File /oname=$PLUGINSDIR\app-64.${COMPRESSION_METHOD} "${APP_64}"
    !ifdef COMPRESS
      SetCompress "${COMPRESS}"
    !endif
    RMDir /r "$PLUGINSDIR\7z-out"
    CreateDirectory "$PLUGINSDIR\7z-out"
    StrCpy $kineOutDir $OUTDIR
    SetOutPath "$PLUGINSDIR\7z-out"
    Push "kine-stack-mark"
    Nsis7z::Extract "$PLUGINSDIR\app-64.${COMPRESSION_METHOD}"
    !insertmacro kineDropToMark
    SetOutPath $kineOutDir
    ${ifNot} ${FileExists} "$PLUGINSDIR\7z-out\${APP_EXECUTABLE_FILENAME}"
    ${orIfNot} ${FileExists} "$PLUGINSDIR\7z-out\resources\app.asar"
      ${if} ${FileExists} "$appExe"
        !insertmacro kineKeepOld "blocked" "Windows blocked part of the ${PRODUCT_NAME} installer (Smart App Control or an antivirus), so the update was not installed.$\r$\n$\r$\nYour current version of ${PRODUCT_NAME} was kept and keeps working."
      ${else}
        !insertmacro kineWriteResult "blocked"
        RMDir /r "$PLUGINSDIR\7z-out"
        MessageBox MB_OK|MB_ICONEXCLAMATION "Windows blocked part of the ${PRODUCT_NAME} installer (Smart App Control or an antivirus), so ${PRODUCT_NAME} could not be installed. Nothing was changed.$\r$\n$\r$\nIf Smart App Control is on, you can turn it off in Windows Security > App & browser control > Smart App Control settings and run the installer again."
        SetErrorLevel 2
        Quit
      ${endIf}
    ${endIf}
  !endif
  !endif
  !endif
!macroend

!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
  !ifndef BUILD_UNINSTALLER
    !insertmacro kineRememberShortcuts
    !insertmacro kinePrepareNewFiles
  !endif
!macroend

; Výsledek odinstalace staré verze (místo výchozí kontroly, která při chybě
; jen skončí - appka by zůstala zavřená a hráč by nevěděl proč).
!macro customUnInstallCheck
  ${if} ${Errors}
    ; Starý odinstalátor nejde spustit (třeba ho Windows zablokuje) - nové
    ; soubory se zapíšou přes ty staré.
    DetailPrint "Uninstall was not successful. Not able to launch uninstaller!"
    ClearErrors
  ${elseIf} $R0 != 0
    ${if} ${FileExists} "$appExe"
      ; Soubory drží jiný program; odinstalátor je vrátil zpátky.
      !insertmacro kineKeepOld "in-use" "${PRODUCT_NAME} could not replace its files because some of them are still in use by another program, so the update was not installed.$\r$\n$\r$\nYour current version of ${PRODUCT_NAME} was kept and keeps working. The update will be offered again."
    ${endIf}
    ; Stará verze už na disku není - instalace pokračuje (nové soubory jsou ověřené).
    DetailPrint "Old version could not be removed cleanly ($R0), installing over it"
  ${endIf}
!macroend

; Po instalaci (soubory jsou rozbalené, zástupci hotoví).
!macro customInstall
  ; Appka musí být na disku. Kdyby ji něco hned po zapsání odstranilo,
  ; zkusí se ji ještě jednou zkopírovat z připravené kopie.
  ${ifNot} ${FileExists} "$appExe"
  ${orIfNot} ${FileExists} "$INSTDIR\resources\app.asar"
    Sleep 1500
    ClearErrors
    CopyFiles /SILENT "$PLUGINSDIR\7z-out\*" "$INSTDIR"
    ClearErrors
  ${endIf}
  ${ifNot} ${FileExists} "$appExe"
  ${orIfNot} ${FileExists} "$INSTDIR\resources\app.asar"
    !insertmacro kineWriteResult "files-missing"
    ; Bez /SD - tohle se ukáže i při tiché instalaci (jinak by hráč o ničem nevěděl).
    MessageBox MB_OK|MB_ICONSTOP "Windows or an antivirus removed or blocked ${APP_EXECUTABLE_FILENAME} while ${PRODUCT_NAME} was being installed, so the installation is not complete.$\r$\n$\r$\nCheck Windows Security > Virus & threat protection > Protection history, then download ${PRODUCT_NAME} again from the Kine website."
    SetErrorLevel 2
    Quit
  ${endIf}

  ; Zástupci, kteří tu před aktualizací byli a během ní zmizeli.
  !ifndef DO_NOT_CREATE_DESKTOP_SHORTCUT
    ${if} $kineHadDesktopLink == "1"
    ${andIfNot} ${FileExists} "$newDesktopLink"
    ${andIfNot} ${isNoDesktopShortcut}
      CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      Push "kine-stack-mark"
      WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
      !insertmacro kineDropToMark
    ${endIf}
  !endif
  !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
    ${if} $kineHadStartMenuLink == "1"
    ${andIfNot} ${FileExists} "$newStartMenuLink"
      !ifdef MENU_FILENAME
        CreateDirectory "$SMPROGRAMS\${MENU_FILENAME}"
      !endif
      CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      Push "kine-stack-mark"
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
      !insertmacro kineDropToMark
    ${endIf}
  !endif

  !insertmacro kineWriteResult "ok"
!macroend

; Starý klíč z doby, kdy si sem instalátor zapisoval svůj název (do 0.4.x).
!macro customUnInstall
  DeleteRegKey HKCU "Software\Kine"
!macroend
