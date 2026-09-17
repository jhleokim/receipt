const TTL = 15 * 60 * 1000;
const MAX_FILE = 1_900_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});
const fail = (message, status) => json({ ok: false, message }, status);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const routes = { '/api/upload': 'POST', '/api/poll': 'GET', '/api/ack': 'POST' };
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (!routes[url.pathname]) return fail('요청한 주소를 찾을 수 없어요.', 404);
    if (request.method !== routes[url.pathname]) return fail('지원하지 않는 요청이에요.', 405);
    const session = url.searchParams.get('s');
    if (!session || !UUID.test(session)) return fail('PC에서 QR코드를 다시 열어 주세요.', 400);
    try {
      const stub = env.SESSIONS.get(env.SESSIONS.idFromName(session));
      return await stub.fetch(new Request('https://session' + url.pathname.slice(4) + url.search, request));
    } catch (error) {
      console.error('receipt-relay', error.name);
      return fail('연결이 잠시 끊겼어요. 다시 시도해 주세요.', 503);
    }
  }
};

async function boundedBody(request, limit) {
  if (Number(request.headers.get('content-length')) > limit) throw new Error('too_large');
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error('too_large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

// Fixed session lifetime; delivery is retained until the v2 desktop acknowledges it.
export class SessionRelay {
  constructor(state) { this.state = state; }
  async expiry() {
    return this.state.storage.transaction(async storage => {
      let expiry = await storage.get('expiresAt');
      if (!expiry) {
        const previous = await storage.list({ prefix: 'up:' });
        expiry = Math.min(Date.now(), ...[...previous.values()].map(v => v.ts)) + TTL;
        for (const key of previous.keys()) await storage.put('pending:' + key.slice(3), true);
        await storage.put('expiresAt', expiry);
        await storage.setAlarm(expiry);
      }
      return expiry;
    });
  }
  async fetch(request) {
    const url = new URL(request.url);
    const expiresAt = await this.expiry();
    if (Date.now() >= expiresAt) { await this.alarm(); return fail('코드가 만료됐어요. PC에서 새 코드를 발급해 주세요.', 410); }
    if (request.method === 'POST' && url.pathname === '/upload') {
      let form;
      try {
        const body = await boundedBody(request, MAX_FILE + 16384);
        form = await new Request(request.url, { method: 'POST', headers: request.headers, body }).formData();
      } catch (error) { return fail(error.message === 'too_large' ? '사진 용량이 너무 커요. 크기를 줄여 다시 보내 주세요.' : '사진을 읽지 못했어요. 다시 선택해 주세요.', error.message === 'too_large' ? 413 : 400); }
      const file = form.get('file');
      if (!file || typeof file === 'string' || !file.type.startsWith('image/')) return fail('사진 파일을 선택해 주세요.', 400);
      if (!file.size || file.size > MAX_FILE) return fail('사진 용량을 확인해 주세요.', 413);
      const requestId = form.get('id');
      if (requestId && (typeof requestId !== 'string' || !UUID.test(requestId))) return fail('전송 번호를 확인해 주세요.', 400);
      const id = requestId || crypto.randomUUID();
      const data = await file.arrayBuffer();
      const result = await this.state.storage.transaction(async storage => {
        if (Date.now() >= expiresAt) return 410;
        if (await storage.get('seen:' + id)) return 200;
        const pending = await storage.list({ prefix: 'pending:' });
        if (pending.size >= 20) return 429;
        const delivered = await storage.list({ prefix: 'seen:' });
        if (delivered.size >= 300) return 429;
        await storage.put('up:' + id, { filename: file.name.slice(0, 240) || 'photo.jpg', type: file.type, data, ts: Date.now() });
        await storage.put('seen:' + id, true);
        await storage.put('pending:' + id, true);
        return 200;
      });
      if (result === 410) return fail('코드가 만료됐어요. PC에서 새 코드를 발급해 주세요.', 410);
      if (result === 429) return fail('대기 중인 사진이 많아요. PC에서 받은 뒤 다시 보내거나 새 코드를 발급해 주세요.', 429);
      return json({ ok: true, id });
    }
    if (request.method === 'GET' && url.pathname === '/poll') {
      const entries = await this.state.storage.list({ prefix: 'up:', limit: 3 });
      const out = [...entries].map(([key, value]) => ({ ...value, id: key.slice(3), data: arrayBufferToBase64(value.data) }));
      // Existing open v1 clients retain their original protocol during rollout.
      if (url.searchParams.get('v') !== '2' && entries.size) await this.state.storage.delete([...entries.keys(), ...[...entries.keys()].map(key => 'pending:' + key.slice(3))]);
      return json(out);
    }
    if (request.method === 'POST' && url.pathname === '/ack') {
      let ids;
      try { ids = JSON.parse(new TextDecoder().decode(await boundedBody(request, 4096))).ids; }
      catch { return fail('수신 확인을 다시 시도해 주세요.', 400); }
      if (!Array.isArray(ids) || ids.length > 20 || ids.some(id => typeof id !== 'string' || !UUID.test(id))) return fail('수신 번호를 확인해 주세요.', 400);
      if (ids.length) await this.state.storage.delete(ids.flatMap(id => ['up:' + id, 'pending:' + id]));
      return json({ ok: true });
    }
    return fail('요청한 주소를 찾을 수 없어요.', 404);
  }
  async alarm() {
    const expiry = await this.state.storage.get('expiresAt');
    if (expiry && Date.now() < expiry) { await this.state.storage.setAlarm(expiry); return; }
    // Keep only the expiry tombstone so an expired QR cannot start a fresh session.
    for (const prefix of ['up:', 'seen:', 'pending:']) {
      while (true) {
        const entries = await this.state.storage.list({ prefix, limit: prefix === 'up:' ? 3 : 100 });
        if (!entries.size) break;
        await this.state.storage.delete([...entries.keys()]);
      }
    }
  }
}
function arrayBufferToBase64(buf) {
  let binary = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
