
  const params = new URLSearchParams(location.search);
  const session = params.get('s');
  const status = document.getElementById('status');
  const thumbs = document.getElementById('thumbs');

  // 서버(Durable Object)가 한 번에 받을 수 있는 한계가 2MB라서 넉넉히 아래로 잡는다.
  const MAX_BYTES = 1.5 * 1024 * 1024;
  // 영수증 글씨를 읽는 데 필요한 해상도는 이 정도면 충분하다.
  const MAX_DIMENSION = 2000;

  if (!session) {
    document.getElementById('hint').textContent = '잘못된 접근이에요. PC 화면의 QR코드를 다시 스캔해주세요.';
    document.getElementById('pickRow').style.display = 'none';
  }

  function loadImage(file){
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('이미지 로드 실패')); };
      img.src = url;
    });
  }

  function canvasToBlob(canvas, quality){
    return new Promise(resolve => canvas.toBlob(b => resolve(b), 'image/jpeg', quality));
  }

  // 긴 변을 2000px로 줄이고, 그래도 크면 화질을 단계적으로 낮춰 용량을 맞춘다.
  function fitImageSize(width, height, step = 1){
    const scale = Math.min(1, MAX_DIMENSION / Math.max(width, height)) * step;
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
  }
  async function shrink(file){


    const img = await loadImage(file);
    const w = img.naturalWidth, h = img.naturalHeight;
    if (file.size <= MAX_BYTES && Math.max(w, h) <= MAX_DIMENSION && !/hei[cf]/i.test(file.type)) return file;
    let blob = null;
    // 화질을 낮춰도 안 되면 크기 자체를 한 단계씩 더 줄인다
    for (const shrinkStep of [1, 0.8, 0.65, 0.5]){
      const { width: cw, height: ch } = fitImageSize(w, h, shrinkStep);
      const canvas = document.createElement('canvas');
      canvas.width = cw; canvas.height = ch;
      canvas.getContext('2d').drawImage(img, 0, 0, cw, ch);

      for (const q of [0.85, 0.7, 0.55, 0.4]){
        blob = await canvasToBlob(canvas, q);
        if (blob && blob.size <= MAX_BYTES) break;
      }
      canvas.width = canvas.height = 0;
      if (blob && blob.size <= MAX_BYTES) break;
    }
    if (!blob || blob.size > MAX_BYTES) throw new Error('사진을 줄이지 못했어요. JPG·PNG로 다시 선택해 주세요.');

    const base = (file.name || 'photo').replace(/\.[^.]+$/, '');
    return new File([blob], base + '.jpg', { type: 'image/jpeg' });
  }

  async function sendOne(file, id){
    const prepared = await shrink(file);
    const fd = new FormData();
    fd.append('file', prepared, prepared.name || 'photo.jpg');
    fd.append('id', id);
    const res = await fetch('/api/upload?s=' + encodeURIComponent(session), {
      method: 'POST',
      body: fd, signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) {
      let msg = '업로드 실패 (' + res.status + ')';
      try {
        const j = await res.json();
        if (j && j.message) msg = j.message;
      } catch(e){}
      throw new Error(msg);
    }
    return prepared;
  }

  let sending = false, failedUploads = [];
  const retry = document.getElementById('retryUpload');
  async function handleFiles(input){
    const batch = [...input.files].map(file => ({ file, id: crypto.randomUUID() }));
    input.value = '';
    if (sending || !batch.length) return;
    await sendBatch([...failedUploads, ...batch]);
  }
  async function sendBatch(batch){
    if (sending) return;
    sending = true; failedUploads = []; retry.hidden = true;
    document.getElementById('pickRow').setAttribute('aria-busy', 'true');
    document.getElementById('fCamera').disabled = document.getElementById('fGallery').disabled = true;
    status.className = '';
    let done = 0, message = '';
    try {
      for (const [i, entry] of batch.entries()){
        status.textContent = '사진을 보내고 있어요 · ' + (i + 1) + ' / ' + batch.length;
        try {
          const sent = await sendOne(entry.file, entry.id);
          done++;
          const img = document.createElement('img');
          const url = URL.createObjectURL(sent);
          img.onload = img.onerror = () => URL.revokeObjectURL(url);
          img.alt = '전송한 영수증 ' + (thumbs.children.length + 1);
          img.src = url; thumbs.appendChild(img);
        } catch (error) {
          failedUploads.push(entry);
          message = error.name === 'TimeoutError' || error.name === 'TypeError' ? '연결을 확인한 뒤 다시 보내 주세요.' : error.message;
        }
      }
      status.className = failedUploads.length ? 'err' : '';
      status.textContent = failedUploads.length ? done + '장 전송 · ' + failedUploads.length + '장 대기. ' + message : done + '장 보냈어요. PC 화면에서 확인해 주세요.';
    } finally {
      sending = false; retry.hidden = !failedUploads.length;
      document.getElementById('pickRow').setAttribute('aria-busy', 'false');
      document.getElementById('fCamera').disabled = document.getElementById('fGallery').disabled = false;
    }
  }
  retry.addEventListener('click', () => sendBatch([...failedUploads]));
  for (const label of document.querySelectorAll('label.pick')) label.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && !sending) { e.preventDefault(); label.querySelector('input').click(); }
  });
  document.getElementById('fCamera').addEventListener('change', (e) => handleFiles(e.target));
  document.getElementById('fGallery').addEventListener('change', (e) => handleFiles(e.target));
