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
 * 结果标签。escalated 就是「策略没判、逃逸到 Claude Code 原生弹窗」的那类，
 * 单列出来正是为了能一眼看清有多少操作没被自动覆盖。
 */
const STATUS = {
  'auto-approved': { label: '自动放行', cls: 'ok' },
  'policy-denied': { label: '策略拒绝', cls: 'no' },
  'escalated': { label: '已逃逸', cls: 'esc' },
  'unknown': { label: '（旧记录）', cls: 'dim' }
};

const SOURCE = {
  rule: '你的规则',
  builtin: '内置规则',
  unmatchedDefault: '无规则匹配',
  dangerousDefault: '危险操作自动放行',
  planMode: '计划自动通过'
};

function renderRows(entries) {
  if (!entries.length) {
    return '<tr><td colspan="5" class="dim">还没有记录 —— Claude Code 跑一次工具调用就会出现在这里</td></tr>';
  }
  return entries.map(r => {
    const st = STATUS[r.status] || { label: r.status, cls: '' };
    const why = [r.reason, SOURCE[r.source]].filter(Boolean).join(' · ');
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

function renderDashboard(store, cfg) {
  const entries = store.list(cfg.historyLimit);

  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CCApproval 日志</title>
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
  .ok{color:#1a7f37;white-space:nowrap} .no{color:#cf222e;white-space:nowrap}
  .esc{color:#9a6700;white-space:nowrap} .dim{color:#888}
  #refresh{float:right;font-size:13px}
</style></head><body>
<h1>🔐 CCApproval <span class="muted">Claude Code 自动审批日志</span></h1>
<a id="refresh" href="" onclick="refresh();return false">↻ 刷新</a>
<p class="muted">共 <span id="count">${entries.length}</span> 条 · 只读 · http://${esc(cfg.host)}:${esc(String(cfg.port))}</p>
<p class="legend"><b class="ok">自动放行</b> 策略引擎放行 · <b class="no">策略拒绝</b> 命中 deny 规则 · <b class="esc">已逃逸</b> 策略没判，交回 Claude Code 原生弹窗</p>
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
