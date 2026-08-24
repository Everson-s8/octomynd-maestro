; F8: custom NSIS macros wired via electron-builder `nsis.include`.
; Adds the installation directory to the USER's PATH so the bundled
; `maestro.cmd` launcher works from any terminal after install, and removes
; it on uninstall.
;
; electron-builder compiles makensis TWICE:
;   pass 1: -DBUILD_UNINSTALLER  -> builds the uninstaller stub
;   pass 2: normal              -> builds the installer
; Installer-side code must not exist in pass 1 and uninstaller-side (un.*)
; code must not exist in pass 2, otherwise warnings 6010/6020 become fatal.

; ---------- shared macro bodies (inert until inserted) ----------
!macro _MaestroPathAdd
  ReadRegStr $R0 HKCU "Environment" "Path"
  StrCpy $R1 ";$R0;"
  StrCpy $R2 ";$INSTDIR;"
  Push $R1
  Push $R2
  Call _MaestroContains
  Pop $R3
  StrCmp $R3 "1" _maestro_path_done 0
    StrCmp $R0 "" _maestro_path_empty 0
      WriteRegExpandStr HKCU "Environment" "Path" "$R0;$INSTDIR"
      Goto _maestro_path_notify
    _maestro_path_empty:
      WriteRegExpandStr HKCU "Environment" "Path" "$INSTDIR"
    _maestro_path_notify:
      SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=2000
  _maestro_path_done:
!macroend

; ---------- hooks (each pass picks up only what it defines) ----------
!ifdef BUILD_UNINSTALLER
!macro customUnInstall
  DetailPrint "Removendo 'maestro' do PATH do usuario..."
  ReadRegStr $R0 HKCU "Environment" "Path"
  StrCmp $R0 "" _maestro_rm_done 0
  Push ";$R0;"
  Push ";$INSTDIR;"
  Call un._MaestroContains
  Pop $R3
  StrCmp $R3 "1" 0 _maestro_rm_done
  Push $R0
  Push "$INSTDIR;"
  Call un._MaestroReplaceAll
  Pop $R0
  Push $R0
  Push ";$INSTDIR"
  Call un._MaestroReplaceAll
  Pop $R0
  WriteRegExpandStr HKCU "Environment" "Path" "$R0"
  SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=2000
  _maestro_rm_done:
!macroend
!else
!macro customInstall
  DetailPrint "Registrando 'maestro' no PATH do usuario..."
  !insertmacro _MaestroPathAdd
!macroend
!endif

; ---------- installer-pass helper ----------
!ifndef BUILD_UNINSTALLER
Function _MaestroContains
  Exch $R1 ; needle
  Exch
  Exch $R0 ; haystack
  Push $R2
  System::Call 'shlwapi::StrStrI(t r0, t r1) t .r2'
  StrCmp $R2 "" 0 _contains_yes
    StrCpy $R2 "0"
    Goto _contains_end
  _contains_yes:
    StrCpy $R2 "1"
  _contains_end:
  Pop $R1
  Pop $R0
  Exch $R2
FunctionEnd
!endif

; ---------- uninstaller-pass helpers ----------
!ifdef BUILD_UNINSTALLER
Function un._MaestroContains
  Exch $R1 ; needle
  Exch
  Exch $R0 ; haystack
  Push $R2
  System::Call 'shlwapi::StrStrI(t r0, t r1) t .r2'
  StrCmp $R2 "" 0 _un_contains_yes
    StrCpy $R2 "0"
    Goto _un_contains_end
  _un_contains_yes:
    StrCpy $R2 "1"
  _un_contains_end:
  Pop $R1
  Pop $R0
  Exch $R2
FunctionEnd

Function un._MaestroReplaceAll
  Exch $R1 ; needle
  Exch
  Exch $R0 ; string
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  _un_replace_loop:
    System::Call 'shlwapi::StrStrI(t r0, t r1) t .r2'
    StrCmp $R2 "" _un_replace_end 0
    StrLen $R3 $R0
    StrLen $R4 $R2
    IntOp $R3 $R3 - $R4          ; prefix length
    StrCpy $R5 $R0 $R3           ; prefix before match
    StrLen $R4 $R1               ; needle length
    IntOp $R3 $R3 + $R4
    StrCpy $R0 $R0 "" $R3        ; remainder after match
    StrCpy $R0 "$R5$R0"
    Goto _un_replace_loop
  _un_replace_end:
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Exch $R0
FunctionEnd
!endif
