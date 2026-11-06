; Konclave NSIS hooks (bundle > windows > nsis > installerHooks in tauri.conf.json).
;
; The uninstaller's "Delete the application data" box runs RmDir /r on
; %LOCALAPPDATA%\app.konclave.desktop, which holds the WebView profile, and the sealed key share of
; every vault on this computer lives in that profile. The label is Tauri's and a hook cannot change
; it (the language files are included after this one), so this asks again, in plain words, before
; anything is deleted.
;
; PREUNINSTALL runs at the start of the uninstall section, after the confirm page has read the box.
; "No" clears the choice: the app is uninstalled and the vaults stay, so a later install finds them.
; A silent uninstall answers No (/SD IDNO). An uninstall run by an update (/UPDATE) never deletes
; app data, and is not asked.
;
; $DeleteAppDataCheckboxState and $UpdateMode are variables of Tauri's NSIS template, read in
; tauri-bundler 2.10.4 (pinned exactly by tauri-cli 2.12.4, which desktop-release.yml installs).
; makensis only warns on an unknown variable, so src-tauri/tests/config_contract.rs ties this file
; to that pin.

!macro NSIS_HOOK_PREUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 \
      "You ticked $\"Delete the application data$\".$\r$\n$\r$\n\
This deletes the vaults stored on this computer, with this computer's key share for each \
of them. Without an export, this computer can no longer approve or sign for those vaults.$\r$\n$\r$\n\
Export each vault first: open Konclave, Settings, $\"Export this vault$\", and keep the file \
somewhere safe.$\r$\n$\r$\n\
Delete the vaults stored on this computer?$\r$\n\
Yes: uninstall and delete them.$\r$\n\
No: uninstall and keep them." \
      /SD IDNO IDYES konclave_delete_confirmed
    StrCpy $DeleteAppDataCheckboxState 0
    konclave_delete_confirmed:
  ${EndIf}
!macroend
