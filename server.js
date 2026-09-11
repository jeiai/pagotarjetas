const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const zlib = require("zlib");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
const UPLOADS_DIR = process.env.DATA_DIR ? path.join(DATA_DIR, "uploads") : path.join(ROOT, "uploads");
const DB_FILE = path.join(DATA_DIR, "db.json");
const MAX_BODY = 80 * 1024 * 1024;
const MAX_AUTO_FILES = 15;
const MAX_SINGLE_FILE = 12 * 1024 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
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
  if (!salt || !/^[a-f0-9]{64}$/i.test(expected || "")) return false;
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

  const responseText = await response.text();
  let payload = {};
  try {
    payload = responseText ? JSON.parse(responseText) : {};
  } catch {
    payload = { raw: responseText };
  }

  if (!response.ok) {
    console.error("[password-reset] Resend rejected email", {
      status: response.status,
      email,
      response: payload,
    });
    throw Object.assign(new Error("Resend rechazo el correo. Revisa RESEND_API_KEY, RESET_EMAIL_FROM y que el dominio remitente este verificado."), { status: 502 });
  }

  console.info("[password-reset] Email accepted by Resend", {
    email,
    id: payload.id || null,
  });
  return payload;
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
      .map(([key, value]) => {
        try { return [key, decodeURIComponent(value)]; }
        catch { return [key, ""]; }
      })
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
      const file = {
        filename: path.basename(filename),
        contentType: contentTypePart,
        buffer: Buffer.from(content, "binary"),
      };
      if (parts[name]) {
        parts[name] = Array.isArray(parts[name]) ? [...parts[name], file] : [parts[name], file];
      } else {
        parts[name] = file;
      }
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

function allowedAutoFile(file) {
  return allowedFile(file);
}

function detectMime(filename) {
  return MIME[path.extname(filename).toLowerCase()] || "application/octet-stream";
}

function safeUploadName(filename) {
  return path.basename(String(filename || "archivo")).replace(/[^\w.\-() ]/g, "_").slice(0, 120) || "archivo";
}

function asFileList(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function readZipEntries(file) {
  const buffer = file.buffer;
  const entries = [];
  const invalid = (message = "El ZIP esta danado o incompleto. Vuelve a comprimir los archivos.") => Object.assign(new Error(message), { status: 400 });
  const check = (offset, size) => {
    if (offset < 0 || offset + size > buffer.length) throw invalid();
  };
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw Object.assign(new Error("El ZIP no parece valido."), { status: 400 });
  }

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (buffer.readUInt16LE(eocdOffset + 4) || buffer.readUInt16LE(eocdOffset + 6) ||
      totalEntries === 65535 || centralOffset === 0xffffffff) {
    throw invalid("No se admite ZIP64 ni ZIP dividido en partes. Crea un ZIP estandar.");
  }
  let offset = centralOffset;

  for (let i = 0; i < totalEntries; i += 1) {
    check(offset, 46);
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw invalid();
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const expectedCrc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    check(offset + 46, fileNameLength + extraLength + commentLength);
    const filename = buffer.slice(offset + 46, offset + 46 + fileNameLength).toString("utf8");
    offset += 46 + fileNameLength + extraLength + commentLength;

    if (!filename || filename.endsWith("/") || filename.includes("__MACOSX")) continue;
    if (![".png", ".jpg", ".jpeg", ".pdf"].includes(path.extname(filename).toLowerCase())) continue;
    if (flags & 1) throw invalid("El ZIP tiene archivos protegidos con contrasena. Crea un ZIP sin contrasena.");
    if (entries.length >= MAX_AUTO_FILES) throw invalid("Puedes procesar maximo 15 capturas o PDFs a la vez, incluyendo los del ZIP.");
    if (uncompressedSize > MAX_SINGLE_FILE) throw invalid(`El archivo ${safeUploadName(filename)} supera el limite de 12 MB descomprimido.`);
    check(localOffset, 30);
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw invalid();
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    check(dataStart, compressedSize);
    const compressed = buffer.slice(dataStart, dataStart + compressedSize);
    let data;
    if (method === 0) {
      data = compressed;
    } else if (method === 8) {
      try {
        data = zlib.inflateRawSync(compressed, { maxOutputLength: MAX_SINGLE_FILE });
      } catch {
        throw invalid(`No se pudo descomprimir ${safeUploadName(filename)}. Esta danado o supera 12 MB.`);
      }
    } else {
      throw invalid("El ZIP usa una compresion no compatible. Vuelve a crearlo con compresion estandar (Deflate).");
    }
    if (data.length !== uncompressedSize || crc32(data) !== expectedCrc) throw invalid();
    const entry = {
      filename: safeUploadName(filename),
      contentType: detectMime(filename),
      buffer: data,
    };
    if (allowedAutoFile(entry)) entries.push(entry);
  }

  return entries;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function collectAutoFiles(parts) {
  const files = [];
  asFileList(parts.documents).forEach((file) => {
    const ext = path.extname(file.filename).toLowerCase();
    if (ext === ".zip" || file.contentType === "application/zip" || file.contentType === "application/x-zip-compressed") {
      files.push(...readZipEntries(file));
    } else {
      files.push(file);
    }
  });

  const valid = files.filter(allowedAutoFile);
  if (!valid.length) {
    throw Object.assign(new Error("Sube PNG, JPG, PDF o un ZIP con esos formatos."), { status: 400 });
  }
  if (valid.length > MAX_AUTO_FILES) {
    throw Object.assign(new Error("Puedes procesar maximo 15 capturas o PDFs a la vez."), { status: 400 });
  }
  const oversized = valid.find((file) => file.buffer.length > MAX_SINGLE_FILE);
  if (oversized) {
    throw Object.assign(new Error(`El archivo ${oversized.filename} supera el limite de 12 MB.`), { status: 400 });
  }
  return valid;
}

function groupCards(db, user) {
  return db.cards.filter((card) => card.ownerId === user.id);
}

function groupStatements(db, user) {
  const cardIds = new Set(groupCards(db, user).map((card) => card.id));
  return db.statements.filter((statement) => cardIds.has(statement.cardId));
}

function normalizeDateFromAi(value) {
  const text = sanitizeText(value, 40);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return "";
}

function aiMoney(value) {
  return money(String(value ?? "").replace(/[^\d.,]/g, ""));
}

function parseJsonObject(text) {
  const raw = String(text || "").trim();
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return {};
    try {
      return JSON.parse(match[0]);
    } catch {
      return {};
    }
  }
}

async function extractStatementData(file, { signal, timeoutMs = 45000 } = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw Object.assign(new Error("Configura OPENAI_API_KEY en Render para extraer datos automaticamente."), { status: 503 });
  }

  const prompt = [
    "Extrae datos de un estado de cuenta de tarjeta de credito en Mexico.",
    "Devuelve solo JSON valido con estas llaves:",
    "bankName, cardName, lastFour, period, dueDate, minPayment, noInterestAmount, totalAmount, confidence, notes.",
    "dueDate debe estar en formato YYYY-MM-DD.",
    "Los montos deben ser numeros sin simbolo de moneda.",
    "Si un dato no aparece, usa cadena vacia o 0.",
    "noInterestAmount corresponde a pago para no generar intereses.",
  ].join(" ");
  const base64 = file.buffer.toString("base64");
  const content =
    file.contentType === "application/pdf"
      ? [
          { type: "input_text", text: prompt },
          { type: "input_file", filename: file.filename, file_data: `data:application/pdf;base64,${base64}` },
        ]
      : [
          { type: "input_text", text: prompt },
          { type: "input_image", image_url: `data:${file.contentType};base64,${base64}` },
        ];

  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, timeoutMs);
  let response, bodyText;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      signal: controller.signal,
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
        input: [{ role: "user", content }],
        text: { format: { type: "json_object" } },
      }),
    });

    bodyText = await response.text();
  } catch (error) {
    console.error("[auto-extract] Request failed", { reason: controller.signal.aborted ? "timeout-or-cancelled" : "connection" });
    throw Object.assign(new Error(controller.signal.aborted
      ? "Se agoto el tiempo para leer este archivo. Intenta de nuevo con una captura mas clara o un PDF mas pequeno."
      : "No se pudo conectar con el servicio de lectura. Intenta de nuevo en unos momentos."), { status: controller.signal.aborted ? 504 : 502 });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
  let payload = {};
  try {
    payload = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    payload = { raw: bodyText };
  }
  if (!response.ok) {
    console.error("[auto-extract] OpenAI rejected extraction", {
      status: response.status,
      code: payload.error?.code,
      requestId: response.headers.get("x-request-id"),
    });
    const message = response.status === 429
      ? payload.error?.code === "insufficient_quota"
        ? "El servicio de lectura no tiene saldo o cuota disponible. El administrador debe revisar la facturacion de OpenAI."
        : "El servicio de lectura esta ocupado. Espera un momento antes de reintentar."
      : [401, 403, 404].includes(response.status)
        ? "El servicio de lectura no esta bien configurado. El administrador debe revisar OPENAI_API_KEY y OPENAI_MODEL en Render."
        : "El servicio no pudo leer este archivo. Comprueba que sea una captura legible o un PDF sin contrasena.";
    throw Object.assign(new Error(message), { status: 502 });
  }

  const outputText =
    payload.output_text ||
    payload.output
      ?.flatMap((item) => item.content || [])
      .map((item) => item.text || "")
      .join("\n") ||
    "";
  const extracted = parseJsonObject(outputText);
  if (!extracted || typeof extracted !== "object" || !Object.keys(extracted).length || payload.status === "incomplete") {
    throw Object.assign(new Error("La lectura no devolvio datos validos. Prueba una captura mas clara."), { status: 502 });
  }
  return {
    bankName: sanitizeText(extracted.bankName, 80),
    cardName: sanitizeText(extracted.cardName, 80),
    lastFour: sanitizeText(String(extracted.lastFour || "").replace(/\D/g, ""), 4),
    period: sanitizeText(extracted.period, 40),
    dueDate: normalizeDateFromAi(extracted.dueDate),
    minPayment: aiMoney(extracted.minPayment),
    noInterestAmount: aiMoney(extracted.noInterestAmount),
    totalAmount: aiMoney(extracted.totalAmount),
    confidence: Math.max(0, Math.min(1, Number(extracted.confidence || 0))),
    notes: sanitizeText(extracted.notes, 280),
  };
}

function findOrCreateCard(db, user, extracted, fallbackCardId) {
  const ownCards = groupCards(db, user);
  const fallback = ownCards.find((card) => card.id === fallbackCardId);
  const bankName = extracted.bankName || fallback?.bankName || "Banco por revisar";
  const cardName = extracted.cardName || fallback?.cardName || "Tarjeta por revisar";
  const lastFour = extracted.lastFour || fallback?.lastFour || "";
  const existing = ownCards.find((card) => {
    const sameLastFour = lastFour ? card.lastFour === lastFour : true;
    return card.bankName.toLowerCase() === bankName.toLowerCase() && card.cardName.toLowerCase() === cardName.toLowerCase() && sameLastFour;
  });
  if (existing) return existing;
  if (fallback && !extracted.bankName && !extracted.cardName) return fallback;

  const card = {
    id: id("card"),
    ownerId: user.id,
    cardName,
    bankName,
    lastFour,
    color: "ink",
    createdAt: new Date().toISOString(),
  };
  db.cards.push(card);
  return card;
}

function saveUploadedFile(file) {
  const ext = path.extname(file.filename).toLowerCase();
  const fileId = id("file");
  const storedName = `${fileId}${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, storedName), file.buffer);
  return {
    id: fileId,
    originalName: file.filename,
    contentType: file.contentType,
    size: file.buffer.length,
    storedName,
  };
}

async function handleApi(req, res, pathname) {
  let db;

  try {
    db = readDb();
    if (req.method === "POST" && pathname === "/api/register") {
      const body = await readJson(req);
      db = readDb();
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
      db = readDb();
      const user = db.users.find((item) => normalizeEmail(item.email) === normalizeEmail(body.email));
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
      db = readDb();
      const email = normalizeEmail(body.email);
      if (!validEmail(email)) {
        return sendJson(res, 400, { error: "Escribe un correo valido." });
      }
      const user = db.users.find((item) => item.email === email);
      if (!user) {
        return sendJson(res, 404, { error: "No existe una cuenta con ese correo. Primero crea tu cuenta." });
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
      return sendJson(res, 200, { message: "Codigo enviado. Revisa tu correo y la carpeta de spam." });
    }

    if (req.method === "POST" && pathname === "/api/reset-password") {
      const body = await readJson(req);
      db = readDb();
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
      db = readDb();
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
      db = readDb();
      if (!requireUser(req, res, db)) return;
      const card = groupCards(db, user).find((item) => item.id === parts.cardId);
      if (!card) return sendJson(res, 400, { error: "Selecciona una tarjeta valida." });
      const file = parts.document;
      if (!file || !allowedFile(file)) {
        return sendJson(res, 400, { error: "Sube un PNG, JPG o PDF valido." });
      }
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
        file: saveUploadedFile(file),
        createdAt: new Date().toISOString(),
      };
      if (!statement.period || !statement.dueDate || !statement.noInterestAmount || !statement.totalAmount) {
        return sendJson(res, 400, { error: "Periodo, fecha limite, monto para no generar intereses y monto total son obligatorios." });
      }
      db.statements.push(statement);
      writeDb(db);
      return sendJson(res, 201, { statement });
    }

    if (req.method === "POST" && pathname === "/api/statements/auto") {
      const parts = parseMultipart(await readBody(req), req.headers["content-type"]);
      const files = collectAutoFiles(parts);
      const fallbackCardId = sanitizeText(parts.cardId, 80);
      const results = [];
      const errors = [];
      const streaming = String(req.headers.accept || "").includes("application/x-ndjson");
      const controller = new AbortController();
      const cancel = () => controller.abort();
      const deadline = setTimeout(cancel, 180000);
      res.once("close", cancel);
      const emit = (event) => {
        if (streaming && !res.destroyed) res.write(JSON.stringify(event) + "\n");
      };
      if (streaming) {
        res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
        emit({ type: "start", total: files.length });
      }
      const heartbeat = streaming ? setInterval(() => emit({ type: "heartbeat" }), 10000) : null;

      try {
        for (const file of files) {
          if (res.destroyed) break;
          try {
            if (controller.signal.aborted) throw Object.assign(new Error("Se agoto el tiempo del lote. Reintenta solo los archivos pendientes."), { status: 504 });
            emit({ type: "progress", filename: file.filename, current: results.length + errors.length + 1, total: files.length });
            const extracted = await extractStatementData(file, { signal: controller.signal });
            if (res.destroyed) break;
            db = readDb();
            if (!currentUser(req, db)) throw Object.assign(new Error("Tu sesion termino. Inicia sesion de nuevo."), { status: 401 });
            const card = findOrCreateCard(db, user, extracted, fallbackCardId);
            const needsReview = !extracted.dueDate || !extracted.noInterestAmount || !extracted.totalAmount;
            const reviewNotes = [
              extracted.notes,
              needsReview ? "Revision necesaria: faltan datos importantes extraidos automaticamente." : "",
              `Confianza IA: ${Math.round((extracted.confidence || 0) * 100)}%`,
            ]
              .filter(Boolean)
              .join(" ");
            const statement = {
              id: id("statement"),
              cardId: card.id,
              uploadedBy: user.id,
              period: extracted.period || "Periodo por revisar",
              dueDate: extracted.dueDate || "",
              minPayment: extracted.minPayment || 0,
              noInterestAmount: extracted.noInterestAmount || 0,
              totalAmount: extracted.totalAmount || 0,
              notes: sanitizeText(reviewNotes, 500),
              status: needsReview ? "pendiente" : "pendiente",
              needsReview,
              extractedAt: new Date().toISOString(),
              extractionConfidence: extracted.confidence,
              file: saveUploadedFile(file),
              createdAt: new Date().toISOString(),
            };
            db.statements.push(statement);
            writeDb(db);
            results.push({ statement, card, extracted, needsReview });
            emit({ type: "result", result: results.at(-1) });
          } catch (error) {
            errors.push({ filename: file.filename, error: error.status ? error.message : "No se pudo procesar este archivo.", status: error.status || 500 });
            emit({ type: "file-error", ...errors.at(-1) });
          }
        }

        if (res.destroyed) return;
        if (streaming) {
          emit({ type: "done", saved: results.length, failed: errors.length });
          return res.end();
        }
        if (!results.length) return sendJson(res, errors[0].status, { error: errors[0].error, errors });
        return sendJson(res, 201, { results, errors });
      } finally {
        clearTimeout(deadline);
        clearInterval(heartbeat);
        res.removeListener("close", cancel);
      }
    }

    const statementMatch = /^\/api\/statements\/([^/]+)$/.exec(pathname);
    if (statementMatch) {
      let statement = groupStatements(db, user).find((item) => item.id === statementMatch[1]);
      if (!statement) return sendJson(res, 404, { error: "Estado de cuenta no encontrado." });
      if (req.method === "PUT") {
        const body = await readJson(req);
        db = readDb();
        if (!requireUser(req, res, db)) return;
        statement = groupStatements(db, user).find((item) => item.id === statementMatch[1]);
        if (!statement) return sendJson(res, 404, { error: "Estado de cuenta no encontrado." });
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

function createServer() {
  ensureStorage();
  return http.createServer((req, res) => {
    const { pathname } = new URL(req.url, `http://${req.headers.host}`);
    if (pathname.startsWith("/api/")) return handleApi(req, res, pathname);
    return serveStatic(req, res, decodeURIComponent(pathname));
  });
}

if (require.main === module) createServer().listen(PORT, HOST, () => {
    console.log(`App disponible en http://${HOST}:${PORT}`);
  });

module.exports = { createServer, readZipEntries, collectAutoFiles, verifyPassword, extractStatementData };
