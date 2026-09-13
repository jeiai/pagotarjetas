const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const snapshots = new WeakMap();
const emptyDb = () => ({ users: [], sessions: {}, cards: [], statements: [], passwordResets: [] });
const unavailable = () => Object.assign(new Error("No se pudo acceder al almacenamiento. Intenta mas tarde; tus datos no se reemplazaron."), { status: 503 });
const conflict = () => Object.assign(new Error("Los datos cambiaron durante la operacion. Intenta de nuevo."), { status: 409 });

function validateDb(db) {
  if (!db || typeof db !== "object" || Array.isArray(db) ||
      !["users", "cards", "statements"].every(key => Array.isArray(db[key])) ||
      !db.sessions || typeof db.sessions !== "object" || Array.isArray(db.sessions) ||
      (db.passwordResets !== undefined && !Array.isArray(db.passwordResets))) throw unavailable();
  db.passwordResets ||= [];
  return db;
}

function safeName(name) {
  if (typeof name !== "string" || !/^[a-zA-Z0-9_-]+\.(png|jpe?g|pdf)$/i.test(name)) {
    throw Object.assign(new Error("Archivo no encontrado."), { status: 404 });
  }
  return name;
}

function createStorage({ env = process.env, root = __dirname, fetch: fetchImpl, timeoutMs = 20000 } = {}) {
  const dataDir = env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.join(root, "data");
  const uploadsDir = env.DATA_DIR ? path.join(dataDir, "uploads") : path.join(root, "uploads");
  const dbFile = path.join(dataDir, "db.json");
  const remoteUrl = String(env.SUPABASE_URL || "").trim().replace(/\/$/, "");
  const key = String(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  const remote = Boolean(remoteUrl || key);
  const bucket = "tarjetas-documentos";
  let initialized = false;

  if (remote) {
    let url;
    try { url = new URL(remoteUrl); } catch { /* Validated below without exposing credentials. */ }
    if (!url || url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || !key) {
      throw new Error("Configura SUPABASE_URL (https://tu-proyecto.supabase.co) y SUPABASE_SECRET_KEY en el servidor.");
    }
    if (key.startsWith("sb_publishable_")) throw new Error("Usa SUPABASE_SECRET_KEY, no la clave publica de Supabase.");
  } else if (env.RENDER === "true" && !env.DATA_DIR) {
    throw new Error("Render necesita almacenamiento persistente: configura Supabase o DATA_DIR sobre un disco persistente antes de iniciar.");
  }

  function ensureStorage() {
    if (remote || initialized) return;
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(uploadsDir, { recursive: true });
    try { fs.writeFileSync(dbFile, JSON.stringify(emptyDb(), null, 2), { flag: "wx" }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    initialized = true;
  }

  async function request(route, options = {}, binary = false) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await (fetchImpl || globalThis.fetch)(`${remoteUrl}${route}`, {
        ...options,
        redirect: "error",
        signal: controller.signal,
        headers: {
          apikey: key,
          // Legacy service_role keys are JWTs; new secret keys use only apikey.
          ...(key.startsWith("sb_secret_") ? {} : { Authorization: `Bearer ${key}` }),
          ...options.headers,
        },
      });
      if (!response.ok) {
        console.error("[storage] Supabase request failed", { status: response.status, operation: options.method || "GET" });
        await response.body?.cancel();
        throw unavailable();
      }
      return binary ? Buffer.from(await response.arrayBuffer()) : await response.json();
    } catch (error) {
      if (error.status === 503) throw error;
      throw unavailable();
    } finally { clearTimeout(timer); }
  }

  async function readDb() {
    if (remote) {
      const rows = await request("/rest/v1/tarjetas_state?id=eq.1&select=revision,document");
      if (!Array.isArray(rows) || rows.length !== 1 || !Number.isSafeInteger(rows[0].revision)) throw unavailable();
      const db = validateDb(rows[0].document);
      snapshots.set(db, { revision: rows[0].revision, storage: api });
      return db;
    }
    ensureStorage();
    try {
      const raw = fs.readFileSync(dbFile, "utf8");
      const db = validateDb(JSON.parse(raw));
      snapshots.set(db, { revision: crypto.createHash("sha256").update(raw).digest("hex"), storage: api });
      return db;
    } catch { throw unavailable(); }
  }

  async function writeDb(db) {
    validateDb(db);
    const snapshot = snapshots.get(db);
    if (!snapshot || snapshot.storage !== api) throw conflict();
    if (remote) {
      const revision = snapshot.revision + 1;
      const rows = await request(`/rest/v1/tarjetas_state?id=eq.1&revision=eq.${snapshot.revision}&select=revision`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Prefer: "return=representation" },
        body: JSON.stringify({ document: db, revision }),
      });
      if (!Array.isArray(rows)) throw unavailable();
      if (rows.length === 0) throw conflict();
      if (rows.length !== 1 || rows[0].revision !== revision) throw unavailable();
      snapshots.set(db, { revision, storage: api });
      return;
    }
    try {
      const current = fs.readFileSync(dbFile, "utf8");
      if (crypto.createHash("sha256").update(current).digest("hex") !== snapshot.revision) throw conflict();
      const raw = JSON.stringify(db, null, 2);
      const tmp = `${dbFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, raw);
      fs.renameSync(tmp, dbFile);
      snapshots.set(db, { revision: crypto.createHash("sha256").update(raw).digest("hex"), storage: api });
    } catch (error) { if (error.status === 409) throw error; throw unavailable(); }
  }

  async function saveFile(name, buffer, contentType) {
    safeName(name);
    if (remote) {
      await request(`/storage/v1/object/${bucket}/${name}`, {
        method: "POST", headers: { "Content-Type": contentType, "x-upsert": "false" }, body: buffer,
      });
    } else {
      ensureStorage();
      fs.writeFileSync(path.join(uploadsDir, name), buffer, { flag: "wx" });
    }
  }

  async function readFile(name) {
    safeName(name);
    if (remote) return request(`/storage/v1/object/authenticated/${bucket}/${name}`, {}, true);
    try { return fs.readFileSync(path.join(uploadsDir, name)); }
    catch (error) {
      if (error.code === "ENOENT") throw Object.assign(new Error("Archivo no encontrado."), { status: 404 });
      throw unavailable();
    }
  }

  async function check() {
    const db = await readDb();
    if (remote) {
      const info = await request(`/storage/v1/bucket/${bucket}`);
      if (info.public !== false) throw new Error("El bucket tarjetas-documentos debe ser privado.");
    }
    return { backend: remote ? "supabase" : "local", users: db.users.length, cards: db.cards.length, statements: db.statements.length };
  }

  const api = { backend: remote ? "supabase" : "local", ensureStorage, readDb, writeDb, saveFile, readFile, check };
  return api;
}

module.exports = { createStorage, validateDb };
