const state = {
  user: null,
  cards: [],
  statements: [],
};

const $ = (selector) => document.querySelector(selector);
const money = (value) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(Number(value || 0));
const amountLabel = value => value === null || value === undefined ? "No identificado" : money(value);
const requiresReview = statement => Boolean(statement.needsReview || (statement.extractedAt && !statement.reviewedAt));
const PERIOD_MONTHS = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
const PERIOD_YEARS = Array.from({ length: 101 }, (_, index) => 2000 + index);
const PERIOD_CARD_NAMES = ["banamex", "bancoppel", "banorte", "BBVA", "bradescard", "didi", "falabella", "juzt", "klar", "Liverpool", "nova", "nu", "otro", "plata", "stori", "uala"];

function currentPeriod(now = new Date()) {
  return { month: PERIOD_MONTHS[now.getMonth()], year: String(now.getFullYear()) };
}

function availablePeriodCardNames() {
  const names = [...PERIOD_CARD_NAMES, ...state.cards.map((card) => card.periodOptionName).filter(Boolean)];
  return [...new Map(names.map((name) => [name.toLowerCase(), name])).values()]
    .sort((left, right) => left.localeCompare(right, "es", { sensitivity: "base" }));
}

function selectOptions(values, selected, placeholder) {
  return `<option value="">${placeholder}</option>` + values
    .map((value) => `<option value="${escapeHtml(value)}" ${String(value) === String(selected) ? "selected" : ""}>${escapeHtml(value)}</option>`)
    .join("");
}

function periodParts(value) {
  const text = String(value || "");
  const normalized = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const month = PERIOD_MONTHS.find((item) => normalized.includes(item.toLowerCase()));
  const year = text.match(/\b(?:19|20|21)\d{2}\b/)?.[0] || "";
  const suffix = month && year ? `${month} ${year}`.toLowerCase() : "";
  const cardName = suffix && text.toLowerCase().endsWith(suffix) ? text.slice(0, -suffix.length).trim() : "";
  return { cardName, month: month || "", year };
}

function buildPeriod(cardName, month, year) {
  return cardName && month && year ? `${cardName} ${month} ${year}` : "";
}

function syncPeriod(form) {
  const selectedCardName = form.querySelector('[name="cardName"]')?.value;
  const cardName = selectedCardName === "otro" ? form.querySelector('[name="otherCardName"]')?.value.trim() : selectedCardName;
  const month = form.querySelector('[name="periodMonth"]')?.value;
  const year = form.querySelector('[name="periodYear"]')?.value;
  const period = buildPeriod(cardName, month, year);
  const target = form.querySelector('[name="period"]');
  if (target) target.value = period;
  return Boolean(period);
}

function toggleOtherCardField(form) {
  const isOther = form.querySelector('[name="cardName"]')?.value === "otro";
  const field = form.querySelector(".other-card-field");
  const input = form.querySelector('[name="otherCardName"]');
  field?.classList.toggle("hidden", !isOther);
  if (input) input.required = isOther;
}

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

function cardOverviewEntries() {
  const requestedSort = $("#overviewSort")?.value;
  const sortBy = ["minPayment", "noInterestAmount", "totalAmount"].includes(requestedSort) ? requestedSort : "minPayment";
  const entries = state.statements.map((statement) => ({
    card: cardById(statement.cardId) || { id: statement.cardId, cardName: "Tarjeta", bankName: "Banco", color: "ink" },
    statement,
  }));
  const cardsWithStatements = new Set(state.statements.map((statement) => statement.cardId));
  for (const card of state.cards) {
    if (!cardsWithStatements.has(card.id)) entries.push({ card, statement: null });
  }
  return entries.sort((left, right) => {
    const leftAmount = left.statement?.[sortBy];
    const rightAmount = right.statement?.[sortBy];
    const leftMissing = leftAmount === null || leftAmount === undefined;
    const rightMissing = rightAmount === null || rightAmount === undefined;
    if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;
    if (!leftMissing && Number(leftAmount) !== Number(rightAmount)) return Number(leftAmount) - Number(rightAmount);
    return String(left.card.bankName || "").localeCompare(String(right.card.bankName || ""), "es") ||
      String(left.card.cardName || "").localeCompare(String(right.card.cardName || ""), "es") ||
      String(left.statement?.period || "").localeCompare(String(right.statement?.period || ""), "es");
  });
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

  const overviewEntries = cardOverviewEntries();
  const pendingReview = state.statements.filter((item) => item.status !== "pagado" && requiresReview(item));
  const activeStatements = state.statements.filter((item) => item.status !== "pagado" && !requiresReview(item));
  $("#summaryNoInterest").textContent = money(activeStatements.reduce((sum, item) => sum + item.noInterestAmount, 0));
  $("#summaryMinimum").textContent = money(activeStatements.reduce((sum, item) => sum + item.minPayment, 0));
  $("#summaryTotal").textContent = money(activeStatements.reduce((sum, item) => sum + item.totalAmount, 0));
  $("#summaryCards").textContent = overviewEntries.length;
  $("#summaryReview").textContent = pendingReview.length
    ? `${pendingReview.length} archivo(s) por revisar. Sus importes aun no se incluyen en estos totales. Abre Revisar y confirmar en Pagos registrados.`
    : "Totales de pagos pendientes, programados y parciales con importes confirmados.";

  $("#cardSelect").innerHTML = selectOptions(availablePeriodCardNames(), "", "Selecciona la tarjeta");
  const todayPeriod = currentPeriod();
  const periodMonthSelect = $("#periodMonth");
  const periodYearSelect = $("#periodYear");
  periodMonthSelect.innerHTML = selectOptions(PERIOD_MONTHS, todayPeriod.month, "Selecciona el mes");
  periodYearSelect.innerHTML = selectOptions(PERIOD_YEARS, todayPeriod.year, "Selecciona el año");
  periodMonthSelect.value = todayPeriod.month;
  periodYearSelect.value = todayPeriod.year;
  $("#autoCardSelect").innerHTML =
    `<option value="">Detectar o crear tarjeta</option>` +
    state.cards.map((card) => `<option value="${card.id}">${escapeHtml(card.bankName)} - ${escapeHtml(card.cardName)}</option>`).join("");

  $("#cardsList").innerHTML = overviewEntries.length
    ? overviewEntries
        .map(
          ({ card, statement }) => {
            const review = statement && requiresReview(statement);
            const statusLabel = statement ? ({ pendiente: "Pendiente", programado: "Programado", parcial: "Parcial", pagado: "Pagado" }[statement.status] || "Pendiente") : "Sin registro";
            return `
            <article class="credit-card ${card.color}">
              <div class="credit-card-heading">
                <strong>${escapeHtml(card.cardName)}</strong>
                <span>${escapeHtml(card.bankName)}</span>
              </div>
              <div class="credit-card-payment">
                <div>
                  <span>Periodo</span>
                  <strong>${statement ? escapeHtml(statement.period || "Sin periodo") : "Sin estado de cuenta"}</strong>
                </div>
                <div>
                  <span>Pago mínimo</span>
                  <strong>${statement ? amountLabel(statement.minPayment) : "—"}</strong>
                </div>
                <div>
                  <span>Para no generar intereses</span>
                  <strong>${statement ? amountLabel(statement.noInterestAmount) : "—"}</strong>
                </div>
                <div>
                  <span>Monto total</span>
                  <strong>${statement ? amountLabel(statement.totalAmount) : "—"}</strong>
                </div>
                <div class="credit-card-due-date">
                  <span>Fecha límite de pago</span>
                  <strong>${statement ? escapeHtml(statement.dueDate || "No identificada") : "—"}</strong>
                </div>
                <div class="credit-card-payment-status ${statement?.status === "parcial" ? "" : "full"}">
                  <span>Estado</span>
                  <strong>${statusLabel}</strong>
                </div>
                ${statement?.status === "parcial" ? `<div>
                  <span>Monto abonado</span>
                  <strong>${amountLabel(statement.partialPaymentAmount)}</strong>
                </div>` : ""}
              </div>
              ${review ? '<span class="credit-card-review">Por revisar</span>' : ""}
              <div class="credit-card-meta">
                <span>${card.lastFour ? `**** ${escapeHtml(card.lastFour)}` : "Sin digitos"}</span>
                <span>${escapeHtml(ownerName(card.ownerId))}</span>
              </div>
            </article>
          `;
          }
        )
        .join("")
    : `<div class="empty">Agrega tu primera tarjeta para ver aquí su periodo y pago mínimo.</div>`;

  const status = $("#statusFilter").value;
  const records = state.statements
    .filter((item) => status === "todos" || item.status === status)
    .sort(compareRecords);

  // Keep an open correction form intact when another file finishes extraction.
  const openReviews = [...document.querySelectorAll("#recordsList .record-review[open]")];
  const focused = document.activeElement;
  $("#recordsList").innerHTML = records.length
    ? records.map(renderRecord).join("")
    : `<div class="empty">Todavia no hay estados de cuenta con este filtro.</div>`;
  for (const details of openReviews) {
    const id = details.querySelector("form").dataset.review;
    const replacement = document.querySelector(`#recordsList form[data-review="${id}"]`)?.closest("details");
    if (replacement) replacement.replaceWith(details);
    if (replacement && focused && details.contains(focused)) focused.focus();
  }
}

function renderRecord(statement) {
  const card = cardById(statement.cardId) || { cardName: "Tarjeta", bankName: "Banco" };
  const review = requiresReview(statement);
  return `
    <article class="record">
      <div class="record-title">
        <strong>${escapeHtml(card.bankName)} - ${escapeHtml(card.cardName)}</strong>
        <span>${escapeHtml(statement.period)} - vence ${escapeHtml(statement.dueDate || "sin fecha")} - subio ${escapeHtml(ownerName(statement.uploadedBy))}</span>
        ${review ? '<span class="review-badge">Por revisar · fuera del resumen</span>' : ""}
      </div>
      <div class="metric">
        <span>Minimo</span>
        <strong>${amountLabel(statement.minPayment)}</strong>
      </div>
      <div class="metric">
        <span>No intereses</span>
        <strong>${amountLabel(statement.noInterestAmount)}</strong>
      </div>
      <div class="metric">
        <span>Total</span>
        <strong>${amountLabel(statement.totalAmount)}</strong>
      </div>
      <div class="record-actions">
        <select data-status="${statement.id}" aria-label="Estado de pago">
          ${["pendiente", "programado", "parcial", "pagado"].map((item) => `<option value="${item}" ${item === statement.status ? "selected" : ""}>${item}</option>`).join("")}
        </select>
        <form class="partial-payment-form ${statement.status === "parcial" ? "" : "hidden"}" data-partial-payment="${statement.id}">
          <label>
            <span>Monto abonado</span>
            <input name="partialPaymentAmount" type="number" min="0.01" max="1000000000000" step="0.01" value="${statement.partialPaymentAmount ?? ""}" placeholder="0.00" required />
          </label>
          <button type="submit">Guardar monto</button>
        </form>
        <a href="/api/files/${statement.file.id}" target="_blank" rel="noreferrer">Ver archivo</a>
      </div>
      ${renderReviewForm(statement, review)}
    </article>
  `;
}

function renderReviewForm(statement, review) {
  const fields = [["minPayment", "Pago minimo"], ["noInterestAmount", "Para no generar intereses"], ["totalAmount", "Monto total"]];
  const legacy = statement.extractedAt && !statement.reviewedAt && !statement.extractionEvidence;
  const { cardName: periodCardName, month, year } = periodParts(statement.period);
  const todayPeriod = currentPeriod();
  const currentCard = cardById(statement.cardId);
  const availableNames = availablePeriodCardNames();
  const selectedCardName = availableNames.find((name) => name.toLowerCase() === periodCardName.toLowerCase()) ||
    availableNames.find((name) => [currentCard?.periodOptionName, currentCard?.bankName, currentCard?.cardName].some((value) => String(value || "").toLowerCase() === name.toLowerCase())) || "";
  return `<details class="record-review">
    <summary>${review ? "Revisar y confirmar" : "Corregir importes"}</summary>
    <p>Compara cada importe con el archivo. Un campo vacio significa que falta identificarlo. Si no aparece el pago minimo, consulta la seccion de pagos de tu banco o el estado de cuenta.</p>
    ${legacy ? '<p class="review-badge">Lectura anterior: los ceros pudieron sustituir datos faltantes. Verifica todos los importes.</p>' : ""}
    ${statement.file.contentType?.startsWith("image/") ? `<a href="/api/files/${statement.file.id}" target="_blank" rel="noreferrer"><img class="statement-preview" src="/api/files/${statement.file.id}" loading="lazy" alt="Captura original para comprobar los importes" /></a>` : ""}
    <form class="statement-form review-form" data-review="${statement.id}">
      <fieldset class="period-fields full">
        <legend>Periodo</legend>
        <div class="period-selects">
          <label>Tarjeta<select name="cardName" required>${selectOptions(availableNames, selectedCardName, "Selecciona la tarjeta")}</select></label>
          <label>Mes<select name="periodMonth" required>${selectOptions(PERIOD_MONTHS, month || todayPeriod.month, "Selecciona el mes")}</select></label>
          <label>Año<select name="periodYear" required>${selectOptions(PERIOD_YEARS, year || todayPeriod.year, "Selecciona el año")}</select></label>
          <label class="other-card-field hidden">Nombre de la otra tarjeta<input name="otherCardName" maxlength="80" placeholder="Escribe el nombre" /></label>
        </div>
        <input name="period" type="hidden" value="${escapeHtml(statement.period === "Periodo por revisar" ? "" : statement.period)}" />
      </fieldset>
      <label>Fecha limite de pago<input name="dueDate" type="date" value="${escapeHtml(statement.dueDate)}" required /></label>
      ${fields.map(([field, label]) => `<label>${label}<input name="${field}" type="number" min="0" max="1000000000000" step="0.01" value="${statement[field] ?? ""}" placeholder="No identificado" required />${statement.extractionEvidence?.[field] ? `<small>Texto leido: ${escapeHtml(statement.extractionEvidence[field])}</small>` : ""}</label>`).join("")}
      <button class="primary-btn full" type="submit">Confirmar importes</button>
      <p class="form-message full" data-review-message role="status"></p>
    </form>
  </details>`;
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

function hideRegisterPassword() {
  $("#showRegisterPassword").checked = false;
  $("#registerPassword").type = "password";
}

$("#showRegisterPassword").addEventListener("change", (event) => {
  $("#registerPassword").type = event.currentTarget.checked ? "text" : "password";
});

$("#registerForm").addEventListener("reset", hideRegisterPassword);

document.querySelectorAll("[data-auth-tab]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-auth-tab]").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    const tab = button.dataset.authTab;
    $("#loginForm").classList.toggle("hidden", tab !== "login");
    $("#registerForm").classList.toggle("hidden", tab !== "register");
    $("#resetForm").classList.toggle("hidden", tab !== "reset");
    hideRegisterPassword();
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
  if (!syncPeriod(formElement)) {
    setMessage($("#appMessage"), "Selecciona la tarjeta, el mes y el año del periodo.");
    return;
  }
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

$("#statementForm").addEventListener("change", (event) => {
  if (["cardName", "periodMonth", "periodYear", "otherCardName"].includes(event.target.name)) {
    toggleOtherCardField(event.currentTarget);
    syncPeriod(event.currentTarget);
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
    const message = extractionSummary(results, errors);
    setMessage($("#autoProgress"), message, !errors.length);
    setMessage($("#appMessage"), message, !errors.length);
  } catch (error) {
    const message = `${error.message} Se recibieron ${results.length} resultados. Revisa el resumen antes de reintentar para evitar duplicados.`;
    setMessage($("#autoProgress"), message);
    setMessage($("#appMessage"), message);
  } finally {
    clearInterval(elapsed);
    button.disabled = false;
    button.textContent = "Extraer para revisar";
  }
});

function extractionSummary(results, errors) {
  const groups = new Map();
  for (const item of errors) {
    const names = groups.get(item.error) || [];
    names.push(item.filename);
    groups.set(item.error, names);
  }
  const skipped = errors.filter(item => item.notAttempted).length;
  const details = [...groups].map(([message, names]) => `${message} Archivos pendientes: ${names.join(", ")}.`).join(" ");
  return `Se recibieron ${results.length} archivo(s) para revisar. Confirma sus importes en Pagos registrados para incluirlos en el resumen.` + (errors.length
    ? ` Quedaron ${errors.length} sin procesar.${skipped ? ` Se detuvo el lote y no se enviaron ${skipped} archivo(s) restantes al servicio.` : ""} ${details}` : "");
}

function renderAutoResult(item) {
  const statement = item.statement;
  const card = item.card;
  const review = requiresReview(statement) ? " · por revisar" : "";
  return `
    <div class="auto-result">
      <strong>${escapeHtml(card.bankName)} - ${escapeHtml(card.cardName)}</strong>
      <span>${escapeHtml(statement.file.originalName)} - ${escapeHtml(statement.dueDate || "sin fecha")}${review}</span>
      <span>Minimo: ${amountLabel(statement.minPayment)} · Para no intereses: ${amountLabel(statement.noInterestAmount)} · Total: ${amountLabel(statement.totalAmount)}</span>
    </div>
  `;
}

$("#recordsList").addEventListener("submit", async (event) => {
  const partialForm = event.target.closest("form[data-partial-payment]");
  if (partialForm) {
    event.preventDefault();
    const button = partialForm.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const result = await api(`/api/statements/${partialForm.dataset.partialPayment}`, {
        method: "PUT",
        body: JSON.stringify({ status: "parcial", partialPaymentAmount: new FormData(partialForm).get("partialPaymentAmount") }),
      });
      const index = state.statements.findIndex(item => item.id === result.statement.id);
      if (index !== -1) state.statements[index] = result.statement;
      render();
      setMessage($("#appMessage"), "Pago parcial guardado.", true);
    } catch (error) {
      setMessage($("#appMessage"), error.message);
      button.disabled = false;
    }
    return;
  }
  const form = event.target.closest("form[data-review]");
  if (!form) return;
  event.preventDefault();
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  const message = form.querySelector("[data-review-message]");
  if (!syncPeriod(form)) {
    button.disabled = false;
    setMessage(message, "Selecciona la tarjeta, el mes y el año del periodo.");
    return;
  }
  try {
    const result = await api(`/api/statements/${form.dataset.review}`, {
      method: "PUT", body: JSON.stringify({ ...Object.fromEntries(new FormData(form)), review: true }),
    });
    const index = state.statements.findIndex(item => item.id === result.statement.id);
    if (index !== -1) state.statements[index] = result.statement;
    form.closest("details").open = false;
    render();
    setMessage($("#appMessage"), "Importes confirmados. El resumen esta actualizado.", true);
  } catch (error) {
    setMessage(message, error.message);
  } finally {
    button.disabled = false;
  }
});

$("#recordsList").addEventListener("change", async (event) => {
  if (["cardName", "periodMonth", "periodYear", "otherCardName"].includes(event.target.name)) {
    const reviewForm = event.target.closest("form[data-review]");
    if (reviewForm) {
      toggleOtherCardField(reviewForm);
      syncPeriod(reviewForm);
    }
    return;
  }
  const id = event.target.dataset.status;
  if (!id) return;
  if (event.target.value === "parcial") {
    const partialForm = event.target.closest(".record-actions").querySelector("[data-partial-payment]");
    partialForm.classList.remove("hidden");
    partialForm.querySelector('input[name="partialPaymentAmount"]').focus();
    return;
  }
  try {
    await api(`/api/statements/${id}`, { method: "PUT", body: JSON.stringify({ status: event.target.value }) });
    await loadApp();
  } catch (error) {
    setMessage($("#appMessage"), error.message);
  }
});

$("#statusFilter").addEventListener("change", render);
$("#sortRecords").addEventListener("change", render);
$("#overviewSort").addEventListener("change", render);

loadApp();
