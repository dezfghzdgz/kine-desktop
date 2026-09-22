; Doplněk k instalátoru (electron-builder ho přibalí sám).
;
; Dřív si sem instalátor zapisoval svůj název do registru, podle kterého
; appka hádala režim (jeden instalátor, dva názvy). Od 0.5.0 jsou to dvě
; různé appky (Kine do PC a Kine Clipper - scripts/publish-config.mjs),
; takže nic hádat netřeba. Starý klíč se při odinstalaci uklidí.
!macro customInstall
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Kine"
!macroend
