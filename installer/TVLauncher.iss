; TVLauncher installer.
;
; Installs to the per-user program folder rather than Program Files. The launcher writes its own
; data next to nothing important, needs no elevation, and belongs to one person — so an
; administrator prompt on install would be asking for rights it does not use. It also means the
; uninstaller can remove everything it created without leaving per-user leftovers behind.

#define AppName "TVLauncher"
#define AppVersion "1.0.0"
#define AppPublisher "TVLauncher"
#define AppExeName "TVLauncher.exe"

[Setup]
AppId={{8F3A2C41-7B5E-4D9A-9C6F-2E1D4A8B7C30}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
VersionInfoVersion={#AppVersion}

; Per-user install: no administrator prompt, and a clean uninstall.
PrivilegesRequired=lowest
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes

; The launcher is 64-bit only: it ships a self-contained win-x64 runtime.
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

OutputDir=..\installer
OutputBaseFilename=TVLauncher-Setup-{#AppVersion}
SetupIconFile=..\host\Resources\TVLauncher.ico
UninstallDisplayIcon={app}\{#AppExeName}
UninstallDisplayName={#AppName}

Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern

; Closing the launcher before installing avoids a "file in use" failure that the user would have to
; work out for themselves.
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "chinese"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务:"
Name: "autostart"; Description: "开机自动启动"; GroupDescription: "附加任务:"

[Files]
; The executable and the interface it serves. The ui folder is included as a whole so the interface
; can still be edited after installation, which is why it is not compiled in.
;
; The debug symbols and the XML documentation files the publish step also produces are left out:
; they are of no use to anyone running the launcher and would more than double the download.
Source: "..\dist\{#AppExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\ui\*"; DestDir: "{app}\ui"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"
Name: "{group}\卸载 {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Run]
; Offered at the end of setup so the user sees it working straight away.
Filename: "{app}\{#AppExeName}"; Description: "立即运行 {#AppName}"; Flags: nowait postinstall skipifsilent

[Registry]
; The startup entry, written only when the user asked for it. The same key the launcher writes from
; its own settings, so the two agree.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; \
    ValueName: "{#AppName}"; ValueData: """{app}\{#AppExeName}"""; Flags: uninsdeletevalue; Tasks: autostart

[UninstallDelete]
; Files the launcher creates for itself in its own folder. The user's data — apps, pictures,
; wallpapers, settings — lives in AppData and is deliberately left alone: uninstalling the program
; should not throw away a collection the user built up.
Type: filesandordirs; Name: "{app}\ui"
