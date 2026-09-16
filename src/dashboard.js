'use strict';
/** HTML rendering for the approval dashboard. Zero dependencies. */

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** ISO string → 北京时间 'MM-DD HH:MM:SS' */
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', hour12: false,
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(d).reduce((o, p) => (o[p.type] = p.value, o), {});
  return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function renderDashboard(store, cfg) {
  const pending = store.listPending();
  const recent = store.listRequests(30).filter(r => r.status !== 'pending').slice(0, 15);

  const card = r => `
  <div class="card" id="req-${esc(r.id)}">
    <div class="head">
      <span class="tool">${esc(r.toolName)}</span>
      <span class="reason">${esc(r.reason || '')}</span>
      <span class="time">${esc(fmtTime(r.createdAt))}</span>
    </div>
    <pre>${esc(r.summary)}\n${esc(JSON.stringify(r.toolInput, null, 2))}</pre>
    <details><summary>修改命令后再批准（可选）</summary>
      <textarea id="mod-${esc(r.id)}" rows="3" placeholder='替换的 tool input，JSON 格式。例如 {"command":"ls -la"}'></textarea>
    </details>
    <div class="actions">
      <button class="ok" onclick="decide('${esc(r.id)}','allow')">✅ 批准</button>
      <button class="no" onclick="decide('${esc(r.id)}','deny')">❌ 拒绝</button>
    </div>
  </div>`;

  const histRow = r => `<tr>
    <td>${esc(fmtTime(r.createdAt))}</td><td>${esc(r.toolName)}</td>
    <td class="${r.status}">${esc(r.status)}</td><td>${esc((r.summary || '').slice(0, 120))}</td></tr>`;

  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CCApproval</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:760px;margin:auto;padding:16px;background:#fafafa}
  h1{font-size:20px} .muted{color:#888;font-size:13px}
  .card{background:#fff;border:1px solid #e2e2e2;border-radius:10px;padding:14px;margin:12px 0}
  .head{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
  .tool{font-weight:700;background:#ddf4ff;padding:2px 8px;border-radius:6px}
  .reason{color:#9a6700;font-size:13px} .time{color:#888;font-size:12px;margin-left:auto}
  pre{background:#f6f8fa;border-radius:8px;padding:10px;overflow:auto;font-size:12px;white-space:pre-wrap;word-break:break-all}
  textarea{width:100%;box-sizing:border-box;font-family:monospace;margin:6px 0}
  .actions{display:flex;gap:10px;margin-top:8px}
  button{padding:10px 22px;border:none;border-radius:8px;font-size:15px;cursor:pointer;font-weight:600}
  .ok{background:#1a7f37;color:#fff} .no{background:#cf222e;color:#fff}
  table{width:100%;border-collapse:collapse;font-size:13px;background:#fff}
  td,th{border-bottom:1px solid #eee;padding:6px;text-align:left}
  .approved{color:#1a7f37} .denied{color:#cf222e} .expired,.timeout{color:#888}
  #refresh{float:right;font-size:13px}
</style></head><body>
<h1>🔐 CCApproval <span class="muted">Claude Code 远程审批</span></h1>
<a id="refresh" href="" onclick="location.reload();return false">↻ 刷新</a>
<p class="muted">待审批 ${pending.length} 条 · 服务 ${esc(cfg.publicUrl)}</p>
<div id="pending">${pending.length ? pending.map(card).join('') : '<p class="muted">✨ 没有待审批请求</p>'}</div>
<h2 style="font-size:16px;margin-top:28px">最近记录</h2>
<table><tr><th>时间</th><th>工具</th><th>结果</th><th>操作</th></tr>${recent.map(histRow).join('')}</table>
<script>
const T = new URLSearchParams(location.search).get('t') || '';
async function decide(id, action) {
  let updatedInput;
  const raw = document.getElementById('mod-' + id)?.value.trim();
  if (action === 'allow' && raw) {
    try { updatedInput = JSON.parse(raw); } catch { alert('修改内容不是合法 JSON'); return; }
  }
  const r = await fetch('/api/decide?t=' + encodeURIComponent(T), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, action, updatedInput })
  });
  const el = document.getElementById('req-' + id);
  if (r.ok) { el.style.opacity = .4; el.querySelector('.actions').innerHTML = '<b>已完成: ' + action + '</b>'; }
  else { const j = await r.json().catch(() => ({})); alert('失败: ' + (j.error || r.status)); }
}
setTimeout(() => location.reload(), 15000);
</script>
</body></html>`;
}

function renderDecisionResult(id, action, result) {
  const ok = result.ok;
  const label = action === 'allow' ? '✅ 已批准' : '❌ 已拒绝';
  const color = action === 'allow' ? '#1a7f37' : '#cf222e';
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>CCApproval</title></head>
<body style="font-family:system-ui,sans-serif;text-align:center;padding:60px 16px">
  <h1 style="color:${ok ? color : '#888'}">${ok ? label : '⚠️ ' + esc(result.error)}</h1>
  <p style="color:#888">Request ${esc(id)}</p>
  <p style="color:#888;font-size:13px">Claude Code 将在下一次轮询时收到该决定（≤ 几秒）。你可以关闭此页面。</p>
</body></html>`;
}

module.exports = { renderDashboard, renderDecisionResult };
