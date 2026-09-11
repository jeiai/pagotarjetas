const state = {
  user: null,
  cards: [],
  statements: [],
};

const $ = (selector) => document.querySelector(selector);
const money = (value) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(Number(value || 0));

async function api(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.body instanceof FormData ? 120000 : 30000);
  try {
    const response = await fetch(path, {
      credentials: "include",
      ...options,
      signal: controller.signal,
      headers: options.body instanceof FormData ? options.headers : { "Content-Type": "application/json", ...(options.headers || {}) },
    });
    const contentType = response.headers.get("content-type") || "";
    const data = contentType.includes("application/json") ? await response.json() : {};
    if (!response.ok) throw Object.assign(new Error(data.error || `No se pudo completar la accion (HTTP ${response.status}). Intenta de nuevo.`), { status: response.status });
    if (!contentType.includes("application/json")) throw new Error("El servidor no devolvio una respuesta valida. Intenta de nuevo en unos momentos.");
    return data;
  } catch (error) {
    if (controller.signal.aborted) throw new Error("El servidor tardo demasiado en responder. Intenta de nuevo.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function extractFiles(form, onEvent) {
  const controller = new AbortController();
  let idleTimer;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), 90000);
  };
  resetIdle();
  const deadline = setTimeout(() => controller.abort(), 240000);
  let reader;
  try {
    const response = await fetch("/api/statements/auto", {
      method: "POST", body: form, credentials: "include",
      headers: { Accept: "application/x-ndjson" }, signal: controller.signal,
    });
    const type = response.headers.get("content-type") || "";
    if (!type.includes("application/x-ndjson")) {
      const data = type.includes("application/json") ? await response.json() : {};
      if (!response.ok) throw new Error(data.error || `No se pudo procesar el envio (HTTP ${response.status}).`);
      if (!Array.isArray(data.results)) throw new Error("El servidor no devolvio una respuesta valida.");
      data.results.forEach(result => onEvent({ type: "result", result }));
      (data.errors || []).forEach(error => onEvent({ type: "file-error", ...error }));
      return;
    }
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", finished = false;
    const consume = (line) => {
      if (!line.trim()) return;
      const event = JSON.parse(line);
      if (event.type === "done") finished = true;
      onEvent(event);
    };
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      resetIdle();
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        consume(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
    }
    buffer += decoder.decode();
    consume(buffer);
    if (!finished) throw new Error("Se interrumpio la conexion antes de terminar el lote.");
  } catch (error) {
    const timedOut = controller.signal.aborted;
    controller.abort();
    throw new Error(timedOut ? "El servidor dejo de responder. Revisa los pagos guardados antes de volver a subir archivos." : error.message);
  } finally {
    reader?.releaseLock();
    clearTimeout(idleTimer);
    clearTimeout(deadline);
  }
}

function setMessage(target, message, ok = false) {
  target.textContent = message || "";
  target.style.color = ok ? "#147a6f" : "#a04444";
}

function cardById(id) {
  return state.cards.find((card) => card.id === id);
}

function ownerName(userId) {
  return userId === state.user?.id ? state.user.name : "Usuario";
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

  const activeStatements = state.statements.filter((item) => item.status !== "pagado");
  $("#summaryNoInterest").textContent = money(activeStatements.reduce((sum, item) => sum + item.noInterestAmount, 0));
  $("#summaryMinimum").textContent = money(activeStatements.reduce((sum, item) => sum + item.minPayment, 0));
  $("#summaryTotal").textContent = money(activeStatements.reduce((sum, item) => sum + item.totalAmount, 0));
  $("#summaryCards").textContent = state.cards.length;

  $("#cardSelect").innerHTML = state.cards.length
    ? state.cards.map((card) => `<option value="${card.id}">${escapeHtml(card.bankName)} - ${escapeHtml(card.cardName)}</option>`).join("")
    : `<option value="">Primero agrega una tarjeta</option>`;
  $("#autoCardSelect").innerHTML =
    `<option value="">Detectar o crear tarjeta</option>` +
    state.cards.map((card) => `<option value="${card.id}">${escapeHtml(card.bankName)} - ${escapeHtml(card.cardName)}</option>`).join("");

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
        <span>${escapeHtml(statement.period)} - vence ${escapeHtml(statement.dueDate || "sin fecha")} - subio ${escapeHtml(ownerName(statement.uploadedBy))}</span>
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
    const [cards, statements] = await Promise.all([api("/api/cards"), api("/api/statements")]);
    state.cards = cards.cards;
    state.statements = statements.statements;
  } catch (error) {
    if (error.status === 401) {
      state.user = null;
      state.cards = [];
      state.statements = [];
    }
    setMessage($(state.user ? "#appMessage" : "#authMessage"), error.status === 401 ? "Inicia sesion para continuar." : `No se pudo cargar el panel: ${error.message}`);
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
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const button = formElement.querySelector('button[type="submit"]');
  button.disabled = true;
  button.textContent = "Entrando...";
  try {
    const result = await api("/api/login", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) });
    state.user = result.user;
    setMessage($("#authMessage"), "");
    formElement.reset();
    await loadApp();
  } catch (error) {
    setMessage($("#authMessage"), error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Entrar";
  }
});

$("#registerForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  try {
    await api("/api/register", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) });
    setMessage($("#authMessage"), "");
    formElement.reset();
    await loadApp();
  } catch (error) {
    setMessage($("#authMessage"), error.message);
  }
});

$("#resetForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  try {
    await api("/api/reset-password", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) });
    setMessage($("#authMessage"), "");
    formElement.reset();
    await loadApp();
  } catch (error) {
    setMessage($("#authMessage"), error.message);
  }
});

$("#requestResetCode").addEventListener("click", async () => {
  const button = $("#requestResetCode");
  const email = new FormData($("#resetForm")).get("email");
  button.disabled = true;
  button.textContent = "Enviando...";
  try {
    const result = await api("/api/request-password-reset", { method: "POST", body: JSON.stringify({ email }) });
    setMessage($("#authMessage"), result.message || "Codigo enviado.", true);
  } catch (error) {
    setMessage($("#authMessage"), error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Enviar codigo temporal";
  }
});

$("#logoutBtn").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST", body: "{}" });
  state.user = null;
  render();
});

$("#cardForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  try {
    await api("/api/cards", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) });
    formElement.reset();
    setMessage($("#appMessage"), "Tarjeta agregada.", true);
    await loadApp();
  } catch (error) {
    setMessage($("#appMessage"), error.message);
  }
});

$("#statementForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  try {
    await api("/api/statements", { method: "POST", body: form });
    formElement.reset();
    setMessage($("#appMessage"), "Estado de cuenta guardado.", true);
    await loadApp();
  } catch (error) {
    setMessage($("#appMessage"), error.message);
  }
});

$("#autoStatementForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const fileInput = formElement.querySelector('input[name="documents"]');
  if (fileInput.files.length > 15) {
    setMessage($("#appMessage"), "Puedes subir maximo 15 archivos a la vez.");
    return;
  }
  const form = new FormData(formElement);
  const button = formElement.querySelector('button[type="submit"]');
  button.disabled = true;
  button.textContent = "Subiendo archivos...";
  setMessage($("#autoProgress"), "Subiendo archivos. El analisis comenzara al terminar la carga.", true);
  $("#autoResults").innerHTML = "";
  const results = [], errors = [];
  const started = Date.now();
  const elapsed = setInterval(() => {
    button.textContent = `Procesando... ${Math.floor((Date.now() - started) / 1000)} s`;
  }, 1000);
  try {
    await extractFiles(form, (event) => {
      if (event.type === "progress") setMessage($("#autoProgress"), `Leyendo ${event.current} de ${event.total}: ${event.filename}.`, true);
      if (event.type === "result") {
        results.push(event.result);
        $("#autoResults").innerHTML = results.map(renderAutoResult).join("");
        const { card, statement } = event.result;
        if (!state.cards.some(item => item.id === card.id)) state.cards.push(card);
        if (!state.statements.some(item => item.id === statement.id)) state.statements.push(statement);
        render();
      }
      if (event.type === "file-error") errors.push(event);
    });
    formElement.reset();
    const message = `Se guardaron ${results.length} archivo(s).` + (errors.length ? ` Fallaron ${errors.length}: ${errors.map(item => `${item.filename}: ${item.error}`).join("; ")}. Reintenta solo los archivos fallidos.` : "");
    setMessage($("#autoProgress"), message, !errors.length);
    setMessage($("#appMessage"), message, !errors.length);
  } catch (error) {
    const message = `${error.message} Se recibieron ${results.length} resultados. Revisa el resumen antes de reintentar para evitar duplicados.`;
    setMessage($("#autoProgress"), message);
    setMessage($("#appMessage"), message);
  } finally {
    clearInterval(elapsed);
    button.disabled = false;
    button.textContent = "Extraer y guardar";
  }
});

function renderAutoResult(item) {
  const statement = item.statement;
  const card = item.card;
  const review = item.needsReview ? " · revisar datos faltantes" : "";
  return `
    <div class="auto-result">
      <strong>${escapeHtml(card.bankName)} - ${escapeHtml(card.cardName)}</strong>
      <span>${escapeHtml(statement.file.originalName)} - ${escapeHtml(statement.dueDate || "sin fecha")} - ${money(statement.noInterestAmount)} para no intereses${review}</span>
    </div>
  `;
}

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

loadApp();
