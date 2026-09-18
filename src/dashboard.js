'use strict';
/** HTML rendering for the read-only audit log. Zero dependencies. */

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

/**
 * 结果标签，只有两种。`escalated` 在旧版本里叫「已逃逸」，是「策略没判、漏给原生弹窗」的意思；
 * 改成白名单之后弹窗是**故意**的（命中名单才有），所以标签得跟着改，
 * 否则看面板的人会以为还在漏。`policy-denied` 那档已经取消（见 src/policy.js）。
 */
const STATUS = {
  'auto-approved': { label: '自动审批', cls: 'ok' },
  'escalated': { label: '交回弹窗', cls: 'esc' },
  // 旧日志里还有 policy-denied 的记录，留着标签以免看不出是什么
  'policy-denied': { label: '策略拒绝（旧）', cls: 'dim' },
  'unknown': { label: '（旧记录）', cls: 'dim' }
};

const SOURCE = {
  rule: '你的名单',
  builtin: '内置名单',
  default: '不在名单内'
};

function renderRows(entries) {
  if (!entries.length) {
    return '<tr><td colspan="5" class="dim">还没有记录 —— Claude Code 跑一次工具调用就会出现在这里</td></tr>';
  }
  return entries.map(r => {
    const st = STATUS[r.status] || { label: r.status, cls: '' };
    // "不在名单内" 只对逃逸行有信息量——审批行的 reason 已经说了这件事
    const why = [r.reason, r.source !== 'default' ? SOURCE[r.source] : ''].filter(Boolean).join(' · ');
    const full = r.toolInput ? JSON.stringify(r.toolInput, null, 2) : '';
    return `<tr>
    <td class="time">${esc(fmtTime(r.ts))}</td>
    <td><span class="tool">${esc(r.toolName || '—')}</span></td>
    <td class="${st.cls}">${esc(st.label)}</td>
    <td class="why">${esc(why)}</td>
    <td class="what"><span title="${esc(full)}">${esc(r.summary || '')}</span></td>
  </tr>`;
  }).join('');
}

/**
 * 本工具启动的所有 HTTP 服务一览。目前两个：日志面板自己 + 推理网关代理。
 * 再加新服务时往 services 数组里推一条即可。
 */
function renderServices(cfg, gwState) {
  const badge = (ok, text, cls) => `<span class="svc-status ${cls}">${esc(text)}</span>`;
  const services = [
    {
      name: '日志面板',
      url: `http://${cfg.host}:${cfg.port}`,
      desc: '审计日志只读面板（本页）',
      status: badge(1, '运行中', 'up'),
      extra: ''
    }
  ];
  const gw = cfg.gateway || {};
  if (gw.enabled) {
    const st = (gwState && gwState.status) || 'disabled';
    const statusBadge = st === 'listening' ? badge(1, '监听中', 'up')
      : st === 'error' ? badge(0, '失败: ' + (gwState.error || ''), 'down')
      : badge(0, st, 'down');
    const routes = Object.entries(gw.modelMap || {})
      .map(([route, real]) => `<span class="route">${esc(route)} → ${esc(real)}</span>`).join(' ');
    services.push({
      name: '推理网关代理',
      url: `http://${gw.host}:${gw.port}`,
      desc: `Claude Desktop 3p 回环代理 → ${esc(gw.upstream || '（未配置）')}`,
      status: statusBadge,
      extra: routes ? `<div class="routes">${routes}</div>` : ''
    });
  }
  return `<div class="svc">
  <h2>HTTP 服务 <span class="muted">本工具启动的全部监听</span></h2>
  ${services.map(s => `<div class="svc-card">
    <div class="svc-head"><b>${esc(s.name)}</b> ${s.status}</div>
    <div class="svc-url"><a href="${esc(s.url)}" target="_blank">${esc(s.url)}</a> <span class="muted">${s.desc}</span></div>
    ${s.extra}
  </div>`).join('\n')}
</div>`;
}

function renderDashboard(store, cfg, gwState) {
  const entries = store.list(cfg.historyLimit);

  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CCApproval 日志</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48">
<link rel="apple-touch-icon" href="/icon-180.png">
<meta name="theme-color" content="#1f6feb">
<style>
  body{font-family:system-ui,sans-serif;max-width:1100px;margin:auto;padding:16px;background:#fafafa}
  h1{font-size:20px} .muted{color:#888;font-size:13px}
  .legend{color:#666;font-size:12px;margin:4px 0 12px}
  table{width:100%;border-collapse:collapse;font-size:13px;background:#fff;table-layout:fixed}
  th,td{border-bottom:1px solid #eee;padding:7px 8px;text-align:left;vertical-align:top}
  th{position:sticky;top:0;background:#fff;white-space:nowrap}
  /* fixed widths for the narrow columns, a share for 原因; 操作内容 takes the rest */
  th:nth-child(1){width:104px} th:nth-child(2){width:120px}
  th:nth-child(3){width:112px} th:nth-child(4){width:26%}
  .time{color:#888;white-space:nowrap;font-variant-numeric:tabular-nums}
  /* long MCP tool names share a prefix, so truncating them would make them
     indistinguishable — wrap instead and keep the whole name readable */
  .tool{font-weight:700;background:#ddf4ff;padding:2px 8px;border-radius:6px;word-break:break-all}
  .why{color:#9a6700;font-size:12px}
  .what{font-family:ui-monospace,monospace;font-size:12px}
  /* clamp the command to 3 lines; the full tool_input is still in the hover title */
  .what span{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;word-break:break-all}
  .ok{color:#1a7f37;white-space:nowrap}
  .esc{color:#9a6700;white-space:nowrap} .dim{color:#888}
  .mark{vertical-align:-4px;margin-right:7px}
  #refresh{float:right;font-size:13px}
  .svc{margin:0 0 14px} .svc h2{font-size:15px;margin:0 0 8px}
  .svc-card{background:#fff;border:1px solid #eee;border-radius:8px;padding:8px 12px;margin-bottom:8px}
  .svc-head{display:flex;gap:10px;align-items:center}
  .svc-status{font-size:11px;padding:1px 8px;border-radius:10px;white-space:nowrap}
  .svc-status.up{background:#dafbe1;color:#1a7f37}
  .svc-status.down{background:#ffebe9;color:#cf222e;word-break:break-all}
  .svc-url{font-family:ui-monospace,monospace;font-size:12px;margin-top:3px}
  .routes{margin-top:5px}
  .route{display:inline-block;font-family:ui-monospace,monospace;font-size:11px;background:#ddf4ff;border-radius:6px;padding:1px 7px;margin:2px 4px 0 0}
</style></head><body>
<h1><img class="mark" src="/favicon.svg" alt="" width="22" height="22">CCApproval <span class="muted">Claude Code 自动审批日志</span></h1>
<a id="refresh" href="" onclick="refresh();return false">↻ 刷新</a>
<p class="muted">共 <span id="count">${entries.length}</span> 条 · 只读 · http://${esc(cfg.host)}:${esc(String(cfg.port))}</p>
<p class="legend"><b class="ok">自动审批</b> 不在名单内 · <b class="esc">交回弹窗</b> 命中白名单</p>
${renderServices(cfg, gwState)}
<table>
  <thead><tr><th>时间</th><th>工具</th><th>结果</th><th>原因</th><th title="悬停任意一行可看完整 tool_input">操作内容</th></tr></thead>
  <tbody id="rows">${renderRows(entries)}</tbody>
</table>
<script>
const T = new URLSearchParams(location.search).get('t') || '';
async function refresh() {
  const r = await fetch('/api/fragment?t=' + encodeURIComponent(T));
  if (!r.ok) return;
  const d = await r.json();
  document.getElementById('rows').innerHTML = d.rows;
  document.getElementById('count').textContent = d.count;
}
// 日志一变服务端就推 change；EventSource 断线会自动重连，重连时服务端补发一次 change。
// 页面上没有任何输入控件，所以整块替换表格是安全的，不需要增量合并。
new EventSource('/api/events?t=' + encodeURIComponent(T)).addEventListener('change', refresh);
</script>
</body></html>`;
}

module.exports = { renderDashboard, renderRows };
