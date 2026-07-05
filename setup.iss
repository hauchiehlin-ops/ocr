[Setup]
AppName=OCREditor
AppVersion=1.0
DefaultDirName={autopf}\OCREditor
DefaultGroupName=OCREditor
OutputDir=build
OutputBaseFilename=OCREditor_Setup
Compression=lzma
SolidCompression=yes

[Files]
; 將發佈的檔案拷貝至安裝目錄
Source: "build\win_publish\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs

[Icons]
Name: "{group}\OCREditor"; Filename: "{app}\OCREditor.exe"
Name: "{autodesktop}\OCREditor"; Filename: "{app}\OCREditor.exe"
