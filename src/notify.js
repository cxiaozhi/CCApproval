'use strict';
/**
 * Notification channels: email (nodemailer/SMTP) and generic webhook
 * (works with Feishu/DingTalk custom bots or any JSON endpoint).
 */
const http = require('http');
const https = require('https');

let transporter = null;

function getTransporter(emailCfg) {
  if (!transporter) {
    const nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport({
      host: emailCfg.host,
      port: emailCfg.port ?? 465,
      secure: emailCfg.secure ?? (emailCfg.port === 465 || emailCfg.port === undefined),
      auth: emailCfg.auth
    });
  }
  return transporter;
}

function decisionLinks(cfg, id) {
  const base = cfg.publicUrl.replace(/\/$/, '');
  const t = encodeURIComponent(cfg.secret);
  return {
    approve: `${base}/d?id=${encodeURIComponent(id)}&a=allow&t=${t}`,
    deny: `${base}/d?id=${encodeURIComponent(id)}&a=deny&t=${t}`,
    dashboard: `${base}/?t=${t}`
  };
}

function beijingTime(iso) {
  try {
    return new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  } catch { return iso || ''; }
}

function renderEmailText(req, links) {
  return [
    `Claude Code is asking for approval:`,
    ``,
    `Time:    ${beijingTime(req.createdAt)} (北京时间)`,
    `Tool:    ${req.toolName}`,
    `Rule:    ${req.reason || ''}`,
    `CWD:     ${req.cwd || ''}`,
    `Session: ${req.sessionId || ''}`,
    ``,
    `Action:`,
    `  ${req.summary}`,
    ``,
    `Full input:`,
    JSON.stringify(req.toolInput, null, 2),
    ``,
    `✅ APPROVE: ${links.approve}`,
    `❌ DENY:    ${links.deny}`,
    ``,
    `Dashboard: ${links.dashboard}`,
    `Request ID: ${req.id}`,
    `This request expires when the hook times out.`
  ].join('\n');
}

function renderEmailHtml(req, links) {
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;max-width:640px;margin:auto;padding:16px">
  <h2 style="margin:0 0 4px">🔐 Claude Code 审批请求</h2>
  <p style="color:#666;margin:0 0 16px">${esc(req.reason || '')}</p>
  <table style="border-collapse:collapse;width:100%;margin-bottom:16px">
    <tr><td style="padding:4px 8px;color:#888">时间</td><td style="padding:4px 8px">${esc(beijingTime(req.createdAt))} (北京时间)</td></tr>
    <tr><td style="padding:4px 8px;color:#888">Tool</td><td style="padding:4px 8px"><b>${esc(req.toolName)}</b></td></tr>
    <tr><td style="padding:4px 8px;color:#888">CWD</td><td style="padding:4px 8px">${esc(req.cwd)}</td></tr>
  </table>
  <pre style="background:#f6f8fa;border:1px solid #ddd;border-radius:8px;padding:12px;white-space:pre-wrap;word-break:break-all">${esc(req.summary)}\n\n${esc(JSON.stringify(req.toolInput, null, 2))}</pre>
  <p>
    <a href="${links.approve}" style="display:inline-block;background:#1a7f37;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;margin-right:12px">✅ 批准 Approve</a>
    <a href="${links.deny}" style="display:inline-block;background:#cf222e;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600">❌ 拒绝 Deny</a>
  </p>
  <p style="color:#888;font-size:12px">Dashboard: <a href="${links.dashboard}">${links.dashboard}</a><br>Request ID: ${esc(req.id)}</p>
</body></html>`;
}

async function sendEmail(cfg, req) {
  const emailCfg = cfg.notify?.email;
  if (!emailCfg) return false;
  const links = decisionLinks(cfg, req.id);
  const mail = {
    from: emailCfg.from || emailCfg.auth?.user,
    to: emailCfg.to,
    subject: `[CCApproval] ${req.toolName}: ${(req.summary || '').slice(0, 80)}`,
    text: renderEmailText(req, links),
    html: renderEmailHtml(req, links)
  };
  await getTransporter(emailCfg).sendMail(mail);
  return true;
}

async function sendWebhook(cfg, req) {
  const url = cfg.notify?.webhook;
  if (!url) return false;
  const links = decisionLinks(cfg, req.id);
  const payload = JSON.stringify({
    msg_type: 'text',
    content: {
      text:
        `🔐 Claude Code 审批请求\n` +
        `Tool: ${req.toolName}\n规则: ${req.reason || ''}\n` +
        `操作: ${req.summary}\n` +
        `✅ 批准: ${links.approve}\n❌ 拒绝: ${links.deny}\n` +
        `面板: ${links.dashboard}\nID: ${req.id}`
    },
    // also include raw fields for non-Feishu consumers
    ccapproval: { id: req.id, tool: req.toolName, summary: req.summary, links }
  });
  await new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const r = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, res => { res.resume(); res.on('end', resolve); });
    r.on('error', reject);
    r.write(payload); r.end();
  });
  return true;
}

/** Fire all configured channels; never throws. Returns list of channels that succeeded. */
async function notifyAll(cfg, req, log = console.error) {
  const ok = [];
  for (const [name, fn] of [['email', sendEmail], ['webhook', sendWebhook]]) {
    try { if (await fn(cfg, req)) ok.push(name); }
    catch (e) { log(`[ccapproval] notify ${name} failed: ${e.message}`); }
  }
  return ok;
}

module.exports = { notifyAll, decisionLinks };
