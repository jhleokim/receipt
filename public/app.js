const { PDFDocument, rgb } = PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const MAX_W = 760;
const cardsEl = document.getElementById('cards');
const fileInput = document.getElementById('fileInput');
const dropzone = document.getElementById('dropzone');
let seq = 0;
const items = []; // 화면에 올라온 모든 영수증 (삭제 시 alive=false)

/* ---------- 업로드(드래그앤드롭 / 클릭) ---------- */
dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
document.getElementById('addMore').addEventListener('click', () => fileInput.click());
dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('drag'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
dropzone.addEventListener('drop', e => {
  e.preventDefault();
  dropzone.classList.remove('drag');
  handleFiles(e.dataTransfer.files);
});
fileInput.addEventListener('change', e => { handleFiles(e.target.files); fileInput.value = ''; });

function handleFiles(fileList){
  [...fileList].forEach(file => {
    if (file.type.startsWith('image/')) addImageItem(file);
    else if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) addPdfItem(file);
  });
}


let activeItemId = null, pendingRemoval = null;
function itemSignature(item){
  return JSON.stringify([item.els.date.value, item.els.name.value, item.els.place.value, item.els.amount.value, item.rects]);
}
function snapshotItem(item){
  const snapshot = { ...item, original: item, rects: item.rects.map(rect => ({ ...rect })), els: { ...item.els } };
  for (const field of ['date', 'name', 'place', 'amount']) snapshot.els[field] = { value: item.els[field].value };
  snapshot.exportSignature = itemSignature(snapshot);
  return snapshot;
}
function updateReceiptNav(item){
  item.navButton.querySelector('strong').textContent = item.els.place.value || item.originalName;
  const amount = item.els.amount.value.replace(/[^\d]/g, '');
  item.navButton.querySelector('small').textContent = (item.els.date.value || '날짜 확인 필요') + (amount ? ' · ' + Number(amount).toLocaleString('ko-KR') + '원' : '');
  item.navButton.classList.toggle('is-saved', item.els.card.classList.contains('saved'));
}
function selectReceipt(id){
  activeItemId = id;
  for (const item of items) {
    item.els.card.hidden = !item.alive || item.id !== id;
    if (item.navButton) item.navButton.setAttribute('aria-current', String(item.id === id));
  }
  const item = items.find(it => it.id === id);
  if (item?.canvas) markScrollable(item);
}
function syncWorkspace(){
  const live = items.filter(it => it.alive);
  const hadFiles = document.body.classList.contains('has-receipts');
  document.body.classList.toggle('has-receipts', !!live.length);
  document.getElementById('workspace').classList.toggle('hidden', !live.length);
  document.getElementById('receiptCount').textContent = live.length;
  if (!hadFiles && live.length) document.getElementById('qrPanel').open = false;
  for (const item of items) {
    if (!item.navButton) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'receipt-nav-item';
      button.setAttribute('aria-controls', 'receipt-' + item.id);
      button.innerHTML = '<span class="receipt-number"></span><span><strong></strong><small></small></span>';
      button.querySelector('.receipt-number').textContent = String(item.id).padStart(2, '0');
      button.addEventListener('click', () => selectReceipt(item.id));
      document.getElementById('receiptList').appendChild(button);
      item.navButton = button;
    }
    item.navButton.hidden = !item.alive;
    updateReceiptNav(item);
  }
  selectReceipt(live.some(it => it.id === activeItemId) ? activeItemId : live[0]?.id);
}
function disposeItem(item){
  item.disposed = true;
  clearTimeout(item.saveLabelTimer);
  // OCR may still be using the original. Release once the serialized queue settles.
  ocrQueue.finally(() => {
    for (const c of [item.canvas, item.baseCanvas]) if (c) c.width = c.height = 0;
    item.pdfDocument?.destroy().catch(console.error);
    item.img = item.pdfBytes = item.pdfPage = item.pdfDocument = null;
    item.els.card.remove(); item.navButton?.remove();
    const index = items.indexOf(item); if (index >= 0) items.splice(index, 1);
  });
}
function removeItem(item){
  if (pendingRemoval) { clearTimeout(pendingRemoval.timer); disposeItem(pendingRemoval.item); }
  item.cancelDrag?.(); item.alive = false; item.ocrVersion++;
  const notice = document.getElementById('notice');
  notice.querySelector('span').textContent = '영수증을 목록에서 지웠어요.';
  notice.classList.remove('hidden');
  pendingRemoval = { item, timer: setTimeout(() => { disposeItem(item); pendingRemoval = null; notice.classList.add('hidden'); }, 8000) };
  notice.querySelector('button').onclick = () => {
    if (!pendingRemoval) return;
    clearTimeout(pendingRemoval.timer); pendingRemoval = null;
    item.alive = true; activeItemId = item.id; notice.classList.add('hidden'); updateBulkBar();
    if (item.ready) queueOCR(item);
  };
  updateBulkBar();
}

/* ---------- QR 폰 업로드 릴레이 ---------- */
let session = crypto.randomUUID();
let receivedCount = 0;
let receivedIds = new Set(), pollInFlight = false, pollTimer = null, sessionExpired = false;

function renderQR(){
  document.getElementById('qrcode').innerHTML = '';
  const mobileUrl = location.origin + '/upload.html?s=' + encodeURIComponent(session);
  new QRCode(document.getElementById('qrcode'), {
    text: mobileUrl, width: 128, height: 128, correctLevel: QRCode.CorrectLevel.M
  });
  const linkEl = document.getElementById('qrLink');
  linkEl.textContent = mobileUrl;
  linkEl.title = mobileUrl; // 한 줄로 줄여 보여주므로 전체 주소는 툴팁으로 남긴다
}
renderQR();

document.getElementById('qrRefresh').addEventListener('click', () => {
  session = crypto.randomUUID();
  receivedCount = 0;
  receivedIds = new Set(); sessionExpired = false;
  document.getElementById('qrCount').textContent = '0';
  renderQR();
  void pollSession();
});

function b64ToBlob(b64, type){
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type });
}

// 릴레이가 실제로 응답하고 있는지를 QR 패널의 점으로 보여준다
const qrPollingEl = document.getElementById('qrPolling');
function setRelayState(ok){
  qrPollingEl.textContent = ok ? '연결됨' : '연결 끊김';
  qrPollingEl.closest('.qr-status').classList.toggle('offline', !ok);
}

async function pollSession(){
  if (pollInFlight || sessionExpired) return;
  clearTimeout(pollTimer);
  if (document.hidden) { pollTimer = setTimeout(pollSession, 10000); return; }
  pollInFlight = true;
  const requestedSession = session, knownIds = receivedIds;
  try{
    const res = await fetch('/api/poll?v=2&s=' + encodeURIComponent(requestedSession), { signal: AbortSignal.timeout(10000), cache: 'no-store' });
    if (session !== requestedSession) return;
    if (res.status === 410) { sessionExpired = true; setRelayState(false); qrPollingEl.textContent = '만료됨 · 새 코드를 발급해 주세요'; return; }
    if (!res.ok){ setRelayState(false); return; }
    setRelayState(true);
    const list = await res.json();
    if (list.length){
      const ackIds = [];
      for (const u of list) {
        if (session !== requestedSession) return;
        if (knownIds.has(u.id)) { ackIds.push(u.id); continue; }
        const blob = b64ToBlob(u.data, u.type || 'image/jpeg');
        const file = new File([blob], u.filename || ('phone_' + Date.now() + '.jpg'), { type: u.type || 'image/jpeg' });
        const loaded = await addImageItem(file);
        if (session !== requestedSession) return;
        if (!loaded) continue;
        knownIds.add(u.id); ackIds.push(u.id);
        receivedCount++;
      }
      if (session !== requestedSession) return;
      document.getElementById('qrCount').textContent = String(receivedCount);
      if (ackIds.length) {
        const ack = await fetch('/api/ack?s=' + encodeURIComponent(requestedSession), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: ackIds }), signal: AbortSignal.timeout(10000) });
        if (!ack.ok) throw new Error('ack failed');
      }
    }
  } catch(e){ if (requestedSession === session) setRelayState(false); }
  finally {
    pollInFlight = false;
    if (!sessionExpired) pollTimer = setTimeout(pollSession, document.getElementById('qrPanel').open ? 3000 : 8000);
  }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) void pollSession(); });
document.getElementById('qrPanel').addEventListener('toggle', () => { if (document.getElementById('qrPanel').open) void pollSession(); });
pollSession(); // 첫 3초 동안 상태가 "확인 중"으로 멈춰 보이지 않도록 한 번 먼저 찔러본다

/* ---------- 공통 유틸 ---------- */
function sanitize(str){
  return (str || '').trim().replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_');
}
function todayISO(){
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off*60000).toISOString().slice(0,10);
}
function buildFilename(item){
  const dateVal = item.els.date.value || todayISO();
  const date = dateVal.replace(/-/g, '');
  const name = sanitize(item.els.name.value);
  const place = sanitize(item.els.place.value);
  const amount = item.els.amount.value.replace(/[^\d]/g, '') || '0';
  const ext = item.type === 'pdf' ? 'pdf' : 'jpg';
  // 비어 있는 항목은 통째로 빼서 밑줄이 겹치지 않게 함
  const parts = [date, name, place, amount].filter(p => p !== '');
  return parts.join('_') + '.' + ext;
}

/* ---------- 카드 생성 ---------- */
function makeCard(item){
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML =
    '<div class="card-top">' +
      '<span class="fname"></span>' +
      '<span class="saved-tag">' +
        '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="m5 13 4.5 4.5L19 7"/>' +
        '</svg>저장됨' +
      '</span>' +
      '<button class="remove" type="button" aria-label="영수증 삭제" title="삭제">✕</button>' +
    '</div>' +
    '<div class="card-body"><section class="receipt-stage" aria-label="영수증 원본"><div class="canvas-wrap"><span class="loading">불러오는 중…</span></div>' +
    '<div class="hl-row"><button class="hl-toggle" type="button" disabled aria-pressed="false">영역 표시하기</button><button class="undo clear" type="button" disabled>되돌리기</button><button class="clear-all clear" type="button" disabled>전체 지우기</button></div>' +
    '<div class="hl-options"><label>새 영역의 항목 <select class="hl-field"><option value="auto">자동 판단</option><option value="date">날짜</option><option value="place">장소</option><option value="amount">금액</option></select></label></div>' +
    '<p class="hl-hint">① 항목 선택　② 원본 위에 드래그　③ 다시 읽기<br>여러 곳을 표시해도 괜찮아요. 읽지 못한 값은 그대로 둡니다.</p>' +
    '<div class="hl-regions" aria-label="표시한 영역"></div>' +
    '</section><section class="receipt-inspector" aria-label="인식 결과 수정"><div class="inspector-heading"><span class="eyebrow">확인하고 저장하기</span><h2>잘 읽었는지 확인해 주세요</h2><p>틀린 값은 직접 고치거나 원본에 표시해 다시 읽을 수 있어요.</p></div><div class="ocr-row"><span class="ocr-status" role="status"></span><button class="ocr-retry" type="button" disabled>전체 다시 인식</button></div>' +
    '<div class="fields">' +
      '<div class="field"><label>결제일자</label><input type="date" class="in-date"></div>' +
      '<div class="field"><label>이름</label><input type="text" class="in-name" placeholder="(선택)"></div>' +
      '<div class="field"><label>결제장소</label><input type="text" class="in-place" placeholder="예: 스타벅스"></div>' +
      '<div class="field"><label>금액(원)</label><input type="text" inputmode="numeric" class="in-amount" placeholder="예: 12500"></div>' +
    '</div>' +
    '<div class="fname-preview">저장할 파일명<b class="fname-out"></b></div>' +
    '<div class="save-row">' +
      '<button class="save-btn" type="button">저장</button>' +
      '<button class="share-btn" type="button">' +
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M12 15V3.5"/><path d="m8 7.5 4-4 4 4"/>' +
          '<path d="M4.5 13v6A1.5 1.5 0 0 0 6 20.5h12a1.5 1.5 0 0 0 1.5-1.5v-6"/>' +
        '</svg><span class="lbl">공유</span>' +
      '</button>' +
    '</div></section></div>';

  card.querySelector('.fname').textContent = item.originalName;
  card.querySelector('.fname').title = item.originalName;
  card.id = 'receipt-' + item.id;
  for (const field of card.querySelectorAll('.field')) {
    const input = field.querySelector('input');
    input.id = input.className + '-' + item.id;
    field.querySelector('label').htmlFor = input.id;
  }
  item.els = {
    date: card.querySelector('.in-date'),
    name: card.querySelector('.in-name'),
    place: card.querySelector('.in-place'),
    amount: card.querySelector('.in-amount'),
    fnameOut: card.querySelector('.fname-out'),
    canvasWrap: card.querySelector('.canvas-wrap'),
    saveBtn: card.querySelector('.save-btn'),
    shareBtn: card.querySelector('.share-btn'),
    shareLbl: card.querySelector('.share-btn .lbl'),
    card: card,
    clearBtn: card.querySelector('.clear-all'),
    undoBtn: card.querySelector('.undo'),
    hlField: card.querySelector('.hl-field'),
    hlRegions: card.querySelector('.hl-regions'),
    removeBtn: card.querySelector('.remove'),
    ocrStatus: card.querySelector('.ocr-status'),
    ocrRetry: card.querySelector('.ocr-retry'),
    hlToggle: card.querySelector('.hl-toggle'),
  };

  // 영역 표시 모드: 버튼을 눌러야만 드래그가 활성화됨(모바일 스크롤과 충돌 방지)
  item.highlightMode = false;
  item.fieldEdits = { date: 0, place: 0, amount: 0 };
  item.regionRevision = 0;
  item.ocrVersion = 0;
  item.setHLMode = function(on){
    item.highlightMode = on;
    card.classList.toggle('highlighting', on);
    if (!on && item.cancelDrag) item.cancelDrag();
    item.els.hlToggle.classList.toggle('active', on);
    item.els.hlToggle.setAttribute('aria-pressed', String(on));
    item.els.hlToggle.textContent = on ? '표시 끝내기' : '영역 표시하기';
    if (item.canvas){
      item.canvas.style.touchAction = on ? 'none' : 'pan-y';
      item.canvas.style.cursor = on ? 'crosshair' : 'default';
    }
  };
  item.els.hlToggle.addEventListener('click', () => item.setHLMode(!item.highlightMode));

  // 이름은 기본적으로 비워둔다 (필요한 사람만 직접 입력)

  [item.els.date, item.els.name, item.els.place, item.els.amount].forEach(inp => {
    inp.addEventListener('input', () => {
      for (const field of ['date', 'place', 'amount']){
        if (item.els[field] === inp) item.fieldEdits[field]++;
      }
      updateFnamePreview(item);
    });
  });
  updateFnamePreview(item);

  item.els.clearBtn.addEventListener('click', () => { item.cancelDrag?.(); item.rects = []; regionsChanged(item); });
  item.els.undoBtn.addEventListener('click', () => { item.cancelDrag?.(); item.rects.pop(); regionsChanged(item); });
  item.els.removeBtn.addEventListener('click', () => removeItem(item));
  item.els.saveBtn.addEventListener('click', () => saveItem(item));

  item.els.shareBtn.addEventListener('click', () => shareItem(item));

  item.els.ocrRetry.addEventListener('click', () => {
    item.setHLMode(false);
    queueOCR(item, { retry: true });
  });

  cardsEl.appendChild(card);
  return card;
}

function updateFnamePreview(item){
  item.els.fnameOut.textContent = buildFilename(item);
  if (item.savedSignature) {
    const unchanged = item.savedSignature === itemSignature(item);
    item.els.card.classList.toggle('saved', unchanged);
    item.els.card.classList.toggle('modified', !unchanged);
    item.els.card.querySelector('.saved-tag').textContent = unchanged ? '저장됨' : '다시 저장 필요';
    if (!unchanged && item.els.saveBtn.textContent === '저장됨') item.els.saveBtn.textContent = '저장';
  }
  if (item.navButton) updateReceiptNav(item);
}

/* ---------- 캔버스 / 하이라이트 드래그 ---------- */
async function setupCanvas(item, drawW, drawH, drawFn){
  item.els.canvasWrap.innerHTML = '';
  const base = document.createElement('canvas');
  base.width = drawW; base.height = drawH;
  await drawFn(base.getContext('2d'));
  if (item.disposed) { base.width = base.height = 0; return; }
  item.baseCanvas = base;

  const view = document.createElement('canvas');
  view.width = drawW; view.height = drawH;
  item.canvas = view;
  item.els.canvasWrap.appendChild(view);
  markScrollable(item);
  redraw(item);
  attachDrag(item);
  item.els.hlToggle.disabled = false;
  item.ready = true;
  updateBulkBar();
  item.setHLMode(false);
  queueOCR(item);
}

// 영수증이 미리보기 상자보다 길면 아래가 더 있다는 그림자를 켠다.
// 카드 폭은 화면 크기에 따라 변하므로 리사이즈 때도 다시 판단한다.
function markScrollable(item){
  const wrap = item.els.canvasWrap;
  requestAnimationFrame(() => {
    wrap.classList.toggle('scrollable', wrap.scrollHeight > wrap.clientHeight + 2);
  });
}
window.addEventListener('resize', () => {
  items.forEach(it => { if (it.alive && it.canvas) markScrollable(it); });
});

function redraw(item){
  if (!item.canvas) return;
  const ctx = item.canvas.getContext('2d');
  ctx.clearRect(0,0,item.canvas.width, item.canvas.height);
  ctx.drawImage(item.baseCanvas, 0, 0);
  drawHighlight(ctx, item, 1, item.draftRect ? [...item.rects, item.draftRect] : item.rects);
  // Number badges are editor guides; exported receipts keep only the red rectangles.
  item.rects.forEach((rect, index) => {
    ctx.fillStyle = '#A62F2A'; ctx.font = 'bold 17px sans-serif';
    const x = Math.max(0, rect.x), y = Math.max(22, rect.y);
    ctx.fillRect(x, y - 22, 25, 22);
    ctx.fillStyle = '#fff'; ctx.fillText(String(index + 1), x + 6, y - 5);
  });
}

function updateRegionControls(item){
  const count = item.rects.length;
  item.els.clearBtn.disabled = item.els.undoBtn.disabled = !count;
  item.els.ocrRetry.textContent = count ? '표시 영역 다시 인식 (' + count + ')' : '전체 다시 인식';
  item.els.hlRegions.replaceChildren();
  item.rects.forEach((rect, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'hl-region';
    const label = (index + 1) + ' · ' + OCR_FIELD_LABELS[rect.field];
    button.textContent = label + ' ×';
    button.setAttribute('aria-label', label + ' 영역 삭제');
    button.addEventListener('click', () => { item.rects.splice(index, 1); regionsChanged(item); });
    item.els.hlRegions.appendChild(button);
  });
}

function regionsChanged(item){
  item.regionRevision++;
  updateFnamePreview(item);
  updateRegionControls(item);
  redraw(item);
  item.els.ocrStatus.textContent = item.rects.length
    ? '표시 영역을 다시 인식하면 해당 항목을 교정합니다'
    : '전체 영수증을 다시 인식할 수 있어요';
}

function attachDrag(item){
  const c = item.canvas;
  let pointerId = null, sx = 0, sy = 0;
  function pos(e){
    const r = c.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(c.width, (e.clientX - r.left) * c.width / r.width)),
      y: Math.max(0, Math.min(c.height, (e.clientY - r.top) * c.height / r.height))
    };
  }
  function down(e){
    if (!item.highlightMode || pointerId !== null || !e.isPrimary || e.button !== 0) return;
    e.preventDefault();
    pointerId = e.pointerId;
    const p = pos(e); sx = p.x; sy = p.y;
    c.setPointerCapture(pointerId);
  }
  function move(e){
    if (e.pointerId !== pointerId) return;
    e.preventDefault();
    const p = pos(e);
    item.draftRect = { x: Math.min(sx,p.x), y: Math.min(sy,p.y), w: Math.abs(p.x-sx), h: Math.abs(p.y-sy), field: item.els.hlField.value };
    redraw(item);
  }
  item.cancelDrag = () => {
    const id = pointerId;
    pointerId = null;
    item.draftRect = null;
    if (id !== null && c.hasPointerCapture(id)) c.releasePointerCapture(id);
    redraw(item);
  };
  function up(e){
    if (e.pointerId !== pointerId) return;
    move(e);
    const rect = item.draftRect;
    item.cancelDrag();
    // 클릭이나 아주 작은 드래그는 영역으로 만들지 않는다.
    if (rect && rect.w >= 4 && rect.h >= 4){
      item.rects.push(rect);
      regionsChanged(item);
    }
  }
  c.addEventListener('pointerdown', down);
  c.addEventListener('pointermove', move);
  c.addEventListener('pointerup', up);
  c.addEventListener('pointercancel', item.cancelDrag);
  c.addEventListener('lostpointercapture', item.cancelDrag);
}

/* ---------- 이미지 / PDF 로드 ---------- */
function addImageItem(file){
  const item = { id: ++seq, type: 'image', originalName: file.name, rects: [], alive: true };
  makeCard(item);
  items.push(item);
  updateBulkBar();
  const img = new Image();
  return new Promise(resolve => {
  const objectUrl = URL.createObjectURL(file);
  img.onload = async () => {
    URL.revokeObjectURL(objectUrl);
    if (item.disposed) { resolve(true); return; }
    item.img = img;
    item.naturalWidth = img.naturalWidth;
    item.naturalHeight = img.naturalHeight;
    const scale = Math.min(1, MAX_W / img.naturalWidth);
    const dw = Math.round(img.naturalWidth * scale);
    const dh = Math.round(img.naturalHeight * scale);
    item.previewScale = scale;
    try {
      await setupCanvas(item, dw, dh, ctx => ctx.drawImage(img, 0, 0, dw, dh));
      resolve(true);
    } catch (error) { console.error(error); resolve(false); }
  };
  img.onerror = () => { URL.revokeObjectURL(objectUrl); if (item.alive) item.els.canvasWrap.innerHTML = '<span class="loading">사진을 열지 못했어요. JPG·PNG 파일로 다시 추가해 주세요.</span>'; resolve(false); };
  img.src = objectUrl;
  });
}

async function addPdfItem(file){
  const item = { id: ++seq, type: 'pdf', originalName: file.name, rects: [], alive: true };
  makeCard(item);
  items.push(item);
  updateBulkBar();
  try{
    const buf = await file.arrayBuffer();
    item.pdfBytes = buf.slice(0);
    const pdf = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
    item.pdfDocument = pdf;
    if (item.disposed) { await pdf.destroy(); return; }
    const page = await pdf.getPage(1);
    item.pdfPage = page; // PDF 묶음 만들 때 고해상도로 다시 그리기 위해 보관
    const v1 = page.getViewport({ scale: 1 });
    item.pageWidthPt = v1.width;
    item.pageHeightPt = v1.height;
    const scale = Math.min(1, MAX_W / v1.width);
    item.previewScale = scale;
    const viewport = page.getViewport({ scale });
    const dw = Math.round(viewport.width);
    const dh = Math.round(viewport.height);
    await setupCanvas(item, dw, dh, async ctx => {
      await page.render({ canvasContext: ctx, viewport }).promise;
    });
  } catch(err){
    console.error(err);
    item.els.canvasWrap.innerHTML = '<span class="loading">PDF를 불러올 수 없어요</span>';
  }
}

/* ---------- 저장(하이라이트 합성 + 다운로드) ---------- */
// 내보낼 때 원본 해상도 그대로 캔버스를 만들면 폰에서 렌더러가 메모리로 죽는다.
// 12MP 사진이면 캔버스 하나가 RGBA 로 약 49MB — 이미 올라와 있는 원본 이미지에 그만큼이 더 얹힌다.
// 공유 시트가 뜨며 탭이 백그라운드로 갈 때 이 상태면 안드로이드가 탭을 날려버리고,
// 공유 시트는 사라진 파일을 기다리며 영원히 돌게 된다.
// 긴 변 2000px 은 upload.html 이 폰 사진에 이미 쓰고 있는 값이고, 영수증을 읽는 데 충분하다.
const MAX_EXPORT = 2000;
function exportSize(item){
  const scale = Math.min(1, MAX_EXPORT / Math.max(item.naturalWidth, item.naturalHeight));
  return {
    w: Math.max(1, Math.round(item.naturalWidth * scale)),
    h: Math.max(1, Math.round(item.naturalHeight * scale)),
    scale,
  };
}

// 하이라이트 사각형을 미리보기 좌표에서 내보내기 좌표로 옮겨 그린다
function drawHighlight(ctx, item, ratio, rects = item.rects){
  ctx.fillStyle = 'rgba(179,49,44,0.1)';
  ctx.strokeStyle = 'rgba(179,49,44,0.9)';
  ctx.lineWidth = Math.max(2, 2 * ratio * 0.3);
  for (const rect of rects){
    const x = rect.x * ratio, y = rect.y * ratio;
    const w = rect.w * ratio, h = rect.h * ratio;
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
  }
}

// 저장이 끝난 카드는 도장 대신 종이 가장자리에 청록 빛을 남긴다.
function markSaved(saved){
  const item = saved.original || saved;
  if (!item.alive) return;
  const card = item.els && item.els.card;
  if (!card) return;
  // 이미 저장된 카드를 다시 저장해도 빛이 한 번 더 피어오르도록 애니메이션을 되감는다
  card.classList.remove('saved');
  void card.offsetWidth;
  card.classList.add('saved');
  card.classList.remove('modified');
  card.querySelector('.saved-tag').textContent = '저장됨';
  item.savedSignature = saved.exportSignature || itemSignature(item);
  updateFnamePreview(item);
  if (item.navButton) updateReceiptNav(item);
}

async function exportImageBlob(item){
  const { w, h, scale } = exportSize(item);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(item.img, 0, 0, w, h);
  drawHighlight(ctx, item, scale / item.previewScale);

  const blob = await new Promise(res => canvas.toBlob(b => res(b), 'image/jpeg', 0.92));
  // 폰에서는 이 메모리를 GC 까지 들고 있으면 늦다. 바로 반납한다.
  canvas.width = canvas.height = 0;
  // 메모리가 모자라면 toBlob 이 null 을 준다. 그대로 두면 "null" 이라고 적힌 파일이 저장된다.
  if (!blob) throw new Error('이미지를 만들지 못했습니다 (메모리 부족)');
  return blob;
}

async function exportPdfBlob(item){
  const doc = await PDFDocument.load(item.pdfBytes);
  const page = doc.getPage(0);
  for (const rect of item.rects){
    const s = item.previewScale;
    const pdfX = rect.x / s;
    const pdfTop = rect.y / s;
    const pdfW = rect.w / s;
    const pdfH = rect.h / s;
    const pdfY = item.pageHeightPt - (pdfTop + pdfH);
    page.drawRectangle({ x: pdfX, y: pdfY, width: pdfW, height: pdfH,
      color: rgb(179/255, 49/255, 44/255), opacity: 0.1,
      borderColor: rgb(179/255, 49/255, 44/255), borderOpacity: 0.9, borderWidth: 2 / s });
  }
  const bytes = await doc.save();
  return new Blob([bytes], { type: 'application/pdf' });
}

function shareItem(item){
  if (!item.alive || !item.ready) return;
  const snapshot = snapshotItem(item);
  return openReceiptShare(async () => {
    const blob = item.type === 'pdf' ? await exportPdfBlob(snapshot) : await exportImageBlob(snapshot);
    return [{ blob, filename: buildFilename(snapshot), item: snapshot }];
  }, '영수증 공유');
}

async function saveItem(item){
  if (item.els.saveBtn.disabled) return;
  const snapshot = snapshotItem(item);
  item.els.removeBtn.disabled = true;
  item.els.saveBtn.disabled = true;
  item.els.saveBtn.textContent = '저장 중…';
  try{
    const blob = item.type === 'pdf' ? await exportPdfBlob(snapshot) : await exportImageBlob(snapshot);
    const filename = buildFilename(snapshot);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    markSaved(snapshot);
    // 눌린 버튼이 잠깐 결과를 말해주고 원래대로 돌아간다. 남는 표시는 카드의 빛이 맡는다.
    item.els.saveBtn.disabled = false;
    item.els.saveBtn.textContent = '저장됨';
    clearTimeout(item.saveLabelTimer);
    item.saveLabelTimer = setTimeout(() => { item.els.saveBtn.textContent = '저장'; }, 1800);
    return;
  } catch(err){
    console.error(err);
    item.els.ocrStatus.textContent = '파일을 만들지 못했어요. 입력한 값은 그대로예요. 저장을 다시 눌러 주세요.';
  } finally {
    item.els.removeBtn.disabled = false;
  }
  item.els.saveBtn.disabled = false;
  item.els.saveBtn.textContent = '저장';
}
/* ---------- 전체 저장 (개별파일 / PDF묶음) ---------- */
const bulkBar = document.getElementById('bulkBar');
const bulkCountEl = document.getElementById('bulkCount');
const bulkStatusEl = document.getElementById('bulkStatus');
const btnEach = document.getElementById('btnEach');
const btnPdf = document.getElementById('btnPdf');

function aliveItems(){
  return items.filter(it => it.alive && it.baseCanvas);
}
function updateBulkBar(){
  syncWorkspace();
  const n = items.filter(it => it.alive).length;
  bulkCountEl.textContent = String(n);
  bulkBar.classList.toggle('hidden', n === 0);
  // 하단 바가 고정이라 마지막 카드가 가리지 않도록 본문 아래 여백을 준다
  document.body.classList.toggle('has-bar', n > 0);
  const ready = aliveItems().length;
  btnEach.disabled = btnPdf.disabled = !ready;
  for (const item of items) {
    item.els.saveBtn.disabled = !item.ready;
    if (item.els.shareBtn) item.els.shareBtn.disabled = !item.ready;
  }
}
function bulkBusy(on, msg){
  btnEach.disabled = on;
  btnPdf.disabled = on;
  bulkStatusEl.textContent = msg || '';
  for (const item of items) item.els.removeBtn.disabled = on;
}
function triggerDownload(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}
// 같은 파일명이 겹치면 뒤에 (2), (3)을 붙여 덮어쓰기를 막음
function dedupeName(filename, used){
  if (!used.has(filename)){ used.add(filename); return filename; }
  const dot = filename.lastIndexOf('.');
  const stem = filename.slice(0, dot), ext = filename.slice(dot);
  let i = 2;
  while (used.has(stem + '(' + i + ')' + ext)) i++;
  const out = stem + '(' + i + ')' + ext;
  used.add(out);
  return out;
}

// Batch preparation also finishes before the user chooses a sharing app.
btnEach.addEventListener('click', () => {
  const list = aliveItems().map(snapshotItem);
  if (!list.length) return;
  void openReceiptShare(async () => {
    const used = new Set(), prepared = [];
    for (const item of list){
      const blob = item.type === 'pdf' ? await exportPdfBlob(item) : await exportImageBlob(item);
      prepared.push({ blob, filename: dedupeName(buildFilename(item), used), item });
    }
    return prepared;
  }, '영수증 ' + list.length + '건 내보내기');
});

// "파일 받기"를 누를 때마다 딱 한 장씩 — 매번 새 클릭이라 어떤 브라우저에서도 막히지 않는다.
function startManualQueue(prepared){
  let idx = 0;
  const panel = document.getElementById('queuePanel');
  const label = document.getElementById('queueLabel');
  const nextBtn = document.getElementById('queueNext');
  const closeBtn = document.getElementById('queueClose');

  panel.classList.remove('hidden');
  bulkBar.classList.add('hidden');

  function render(){
    if (idx >= prepared.length){
      label.innerHTML = '<b>완료 ✓</b> (' + prepared.length + '/' + prepared.length + ')';
      nextBtn.textContent = '완료';
      nextBtn.disabled = true;
      return;
    }
    label.innerHTML = '<b>' + (idx+1) + '</b> / ' + prepared.length;
    nextBtn.disabled = false;
    nextBtn.textContent = '파일 받기 (' + (idx+1) + '/' + prepared.length + ')';
  }
  function onNext(){
    if (idx >= prepared.length) return;
    const p = prepared[idx];
    triggerDownload(p.blob, p.filename);
    markSaved(p.item);
    idx++;
    render();
  }
  function onClose(){
    panel.classList.add('hidden');
    bulkBar.classList.remove('hidden');
    nextBtn.removeEventListener('click', onNext);
    closeBtn.removeEventListener('click', onClose);
  }
  nextBtn.addEventListener('click', onNext);
  closeBtn.addEventListener('click', onClose);
  render();
}

/* ----- PDF 미리보기 & 묶음 저장 ----- */
const A4_W = 595.28, A4_H = 841.89; // A4 (pt)  1pt ≈ 0.353mm
const MARGIN = 28;                  // 약 10mm 여백
const GUTTER = 12;                  // 영수증 사이 간격
const CAPTION_H = 11;               // 각 영수증 아래 날짜·금액 표기 공간
const PRINT_W = A4_W - MARGIN * 2;
const PRINT_H = A4_H - MARGIN * 2;
const TARGET_TEXT_PT = 9;           // 영수증 글씨가 이 크기로 앉도록 배율 계산(자동 배치 판단용)
const OCR_FAIL_RATIO = 0.030;       // OCR이 글자높이를 못 재면 쓰는 기본값

function colWidth(cols){
  return (PRINT_W - GUTTER * (cols - 1)) / cols;
}
function neededWidth(item){
  const ratio = item.textPxRatio || OCR_FAIL_RATIO;
  return TARGET_TEXT_PT / ratio;
}
// 자동 초기값: 전체 영수증의 필요 폭을 보고 1~4열 중 하나를 고른다.
// (이후 사용자가 슬라이더로 직접 바꿀 수 있음)
function decideColumns(list){
  const needs = list.map(neededWidth).sort((a,b) => a-b);
  const q3 = needs[Math.min(needs.length - 1, Math.floor(needs.length * 0.75))];
  for (const cols of [4, 3, 2]){
    if (colWidth(cols) >= q3) return cols;
  }
  return 1;
}

// 하이라이트까지 합성된 원본 해상도 캔버스
async function composeCanvas(item){
  if (item.type === 'image'){
    // PDF 로 묶을 때도 원본 해상도로 펼치면 폰에서 메모리로 죽는다 (exportSize 주석 참고)
    const { w, h, scale } = exportSize(item);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(item.img, 0, 0, w, h);
    drawHighlight(ctx, item, scale / item.previewScale);
    return c;
  }
  const scale = 2;
  const viewport = item.pdfPage.getViewport({ scale });
  const c = document.createElement('canvas');
  c.width = Math.round(viewport.width); c.height = Math.round(viewport.height);
  await item.pdfPage.render({ canvasContext: c.getContext('2d'), viewport }).promise;
  drawHighlight(c.getContext('2d'), item, scale / item.previewScale);
  return c;
}

function canvasToJpegBytes(canvas, quality){
  const dataUrl = canvas.toDataURL('image/jpeg', quality || 0.88);
  const b64 = dataUrl.split(',')[1];
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

// 한 칸 높이를 넘는 긴 영수증은 세로로 잘라 여러 칸에 이어 붙인다
function sliceCanvas(canvas, sliceH, overlap){
  const out = [];
  let y = 0;
  while (y < canvas.height){
    const h = Math.min(sliceH, canvas.height - y);
    const c = document.createElement('canvas');
    c.width = canvas.width; c.height = h;
    c.getContext('2d').drawImage(canvas, 0, y, canvas.width, h, 0, 0, canvas.width, h);
    out.push(c);
    if (y + h >= canvas.height) break;
    y += h - overlap;
  }
  return out;
}

function buildBundleFilename(list){
  const dates = list
    .map(it => (it.els.date.value || '').replace(/-/g, ''))
    .filter(Boolean)
    .sort();
  const first = dates[0] || todayISO().replace(/-/g,'');
  const last = dates[dates.length - 1] || first;
  const dateStr = (first === last) ? first : (first + '~' + last);

  const name = sanitize(list[0].els.name.value);

  const places = list.map(it => sanitize(it.els.place.value)).filter(Boolean);
  let placeStr = '';
  if (places.length){
    const freq = {};
    places.forEach(p => { freq[p] = (freq[p] || 0) + 1; });
    const rep = Object.keys(freq).sort((a,b) => freq[b] - freq[a])[0];
    placeStr = Object.keys(freq).length > 1 ? (rep + '등') : rep;
  }

  return [dateStr, name, placeStr].filter(p => p !== '').join('_') + '.pdf';
}

// 순수 배치 계산(동기): 이미 합성된 캔버스들을 열 개수만 바꿔가며 다시 배열한다.
// 무거운 부분(이미지 합성)은 미리 끝내놨기 때문에 슬라이더를 움직여도 빠르게 다시 그려진다.
function layoutPagesSync(list, canvases, cols){
  const cw = colWidth(cols);
  const pages = [[]];
  let colY = new Array(cols).fill(0);
  let curPage = 0;

  function pickColumn(blockH){
    let best = -1;
    for (let c = 0; c < cols; c++){
      if (colY[c] + blockH <= PRINT_H && (best === -1 || colY[c] < colY[best])) best = c;
    }
    return best;
  }
  function newPage(){ pages.push([]); curPage++; colY = new Array(cols).fill(0); }

  for (let idx = 0; idx < list.length; idx++){
    const item = list[idx];
    const canvas = canvases[idx];
    const pxPerPt = canvas.width / cw;
    const fullH = canvas.height / pxPerPt;
    const maxH = PRINT_H - CAPTION_H - GUTTER;

    let pieces;
    if (fullH <= maxH){
      pieces = [canvas];
    } else {
      const sliceHpx = Math.floor(maxH * pxPerPt);
      pieces = sliceCanvas(canvas, sliceHpx, Math.floor(sliceHpx * 0.04));
    }

    for (let p = 0; p < pieces.length; p++){
      const piece = pieces[p];
      const drawW = cw;
      const drawH = piece.height / (piece.width / cw);
      const blockH = drawH + CAPTION_H + GUTTER;

      let c = pickColumn(blockH);
      if (c === -1){ newPage(); c = 0; }

      const x = MARGIN + c * (cw + GUTTER);
      const yTop = colY[c];
      const caption = (item.els.date.value || '').replace(/-/g,'') + '  ' +
                      (item.els.amount.value.replace(/[^\d]/g,'') || '0') +
                      (pieces.length > 1 ? ('  (' + (p+1) + '/' + pieces.length + ')') : '');

      pages[curPage].push({ canvas: piece, x, yTop, drawW, drawH, caption });
      colY[c] = yTop + blockH;
    }
  }
  return pages;
}

async function pagesToPdfBlob(pages){
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  for (const placements of pages){
    const page = doc.addPage([A4_W, A4_H]);
    for (const pl of placements){
      const img = await doc.embedJpg(canvasToJpegBytes(pl.canvas));
      const yPdf = A4_H - MARGIN - pl.yTop - pl.drawH;
      page.drawImage(img, { x: pl.x, y: yPdf, width: pl.drawW, height: pl.drawH });
      page.drawText(pl.caption, { x: pl.x, y: yPdf - 8, size: 7, font, color: rgb(0.55, 0.51, 0.45) });
    }
  }
  const bytes = await doc.save();
  return new Blob([bytes], { type: 'application/pdf' });
}

function renderPreviewThumbs(pages){
  const strip = document.getElementById('previewStrip');
  strip.innerHTML = '';
  const thumbW = Math.min(520, Math.max(260, window.innerWidth - 96)) * Number(document.getElementById('previewZoom').value);
  const scale = thumbW / A4_W;
  const thumbH = A4_H * scale;

  pages.forEach((placements, pi) => {
    const wrap = document.createElement('div');
    wrap.className = 'preview-page';
    const c = document.createElement('canvas');
    c.width = thumbW; c.height = thumbH;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, thumbW, thumbH);
    placements.forEach(pl => {
      const dx = pl.x * scale, dy = (MARGIN + pl.yTop) * scale;
      const dw = pl.drawW * scale, dh = pl.drawH * scale;
      ctx.drawImage(pl.canvas, dx, dy, dw, dh);
      ctx.strokeStyle = '#e5ddc9';
      ctx.lineWidth = 1;
      ctx.strokeRect(dx, dy, dw, dh);
    });
    ctx.strokeStyle = '#D9D0BC';
    ctx.strokeRect(0, 0, thumbW, thumbH);

    const label = document.createElement('div');
    label.className = 'preview-page-label';
    label.textContent = (pi + 1) + ' / ' + pages.length + '쪽';

    wrap.appendChild(c);
    wrap.appendChild(label);
    strip.appendChild(wrap);
  });
  document.getElementById('previewPageCount').textContent = pages.length + '쪽 · A4';
}

let previewList = null, previewCanvases = null, previewPages = null, previewDebounce = null;

function openPdfPreview(list, canvases){
  previewList = list;
  previewCanvases = canvases;
  const cols = Math.max(1, Math.min(4, decideColumns(list)));

  const slider = document.getElementById('colsSlider');
  const colsLabel = document.getElementById('colsLabel');
  slider.value = String(cols);
  colsLabel.textContent = cols + '열';

  previewPages = layoutPagesSync(list, canvases, cols);
  renderPreviewThumbs(previewPages);

  document.getElementById('pdfPreviewPanel').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  document.getElementById('workspace').inert = true;
  bulkBar.inert = true;
  document.getElementById('previewClose').focus();
}

document.getElementById('colsSlider').addEventListener('input', (e) => {
  document.getElementById('colsLabel').textContent = e.target.value + '열';
  clearTimeout(previewDebounce);
  releasePreviewPieces();
  previewPages = layoutPagesSync(previewList, previewCanvases, Number(e.target.value));
  renderPreviewThumbs(previewPages);
});

function releasePreviewPieces(){
  for (const page of previewPages || []) for (const p of page) {
    if (!previewCanvases?.includes(p.canvas)) p.canvas.width = p.canvas.height = 0;
  }
}
function closePdfPreview(){
  if (document.getElementById('previewDownload').disabled) return;
  clearTimeout(previewDebounce);
  releasePreviewPieces();
  for (const c of previewCanvases || []) c.width = c.height = 0;
  previewPages = previewCanvases = previewList = null;
  document.getElementById('previewStrip').replaceChildren();
  document.getElementById('pdfPreviewPanel').classList.add('hidden');
  document.body.style.overflow = '';
  document.getElementById('workspace').inert = false;
  bulkBar.inert = false;
  btnPdf.focus();
}
document.getElementById('previewZoom').addEventListener('change', () => renderPreviewThumbs(previewPages));
document.getElementById('pdfPreviewPanel').addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.preventDefault(); closePdfPreview(); }
  if (e.key === 'Tab') {
    const controls = [...e.currentTarget.querySelectorAll('button:not(:disabled), select:not(:disabled)')];
    const first = controls[0], last = controls.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});
document.getElementById('previewClose').addEventListener('click', closePdfPreview);

document.getElementById('previewDownload').addEventListener('click', async () => {
  const btn = document.getElementById('previewDownload');
  btn.disabled = true;
  for (const id of ['colsSlider', 'previewZoom', 'previewClose']) document.getElementById(id).disabled = true;
  btn.textContent = '만드는 중…';
  try{
    const blob = await pagesToPdfBlob(previewPages);
    triggerDownload(blob, buildBundleFilename(previewList));
    previewList.forEach(it => markSaved(it));
    btn.disabled = false;
    closePdfPreview();
  } catch(err){
    console.error(err);
    document.getElementById('previewPageCount').textContent = 'PDF를 만들지 못했어요. 열 수를 바꿔 다시 시도해 주세요.';
  } finally{
    btn.disabled = false;
    for (const id of ['colsSlider', 'previewZoom', 'previewClose']) document.getElementById(id).disabled = false;
    btn.textContent = '이 설정으로 다운로드';
  }
});

btnPdf.addEventListener('click', async () => {
  const list = aliveItems().map(snapshotItem);
  if (!list.length) return;
  bulkBusy(true, '미리보기 준비 중…');
  const canvases = [];
  try{
    for (let i = 0; i < list.length; i++){
      bulkStatusEl.textContent = '이미지 준비 중… ' + (i+1) + ' / ' + list.length;
      canvases.push(await composeCanvas(list[i]));
    }
    openPdfPreview(list, canvases);
    bulkStatusEl.textContent = '';
  } catch(err){
    console.error(err);
    for (const c of canvases) c.width = c.height = 0;
    bulkStatusEl.textContent = '미리보기 준비 중 오류가 발생했어요.';
  } finally{
    btnEach.disabled = false; btnPdf.disabled = false;
    for (const item of items) item.els.removeBtn.disabled = false;
  }
});
