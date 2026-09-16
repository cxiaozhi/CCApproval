#!/usr/bin/env node
'use strict';
/**
 * One-click launcher:
 *   node scripts/launch.js [--open]
 *
 * 1. ensures config.json exists (copies the example on first run)
 * 2. starts the approval server in the background if not already running
 * 3. prints (and optionally opens) the dashboard URL with auth token
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const { loadConfig, PROJECT_DIR } = require('../src/config');

const cfg = loadConfig();
const openBrowser = process.argv.includes('--open');

function ping() {
  return new Promise(resolve => {
    const req = http.request({
      host: '127.0.0.1', port: cfg.port, path: '/api/requests', method: 'GET',
      headers: { Authorization: `Bearer ${cfg.secret}` }, timeout: 1500
    }, res => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function ensureConfig() {
  const target = path.join(PROJECT_DIR, 'config.json');
  if (!fs.existsSync(target)) {
    fs.copyFileSync(path.join(PROJECT_DIR, 'config.example.json'), target);
    console.log('• 已生成 config.json（用示例配置，SMTP 为占位，稍后自行填写）');
  }
}

async function startServer() {
  if (await ping()) return 'already';
  console.log('• 正在后台启动审批服务器…');
  const out = fs.openSync(path.join(cfg.dataDir, 'server.out.log'), 'a');
  const err = fs.openSync(path.join(cfg.dataDir, 'server.err.log'), 'a');
  const child = spawn(process.execPath, [path.join(PROJECT_DIR, 'src', 'server.js')], {
    detached: true, stdio: ['ignore', out, err], windowsHide: true,
    env: { ...process.env }
  });
  child.unref();
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 300));
    if (await ping()) return 'started';
  }
  throw new Error('服务器启动超时，查看日志: ' + path.join(cfg.dataDir, 'server.err.log'));
}

function open(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => { /* ignore */ });
}

(async () => {
  ensureConfig();
  const state = await startServer();
  const url = `http://127.0.0.1:${cfg.port}/?t=${cfg.secret}`;
  console.log('');
  console.log(state === 'already' ? '✔ CCApproval 已在运行' : '✔ CCApproval 启动成功');
  console.log(`  本地面板:  ${url}`);
  console.log(`  远程地址:  ${cfg.publicUrl}/?t=${cfg.secret}   ← 手机/邮件里点这个`);
  console.log(`  日志:      ${path.join(cfg.dataDir, 'server.out.log')}`);
  console.log('');
  console.log('提示: Claude Code 调用危险工具时会自动通知；改 SMTP/Webhook 请编辑 config.json');
  if (openBrowser) open(url);
})().catch(e => { console.error('✘ 启动失败: ' + e.message); process.exit(1); });
