'use strict';
/**
 * Icon tests.
 *
 * The images themselves come from sharp via `npm run icon`, so there is nothing left
 * to verify about PNG encoding — what can still go wrong is that the committed files
 * drift from their names, or that the routes stop being reachable. So this checks the
 * two things a user actually notices: the declared sizes match the pixels, and the
 * browser can fetch them without a token (a favicon GET cannot carry `?t=`, and if it
 * 401s the tab just shows a broken-image default).
 *
 * Deliberately does not require the dev toolchain — these run against the files in
 * assets/, so `npm test` works on a fresh clone with no `npm install`.
 */
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { iconFor, ASSETS } = require('../src/icon');

let failures = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log('✔ ' + label); return; }
  failures++;
  console.error('✘ ' + label + (detail ? ' — ' + detail : ''));
}
function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(label, a === e, `got ${a} want ${e}`);
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const file = name => fs.readFileSync(path.join(ASSETS, name));

// -- routes -------------------------------------------------------------------

eq('未知路径不当作图标', iconFor('/api/requests'), null);
eq('目录穿越不当作图标', iconFor('/../package.json'), null);
eq('favicon.svg 的 content type', iconFor('/favicon.svg').contentType, 'image/svg+xml; charset=utf-8');
eq('favicon.ico 的 content type', iconFor('/favicon.ico').contentType, 'image/x-icon');
eq('icon-180 是 PNG', iconFor('/icon-180.png').contentType, 'image/png');

// -- the committed files -----------------------------------------------------

{
  const svg = file('icon.svg').toString('utf8');
  check('icon.svg 是 SVG', svg.includes('<svg') && svg.includes('viewBox="0 0 64 64"'));
  check('icon.svg 不引用外部资源', (svg.match(/https?:\/\//g) || []).length === 1, svg.match(/https?:\/\//g));
  check('icon.svg 里写了改完要跑哪条命令', svg.includes('npm run icon'));
}

for (const size of [180, 512]) {
  const png = file(`icon-${size}.png`);
  check(`icon-${size}.png 是 PNG`, png.subarray(0, 8).equals(PNG_SIG));
  // IHDR sits at a fixed offset: 8-byte signature + 4 length + 4 type
  eq(`icon-${size}.png 的实际像素尺寸与文件名一致`,
    [png.readUInt32BE(16), png.readUInt32BE(20)], [size, size]);
}

{
  const ico = file('icon.ico');
  eq('icon.ico 头正确', [ico.readUInt16LE(0), ico.readUInt16LE(2)], [0, 1]);
  const count = ico.readUInt16LE(4);
  const sizes = [];
  const problems = [];
  for (let i = 0; i < count; i++) {
    const b = 6 + i * 16;
    const size = ico[b] || 256;
    const len = ico.readUInt32LE(b + 8);
    const off = ico.readUInt32LE(b + 12);
    sizes.push(size);
    if (off + len > ico.length) { problems.push(`${size}px 越界`); continue; }

    // Either payload is legal: a PNG, or the classic DIB — whose header doubles the
    // height because the AND mask is appended below the pixels (png-to-ico writes
    // the DIB form, which is the more compatible of the two).
    const frame = ico.subarray(off, off + len);
    if (frame.subarray(0, 8).equals(PNG_SIG)) continue;
    const headerSize = frame.readUInt32LE(0);
    const ok = [40, 108, 124].includes(headerSize) &&
      frame.readInt32LE(4) === size &&
      frame.readInt32LE(8) === size * 2 &&
      frame.readUInt16LE(14) === 32;
    if (!ok) problems.push(`${size}px 既不是 PNG 也不是 32bpp DIB`);
  }
  eq('icon.ico 含 Windows/Chrome 会挑的三档', sizes, [16, 32, 48]);
  check('icon.ico 每帧都落在文件内且像素尺寸正确', problems.length === 0, problems.join('; '));
}

// -- served without a token ---------------------------------------------------

function freePort() {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function get(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccapproval-icon-'));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: {
      ...process.env,
      CCAPPROVAL_DATA_DIR: dataDir,
      CCAPPROVAL_PORT: String(port),
      CCAPPROVAL_SECRET: 'icon-test-secret',
      CCAPPROVAL_GATEWAY_ENABLED: '0' // do not fight the real instance for 15721
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    try { ready = (await get(port, '/favicon.svg')).status === 200; } catch { await sleep(100); }
  }
  check('面板起来了', ready);

  try {
    const ico = await get(port, '/favicon.ico');
    eq('无 token 也能取 favicon.ico', [ico.status, ico.headers['content-type']], [200, 'image/x-icon']);
    check('拿到的是 assets 里那个文件', ico.body.equals(file('icon.ico')));
    eq('favicon.ico 可缓存', ico.headers['cache-control'], 'public, max-age=86400');

    const svg = await get(port, '/favicon.svg');
    eq('无 token 也能取 favicon.svg', [svg.status, svg.headers['content-type']],
      [200, 'image/svg+xml; charset=utf-8']);

    const touch = await get(port, '/icon-180.png');
    eq('apple-touch-icon 可用', [touch.status, touch.headers['content-type']], [200, 'image/png']);

    eq('数据接口仍然要 token', (await get(port, '/api/requests')).status, 401);
    const authed = await get(port, '/api/requests', { Authorization: 'Bearer icon-test-secret' });
    eq('带 token 的数据接口正常', [authed.status, JSON.parse(authed.body.toString()).recent.length], [200, 0]);

    const page = await get(port, '/?t=icon-test-secret');
    eq('面板页面可达', page.status, 200);
    const html = page.body.toString('utf8');
    check('页面声明了 svg + ico + apple-touch 图标',
      html.includes('href="/favicon.svg"') && html.includes('href="/favicon.ico"') &&
      html.includes('href="/icon-180.png"'));
    check('页面正文用了同一个图标', html.includes('src="/favicon.svg"'));
  } finally {
    child.kill();
  }

  console.log(failures ? `\n${failures} 项失败` : '\nicon 全部通过');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
