; Doplněk k instalátoru (electron-builder ho přibalí sám).
;
; Instalátor si zapíše svůj název souboru do registru. Na webu jsou dva
; odkazy na tentýž instalátor: Kine-Setup.exe (Kine + klipy) a
; Kine-Clipper-Setup.exe (jen klipovač). Appka si to při prvním spuštění
; přečte a v průvodci předvyplní režim.
!macro customInstall
  WriteRegStr HKCU "Software\Kine" "installer" "$EXEFILE"
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Kine"
!macroend
