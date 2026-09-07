/* ---------- OCR 자동 인식 ---------- */
const OCR_FIELD_LABELS = { auto: '자동 판단', date: '날짜', place: '장소', amount: '금액' };
let ocrQueue = Promise.resolve();
function queueOCR(item, { retry = false } = {}){
  if (!item.alive || !item.baseCanvas) return;
  const job = {
    version: ++item.ocrVersion,
    regionRevision: item.regionRevision,
    rects: retry ? item.rects.map(rect => ({ ...rect })) : [],
    edits: { ...item.fieldEdits },
    retry
  };
  item.els.ocrRetry.disabled = true;
  item.els.ocrStatus.textContent = 'OCR 대기 중…';
  ocrQueue = ocrQueue.then(() => doOCR(item, job)).catch(err => console.error(err));
  return ocrQueue;
}

function isCurrentOCR(item, job){
  return item.alive && item.ocrVersion === job.version &&
    (!job.rects.length || item.regionRevision === job.regionRevision);
}

async function doOCR(item, job){
  let worker;
  try{
    if (!isCurrentOCR(item, job)) return;
    item.els.ocrStatus.textContent = 'OCR 인식 중…';
    worker = await Tesseract.createWorker('kor+eng');
    const regional = job.rects.length > 0;
    const results = [];
    let failed = 0;
    for (const [index, rect] of (regional ? job.rects : [null]).entries()){
      if (!isCurrentOCR(item, job)) return;
      item.els.ocrStatus.textContent = regional
        ? '표시 영역 인식 중… ' + (index + 1) + ' / ' + job.rects.length
        : '전체 영수증 인식 중…';
      let input;
      try{
        input = await makeOCRInput(item, rect);
        await worker.setParameters({ tessedit_pageseg_mode: regional ? '6' : '3', preserve_interword_spaces: '1' });
        let result = await worker.recognize(input.source);
        if (!regional){
          if (isCurrentOCR(item, job)) item.textPxRatio = measureTextRatio(result.data, input.width);
          results.push({ parsed: parseReceiptText(result.data.text || ''), field: 'auto' });
        } else {
          let parsed = parseRegionText(result.data.text || '', rect.field);
          // 작은 영역에서 줄 배치를 못 찾으면 흩어진 텍스트 모드로 한 번 더 읽는다.
          if (!Object.values(parsed).some(Boolean) || result.data.confidence < 45){
            await worker.setParameters({ tessedit_pageseg_mode: '11' });
            const second = await worker.recognize(input.source);
            const alternative = parseRegionText(second.data.text || '', rect.field);
            if (Object.values(alternative).some(Boolean) &&
                (!Object.values(parsed).some(Boolean) || second.data.confidence > result.data.confidence)){
              result = second;
              parsed = alternative;
            }
          }
          // 심하게 깨진 글씨는 기존 값을 추측으로 덮어쓰지 않는다.
          if (result.data.confidence < 30) parsed = {};
          results.push({ parsed, field: rect.field });
        }
      } catch(err){
        console.error(err);
        failed++;
      } finally {
        input?.release();
      }
    }
    if (!isCurrentOCR(item, job)) return;
    const { parsed, conflicts } = mergeRegionResults(results);
    const filled = [];
    for (const field of ['date', 'place', 'amount']){
      // 요청 후 사용자가 수정한 필드와, 이번 인식에서 읽지 못한 필드는 유지한다.
      if (parsed[field] && item.fieldEdits[field] === job.edits[field] &&
          (job.retry || !item.els[field].value)){
        item.els[field].value = parsed[field];
        filled.push(OCR_FIELD_LABELS[field]);
      }
    }
    updateFnamePreview(item);
    const messages = [filled.length
      ? filled.join('·') + (job.retry ? ' 교정됨 · 확인해주세요' : ' 자동입력됨 · 확인해주세요')
      : '교정할 값을 찾지 못했어요 · 기존 값 유지'];
    if (conflicts.length) messages.push(conflicts.map(f => OCR_FIELD_LABELS[f]).join('·') + ' 후보가 달라요 · 영역을 좁혀주세요');
    if (failed) messages.push(failed + '개 영역 인식 실패 · 다시 시도해주세요');
    item.els.ocrStatus.textContent = messages.join(' / ');
  } catch(err){
    console.error(err);
    if (isCurrentOCR(item, job)) item.els.ocrStatus.textContent = 'OCR 인식 실패 · 기존 값 유지 · 다시 시도해주세요';
  } finally {
    if (worker) await worker.terminate().catch(err => console.error(err));
    if (item.alive && item.ocrVersion === job.version){
      item.els.ocrRetry.disabled = false;
      updateRegionControls(item);
      if (!isCurrentOCR(item, job)) item.els.ocrStatus.textContent = '표시 영역이 바뀌었어요 · 다시 인식해주세요';
    }
  }
}

// CSS 크기 대신 실제 미리보기 픽셀 비율로 원본 좌표를 구한다. 가장자리도 안전하게 자른다.
function getOCRBounds(rect, previewWidth, previewHeight, sourceWidth, sourceHeight){
  const rx = sourceWidth / previewWidth, ry = sourceHeight / previewHeight;
  const pad = 2;
  const x = Math.max(0, Math.floor((rect.x - pad) * rx));
  const y = Math.max(0, Math.floor((rect.y - pad) * ry));
  const right = Math.min(sourceWidth, Math.ceil((rect.x + rect.w + pad) * rx));
  const bottom = Math.min(sourceHeight, Math.ceil((rect.y + rect.h + pad) * ry));
  if (right <= x || bottom <= y) throw new Error('빈 인식 영역');
  return { x, y, w: right - x, h: bottom - y };
}

async function makeOCRInput(item, rect){
  if (!rect && item.type === 'image'){
    return { source: item.img, width: item.naturalWidth, release(){} };
  }
  const isPDF = item.type === 'pdf';
  const viewport = isPDF ? item.pdfPage.getViewport({ scale: 2 }) : null;
  const width = isPDF ? viewport.width : item.naturalWidth;
  const height = isPDF ? viewport.height : item.naturalHeight;
  const bounds = rect
    ? getOCRBounds(rect, item.baseCanvas.width, item.baseCanvas.height, width, height)
    : { x: 0, y: 0, w: width, h: height };
  // 원본에서 잘라 확대하되 긴 변 3000px로 메모리를 제한한다. PDF도 미리보기 대신 다시 렌더링한다.
  const scale = Math.min(rect ? Math.max(1, Math.min(3, 1200 / bounds.w)) : 1, 3000 / Math.max(bounds.w, bounds.h));
  const border = rect ? 16 : 0;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(bounds.w * scale) + border * 2;
  canvas.height = Math.ceil(bounds.h * scale) + border * 2;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  try{
    if (isPDF){
      await item.pdfPage.render({
        canvasContext: ctx,
        viewport: item.pdfPage.getViewport({ scale: 2 * scale }),
        transform: [1, 0, 0, 1, border - bounds.x * scale, border - bounds.y * scale]
      }).promise;
    } else {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(item.img, bounds.x, bounds.y, bounds.w, bounds.h,
        border, border, bounds.w * scale, bounds.h * scale);
    }
    return { source: canvas, width: canvas.width, release(){ canvas.width = canvas.height = 0; } };
  } catch(err){
    canvas.width = canvas.height = 0;
    throw err;
  }
}

// 항목을 지정하면 그 필드만 교정한다. 자동 판단에서는 명확한 라벨 또는 독립된 값만 쓴다.
function parseRegionText(rawText, field = 'auto'){
  const lines = (rawText || '').split('\n').map(l => normalizeSpacedOut(l.trim())).filter(Boolean);
  const text = lines.join('\n');
  const parsed = { date: '', place: '', amount: '' };
  if (field === 'auto' || field === 'date') parsed.date = extractDate(text);
  if (field === 'auto' || field === 'amount'){
    const positive = lines.filter(l => !AMOUNT_NEG.test(compact(l)));
    const labelled = positive.filter(l => AMOUNT_TIERS.some(t => t.w >= 2 && t.re.test(compact(l))));
    const bare = positive.filter(l => /^[₩￦W]?\s*(?:\d{1,3}(?:,\d{3})+|\d{3,8})\s*원?$/i.test(l));
    if (labelled.length) parsed.amount = extractAmount(positive.join('\n'));
    else if (field === 'amount' || (!extractDate(text) && bare.length === lines.length)){
      const values = [...new Set(bare.flatMap(l => moneyCandidates(l).map(c => String(c.value))))];
      if (values.length === 1) parsed.amount = values[0];
    }
  }
  if (field === 'auto' || field === 'place'){
    const labelled = lines.filter(l => PLACE_LABEL.test(l));
    if (labelled.length) parsed.place = extractPlace(labelled.join('\n'), labelled);
    else if (field === 'place') parsed.place = extractPlace(text, lines);
    else if (!parsed.date && !parsed.amount && lines.length === 1 &&
        !/\d|결제|일자|일시|요금|할인|포인트|total|date|amount/i.test(text)){
      parsed.place = extractPlace(text, lines);
    }
  }
  return parsed;
}

function mergeRegionResults(results){
  const parsed = {}, conflicts = [];
  for (const field of ['date', 'place', 'amount']){
    const explicit = results.filter(r => r.field === field && r.parsed[field]);
    const candidates = explicit.length ? explicit : results.filter(r => r.parsed[field]);
    const values = [...new Set(candidates.map(r => r.parsed[field]))];
    if (values.length === 1) parsed[field] = values[0];
    else if (values.length > 1) conflicts.push(field);
  }
  return { parsed, conflicts };
}

// 글자높이 ÷ 이미지폭. 이 값이 클수록 글씨가 큰 영수증이다.
// 예: 0.035 이면 이미지 폭의 3.5% 가 글자 한 줄 높이.
function measureTextRatio(data, imgW){
  // Tesseract 버전에 따라 words 위치가 달라서 몇 군데를 훑는다
  let words = data.words || [];
  if (!words.length && data.lines) words = data.lines.flatMap(l => l.words || []);
  if (!words.length && data.blocks){
    words = data.blocks.flatMap(b =>
      (b.paragraphs || []).flatMap(p => (p.lines || []).flatMap(l => l.words || []))
    );
  }
  const good = words.filter(w =>
    w && w.confidence > 60 && w.bbox && (w.bbox.y1 - w.bbox.y0) > 3
  );
  if (good.length < 5 || !imgW) return null;
  const heights = good.map(w => w.bbox.y1 - w.bbox.y0).sort((a,b) => a-b);
  const median = heights[Math.floor(heights.length / 2)];
  const ratio = median / imgW;
  // 말도 안 되는 값은 버림(글자 대신 로고·테두리를 잡은 경우)
  if (ratio < 0.008 || ratio > 0.15) return null;
  return ratio;
}

/* ========== 영수증 텍스트 파싱 ==========
   OCR이 뱉은 날것의 텍스트에서 결제일자 / 결제장소 / 최종결제금액을 뽑아낸다.
   원칙: 확신이 없으면 채우지 않는다. 엉뚱한 값이 들어가면 사용자가 지우는 게 더 번거롭다.
*/

/* ---------- 공통 유틸 ---------- */

// OCR은 글자 사이에 공백을 멋대로 끼워 넣는다. 키워드 매칭은 공백 제거 후에 한다.
function compact(s){ return (s || '').replace(/\s+/g, ''); }

// Tesseract는 자간이 넓은 영수증 글씨를 "1 2 , 8 0 0" / "투 썸 플 레 이 스"처럼
// 한 글자씩 떼어 놓는 일이 잦다. 그런 줄만 골라서 도로 붙인다.
// (단순히 모든 공백을 지우면 "아메리카노 2 9,000" 의 수량과 금액이 붙어버리므로,
//  한 글자+한 칸이 4번 이상 반복되는 "확실히 자간이 벌어진" 줄에만 적용한다.)
function normalizeSpacedOut(line){
  let out = line;
  if (/(?:[\d,.]\s){3,}[\d,.]/.test(out)){
    out = out.replace(/([\d,.])\s(?=[\d,.])/g, '$1');
  }
  if (/(?:[\uAC00-\uD7A3]\s){3,}[\uAC00-\uD7A3]/.test(out)){
    out = out.replace(/([\uAC00-\uD7A3])\s(?=[\uAC00-\uD7A3])/g, '$1');
  }
  return out;
}

// 금액으로 오인하기 쉬운 것들을 미리 지운다.
// (사업자번호, 전화번호, 카드번호, 날짜, 시각, 승인번호 등)
function stripNonMoney(line){
  return line
    .replace(/\d{3}\s*-\s*\d{2}\s*-\s*\d{5}/g, ' ')            // 사업자등록번호
    .replace(/\d{2,4}\s*-\s*\d{3,4}\s*-\s*\d{4}/g, ' ')         // 전화번호
    .replace(/[\d*]{4}\s*-\s*[\d*]{4}\s*-\s*[\d*]{4}\s*-\s*[\d*]{4}/g, ' ') // 카드번호
    .replace(/\d{4}[-./]\d{1,2}[-./]\d{1,2}/g, ' ')             // 날짜
    .replace(/\d{1,2}\s*:\s*\d{2}(\s*:\s*\d{2})?/g, ' ')        // 시각
    .replace(/(승인|거래|전표|단말기|가맹점)\s*(번호|NO|No)?\s*[:：]?\s*[\d-]+/gi, ' ')
    .replace(/\d{10,}/g, ' ');                                   // 지나치게 긴 숫자열
}

// 한 줄에서 "돈처럼 생긴 숫자"들을 모두 뽑는다.
function moneyCandidates(line){
  const cleaned = stripNonMoney(line);
  const out = [];
  const re = /\d{1,3}(?:,\d{3})+|\d{3,9}/g;
  let m;
  while ((m = re.exec(cleaned)) !== null){
    const hasComma = m[0].includes(',');
    const v = parseInt(m[0].replace(/,/g, ''), 10);
    if (isNaN(v)) continue;
    if (v < 100 || v > 50000000) continue;   // 현실적인 결제금액 범위
    out.push({ value: v, hasComma });
  }
  return out;
}

/* ---------- 금액 ---------- */

// 영수증마다 최종 금액을 부르는 이름이 다르다. 신뢰도 순으로 계층을 나눈다.
// 위 계층에서 찾으면 아래는 보지 않는다.
const AMOUNT_TIERS = [
  // 3순위 가중치: "이게 최종 낼 돈"이라고 못박은 표현
  { w: 3, re: /(총청구액|청구금액|청구액|최종결제금액|실결제금액|결제금액|결제할금액|카드승인금액|승인금액|총결제금액|납부금액|납부액|총납부액|받을금액|최종금액|최종요금|총요금|결제대상금액)/ },
  // 2순위: 합계류
  { w: 2, re: /(합계금액|총합계|판매총액|금액계|합계|총계|총액|totalamount|amountdue|total)/i },
  // 1순위: 약한 단서 (다른 게 하나도 없을 때만)
  { w: 1, re: /(소계|subtotal|금액)/i }
];

// 이 단어가 있는 줄의 숫자는 최종금액이 아니다.
const AMOUNT_NEG = /(공급가액|공급가|부가세|부가가치세|세액|면세|과세|봉사료|받은금액|받은돈|거스름|잔액|잔돈|할인|포인트|적립|마일리지|잔여|쿠폰|현금영수증|이전금액|기존금액)/;

function extractAmount(text){
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // 계층별로 후보를 모은다
  const found = { 3: [], 2: [], 1: [] };

  for (let i = 0; i < lines.length; i++){
    const c = compact(lines[i]);
    if (AMOUNT_NEG.test(c)) continue;

    let tier = 0;
    for (const t of AMOUNT_TIERS){
      if (t.re.test(c)){ tier = t.w; break; }
    }
    if (!tier) continue;

    // 같은 줄에서 숫자 찾기
    let cands = moneyCandidates(lines[i]);

    // 줄 끝에 금액이 없으면 다음 1~2줄을 본다 (표 형태 영수증 대응)
    if (!cands.length){
      for (let j = i + 1; j <= Math.min(i + 2, lines.length - 1); j++){
        const nextC = compact(lines[j]);
        if (AMOUNT_NEG.test(nextC)) break;
        cands = moneyCandidates(lines[j]);
        if (cands.length) break;
      }
    }
    if (!cands.length) continue;

    // 한 줄에 여러 숫자면 가장 큰 값 (수량×단가=금액 형태 대비)
    const best = cands.reduce((a, b) => (b.value > a.value ? b : a));
    found[tier].push({ value: best.value, line: i, hasComma: best.hasComma });
  }

  for (const tier of [3, 2, 1]){
    const list = found[tier];
    if (!list.length) continue;
    // 같은 계층이 여러 번 나오면 아래쪽(영수증 끝)에 가까운 것이 최종금액이다
    const last = list.reduce((a, b) => (b.line >= a.line ? b : a));
    return String(last.value);
  }

  // 키워드를 하나도 못 찾은 경우:
  // 영수증에서 최종금액은 보통 합계·결제·승인 자리에 2~3번 반복해서 찍힌다.
  // 그래서 "가장 자주 등장한 금액"이 최댓값보다 훨씬 안전한 추측이다.
  const freq = new Map();
  lines.forEach(l => {
    moneyCandidates(l).forEach(c => {
      // 콤마가 있는 숫자가 금액일 확률이 높아 가중치를 더 준다
      freq.set(c.value, (freq.get(c.value) || 0) + (c.hasComma ? 1.5 : 1));
    });
  });
  if (!freq.size) return '';

  let bestVal = '', bestScore = -1;
  for (const [value, score] of freq){
    // 동점이면 큰 금액을 택한다
    if (score > bestScore || (score === bestScore && value > bestVal)){
      bestScore = score; bestVal = value;
    }
  }
  // 딱 한 번만 등장한 숫자뿐이라면 확신이 없으니 비워둔다
  if (bestScore < 1.5) return '';
  return String(bestVal);
}

/* ---------- 날짜 ---------- */

// 사업자등록번호(105-22-33445)나 전화번호를 날짜로 착각하는 일이 잦다.
// 먼저 지워두고, 남은 후보를 전부 훑어서 유효한 첫 번째 날짜를 쓴다.
function stripNonDate(text){
  return text
    .replace(/\d{3}\s*-\s*\d{2}\s*-\s*\d{5}/g, ' ')       // 사업자등록번호
    .replace(/\d{2,4}\s*-\s*\d{3,4}\s*-\s*\d{4}/g, ' ')    // 전화번호
    .replace(/[\d*]{4}\s*-\s*[\d*]{4}\s*-\s*[\d*]{4}\s*-\s*[\d*]{4}/g, ' '); // 카드번호
}

function toValidDate(y, mo, d){
  if (y.length === 2) y = '20' + y;
  if (y.length !== 4) return '';
  mo = mo.padStart(2, '0');
  d = d.padStart(2, '0');
  const yn = Number(y), mn = Number(mo), dn = Number(d);
  if (yn < 2000 || yn > 2099) return '';
  if (mn < 1 || mn > 12) return '';
  if (dn < 1 || dn > 31) return '';
  const date = new Date(Date.UTC(yn, mn - 1, dn));
  if (date.getUTCMonth() !== mn - 1 || date.getUTCDate() !== dn) return '';
  return y + '-' + mo + '-' + d;
}

function extractDate(text){
  const src = stripNonDate(text);

  // 1) "거래일시 / 승인일시" 같은 라벨이 붙은 날짜가 가장 믿을 만하다
  const kw = /(?:거래일시|승인일시|결제일시|이용일시|매출일시|주문일시|거래일자|승인일자|결제일자|판매일|일\s*시|날짜)[^\d]{0,6}(\d{2,4})\s*[.\-\/년]\s*(\d{1,2})\s*[.\-\/월]\s*(\d{1,2})/g;
  for (const m of src.matchAll(kw)){
    const v = toValidDate(m[1], m[2], m[3]);
    if (v) return v;
  }

  // 2) 라벨이 없으면 본문에서 날짜꼴을 차례로 검사한다
  const gen = /(\d{2,4})\s*[.\-\/년]\s*(\d{1,2})\s*[.\-\/월]\s*(\d{1,2})\s*일?/g;
  for (const m of src.matchAll(gen)){
    const v = toValidDate(m[1], m[2], m[3]);
    if (v) return v;
  }
  return '';
}

/* ---------- 결제장소 ---------- */

// 상호가 아닌 게 확실한 줄들
const PLACE_JUNK = /(영수증|매출전표|신용카드|체크카드|카드사|승인|거래|사업자|등록번호|대표자?|주소|전화|TEL|FAX|www|http|POS|단말기|일련번호|가맹점번호|고객용|가맹점용|반품|교환|환불|감사합니다|안녕|주문번호|테이블|영업시간|현금영수증|할부|일시불|공급가|부가세|합계|총액|금액|수량|단가|품명)/i;

// 상호를 대놓고 알려주는 줄
const PLACE_LABEL = /(?:상호명|상호|가맹점명|가맹점|점포명|지점명|매장명|사업장명)\s*[:：]?\s*(.{2,30})/;

function cleanPlace(s){
  return (s || '')
    // 한글·영문·숫자와 최소한의 기호만 남기고 나머지(OCR 잡음)는 제거
    .replace(/[^\uAC00-\uD7A3a-zA-Z0-9()&.\-'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.\-'&()]+|[\s.\-'&()]+$/g, '')
    .trim();
}

// 상호로 쓸 만한 문자열인지 판정
function placeScore(s){
  const t = cleanPlace(s);
  if (t.length < 2 || t.length > 30) return -1;
  if (PLACE_JUNK.test(t)) return -1;

  const chars = t.replace(/\s/g, '');
  if (!chars.length) return -1;

  const hangul = (chars.match(/[\uAC00-\uD7A3]/g) || []).length;
  const latin  = (chars.match(/[a-zA-Z]/g) || []).length;
  const digits = (chars.match(/[0-9]/g) || []).length;
  const letters = hangul + latin;

  // 글자가 거의 없으면 상호가 아니다 (주소·번호·잡음)
  if (letters < 2) return -1;
  // 숫자가 절반 가까우면 주소나 번호일 가능성이 높다
  if (digits / chars.length > 0.4) return -1;
  // 인식 잡음 비율: 한글·영문·숫자가 아닌 글자가 많으면 버린다
  if (letters / chars.length < 0.55) return -1;

  let score = 10;
  score += hangul > 0 ? 6 : 0;              // 한글 상호 우대
  if (t.length >= 3 && t.length <= 12) score += 5;  // 상호는 대체로 짧다
  else if (t.length <= 16) score += 2;
  else if (t.length <= 22) score -= 2;      // 길면 상호가 아닐 확률이 오른다
  else score -= 4;
  if (/(점|지점|店)$/.test(chars)) score += 3;       // "○○강남점"
  if (/(주식회사|㈜|\(주\))/.test(chars)) score += 2;
  score -= digits;                          // 숫자는 조금씩 감점
  return score;
}

function extractPlace(text, lines){
  const raw = lines || text.split('\n').map(l => l.trim()).filter(Boolean);

  // 1) "상호: ○○○" 처럼 명시된 줄이 있으면 최우선
  for (const line of raw){
    const m = line.match(PLACE_LABEL);
    if (m){
      const cand = cleanPlace(m[1]);
      if (placeScore(cand) > 0) return truncatePlace(cand);
    }
  }

  // 2) 없으면 상단 8줄 중 가장 상호다운 줄을 고른다
  let best = '', bestScore = 0;
  const head = raw.slice(0, 8);
  for (let i = 0; i < head.length; i++){
    const cand = cleanPlace(head[i]);
    let s = placeScore(cand);
    if (s <= 0) continue;
    s += (8 - i);   // 위쪽 줄일수록 상호일 확률이 높다
    if (s > bestScore){ bestScore = s; best = cand; }
  }

  // 확신이 없으면 차라리 비워둔다 (잘못된 긴 문자열을 지우는 게 더 번거롭다)
  if (bestScore < 14) return '';
  return truncatePlace(best);
}

// 너무 길면 사용자가 지우기 번거로우니 앞쪽 핵심만 남긴다
function truncatePlace(s){
  const t = cleanPlace(s);
  if (t.length <= 16) return t;
  const cut = t.slice(0, 16);
  const sp = cut.lastIndexOf(' ');
  return (sp >= 6 ? cut.slice(0, sp) : cut).trim();
}

/* ---------- 통합 ---------- */

function parseReceiptText(rawText){
  // 자간이 벌어진 줄을 먼저 정상화한 뒤, 모든 추출기가 같은 텍스트를 보게 한다
  const lines = (rawText || '')
    .split('\n')
    .map(l => normalizeSpacedOut(l.trim()))
    .filter(Boolean);
  const text = lines.join('\n');

  return {
    date: extractDate(text),
    place: extractPlace(text, lines),
    amount: extractAmount(text)
  };
}

