const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStorage } = require("./storage");
const { createServer } = require("./server");
const { migrate } = require("./scripts/migrate-storage");

function supabaseFixture() {
  let revision = 0;
  let document = { users: [], cards: [], statements: [], sessions: {}, passwordResets: [] };
  const files = new Map();
  const env = { SUPABASE_URL: "https://fixture.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_test-only" };
  const fixture = { files, env, unavailable: false, missingRow: false, publicBucket: false, calls: [] };
  fixture.fetch = async (url, options) => {
    fixture.calls.push({ url, method: options.method || "GET" });
    assert.equal(options.headers.apikey, env.SUPABASE_SECRET_KEY);
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.redirect, "error");
    if (fixture.unavailable) return Response.json({ error: "private provider details" }, { status: 503 });
    const route = new URL(url);
    if (route.pathname === "/rest/v1/tarjetas_state") {
      if (fixture.missingRow) return Response.json([]);
      if (options.method === "PATCH") {
        if (route.searchParams.get("revision") !== `eq.${revision}`) return Response.json([]);
        const body = JSON.parse(options.body);
        document = body.document;
        revision = body.revision;
        return Response.json([{ revision }]);
      }
      return Response.json([{ revision, document }]);
    }
    if (route.pathname === "/storage/v1/bucket/tarjetas-documentos") return Response.json({ public: fixture.publicBucket });
    const filename = route.pathname.split("/").at(-1);
    if (options.method === "POST" && route.pathname.startsWith("/storage/v1/object/tarjetas-documentos/")) {
      await fixture.beforeUpload?.();
      assert.equal(options.headers["x-upsert"], "false");
      if (files.has(filename)) return Response.json({}, { status: 409 });
      files.set(filename, Buffer.from(options.body));
      return Response.json({ Key: filename });
    }
    if (route.pathname.startsWith("/storage/v1/object/authenticated/tarjetas-documentos/")) {
      return files.has(filename) ? new Response(files.get(filename)) : Response.json({}, { status: 404 });
    }
    throw new Error(`Unexpected fixture path: ${route.pathname}`);
  };
  fixture.storage = () => createStorage({ env, fetch: fixture.fetch });
  return fixture;
}

test("Supabase retains account, session, payments and private files across a fresh server", async () => {
  const fixture = supabaseFixture();
  let server, base;
  const start = async () => {
    const storage = fixture.storage();
    await storage.check();
    server = createServer({ storage });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  };
  const request = (route, body, cookie, method) => fetch(base + route, {
    method: method || (body ? "POST" : "GET"),
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body instanceof FormData ? {} : { "Content-Type": "application/json" }) },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const credentials = { email: "owner@example.com", password: "test-password" };
  await start();
  try {
    let response = await request("/api/health");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, storage: "supabase" });
    assert.match(response.headers.get("cache-control"), /no-store/);
    response = await request("/api/register", { ...credentials, name: "Owner" });
    assert.equal(response.status, 201);
    let cookie = response.headers.get("set-cookie").split(";")[0];
    response = await request("/api/cards", { cardName: "Oro", bankName: "Demo" }, cookie);
    const { card } = await response.json();
    const form = new FormData();
    Object.entries({ cardId: card.id, period: "Septiembre 2026", dueDate: "2026-09-20", minPayment: "10", noInterestAmount: "50", totalAmount: "100" }).forEach(([key, value]) => form.set(key, value));
    form.set("document", new Blob(["private-fixture"], { type: "image/png" }), "estado.png");
    let releaseUpload, uploadStarted;
    const uploadGate = new Promise(resolve => { releaseUpload = resolve; });
    const uploadEntered = new Promise(resolve => { uploadStarted = resolve; });
    fixture.beforeUpload = async () => { uploadStarted(); await uploadGate; };
    const uploading = request("/api/statements", form, cookie);
    await uploadEntered;
    const concurrentLogin = await request("/api/login", credentials);
    assert.equal(concurrentLogin.status, 200);
    const concurrentCookie = concurrentLogin.headers.get("set-cookie").split(";")[0];
    releaseUpload();
    response = await uploading;
    assert.equal(response.status, 201);
    const { statement } = await response.json();
    assert.equal(fixture.files.size, 1);
    assert.equal((await request("/api/me", null, concurrentCookie)).status, 200);
    await new Promise(resolve => server.close(resolve));
    await start();
    assert.equal((await request("/api/me", null, cookie)).status, 200);
    assert.equal((await request("/api/login", { ...credentials, password: "wrong" })).status, 401);
    response = await request("/api/login", { ...credentials, email: " OWNER@EXAMPLE.COM " });
    assert.equal(response.status, 200);
    cookie = response.headers.get("set-cookie").split(";")[0];
    response = await request("/api/statements", null, cookie);
    assert.equal((await response.json()).statements[0].id, statement.id);
    response = await request(`/api/files/${statement.file.id}`, null, cookie);
    assert.equal(await response.text(), "private-fixture");
    assert.match(response.headers.get("cache-control"), /no-store/);
    assert.equal((await request(`/api/files/${statement.file.id}`)).status, 401);
    response = await request("/api/register", { email: "other@example.com", password: "test-password", name: "Other" });
    const otherCookie = response.headers.get("set-cookie").split(";")[0];
    assert.equal((await request(`/api/files/${statement.file.id}`, null, otherCookie)).status, 404);
    fixture.unavailable = true;
    response = await request("/api/health");
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /private provider details|sb_secret_/);
    response = await request("/api/login", credentials);
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /almacenamiento/);
    fixture.unavailable = false;
    assert.equal((await request("/api/login", credentials)).status, 200);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("stale writes cannot erase another session or account", async () => {
  const fixture = supabaseFixture();
  const first = fixture.storage(), second = fixture.storage();
  const a = await first.readDb(), b = await second.readDb();
  a.users.push({ id: "first" }); a.sessions.first = "first";
  b.users.push({ id: "second" });
  await first.writeDb(a);
  await assert.rejects(second.writeDb(b), { status: 409 });
  const current = await second.readDb();
  assert.deepEqual(current.users, [{ id: "first" }]);
  assert.equal(current.sessions.first, "first");
});

test("remote failures, missing schema, public bucket and incomplete config never fall back to local", async () => {
  const fixture = supabaseFixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tarjetas-no-fallback-"));
  const storage = createStorage({ env: fixture.env, fetch: fixture.fetch, root });
  fixture.missingRow = true;
  await assert.rejects(storage.readDb(), { status: 503 });
  assert.equal(fs.existsSync(path.join(root, "data")), false);
  fixture.missingRow = false; fixture.publicBucket = true;
  await assert.rejects(storage.check(), /privado/);
  assert.throws(() => createStorage({ env: { SUPABASE_URL: fixture.env.SUPABASE_URL }, root }), /SUPABASE_SECRET_KEY/);
  assert.throws(() => createStorage({ env: { RENDER: "true" }, root }), /persistente/);
  assert.throws(() => createStorage({ env: { ...fixture.env, SUPABASE_URL: "http://fixture.supabase.co" }, root }), /SUPABASE_URL/);
  assert.throws(() => createStorage({ env: { ...fixture.env, SUPABASE_SECRET_KEY: "sb_publishable_test" }, root }), /clave publica/);
});

test("storage bounds stalled connection and body reads", async () => {
  const env = supabaseFixture().env;
  const hang = signal => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  for (const fetch of [(_, { signal }) => hang(signal), async (_, { signal }) => ({ ok: true, json: () => hang(signal) })]) {
    await assert.rejects(createStorage({ env, fetch, timeoutMs: 20 }).readDb(), { status: 503 });
  }
});

test("local storage remains compatible and does not recreate a missing or corrupt active database", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tarjetas-local-storage-"));
  const storage = createStorage({ env: {}, root });
  const db = await storage.readDb();
  db.users.push({ id: "legacy", passwordHash: "unchanged" });
  await storage.writeDb(db);
  const restarted = createStorage({ env: {}, root });
  assert.equal((await restarted.readDb()).users[0].passwordHash, "unchanged");
  const stale = await storage.readDb();
  const fresh = await storage.readDb(); fresh.sessions.new = "legacy";
  await storage.writeDb(fresh);
  await assert.rejects(storage.writeDb(stale), { status: 409 });
  const dbPath = path.join(root, "data/db.json");
  fs.renameSync(dbPath, path.join(root, "data/saved-db.json"));
  await assert.rejects(storage.readDb(), { status: 503 });
  assert.equal(fs.existsSync(dbPath), false);
  fs.writeFileSync(dbPath, "broken");
  await assert.rejects(storage.readDb(), { status: 503 });
  assert.equal(fs.readFileSync(dbPath, "utf8"), "broken");
});

test("migration preserves account IDs, hashes and files without overwriting a populated destination", async () => {
  const fixture = supabaseFixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tarjetas-migrate-"));
  const source = { users: [{ id: "legacy", email: "old@example.com", passwordHash: "unchanged" }], cards: [{ id: "card", ownerId: "legacy" }],
    sessions: { old: "legacy" }, passwordResets: [], statements: [{ id: "statement", cardId: "card", file: { id: "file", storedName: "file_old.pdf", contentType: "application/pdf" } }] };
  const dbPath = path.join(root, "backup.json");
  fs.writeFileSync(dbPath, JSON.stringify(source));
  await assert.rejects(migrate(dbPath, root, fixture.storage()), { code: "ENOENT" });
  assert.equal(fixture.calls.length, 0);
  fs.writeFileSync(path.join(root, "file_old.pdf"), "original-pdf");
  await migrate(dbPath, root, fixture.storage());
  const restored = await fixture.storage().readDb();
  assert.deepEqual(restored.users, source.users);
  assert.deepEqual(restored.sessions, {});
  assert.equal((await fixture.storage().readFile(restored.statements[0].file.storedName)).toString(), "original-pdf");
  assert.equal(fs.readFileSync(dbPath, "utf8"), JSON.stringify(source));
  await assert.rejects(migrate(dbPath, root, fixture.storage()), /ya tiene datos/);
  assert.equal(fixture.files.size, 1);
});
