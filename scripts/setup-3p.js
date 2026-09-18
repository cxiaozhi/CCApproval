#!/usr/bin/env node
'use strict';
/**
 * Point Claude Desktop (3p mode) at the CCApproval loopback gateway.
 *
 *   node scripts/setup-3p.js
 *
 * What it does:
 *   1. finds the active profile in %LOCALAPPDATA%\Claude-3p\configLibrary\
 *   2. backs it up (<file>.bak-ccapproval-<timestamp>)
 *   3. rewrites it to use http://127.0.0.1:<gateway.port> as inferenceGatewayBaseUrl
 *      and Anthropic model routes (from gateway.modelMap) as inferenceModels
 *   4. makes sure _meta.json lists the profile and marks it applied
 *
 * Restart Claude Desktop afterwards. The CCApproval server (with gateway.enabled)
 * must be running for the desktop app to reach the upstream gateway.
 */
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../src/config');

const cfg = loadConfig();
const gw = cfg.gateway || {};

if (!gw.upstream) {
  console.error('✘ 请先在 config.json 里配置 gateway.upstream（真实网关地址）');
  process.exit(1);
}

const localAppData = process.env.LOCALAPPDATA;
if (!localAppData) {
  console.error('✘ 找不到 LOCALAPPDATA（仅支持 Windows 桌面版）');
  process.exit(1);
}
const libDir = path.join(localAppData, 'Claude-3p', 'configLibrary');
if (!fs.existsSync(libDir)) {
  console.error('✘ 未找到 Claude-3p 配置目录: ' + libDir);
  console.error('  （桌面版需要先切到 3p 模式才会生成该目录）');
  process.exit(1);
}

// locate the applied profile; fall back to the newest profile file
const metaFile = path.join(libDir, '_meta.json');
let meta = null;
try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { /* no meta */ }

let profileId = meta && meta.appliedId;
if (!profileId || !fs.existsSync(path.join(libDir, profileId + '.json'))) {
  const candidates = fs.readdirSync(libDir)
    .filter(f => f.endsWith('.json') && f !== '_meta.json')
    .map(f => ({ f, mtime: fs.statSync(path.join(libDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!candidates.length) {
    console.error('✘ configLibrary 里没有 profile 文件');
    process.exit(1);
  }
  profileId = candidates[0].f.replace(/\.json$/, '');
}

const profileFile = path.join(libDir, profileId + '.json');
let profile = {};
try { profile = JSON.parse(fs.readFileSync(profileFile, 'utf8')); } catch { /* fresh */ }

// backup before touching anything
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const backupFile = profileFile + '.bak-ccapproval-' + stamp;
if (fs.existsSync(profileFile)) fs.copyFileSync(profileFile, backupFile);

// model routes: name = Anthropic route the desktop sends, labelOverride = real model
const inferenceModels = Object.entries(gw.modelMap || {}).map(([name, real]) => ({
  labelOverride: real,
  name
}));
if (!inferenceModels.length) {
  console.error('✘ config.json 的 gateway.modelMap 为空 — 至少需要一条 { "claude-sonnet-5": "真实模型" }');
  process.exit(1);
}

const next = {
  ...profile, // keep extra keys like coworkEgressAllowedHosts / disableDeploymentModeChooser
  inferenceProvider: 'gateway',
  inferenceGatewayAuthScheme: 'bearer',
  inferenceGatewayBaseUrl: `http://127.0.0.1:${gw.port}`,
  inferenceGatewayApiKey: gw.apiKey || profile.inferenceGatewayApiKey || '',
  inferenceModels
};
fs.writeFileSync(profileFile, JSON.stringify(next, null, 2));

// make sure _meta.json lists and applies this profile
const entry = { id: profileId, name: 'CCApproval Gateway' };
const entries = (meta && Array.isArray(meta.entries) ? meta.entries : [])
  .filter(e => e.id !== profileId);
meta = { appliedId: profileId, entries: [...entries, entry] };
fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));

console.log('✔ 已写入 3p profile: ' + profileFile);
console.log('  备份:            ' + backupFile);
console.log('  gateway:         ' + next.inferenceGatewayBaseUrl + '  →  ' + gw.upstream);
for (const m of inferenceModels) console.log(`  模型路由:        ${m.name}  →  ${m.labelOverride}`);
console.log('');
console.log('下一步:');
console.log('  1. 确保 CCApproval 在运行（start.bat / CCApproval.vbs），网关代理随面板一起启动');
console.log('  2. 重启 Claude Desktop');
