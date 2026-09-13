const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createStorage, validateDb } = require("../storage");

async function migrate(dbPath, uploadsPath, storage = createStorage()) {
  if (!dbPath || !uploadsPath) throw new Error("Uso: npm run storage:migrate -- ruta/db.json ruta/uploads");
  if (storage.backend !== "supabase") throw new Error("Configura Supabase en el entorno del comando antes de migrar.");
  const source = validateDb(JSON.parse(fs.readFileSync(path.resolve(dbPath), "utf8")));
  const sourceUploads = path.resolve(uploadsPath);
  const files = new Map();
  // Verify every referenced file before writing anything to Supabase.
  for (const statement of source.statements) {
    const name = statement.file?.storedName;
    if (!name || !/^[a-zA-Z0-9_-]+\.(png|jpe?g|pdf)$/i.test(name)) throw new Error("El respaldo contiene una referencia de archivo invalida.");
    const filePath = path.join(sourceUploads, name);
    const size = fs.statSync(filePath).size;
    if (size > 12 * 1024 * 1024) throw new Error("Un archivo del respaldo supera el limite de 12 MB.");
    files.set(name, { filePath, contentType: statement.file.contentType });
  }
  await storage.check();
  const destination = await storage.readDb();
  if (destination.users.length || destination.cards.length || destination.statements.length ||
      Object.keys(destination.sessions).length || destination.passwordResets.length) {
    throw new Error("La base de destino ya tiene datos. No se sobrescribio nada.");
  }
  for (const [name, file] of files) {
    file.storedName = `file_${crypto.randomBytes(10).toString("hex")}${path.extname(name).toLowerCase()}`;
    await storage.saveFile(file.storedName, fs.readFileSync(file.filePath), file.contentType);
  }
  for (const statement of source.statements) statement.file.storedName = files.get(statement.file.storedName).storedName;
  // Keep account IDs and password hashes; old sessions and reset codes must expire.
  Object.assign(destination, source, { sessions: {}, passwordResets: [] });
  await storage.writeDb(destination);
  return { users: source.users.length, cards: source.cards.length, statements: source.statements.length, files: files.size };
}

if (require.main === module) migrate(...process.argv.slice(2)).then(result => {
  console.log("Migracion completada:", JSON.stringify(result));
}).catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { migrate };
