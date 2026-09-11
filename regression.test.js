const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const vm = require('node:vm');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tarjetas-regression-'));
const { createServer, readZipEntries, verifyPassword } = require('./server');

function zip(names = ['capturas/estado.png'], method = 8, flags = 0) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const name of names) {
    const filename = Buffer.from(name), data = Buffer.from('fixture');
    const compressed = method === 8 ? zlib.deflateRawSync(data) : data;
    let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, filename, compressed); centrals.push(central, filename);
    offset += local.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(names.length, 8); end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test('ZIP: stored/deflate, folders, encrypted, unsupported, damaged and file count', () => {
  for (const method of [0, 8]) assert.equal(readZipEntries({ buffer: zip(undefined, method) })[0].buffer.toString(), 'fixture');
  assert.throws(() => readZipEntries({ buffer: zip(undefined, 8, 1) }), /contrasena/);
  assert.throws(() => readZipEntries({ buffer: zip(undefined, 12) }), /compresion/);
  const damaged = zip(); damaged.writeUInt32LE(0xfffffff0, damaged.length - 6);
  assert.throws(() => readZipEntries({ buffer: damaged }), /danado/);
  assert.throws(() => readZipEntries({ buffer: zip(Array.from({length:16}, (_,i) => `${i}.png`)) }), /15/);
  assert.equal(verifyPassword('password', 'salt:broken'), false);
});

test('login, restart persistence, ZIP extraction and concurrent login, partial failure', async () => {
  let server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let base = `http://127.0.0.1:${server.address().port}`;
  const realFetch = global.fetch;
  const request = (route, body, cookie) => realFetch(base + route, {method: body ? 'POST' : 'GET', headers: { ...(cookie ? {Cookie:cookie}:{}), ...(body instanceof FormData ? {} : {'Content-Type':'application/json'}) }, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined});
  const credentials = {email:'test@example.com', password:'test-password'};
  try {
    let response = await request('/api/register', {...credentials, name:'Test'});
    assert.equal(response.status, 201);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    assert.equal((await request('/api/login', {...credentials, password:'wrong'})).status, 401);
    response = await request('/api/login', {...credentials, email:' TEST@EXAMPLE.COM '});
    assert.equal(response.status, 200);
    await new Promise(resolve => server.close(resolve));
    server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await request('/api/me', null, cookie)).status, 200);
    const form = () => { const f = new FormData(); f.set('documents', new Blob([zip()], {type:'application/zip'}), 'estados.zip'); return f; };
    delete process.env.OPENAI_API_KEY;
    response = await request('/api/statements/auto', form(), cookie);
    assert.equal(response.status, 503); assert.match((await response.json()).error, /OPENAI_API_KEY/);
    process.env.OPENAI_API_KEY = 'mock-only';
    let release, started;
    const blocked = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { started = resolve; });
    global.fetch = async () => { started(); await blocked; return new Response(JSON.stringify({output_text:JSON.stringify({bankName:'Demo', cardName:'Oro', dueDate:'2026-09-20', minPayment:100, noInterestAmount:500, totalAmount:800, confidence:0.9})})); };
    const uploading = request('/api/statements/auto', form(), cookie);
    await entered;
    response = await request('/api/login', credentials);
    const secondCookie = response.headers.get('set-cookie').split(';')[0];
    release();
    response = await uploading; assert.equal(response.status, 201);
    assert.equal((await response.json()).results[0].statement.noInterestAmount, 500);
    assert.equal((await request('/api/me', null, secondCookie)).status, 200);
    const success = global.fetch; let calls = 0;
    global.fetch = (...args) => ++calls === 2 ? Promise.reject(new Error('mock failure')) : success(...args);
    const batch = new FormData(); batch.set('documents', new Blob([zip(['one.png','two.png'])], {type:'application/zip'}), 'batch.zip');
    response = await request('/api/statements/auto', batch, cookie);
    const result = await response.json(); assert.equal(result.results.length, 1); assert.equal(result.errors.length, 1);
    response = await request('/api/statements', null, cookie); assert.equal((await response.json()).statements.length, 2);
    await request('/api/logout', {}, secondCookie);
    assert.equal((await request('/api/me', null, secondCookie)).status, 401);
  } finally {
    global.fetch = realFetch; delete process.env.OPENAI_API_KEY;
    await new Promise(resolve => server.close(resolve));
  }
});

test('panel keeps authenticated user on server errors; clears on 401', async () => {
  const nodes = new Map();
  const node = selector => { if (!nodes.has(selector)) nodes.set(selector, {classList:{add(){},remove(){}}, style:{}, addEventListener(){}, value:'todos'}); return nodes.get(selector); };
  const context = vm.createContext({document:{querySelector:node, querySelectorAll:()=>[]}, Intl, FormData, console});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'public/app.js'),'utf8').replace(/loadApp\(\);\s*$/, ''), context);
  vm.runInContext('api = async (path) => { if(path === "/api/me") return {user:{id:"test",name:"Test"}}; throw Object.assign(new Error("Server failed"),{status:500}); };', context);
  await vm.runInContext('loadApp()', context);
  assert.equal(vm.runInContext('state.user.id', context), 'test');
  assert.match(node('#appMessage').textContent, /Server failed/);
  vm.runInContext('api = async () => { throw Object.assign(new Error("Expired"), {status:401}); };', context);
  await vm.runInContext('loadApp()', context);
  assert.equal(vm.runInContext('state.user', context), null);
});
