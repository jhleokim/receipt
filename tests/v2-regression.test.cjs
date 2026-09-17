const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const mobile = fs.readFileSync(path.join(root, 'public/upload.js'), 'utf8');
const workerSource = fs.readFileSync(path.join(root, 'worker.js'), 'utf8');
const workerModule = import('data:text/javascript;base64,' + Buffer.from(workerSource).toString('base64'));
const section = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end));
class Storage {
  values = new Map(); timer = null; queue = Promise.resolve();
  async get(key) { return this.values.get(key); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async list({ prefix = '', limit = Infinity } = {}) { return new Map([...this.values].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit)); }
  async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) this.values.delete(key); }
  async setAlarm(time) { this.timer = time; }
  transaction(fn) { const next = this.queue.then(() => fn(this)); this.queue = next.catch(() => {}); return next; }
}
async function relay() {
  const { SessionRelay } = await workerModule;
  const storage = new Storage();
  return { storage, relay: new SessionRelay({ storage }) };
}
const upload = (id = crypto.randomUUID(), body = new Uint8Array([1, 2, 3])) => {
  const form = new FormData();
  form.append('file', new File([body], 'synthetic.png', { type: 'image/png' })); form.append('id', id);
  return new Request('https://test/upload', { method: 'POST', body: form });
};
const poll = () => new Request('https://test/poll?v=2');
const ack = ids => new Request('https://test/ack', { method: 'POST', body: JSON.stringify({ ids }) });

test('all frontend assets parse', () => { new vm.Script(app); new vm.Script(mobile); });
test('long receipts produce no blank page and fit every column including caption/gutter', () => {
  const context = vm.createContext({ document: { createElement: () => ({ getContext: () => ({ drawImage() {} }) }) } });
  vm.runInContext(section(app, 'const A4_W =', 'function neededWidth') + section(app, 'function sliceCanvas(', 'function buildBundleFilename') + section(app, 'function layoutPagesSync(', 'async function pagesToPdfBlob'), context);
  const item = { els: { date: { value: '2026-09-09' }, amount: { value: '12500' } } };
  for (const cols of [1, 2, 3, 4]) for (const height of [100, 1350, 3000, 12000]) {
    const pages = context.layoutPagesSync([item, item], [{ width: 460, height }, { width: 760, height: height * 2 }], cols);
    assert.ok(pages.every(p => p.length), `blank page: ${cols} cols, ${height}px`);
    for (const page of pages) for (const p of page) {
      assert.ok(p.yTop + p.drawH + 23 <= 785.89 + 0.001, 'overflows printable height');
      assert.ok(p.x >= 28 && p.x + p.drawW <= 567.28 + 0.001, 'overflows width');
    }
  }
});
test('mobile resize preserves narrow receipt aspect ratio without upscaling', () => {
  const ctx = vm.createContext();
  vm.runInContext('const MAX_DIMENSION = 2000;' + section(mobile, '  function fitImageSize', '  async function shrink'), ctx);
  for (const [w, h] of [[150, 2000], [400, 8000], [6000, 3000], [100, 100]]) for (const step of [1, .8, .65, .5]) {
    const size = ctx.fitImageSize(w, h, step);
    assert.ok(size.width <= w && size.height <= h);
    assert.ok(Math.max(size.width, size.height) <= 2000);
    assert.ok(Math.abs(size.width / size.height - w / h) < .003);
  }
});
test('phone delivery survives lost poll/ack responses and upload retries are idempotent', async () => {
  const { relay: r, storage } = await relay(); const id = crypto.randomUUID();
  assert.equal((await r.fetch(upload(id))).status, 200);
  const expiry = storage.timer;
  assert.equal((await r.fetch(upload(id))).status, 200);
  const first = await (await r.fetch(poll())).json();
  assert.equal(first.length, 1);
  assert.deepEqual(await (await r.fetch(poll())).json(), first);
  assert.equal((await r.fetch(ack([id]))).status, 200);
  assert.equal((await r.fetch(ack([id]))).status, 200);
  await r.fetch(upload(id));
  assert.deepEqual(await (await r.fetch(poll())).json(), []);
  assert.equal(storage.timer, expiry, 'retries must not extend expiry');
});
test('expired session deletes images and cannot be reopened', async () => {
  const { relay: r, storage } = await relay();
  await r.fetch(upload()); await storage.put('expiresAt', Date.now() - 1);
  await r.alarm();
  assert.equal((await storage.list({ prefix: 'up:' })).size, 0);
  assert.equal((await storage.list({ prefix: 'seen:' })).size, 0);
  assert.equal((await r.fetch(poll())).status, 410);
  assert.equal((await r.fetch(upload())).status, 410);
});
test('upload validates form values, actual stream size, pending quota and batch size', async () => {
  const { relay: r } = await relay();
  const form = new FormData(); form.append('file', 'not a file');
  assert.equal((await r.fetch(new Request('https://test/upload', { method: 'POST', body: form }))).status, 400);
  const oversized = upload(crypto.randomUUID(), new Uint8Array(2_000_000));
  assert.equal((await r.fetch(new Request(oversized.url, { method: 'POST', headers: oversized.headers, body: await oversized.arrayBuffer() }))).status, 413);
  const responses = await Promise.all(Array.from({ length: 21 }, () => r.fetch(upload())));
  assert.equal(responses.filter(r => r.status === 200).length, 20);
  assert.equal(responses.filter(r => r.status === 429).length, 1);
  assert.equal((await (await r.fetch(poll())).json()).length, 3);
  assert.equal((await r.fetch(ack(['bad-id']))).status, 400);
});
test('edge routing validates session and forwards v2 acknowledgement protocol', async () => {
  const { default: worker } = await workerModule;
  const { relay: r } = await relay();
  const env = { SESSIONS: { idFromName: id => id, get: () => ({ fetch: req => r.fetch(req) }) }, ASSETS: { fetch: async () => new Response('asset') } };
  const id = crypto.randomUUID();
  assert.equal((await worker.fetch(new Request('https://test/api/poll?s=bad'), env)).status, 400);
  const response = await worker.fetch(new Request('https://test/api/poll?v=2&s=' + id), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await worker.fetch(new Request('https://test/api/poll?s=' + id, { method: 'POST' }), env)).status, 405);
});

module.exports = { Storage };
