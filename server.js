const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const UPLOADS_DIR = path.join(ROOT, "uploads");
const DB_FILE = path.join(DATA_DIR, "db.json");
const MAX_BODY = 18 * 1024 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".pdf": "application/pdf",
};

function ensureStorage() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    writeDb({ users: [], sessions: {}, cards: [], statements: [], passwordResets: [] });
  }
}

function readDb() {
  ensureStorage();
  const db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  db.users ||= [];
  db.sessions ||= {};
  db.cards ||= [];
  db.statements ||= [];
  db.passwordResets ||= [];
  return db;
}

function writeDb(db) {
  const tmp = `${DB_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, expected] = String(stored || "").split(":");
  if (!salt || !expected) return false;
  const actual = hashPassword(password, salt).split(":")[1];
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function resetCode() {
  return String(crypto.randomInt(100000, 1000000));
}

function resetCodeHash(email, code) {
  const secret = process.env.RESET_CODE_SECRET || "local-reset-secret";
  return crypto.createHash("sha256").update(`${normalizeEmail(email)}:${String(code).trim()}:${secret}`).digest("hex");
}

async function sendResetEmail(email, code) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESET_EMAIL_FROM || process.env.FROM_EMAIL;
  if (!apiKey || !from) {
    throw Object.assign(new Error("Configura RESEND_API_KEY y RESET_EMAIL_FROM en Render para enviar codigos por correo."), { status: 503 });
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: email,
      subject: "Codigo temporal para resetear tu contrasena",
      text: `Tu codigo temporal es ${code}. Expira en 15 minutos.`,
      html: `<p>Tu codigo temporal es <strong>${code}</strong>.</p><p>Expira en 15 minutos.</p>`,
    }),
  });

  if (!response.ok) {
    throw Object.assign(new Error("No se pudo enviar el codigo por correo. Revisa la configuracion de correo en Render."), { status: 502 });
  }
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": typeof body === "object" && !Buffer.isBuffer(body) ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
    ...headers,
  });
  res.end(payload);
}

function sendJson(res, status, body, headers = {}) {
  send(res, status, body, { "Content-Type": "application/json; charset=utf-8", ...headers });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY) {
        reject(Object.assign(new Error("Archivo demasiado grande."), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const body = await readBody(req);
  if (!body.length) return {};
  return JSON.parse(body.toString("utf8"));
}

function cookieMap(req) {
  return Object.fromEntries(
    String(req.headers.cookie || "")
      .split(";")
      .map((item) => item.trim().split("="))
      .filter(([key, value]) => key && value)
      .map(([key, value]) => [key, decodeURIComponent(value)])
  );
}

function currentUser(req, db) {
  const sid = cookieMap(req).sid;
  const userId = sid && db.sessions[sid];
  return userId ? db.users.find((user) => user.id === userId) : null;
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt,
  };
}

function requireUser(req, res, db) {
  const user = currentUser(req, db);
  if (!user) {
    sendJson(res, 401, { error: "Inicia sesion para continuar." });
    return null;
  }
  return user;
}

function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!match) throw Object.assign(new Error("Formato de archivo invalido."), { status: 400 });
  const boundary = `--${match[1] || match[2]}`;
  const raw = buffer.toString("binary");
  const parts = {};

  raw.split(boundary).forEach((part) => {
    if (!part || part === "--\r\n" || part === "--") return;
    const cleaned = part.replace(/^\r\n/, "").replace(/\r\n--$/, "");
    const splitAt = cleaned.indexOf("\r\n\r\n");
    if (splitAt === -1) return;
    const headerBlock = cleaned.slice(0, splitAt);
    let content = cleaned.slice(splitAt + 4);
    if (content.endsWith("\r\n")) content = content.slice(0, -2);
    const name = /name="([^"]+)"/.exec(headerBlock)?.[1];
    if (!name) return;
    const filename = /filename="([^"]*)"/.exec(headerBlock)?.[1];
    const contentTypePart = /Content-Type:\s*([^\r\n]+)/i.exec(headerBlock)?.[1] || "application/octet-stream";
    if (filename) {
      parts[name] = {
        filename: path.basename(filename),
        contentType: contentTypePart,
        buffer: Buffer.from(content, "binary"),
      };
    } else {
      parts[name] = Buffer.from(content, "binary").toString("utf8").trim();
    }
  });

  return parts;
}

function sanitizeText(value, max = 120) {
  return String(value || "").trim().slice(0, max);
}

function money(value) {
  const n = Number(String(value || "").replace(/,/g, ""));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 0;
}

function dateValue(value) {
  const text = sanitizeText(value, 20);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function allowedFile(file) {
  const ext = path.extname(file.filename).toLowerCase();
  const types = new Set(["image/png", "image/jpeg", "application/pdf"]);
  return [".png", ".jpg", ".jpeg", ".pdf"].includes(ext) && types.has(file.contentType);
}

function groupCards(db, user) {
  return db.cards.filter((card) => card.ownerId === user.id);
}

function groupStatements(db, user) {
  const cardIds = new Set(groupCards(db, user).map((card) => card.id));
  return db.statements.filter((statement) => cardIds.has(statement.cardId));
}

async function handleApi(req, res, pathname) {
  const db = readDb();

  try {
    if (req.method === "POST" && pathname === "/api/register") {
      const body = await readJson(req);
      const email = normalizeEmail(body.email);
      const password = String(body.password || "");
      const name = sanitizeText(body.name, 80);
      if (!name || !validEmail(email) || password.length < 6) {
        return sendJson(res, 400, { error: "Nombre, correo valido y contrasena de al menos 6 caracteres son obligatorios." });
      }
      if (db.users.some((user) => user.email === email)) {
        return sendJson(res, 409, { error: "Ese correo ya tiene cuenta." });
      }
      const user = {
        id: id("user"),
        name,
        email,
        passwordHash: hashPassword(password),
        createdAt: new Date().toISOString(),
      };
      const sid = id("sid");
      db.users.push(user);
      db.sessions[sid] = user.id;
      writeDb(db);
      return sendJson(res, 201, { user: publicUser(user) }, { "Set-Cookie": `sid=${encodeURIComponent(sid)}; HttpOnly; SameSite=Lax; Path=/` });
    }

    if (req.method === "POST" && pathname === "/api/login") {
      const body = await readJson(req);
      const user = db.users.find((item) => item.email === normalizeEmail(body.email));
      if (!user || !verifyPassword(body.password, user.passwordHash)) {
        return sendJson(res, 401, { error: "Correo o contrasena incorrectos." });
      }
      const sid = id("sid");
      db.sessions[sid] = user.id;
      writeDb(db);
      return sendJson(res, 200, { user: publicUser(user) }, { "Set-Cookie": `sid=${encodeURIComponent(sid)}; HttpOnly; SameSite=Lax; Path=/` });
    }

    if (req.method === "POST" && pathname === "/api/request-password-reset") {
      const body = await readJson(req);
      const email = normalizeEmail(body.email);
      if (!validEmail(email)) {
        return sendJson(res, 400, { error: "Escribe un correo valido." });
      }
      const user = db.users.find((item) => item.email === email);
      if (!user) {
        return sendJson(res, 200, { message: "Si existe una cuenta con ese correo, enviaremos un codigo temporal." });
      }
      const now = Date.now();
      const recent = db.passwordResets.find((item) => item.email === email && now - Date.parse(item.createdAt) < 60 * 1000);
      if (recent) {
        return sendJson(res, 429, { error: "Espera un minuto antes de pedir otro codigo." });
      }
      const code = resetCode();
      db.passwordResets = db.passwordResets.filter((item) => item.email !== email && Date.parse(item.expiresAt) > now);
      db.passwordResets.push({
        id: id("reset"),
        email,
        codeHash: resetCodeHash(email, code),
        expiresAt: new Date(now + 15 * 60 * 1000).toISOString(),
        createdAt: new Date(now).toISOString(),
        attempts: 0,
      });
      writeDb(db);
      try {
        await sendResetEmail(email, code);
      } catch (error) {
        const latestDb = readDb();
        latestDb.passwordResets = latestDb.passwordResets.filter((item) => item.email !== email);
        writeDb(latestDb);
        throw error;
      }
      return sendJson(res, 200, { message: "Te enviamos un codigo temporal. Revisa tu correo." });
    }

    if (req.method === "POST" && pathname === "/api/reset-password") {
      const body = await readJson(req);
      const email = normalizeEmail(body.email);
      const code = sanitizeText(body.code, 12);
      const password = String(body.password || "");
      const user = db.users.find((item) => item.email === email);
      if (!validEmail(email) || !code || password.length < 6) {
        return sendJson(res, 400, { error: "Correo, codigo temporal y contrasena nueva de al menos 6 caracteres son obligatorios." });
      }
      if (!user) {
        return sendJson(res, 404, { error: "No encontramos una cuenta con ese correo." });
      }
      const now = Date.now();
      const reset = db.passwordResets.find((item) => item.email === email);
      if (!reset || Date.parse(reset.expiresAt) < now) {
        db.passwordResets = db.passwordResets.filter((item) => item.email !== email);
        writeDb(db);
        return sendJson(res, 400, { error: "El codigo expiro. Pide uno nuevo." });
      }
      if (reset.attempts >= 5 || reset.codeHash !== resetCodeHash(email, code)) {
        reset.attempts += 1;
        writeDb(db);
        return sendJson(res, 400, { error: "Codigo temporal incorrecto." });
      }
      user.passwordHash = hashPassword(password);
      user.updatedAt = new Date().toISOString();
      Object.entries(db.sessions).forEach(([sid, userId]) => {
        if (userId === user.id) delete db.sessions[sid];
      });
      const sid = id("sid");
      db.sessions[sid] = user.id;
      db.passwordResets = db.passwordResets.filter((item) => item.email !== email);
      writeDb(db);
      return sendJson(res, 200, { user: publicUser(user) }, { "Set-Cookie": `sid=${encodeURIComponent(sid)}; HttpOnly; SameSite=Lax; Path=/` });
    }

    if (req.method === "POST" && pathname === "/api/logout") {
      const sid = cookieMap(req).sid;
      if (sid) delete db.sessions[sid];
      writeDb(db);
      return sendJson(res, 200, { ok: true }, { "Set-Cookie": "sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" });
    }

    const user = requireUser(req, res, db);
    if (!user) return;

    if (req.method === "GET" && pathname === "/api/me") {
      return sendJson(res, 200, {
        user: publicUser(user),
      });
    }

    if (req.method === "GET" && pathname === "/api/cards") {
      return sendJson(res, 200, { cards: groupCards(db, user) });
    }

    if (req.method === "POST" && pathname === "/api/cards") {
      const body = await readJson(req);
      const card = {
        id: id("card"),
        ownerId: user.id,
        cardName: sanitizeText(body.cardName, 80),
        bankName: sanitizeText(body.bankName, 80),
        lastFour: sanitizeText(body.lastFour, 4),
        color: sanitizeText(body.color, 20) || "ink",
        createdAt: new Date().toISOString(),
      };
      if (!card.cardName || !card.bankName) {
        return sendJson(res, 400, { error: "Nombre de tarjeta y banco son obligatorios." });
      }
      db.cards.push(card);
      writeDb(db);
      return sendJson(res, 201, { card });
    }

    const cardDelete = /^\/api\/cards\/([^/]+)$/.exec(pathname);
    if (req.method === "DELETE" && cardDelete) {
      const card = db.cards.find((item) => item.id === cardDelete[1] && item.ownerId === user.id);
      if (!card) return sendJson(res, 404, { error: "Tarjeta no encontrada." });
      const statementIds = new Set(db.statements.filter((item) => item.cardId === card.id).map((item) => item.id));
      db.cards = db.cards.filter((item) => item.id !== card.id);
      db.statements = db.statements.filter((item) => !statementIds.has(item.id));
      writeDb(db);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "GET" && pathname === "/api/statements") {
      return sendJson(res, 200, { statements: groupStatements(db, user) });
    }

    if (req.method === "POST" && pathname === "/api/statements") {
      const parts = parseMultipart(await readBody(req), req.headers["content-type"]);
      const card = groupCards(db, user).find((item) => item.id === parts.cardId);
      if (!card) return sendJson(res, 400, { error: "Selecciona una tarjeta valida." });
      const file = parts.document;
      if (!file || !allowedFile(file)) {
        return sendJson(res, 400, { error: "Sube un PNG, JPG o PDF valido." });
      }
      const ext = path.extname(file.filename).toLowerCase();
      const fileId = id("file");
      const filePath = path.join(UPLOADS_DIR, `${fileId}${ext}`);
      fs.writeFileSync(filePath, file.buffer);
      const statement = {
        id: id("statement"),
        cardId: card.id,
        uploadedBy: user.id,
        period: sanitizeText(parts.period, 40),
        dueDate: dateValue(parts.dueDate),
        minPayment: money(parts.minPayment),
        noInterestAmount: money(parts.noInterestAmount),
        totalAmount: money(parts.totalAmount),
        notes: sanitizeText(parts.notes, 500),
        status: "pendiente",
        file: {
          id: fileId,
          originalName: file.filename,
          contentType: file.contentType,
          size: file.buffer.length,
          storedName: `${fileId}${ext}`,
        },
        createdAt: new Date().toISOString(),
      };
      if (!statement.period || !statement.dueDate || !statement.noInterestAmount || !statement.totalAmount) {
        return sendJson(res, 400, { error: "Periodo, fecha limite, monto para no generar intereses y monto total son obligatorios." });
      }
      db.statements.push(statement);
      writeDb(db);
      return sendJson(res, 201, { statement });
    }

    const statementMatch = /^\/api\/statements\/([^/]+)$/.exec(pathname);
    if (statementMatch) {
      const statement = groupStatements(db, user).find((item) => item.id === statementMatch[1]);
      if (!statement) return sendJson(res, 404, { error: "Estado de cuenta no encontrado." });
      if (req.method === "PUT") {
        const body = await readJson(req);
        const next = sanitizeText(body.status, 20);
        if (!["pendiente", "programado", "pagado"].includes(next)) {
          return sendJson(res, 400, { error: "Estado invalido." });
        }
        statement.status = next;
        statement.updatedAt = new Date().toISOString();
        writeDb(db);
        return sendJson(res, 200, { statement });
      }
      if (req.method === "DELETE") {
        db.statements = db.statements.filter((item) => item.id !== statement.id);
        writeDb(db);
        return sendJson(res, 200, { ok: true });
      }
    }

    const fileMatch = /^\/api\/files\/([^/]+)$/.exec(pathname);
    if (req.method === "GET" && fileMatch) {
      const statement = groupStatements(db, user).find((item) => item.file.id === fileMatch[1]);
      if (!statement) return sendJson(res, 404, { error: "Archivo no encontrado." });
      const filePath = path.join(UPLOADS_DIR, statement.file.storedName);
      if (!fs.existsSync(filePath)) return sendJson(res, 404, { error: "Archivo no encontrado." });
      res.writeHead(200, {
        "Content-Type": statement.file.contentType,
        "Content-Disposition": `inline; filename="${statement.file.originalName.replace(/"/g, "")}"`,
      });
      return fs.createReadStream(filePath).pipe(res);
    }

    return sendJson(res, 404, { error: "Ruta no encontrada." });
  } catch (error) {
    const status = error.status || 500;
    return sendJson(res, status, { error: status === 500 ? "Ocurrio un error inesperado." : error.message });
  }
}

function serveStatic(req, res, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, "Prohibido");
  fs.stat(filePath, (error, stat) => {
    if (error || !stat.isFile()) {
      return send(res, 404, "No encontrado");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  });
}

ensureStorage();
http
  .createServer((req, res) => {
    const { pathname } = new URL(req.url, `http://${req.headers.host}`);
    if (pathname.startsWith("/api/")) return handleApi(req, res, pathname);
    return serveStatic(req, res, decodeURIComponent(pathname));
  })
  .listen(PORT, HOST, () => {
    console.log(`App disponible en http://${HOST}:${PORT}`);
  });
