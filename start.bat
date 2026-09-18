@echo off
rem ============================================
rem  CCApproval one-click starter (Windows)
rem  Double-click this file, or CCApproval.vbs
rem  for a fully silent (no console window) start.
rem ============================================
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [CCApproval] Node.js not found. Install it from https://nodejs.org first.
  pause
  exit /b 1
)

if not exist node_modules (
  echo [CCApproval] First run - installing dependencies...
  rem --omit=dev: the devDependencies only exist to regenerate the icons
  rem (npm run icon). A user just running the guard should not pull sharp down.
  call npm install --omit=dev --no-fund --no-audit
  if errorlevel 1 ( echo [CCApproval] npm install failed. & pause & exit /b 1 )
)

node scripts\launch.js --open
if errorlevel 1 pause
