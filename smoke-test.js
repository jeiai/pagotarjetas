const fs = require("fs");
const os = require("os");
const path = require("path");

async function main() {
  const stamp = Date.now();
  const register = await fetch("http://127.0.0.1:4173/api/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Prueba Smoke",
      email: `smoke+${stamp}@example.com`,
      password: "prueba123",
    }),
  });
  if (!register.ok) throw new Error(await register.text());
  const cookie = register.headers.get("set-cookie").split(";")[0];

  const cardResponse = await fetch("http://127.0.0.1:4173/api/cards", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ cardName: "Oro", bankName: "Banco Demo", lastFour: "9999", color: "green" }),
  });
  if (!cardResponse.ok) throw new Error(await cardResponse.text());
  const { card } = await cardResponse.json();

  const filePath = path.join(os.tmpdir(), `estado-${stamp}.png`);
  fs.writeFileSync(
    filePath,
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64")
  );

  const form = new FormData();
  form.set("cardId", card.id);
  form.set("period", "Agosto 2026");
  form.set("dueDate", "2026-08-20");
  form.set("minPayment", "500");
  form.set("noInterestAmount", "3200.50");
  form.set("totalAmount", "4100.75");
  form.set("notes", "Prueba automatica");
  form.set("document", new Blob([fs.readFileSync(filePath)], { type: "image/png" }), "estado.png");

  const statement = await fetch("http://127.0.0.1:4173/api/statements", {
    method: "POST",
    headers: { Cookie: cookie },
    body: form,
  });
  if (!statement.ok) throw new Error(await statement.text());
  const data = await statement.json();
  console.log(`OK ${data.statement.period} ${data.statement.file.originalName}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
