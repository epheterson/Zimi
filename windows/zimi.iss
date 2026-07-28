; Inno Setup script for Zimi Desktop (Windows).
;
; Produces a per-user installer (no admin/UAC prompt) that WinSparkle can
; download and run to auto-update the app in place. Compiled in CI:
;
;   iscc /DMyAppVersion=1.8.0 windows\zimi.iss
;
; Input : dist\Zimi\        (PyInstaller one-dir output: Zimi.exe + _internal\)
; Output: dist\Zimi-windows-x64-Setup.exe

#ifndef MyAppVersion
  #define MyAppVersion "0.0.0"
#endif

#define MyAppName "Zimi"
#define MyAppPublisher "Zimi"
#define MyAppURL "https://github.com/epheterson/Zimi"
#define MyAppExeName "Zimi.exe"

[Setup]
; Stable AppId — must not change across releases or upgrades won't be detected.
AppId={{6B6F8C2E-3C1A-4E7B-9E4E-5A2D9F1B7C10}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}/releases

; Per-user install: no elevation, so WinSparkle can update without a UAC prompt.
PrivilegesRequired=lowest
DefaultDirName={localappdata}\Programs\{#MyAppName}
DisableProgramGroupPage=yes
DefaultGroupName={#MyAppName}

; x64-only build.
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

; Let the installer close/relaunch a running Zimi during an update.
CloseApplications=yes
RestartApplications=yes

Compression=lzma2
SolidCompression=yes
WizardStyle=modern

OutputDir=..\dist
OutputBaseFilename=Zimi-windows-x64-Setup
SetupIconFile=..\zimi\assets\icon.ico
UninstallDisplayIcon={app}\{#MyAppExeName}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; Whole PyInstaller one-dir tree (Zimi.exe, _internal\, bundled WinSparkle.dll).
Source: "..\dist\Zimi\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
; Relaunch Zimi after install. No `skipifsilent`: WinSparkle runs this installer
; with /SILENT for auto-updates and then quits the old app WITHOUT relaunching
; it (WinSparkle 0.9.4 ShellExecuteEx's the installer, then RequestShutdown),
; so the installer itself must bring the updated app back up — in silent mode too.
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; Flags: nowait postinstall
