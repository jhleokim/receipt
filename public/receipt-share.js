// Prepare once, then share directly from a fresh user click (no encoding await in that click).
function createReceiptShareFlow({ view, share, canShare, save, FileType = File }) {
  let revision = 0, entries = [], files = [], busy = false, title = '';
  function supported() {
    try { return files.length > 0 && canShare({ files }); } catch { return false; }
  }
  function reset() { entries = []; files = []; }
  function ready(message) {
    view.ready({ message, names: files.map(file => file.name), canShare: supported(), busy });
  }
  return {
    async open(prepare, nextTitle = '영수증 공유') {
      if (busy) { view.message('기기의 공유 창을 먼저 닫아 주세요.'); return; }
      const version = ++revision;
      reset(); title = nextTitle; view.open(title); view.loading();
      try {
        const prepared = await prepare();
        if (version !== revision) return;
        if (!prepared.length || prepared.some(entry => !entry.blob?.size)) throw new Error('empty file');
        const preparedFiles = prepared.map(entry => new FileType([entry.blob], entry.filename, { type: entry.blob.type }));
        entries = prepared; files = preparedFiles;
        ready(supported() ? '파일이 준비됐어요. 공유할 앱을 선택해 주세요.' : '이 환경에서는 파일 공유를 지원하지 않아요. 파일을 저장한 뒤 원하는 앱에 첨부해 주세요.');
      } catch (error) {
        if (version === revision) { reset(); view.error('파일을 준비하지 못했어요. 닫은 뒤 다시 시도해 주세요.'); }
      }
    },
    async choose() {
      if (busy || !entries.length) return;
      if (!supported()) { ready('이 파일은 공유할 수 없어요. 파일을 저장한 뒤 첨부해 주세요.'); return; }
      const version = revision;
      busy = true; ready('기기의 공유 창에서 앱을 선택해 주세요.');
      try {
        // This call must stay before the first await: user activation is transient.
        await share({ files, title });
        if (version === revision) ready('파일을 공유 앱에 전달했어요. 실제 전송 여부는 해당 앱에서 확인해 주세요.');
      } catch (error) {
        if (version === revision) {
          const messages = {
            AbortError: '공유를 취소했거나 받을 앱이 없어요. 다시 선택하거나 파일을 저장해 주세요.',
            NotAllowedError: '브라우저가 공유 창을 열지 못했어요. 다시 선택하거나 파일을 저장해 주세요.',
            InvalidStateError: '이미 열린 공유 창을 닫은 뒤 다시 선택해 주세요.'
          };
          ready(messages[error.name] || '공유 앱에 전달하지 못했어요. 다시 선택하거나 파일을 저장해 주세요.');
        }
      } finally {
        busy = false;
        if (version === revision) view.unblock();
      }
    },
    download() {
      if (!entries.length) return;
      const prepared = entries;
      this.close();
      save(prepared);
    },
    close() { revision++; reset(); view.close(); }
  };
}

let receiptShareDialog = null;
function openReceiptShare(prepare, title) {
  if (!receiptShareDialog) {
    const dialog = document.createElement('dialog');
    dialog.className = 'receipt-share-dialog';
    dialog.setAttribute('aria-labelledby', 'receiptShareTitle');
    dialog.innerHTML = '<div class="share-head"><h2 id="receiptShareTitle"></h2><button type="button" class="share-close" aria-label="공유 준비 창 닫기">✕</button></div>' +
      '<p class="share-status" role="status"></p><ul class="share-files" aria-label="준비한 파일"></ul>' +
      '<div class="share-actions"><button type="button" class="share-download">파일 저장</button><button type="button" class="share-choose">공유 앱 선택</button></div>';
    document.body.appendChild(dialog);
    const status = dialog.querySelector('.share-status'), list = dialog.querySelector('.share-files');
    const choose = dialog.querySelector('.share-choose'), download = dialog.querySelector('.share-download');
    let returnFocus = null;
    const flow = createReceiptShareFlow({
      share: data => navigator.share(data),
      canShare: data => typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && navigator.canShare(data),
      save: prepared => {
        if (prepared.length === 1) {
          triggerDownload(prepared[0].blob, prepared[0].filename);
          markSaved(prepared[0].item);
        } else startManualQueue(prepared);
      },
      view: {
        open(title) { returnFocus = document.activeElement; dialog.querySelector('h2').textContent = title; dialog.showModal(); },
        loading() { status.textContent = '공유할 파일을 준비하고 있어요…'; list.replaceChildren(); choose.hidden = false; choose.disabled = download.disabled = true; },
        ready({ message, names, canShare, busy }) {
          status.textContent = message; list.replaceChildren();
          for (const name of names) { const li = document.createElement('li'); li.textContent = name; list.appendChild(li); }
          choose.hidden = !canShare; choose.disabled = busy; download.disabled = false;
        },
        unblock() { choose.disabled = false; },
        message(message) { status.textContent = message; if (!dialog.open) dialog.showModal(); },
        error(message) { status.textContent = message; choose.disabled = download.disabled = true; },
        close() { dialog.close(); list.replaceChildren(); returnFocus?.focus(); }
      }
    });
    choose.addEventListener('click', () => { void flow.choose(); });
    download.addEventListener('click', () => flow.download());
    dialog.querySelector('.share-close').addEventListener('click', () => flow.close());
    dialog.addEventListener('cancel', event => { event.preventDefault(); flow.close(); });
    receiptShareDialog = flow;
  }
  return receiptShareDialog.open(prepare, title);
}
