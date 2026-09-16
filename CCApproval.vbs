' CCApproval silent launcher — double-click to start with NO console window.
' The approval server runs in the background; the dashboard opens in your browser.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("Wscript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
sh.Run "cmd /c """"" & dir & "\start.bat""""", 0, False
