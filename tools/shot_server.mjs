/**
 * QA 截图落盘服务（零依赖 Node，D1 起用于 headless 不可用的环境）
 *
 * 背景：本机 msedge.exe 需要提权（spawn EACCES / requires elevation），MCP 浏览器
 * 截图在 4K 显示器上又超 10MiB 上限 ⇒ 「页面自己把 canvas 编码成 PNG，POST 给本地
 * 服务落盘」是唯一可靠通道。页面侧入口见 `src/main.ts` 的 `#shot=<name>` 钩子
 * （仅 DEV），渲染钩子在 `Game.requestCapture()`（同一帧 postfx.render 之后取值，
 * 不需要给 renderer 开 preserveDrawingBuffer）。
 *
 * 用法：
 *   node tools/shot_server.mjs <输出目录>      # 默认 .qa/nr/d1
 *   浏览器打开  http://localhost:5179/#autostart&shot=chase
 *
 * 协议：
 *   POST /shot?name=<name>   body = data:image/png;base64,....
 *   → 写 <输出目录>/<name>.png，回 200
 */
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const outDir = resolve(process.argv[2] ?? '.qa/nr/d1');
mkdirSync(outDir, { recursive: true });

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': '*'
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  if (req.method === 'POST' && url.pathname === '/shot') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const b64 = body.replace(/^data:image\/\w+;base64,/, '');
      const name = (url.searchParams.get('name') ?? 'shot').replace(/[^\w.-]/g, '_');
      const buf = Buffer.from(b64, 'base64');
      const file = join(outDir, `${name}.png`);
      writeFileSync(file, buf);
      console.log(`[shot] ${file} (${buf.length} bytes)`);
      res.writeHead(200, cors);
      res.end('ok');
    });
    return;
  }
  res.writeHead(200, { ...cors, 'Content-Type': 'text/plain' });
  res.end(`shot-server alive → ${outDir}\n`);
});

server.listen(5399, '127.0.0.1', () => {
  console.log(`[shot] listening on http://127.0.0.1:5399 → ${outDir}`);
});
