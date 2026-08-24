export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/upload' && request.method === 'POST') {
      return relayToSession(request, env, 'POST', '/upload');
    }
    if (url.pathname === '/api/poll' && request.method === 'GET') {
      return relayToSession(request, env, 'GET', '/poll');
    }

    // 그 외 요청은 public/ 폴더의 정적 파일로 응답
    return env.ASSETS.fetch(request);
  }
};

async function relayToSession(request, env, method, doPath) {
  const url = new URL(request.url);
  const session = url.searchParams.get('s');
  if (!session) return new Response('missing session', { status: 400 });

  const id = env.SESSIONS.idFromName(session);
  const stub = env.SESSIONS.get(id);

  const init = { method, headers: request.headers };
  if (method === 'POST') init.body = request.body;

  return stub.fetch('https://do' + doPath, init);
}

// 세션(=폰과 PC가 QR로 연결된 한 번의 만남)마다 하나씩 생기는 임시 사진 보관함.
// 15분간 보관 후 자동 삭제되고, PC가 폴링해서 가져가면 즉시 삭제됨(1회성 전달).
export class SessionRelay {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/upload') {
      const form = await request.formData();
      const file = form.get('file');
      if (!file) return new Response('no file', { status: 400 });

      const buf = await file.arrayBuffer();

      // SQLite 방식 Durable Object는 키+값 합쳐 2MB가 한계다.
      // base64로 담으면 용량이 33% 불어나므로 원본 바이트 그대로 저장하고,
      // 문자열 변환은 PC가 받아갈 때(/poll)만 한다.
      if (buf.byteLength > 1_900_000) {
        return new Response(JSON.stringify({
          ok: false,
          error: 'too_large',
          message: '사진 용량이 너무 커요. 조금 더 줄여서 다시 보내주세요.'
        }), { status: 413, headers: { 'content-type': 'application/json' } });
      }

      const id = crypto.randomUUID();
      await this.state.storage.put('up:' + id, {
        filename: file.name || 'photo.jpg',
        type: file.type || 'image/jpeg',
        data: buf,
        ts: Date.now()
      });
      await this.state.storage.setAlarm(Date.now() + 15 * 60 * 1000);

      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' }
      });
    }

    if (request.method === 'GET' && url.pathname === '/poll') {
      const list = await this.state.storage.list({ prefix: 'up:' });
      const out = [];
      for (const [key, val] of list) {
        out.push({
          id: key.slice(3),
          filename: val.filename,
          type: val.type,
          // 저장은 원본 바이트로, 전송은 JSON이라 여기서만 base64로 바꾼다
          data: arrayBufferToBase64(val.data),
          ts: val.ts
        });
        await this.state.storage.delete(key);
      }
      return new Response(JSON.stringify(out), {
        headers: { 'content-type': 'application/json' }
      });
    }

    return new Response('not found', { status: 404 });
  }

  async alarm() {
    const list = await this.state.storage.list({ prefix: 'up:' });
    for (const key of list.keys()) await this.state.storage.delete(key);
  }
}

function arrayBufferToBase64(buf) {
  let binary = '';
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
