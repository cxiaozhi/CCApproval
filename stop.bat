@echo off
rem Stop the background CCApproval server.
cd /d "%~dp0"
node scripts\stop.js
pause
