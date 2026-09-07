const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const ocr = fs.readFileSync(path.join(root, 'public/receipt-ocr.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
function context(extra = {}){
  const ctx = vm.createContext({ console: { error(){} }, Date, ...extra });
  vm.runInContext(ocr, ctx);
  return ctx;
}
function plain(value){ return JSON.parse(JSON.stringify(value)); }
function section(start, end){ return html.slice(html.indexOf(start), html.indexOf(end)); }
function item(){
  return {
    alive: true, type: 'image', ocrVersion: 0, regionRevision: 0,
    rects: [{ x: 10, y: 20, w: 100, h: 30, field: 'amount' }],
    fieldEdits: { date: 0, place: 0, amount: 0 },
    baseCanvas: { width: 460, height: 800 },
    img: {}, naturalWidth: 1840, naturalHeight: 3200,
    els: { date: { value: '2026-09-01' }, place: { value: '기존카페' }, amount: { value: '999' },
      ocrStatus: {}, ocrRetry: {} }
  };
}
function harness(recognize){
  const inputs = [], params = [];
  let terminated = 0;
  const ctx = context({
    updateFnamePreview(){}, updateRegionControls(){},
    Tesseract: { async createWorker(){ return {
      async setParameters(p){ params.push(p); },
      async recognize(source){ inputs.push(source); return recognize(source, inputs.length); },
      async terminate(){ terminated++; }
    }; } }
  });
  ctx.makeOCRInput = async () => ({ source: { cropped: true }, release(){}, width: 1200 });
  return { ctx, inputs, params, terminated: () => terminated };
}
const result = (text, confidence = 95) => ({ data: { text, confidence } });

test('all inline scripts and the OCR script have valid syntax', () => {
  new vm.Script(ocr);
  for (const [, code] of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(code);
});

test('selected values recognize date, place, and an amount without a label', () => {
  const ctx = context();
  assert.equal(ctx.parseRegionText('2026.09.08').date, '2026-09-08');
  assert.equal(ctx.parseRegionText('테스트카페 강남점').place, '테스트카페 강남점');
  assert.equal(ctx.parseRegionText('12,500원').amount, '12500');
  assert.equal(ctx.parseRegionText('12500', 'amount').amount, '12500');
  assert.deepEqual(plain(ctx.parseRegionText('결제금액 12,500원', 'amount')), { date: '', place: '', amount: '12500' });
  assert.equal(ctx.parseRegionText('결제일자: 2026-09-08', 'amount').amount, '');
});

test('dates, phone numbers, approval numbers, tax, and conflicting amounts do not become a selected total', () => {
  const ctx = context();
  for (const text of ['2026-09-08', '26.09.08', '02-1234-5678', '승인번호 12345678', '부가세 1,136', '할인 1,000', '12,500\n10,500']){
    assert.equal(ctx.parseRegionText(text).amount, '', text);
  }
  assert.equal(ctx.extractDate('2026-02-31'), '');
  assert.equal(ctx.extractDate('2024-02-29'), '2024-02-29');
});

test('independent regions merge by field; disagreements preserve existing values; explicit targets win', () => {
  const ctx = context();
  const merged = ctx.mergeRegionResults([
    { field: 'auto', parsed: { date: '2026-09-08', amount: '12500' } },
    { field: 'auto', parsed: { amount: '10500', place: '테스트카페' } }
  ]);
  assert.deepEqual(plain(merged), { parsed: { date: '2026-09-08', place: '테스트카페' }, conflicts: ['amount'] });
  assert.equal(ctx.mergeRegionResults([
    { field: 'auto', parsed: { amount: '10500' } },
    { field: 'amount', parsed: { amount: '12500' } }
  ]).parsed.amount, '12500');
});

test('retry recognizes each selected region and only replaces fields it reads', async () => {
  const h = harness((_source, n) => result(n === 1 ? '2026-09-08' : '12,500원'));
  const it = item();
  it.rects.unshift({ x: 10, y: 0, w: 100, h: 20, field: 'date' });
  await h.ctx.queueOCR(it, { retry: true });
  assert.equal(h.inputs.length, 2);
  assert.equal(it.els.date.value, '2026-09-08');
  assert.equal(it.els.amount.value, '12500');
  assert.equal(it.els.place.value, '기존카페');
  assert.equal(it.els.ocrRetry.disabled, false);
  assert.equal(h.terminated(), 1);
});

test('empty and failed recognition preserve all existing fields and allow retry', async () => {
  for (const recognize of [() => result(''), () => { throw Error('OCR failure'); }]){
    const h = harness(recognize), it = item();
    await h.ctx.queueOCR(it, { retry: true });
    assert.equal(it.els.amount.value, '999');
    assert.equal(it.els.date.value, '2026-09-01');
    assert.equal(it.els.ocrRetry.disabled, false);
    assert.equal(h.terminated(), 1);
  }
});

test('a failed region does not discard a successful region', async () => {
  const h = harness((_s, n) => { if (n === 1) throw Error('bad crop'); return result('12,500'); });
  const it = item();
  it.rects.push({ ...it.rects[0] });
  await h.ctx.queueOCR(it, { retry: true });
  assert.equal(it.els.amount.value, '12500');
  assert.match(it.els.ocrStatus.textContent, /1개 영역 인식 실패/);
});

test('manual changes made during recognition are preserved', async () => {
  const it = item();
  const h = harness(() => {
    it.els.amount.value = '7000'; it.fieldEdits.amount++;
    return result('12,500');
  });
  await h.ctx.queueOCR(it, { retry: true });
  assert.equal(it.els.amount.value, '7000');
});

test('editing regions or removing the card invalidates in-flight results', async () => {
  for (const invalidate of [it => it.regionRevision++, it => { it.alive = false; }]){
    const it = item();
    const h = harness(() => { invalidate(it); return result('12,500'); });
    await h.ctx.queueOCR(it, { retry: true });
    assert.equal(it.els.amount.value, '999');
    assert.equal(h.terminated(), 1);
  }
});

test('automatic OCR does not overwrite prefilled values; full retry updates only recognized values', async () => {
  const h = harness(() => result('결제금액 12,500원')), it = item();
  await h.ctx.queueOCR(it);
  assert.equal(it.els.amount.value, '999');
  it.rects = [];
  await h.ctx.queueOCR(it, { retry: true });
  assert.equal(it.els.amount.value, '12500');
  assert.equal(it.els.place.value, '기존카페');
});

test('crop coordinates use original pixels, clamp edges, and never use the highlighted preview', async () => {
  const canvases = [], draws = [];
  const ctx = context({ document: { createElement(){
    const canvas = { getContext: () => ({ fillRect(){}, drawImage(...args){ draws.push(args); } }) };
    canvases.push(canvas); return canvas;
  } } });
  assert.deepEqual(plain(ctx.getOCRBounds({ x: 0, y: 0, w: 460, h: 800 }, 460, 800, 1840, 3200)),
    { x: 0, y: 0, w: 1840, h: 3200 });
  const it = item();
  const input = await ctx.makeOCRInput(it, it.rects[0]);
  assert.equal(draws[0][0], it.img);
  assert.deepEqual(draws[0].slice(1, 5), [32, 72, 416, 136]);
  assert.ok(input.source.width > 416);
  input.release();
  assert.equal(canvases[0].width, 0);
});

test('PDF OCR re-renders the selected area at higher resolution and bounds memory', async () => {
  const renders = [];
  const ctx = context({ document: { createElement: () => ({ getContext: () => ({ fillRect(){} }) }) } });
  const it = item();
  it.type = 'pdf';
  it.pdfPage = {
    getViewport: ({ scale }) => ({ width: 600 * scale, height: 900 * scale }),
    render(options){ renders.push(options); return { promise: Promise.resolve() }; }
  };
  const input = await ctx.makeOCRInput(it, it.rects[0]);
  assert.ok(renders[0].viewport.width > 1200);
  assert.ok(renders[0].transform[4] < 16);
  assert.ok(input.source.width <= 3032 && input.source.height <= 3032);
});

test('continuous pointer drags append regions; reverse and out-of-bounds drags clamp; cancellation discards drafts', () => {
  const events = {}, captures = new Set();
  const canvas = { width: 460, height: 800,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 230, height: 400 }),
    addEventListener(name, callback){ events[name] = callback; },
    setPointerCapture(id){ captures.add(id); }, hasPointerCapture: id => captures.has(id),
    releasePointerCapture(id){ captures.delete(id); }
  };
  const ctx = context({ redraw(){}, regionsChanged(){} });
  vm.runInContext(section('function attachDrag(', '/* ---------- 이미지 / PDF 로드'), ctx);
  const it = { canvas, rects: [], highlightMode: true, els: { hlField: { value: 'amount' } } };
  ctx.attachDrag(it);
  const event = (x, y) => ({ clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0, preventDefault(){} });
  events.pointerdown(event(10, 10)); events.pointerup(event(80, 50));
  events.pointerdown(event(220, 200)); events.pointerup(event(-20, 150));
  assert.equal(it.rects.length, 2);
  assert.equal(it.highlightMode, true);
  assert.equal(it.rects[1].x, 0);
  events.pointerdown(event(10, 10)); events.pointermove(event(80, 50)); events.pointercancel();
  assert.equal(it.rects.length, 2);
  assert.equal(it.draftRect, null);
  events.pointerdown(event(10, 10)); events.pointerup(event(10, 10));
  assert.equal(it.rects.length, 2);
});

test('canvas and individual PDF exports include every red region with 10% fill', async () => {
  const fills = [], strokes = [], rectangles = [];
  const ctx = context({ Blob, rgb: (r, g, b) => ({ r, g, b }),
    PDFDocument: { async load(){ return { getPage: () => ({ drawRectangle: r => rectangles.push(r) }), save: async () => new Uint8Array() }; } }
  });
  vm.runInContext(section('function drawHighlight(', '// 저장이 끝난'), ctx);
  vm.runInContext(section('async function exportPdfBlob(', 'async function shareItem('), ctx);
  const it = item();
  it.rects.push({ x: 50, y: 60, w: 30, h: 20, field: 'auto' });
  it.previewScale = 0.5; it.pageHeightPt = 1600;
  const drawing = { fillRect(...r){ fills.push([this.fillStyle, ...r]); }, strokeRect(...r){ strokes.push(r); } };
  ctx.drawHighlight(drawing, it, 2);
  assert.equal(fills.length, 2); assert.equal(strokes.length, 2);
  assert.equal(fills[0][0], 'rgba(179,49,44,0.1)');
  assert.deepEqual(fills[0].slice(1), [20, 40, 200, 60]);
  await ctx.exportPdfBlob(it);
  assert.equal(rectangles.length, 2);
  assert.ok(rectangles.every(r => r.opacity === 0.1 && r.borderOpacity === 0.9));
  assert.equal(rectangles[0].y, 1500);
});
