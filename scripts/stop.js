#!/usr/bin/env node
'use strict';
/** Stop the background CCApproval server. */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { loadConfig } = require('../src/config');

const cfg = loadConfig();
const pidFile = path.join(cfg.dataDir, 'server.pid');

let pid = null;
try { pid = Number(fs.readFileSync(pidFile, 'utf8').trim()); } catch { /* no pid file */ }

function alive(p) {
  try { process.kill(p, 0); return true; } catch { return false; }
}

if (pid && alive(pid)) {
  try {
    process.kill(pid, 'SIGTERM');
    setTimeout(() => { if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ } } }, 1500);
    console.log(`✔ 已停止 CCApproval 服务器 (pid ${pid})`);
  } catch (e) {
    console.error('✘ 停止失败: ' + e.message);
    process.exit(1);
  }
} else if (process.platform === 'win32') {
  // fallback: find node processes running our server.js
  try {
    const out = execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process | ' +
      "Where-Object { $_.CommandLine -match 'ccapproval|CCApproval' -and $_.CommandLine -match 'server\\.js' } | " +
      'ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Output $_.ProcessId }"',
      { encoding: 'utf8' }
    ).trim();
    console.log(out ? `✔ 已停止 (pid ${out.replace(/\s+/g, ', ')})` : 'ℹ 没有正在运行的 CCApproval 服务器');
  } catch {
    console.log('ℹ 没有正在运行的 CCApproval 服务器');
  }
} else {
  console.log('ℹ 没有正在运行的 CCApproval 服务器');
}
try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
