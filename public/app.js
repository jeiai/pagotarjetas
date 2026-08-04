const state = {
  user: null,
  cards: [],
  statements: [],
  members: [],
};

const $ = (selector) => document.querySelector(selector);
const money = (value) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(Number(value || 0));

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "include",
    ...options,
    headers: options.body instanceof FormData ? options.headers : { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json() : {};
  if (!response.ok) throw new Error(data.error || "No se pudo completar la accion.");
  return data;
}

function setMessage(target, message, ok = false) {
  target.textContent = message || "";
  target.style.color = ok ? "#147a6f" : "#a04444";
}

function cardById(id) {
  return state.cards.find((card) => card.id === id);
}

function ownerName(userId) {
  return state.members.find((member) => member.id === userId)?.name || "Familia";
}

function render() {
  if (!state.user) {
    $("#authView").classList.remove("hidden");
    $("#dashboardView").classList.add("hidden");
    return;
  }

  $("#authView").classList.add("hidden");
  $("#dashboardView").classList.remove("hidden");
  $("#userName").textContent = state.user.name;
  $("#familyCode").textContent = state.user.familyCode;
  $("#familyCodeCopy").textContent = state.user.familyCode;

  const activeStatements = state.statements.filter((item) => item.status !== "pagado");
  $("#summaryNoInterest").textContent = money(activeStatements.reduce((sum, item) => sum + item.noInterestAmount, 0));
  $("#summaryMinimum").textContent = money(activeStatements.reduce((sum, item) => sum + item.minPayment, 0));
  $("#summaryTotal").textContent = money(activeStatements.reduce((sum, item) => sum + item.totalAmount, 0));

  $("#cardSelect").innerHTML = state.cards.length
    ? state.cards.map((card) => `<option value="${card.id}">${escapeHtml(card.bankName)} - ${escapeHtml(card.cardName)}</option>`).join("")
    : `<option value="">Primero agrega una tarjeta</option>`;

  $("#cardsList").innerHTML = state.cards.length
    ? state.cards
        .map(
          (card) => `
            <article class="credit-card ${card.color}">
              <div>
                <strong>${escapeHtml(card.cardName)}</strong>
                <span>${escapeHtml(card.bankName)}</span>
              </div>
              <div>
                <span>${card.lastFour ? `**** ${escapeHtml(card.lastFour)}` : "Sin digitos"}</span>
                <span>${escapeHtml(ownerName(card.ownerId))}</span>
              </div>
            </article>
          `
        )
        .join("")
    : `<div class="empty">Agrega tu primera tarjeta para empezar a subir estados de cuenta.</div>`;

  const status = $("#statusFilter").value;
  const records = state.statements
    .filter((item) => status === "todos" || item.status === status)
    .sort(compareRecords);

  $("#recordsList").innerHTML = records.length
    ? records.map(renderRecord).join("")
    : `<div class="empty">Todavia no hay estados de cuenta con este filtro.</div>`;
}

function renderRecord(statement) {
  const card = cardById(statement.cardId) || { cardName: "Tarjeta", bankName: "Banco" };
  return `
    <article class="record">
      <div class="record-title">
        <strong>${escapeHtml(card.bankName)} - ${escapeHtml(card.cardName)}</strong>
        <span>${escapeHtml(statement.period)} · vence ${escapeHtml(statement.dueDate)} · subio ${escapeHtml(ownerName(statement.uploadedBy))}</span>
      </div>
      <div class="metric">
        <span>Minimo</span>
        <strong>${money(statement.minPayment)}</strong>
      </div>
      <div class="metric">
        <span>No intereses</span>
        <strong>${money(statement.noInterestAmount)}</strong>
      </div>
      <div class="metric">
        <span>Total</span>
        <strong>${money(statement.totalAmount)}</strong>
      </div>
      <div class="record-actions">
        <select data-status="${statement.id}" aria-label="Estado de pago">
          ${["pendiente", "programado", "pagado"].map((item) => `<option value="${item}" ${item === statement.status ? "selected" : ""}>${item}</option>`).join("")}
        </select>
        <a href="/api/files/${statement.file.id}" target="_blank" rel="noreferrer">Ver archivo</a>
      </div>
    </article>
  `;
}

function compareRecords(a, b) {
  const sortBy = $("#sortRecords").value;
  if (sortBy === "dueDate") {
    return a.dueDate.localeCompare(b.dueDate) || a.totalAmount - b.totalAmount;
  }
  return Number(a[sortBy] || 0) - Number(b[sortBy] || 0) || a.dueDate.localeCompare(b.dueDate);
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function loadApp() {
  try {
    const me = await api("/api/me");
    state.user = me.user;
    state.members = me.members;
    const [cards, statements] = await Promise.all([api("/api/cards"), api("/api/statements")]);
    state.cards = cards.cards;
    state.statements = statements.statements;
  } catch {
    state.user = null;
  }
  render();
}

document.querySelectorAll("[data-auth-tab]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-auth-tab]").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    const tab = button.dataset.authTab;
    $("#loginForm").classList.toggle("hidden", tab !== "login");
    $("#registerForm").classList.toggle("hidden", tab !== "register");
    $("#resetForm").classList.toggle("hidden", tab !== "reset");
    setMessage($("#authMessage"), "");
  });
});

$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    await api("/api/login", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) });
    setMessage($("#authMessage"), "");
    event.currentTarget.reset();
    await loadApp();
  } catch (error) {
    setMessage($("#authMessage"), error.message);
  }
});

$("#registerForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    await api("/api/register", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) });
    setMessage($("#authMessage"), "");
    event.currentTarget.reset();
    await loadApp();
  } catch (error) {
    setMessage($("#authMessage"), error.message);
  }
});

$("#resetForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    await api("/api/reset-password", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) });
    setMessage($("#authMessage"), "");
    event.currentTarget.reset();
    await loadApp();
  } catch (error) {
    setMessage($("#authMessage"), error.message);
  }
});

$("#logoutBtn").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST", body: "{}" });
  state.user = null;
  render();
});

$("#cardForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    await api("/api/cards", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) });
    event.currentTarget.reset();
    setMessage($("#appMessage"), "Tarjeta agregada.", true);
    await loadApp();
  } catch (error) {
    setMessage($("#appMessage"), error.message);
  }
});

$("#statementForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    await api("/api/statements", { method: "POST", body: form });
    event.currentTarget.reset();
    setMessage($("#appMessage"), "Estado de cuenta guardado.", true);
    await loadApp();
  } catch (error) {
    setMessage($("#appMessage"), error.message);
  }
});

$("#recordsList").addEventListener("change", async (event) => {
  const id = event.target.dataset.status;
  if (!id) return;
  try {
    await api(`/api/statements/${id}`, { method: "PUT", body: JSON.stringify({ status: event.target.value }) });
    await loadApp();
  } catch (error) {
    setMessage($("#appMessage"), error.message);
  }
});

$("#statusFilter").addEventListener("change", render);
$("#sortRecords").addEventListener("change", render);

$("#copyFamilyCode").addEventListener("click", async () => {
  await navigator.clipboard.writeText(state.user.familyCode);
  setMessage($("#appMessage"), "Codigo familiar copiado.", true);
});

loadApp();
