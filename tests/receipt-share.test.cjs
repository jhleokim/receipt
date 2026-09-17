const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const code = fs.readFileSync(path.join(__dirname, '../public/receipt-share.js'), 'utf8');
const create = vm.runInNewContext(code + '\ncreateReceiptShareFlow', { File });
const entry = () => ({ blob: new Blob(['synthetic receipt'], { type: 'application/pdf' }), filename: 'receipt.pdf', item: {} });
function harness(options = {}) {
  const calls = { shares: [], downloads: [], messages: [], prepares: 0 };
  const view = {
    open() {}, close() { calls.closed = true; }, loading() {}, unblock() {},
    ready(value) { calls.ready = value; calls.messages.push(value.message); },
    message(message) { calls.messages.push(message); }, error(message) { calls.error = message; }
  };
  const flow = create({ view, canShare: () => true,
    share: async data => { calls.shares.push(data); }, save: entries => calls.downloads.push(entries), ...options });
  const prepare = async () => { calls.prepares++; return [entry()]; };
  return { flow, calls, prepare };
}
test('slow preparation never opens share; fresh click invokes native share synchronously', async () => {
  let active = false, finish, invoked = 0;
  const h = harness({ share: () => { assert.equal(active, true); invoked++; return Promise.resolve(); } });
  const pending = h.flow.open(() => new Promise(resolve => { finish = resolve; }));
  active = false; finish([entry()]); await pending;
  assert.equal(invoked, 0);
  active = true;
  const sharing = h.flow.choose();
  assert.equal(invoked, 1, 'native share must run before any await');
  active = false; await sharing;
});
test('blocked share retries the same prepared file without re-encoding', async () => {
  const files = [];
  const h = harness({ share: async data => { files.push(data.files[0]); if (files.length === 1) throw { name: 'NotAllowedError' }; } });
  await h.flow.open(h.prepare); await h.flow.choose(); await h.flow.choose();
  assert.equal(h.calls.prepares, 1); assert.equal(files.length, 2); assert.equal(files[0], files[1]);
  assert.match(h.calls.messages.at(-1), /실제 전송 여부/);
});
test('unsupported actual file type offers download and never attempts native share', async () => {
  const h = harness({ canShare: data => data.files[0].type === 'image/jpeg' });
  await h.flow.open(h.prepare); assert.equal(h.calls.ready.canShare, false);
  await h.flow.choose(); assert.equal(h.calls.shares.length, 0);
  h.flow.download(); assert.equal(h.calls.downloads.length, 1);
  assert.equal(h.calls.downloads[0][0].filename, 'receipt.pdf');
});
test('cancellation keeps the file ready and does not silently download it', async () => {
  let attempts = 0;
  const h = harness({ share: async () => { attempts++; throw { name: 'AbortError' }; } });
  await h.flow.open(h.prepare); await h.flow.choose(); await h.flow.choose();
  assert.equal(attempts, 2); assert.equal(h.calls.prepares, 1); assert.equal(h.calls.downloads.length, 0);
});
test('double clicks and other receipts cannot start a concurrent native share', async () => {
  let complete, count = 0;
  const h = harness({ share: () => { count++; return new Promise(resolve => { complete = resolve; }); } });
  await h.flow.open(h.prepare);
  const sharing = h.flow.choose(); await h.flow.choose();
  await h.flow.open(h.prepare); assert.equal(count, 1); assert.equal(h.calls.prepares, 1);
  complete(); await sharing; await h.flow.open(h.prepare); assert.equal(h.calls.prepares, 2);
});
test('closing during preparation discards late results and the next receipt stays current', async () => {
  let complete;
  const h = harness();
  const pending = h.flow.open(() => new Promise(resolve => { complete = resolve; }));
  h.flow.close();
  await h.flow.open(async () => [{ ...entry(), filename: 'new.pdf' }]);
  complete([{ ...entry(), filename: 'old.pdf' }]); await pending;
  await h.flow.choose(); assert.equal(h.calls.shares[0].files[0].name, 'new.pdf');
});
test('empty or failed exports cannot be shared or downloaded', async () => {
  for (const prepare of [async () => [], async () => [{ ...entry(), blob: new Blob([]) }], async () => { throw Error('failed'); }]) {
    const h = harness(); await h.flow.open(prepare); await h.flow.choose(); h.flow.download();
    assert.ok(h.calls.error); assert.equal(h.calls.shares.length, 0); assert.equal(h.calls.downloads.length, 0);
  }
});
