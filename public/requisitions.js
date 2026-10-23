/* Aba Requisições: envio dos PDFs de requisição de estiva do OGMO e a conferência pela instrução de trabalho.
   Dados de /api/requisicoes (netlify/functions/requisicoes.mjs). Expõe window.requisitionsPanel = { show(open) }. */
(function () {
  const $ = id => document.getElementById(id);
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const S = window.TpsShifts;
  const state = { rows: [], holidays: [], customHolidays: false, canEditHolidays: false, started: false, busy: false, open: new Set(), editingHolidays: false };
  const RESULT = {
    reprovado: { label: "Reprovada", css: "is-error" }, confirmar: { label: "Confirmar", css: "is-warn" },
    aprovado: { label: "Aprovada", css: "is-ok" }, "aprovado-justificado": { label: "Aprovada com justificativa", css: "is-ok" }
  };
  const brDate = iso => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
  const period = value => String(value || "").replace("-", "x");
  const when = value => value ? new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)).replace(",", " às") : "";
  const localWhen = local => local ? `${local.slice(8, 10)}/${local.slice(5, 7)} às ${local.slice(11, 16)}` : "";

  async function api(path, body) {
    const response = await fetch(`/api/requisicoes${path}`, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Não foi possível falar com o servidor.");
    return data;
  }
  function announce(text, isError = false) {
    const box = $("requisitionsStatus");
    box.textContent = text;
    box.classList.toggle("is-error", isError);
  }

  /* ---------- Envio ---------- */

  async function upload(files) {
    const pdfs = [...files].filter(file => file.type === "application/pdf" || /\.pdf$/i.test(file.name));
    if (!pdfs.length) { announce("Escolha o PDF da requisição.", true); return; }
    const results = [];
    for (const [index, file] of pdfs.entries()) {
      announce(`Conferindo ${pdfs.length > 1 ? `${index + 1} de ${pdfs.length}: ` : ""}${file.name}…`);
      try {
        const response = await fetch("/api/requisicoes/enviar", { method: "POST", body: file, headers: { "Content-Type": "application/pdf", "X-Arquivo": encodeURIComponent(file.name) } });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Não foi possível enviar.");
        results.push(`${data.number} (${period(data.period)} de ${brDate(data.date).slice(0, 5)}): ${RESULT[data.status].label.toLowerCase()}${data.replaced ? ", substituiu o envio anterior" : ""}`);
        state.open.add(data.id);
        // Mostra o dia da requisição enviada, se estiver fora do filtro.
        if (data.date < $("requisitionsFrom").value) $("requisitionsFrom").value = data.date;
        if (data.date > $("requisitionsTo").value) $("requisitionsTo").value = data.date;
      } catch (error) {
        results.push(`${file.name}: ${error.message}`);
      }
    }
    await load({ quiet: true });
    announce(results.join(" · "), results.some(text => /Não |inválid|grande|Envie/.test(text)));
  }

  /* ---------- Lista ---------- */

  function itemsHtml(row) {
    const order = { erro: 0, confirmar: 1, ok: 2 };
    const items = [...row.check.items].sort((a, b) => order[a.level] - order[b.level]);
    const shown = items.filter(item => item.level !== "ok");
    const ok = items.filter(item => item.level === "ok");
    const line = item => `<li class="req-item is-${item.level}"><span class="req-mark" aria-hidden="true">${item.level === "erro" ? "✖" : item.level === "confirmar" ? "!" : "✔"}</span><span>${escapeHtml(item.text)}${item.ref ? ` <small>IT ${escapeHtml(item.ref)}</small>` : ""}</span></li>`;
    return `${shown.length ? `<ul class="req-items">${shown.map(line).join("")}</ul>` : `<p class="req-allok">Tudo conforme a instrução de trabalho.</p>`}
      ${ok.length ? `<details class="req-ok"><summary>Ver os ${ok.length} itens conferidos sem problema</summary><ul class="req-items">${ok.map(line).join("")}</ul></details>` : ""}`;
  }

  function ternosHtml(row) {
    return `<details class="req-ternos"><summary>Composição lida do PDF (${row.ternos.length} ${row.ternos.length === 1 ? "terno" : "ternos"})</summary><div class="base-table-scroll"><table class="base-table"><thead><tr><th>Terno</th><th>Faina</th><th>Observação</th><th>Funções</th></tr></thead><tbody>${row.ternos.map(terno => `<tr><td>${terno.equipe}</td><td>${escapeHtml(terno.fainas.map(f => f.code).join(", ") || "—")}</td><td>${escapeHtml(terno.observation || "—")}</td><td>${terno.functions.map(f => `${escapeHtml(f.code)} ${f.vagas ?? "?"}`).join(" · ")}</td></tr>`).join("")}</tbody></table></div></details>`;
  }

  function actionsHtml(row) {
    const parts = [];
    if (row.check.items.some(item => item.action === "informar-hora") && !row.override) {
      parts.push(`<form class="req-inline" data-form="hora" data-id="${escapeHtml(row.id)}"><label>Hora em que o pedido foi feito<input type="datetime-local" name="at" required value="${escapeHtml(row.requestedAt?.at?.slice(0, 16) || "")}"></label><button type="submit" class="act-button">Salvar hora</button></form>`);
    }
    if (row.status === "reprovado" || row.status === "confirmar") {
      parts.push(`<details class="req-approve"><summary class="act-button">Aprovar com justificativa</summary><form class="req-inline" data-form="aprovar" data-id="${escapeHtml(row.id)}"><label>Motivo<textarea name="reason" rows="2" maxlength="1000" required placeholder="Ex.: CMG pedido pelo especialista para esta operação."></textarea></label><button type="submit" class="act-button is-primary">Aprovar</button></form></details>`);
    }
    return parts.length ? `<div class="req-actions">${parts.join("")}</div>` : "";
  }

  function rowHtml(row) {
    const result = RESULT[row.status];
    const vessel = row.vessel.raw;
    const meta = [`${brDate(row.date)} · ${period(row.period)}`, row.local, `${row.ternos.length} ${row.ternos.length === 1 ? "terno" : "ternos"}`, row.check.operation.title].filter(Boolean).map(escapeHtml).join(" · ");
    const override = row.override ? `<p class="req-note">Aprovada com justificativa por <strong>${escapeHtml(row.override.by?.name)}</strong> em ${when(row.override.at)}: ${escapeHtml(row.override.reason)}</p>` : "";
    const activity = row.activity ? `<p class="req-note">${row.activity.done ? `Atividade do turno marcada como feita (${escapeHtml(S.label(row.activity.shiftId))}), com o PDF anexado.` : `Atividade do turno não foi marcada: ${escapeHtml(row.activity.reason || "")}.`}</p>` : "";
    const history = row.history?.length ? `<details class="req-history"><summary>Envios anteriores (${row.history.length})</summary><ul>${row.history.map(item => `<li>${when(item.at)} por ${escapeHtml(item.by?.name || "—")}: ${escapeHtml(RESULT[item.status]?.label || item.status)} · <a href="/api/requisicoes/pdf?id=${encodeURIComponent(row.id)}&versao=${encodeURIComponent(item.fileKey.split("/").pop().replace(".pdf", ""))}" target="_blank" rel="noopener">PDF</a></li>`).join("")}</ul></details>` : "";
    return `<article class="req-card" data-id="${escapeHtml(row.id)}">
      <details${state.open.has(row.id) || row.status === "reprovado" || row.status === "confirmar" ? " open" : ""} data-toggle="${escapeHtml(row.id)}">
        <summary class="req-head"><span class="req-badge ${result.css}">${escapeHtml(result.label)}</span><span class="req-title"><strong>${escapeHtml(vessel)}</strong><small>Requisição ${escapeHtml(row.number)} · ${meta}</small></span></summary>
        <div class="req-body">
          <p class="req-sent">Enviada por ${escapeHtml(row.uploadedBy?.name || "—")} em ${when(row.uploadedAt)} · impressa em ${escapeHtml(localWhen(row.printedAt) || "—")}${row.requestedAt ? ` · pedido feito em ${escapeHtml(localWhen(row.requestedAt.at))} (informado por ${escapeHtml(row.requestedAt.by?.name || "—")})` : ""} · <a href="/api/requisicoes/pdf?id=${encodeURIComponent(row.id)}" target="_blank" rel="noopener">Abrir PDF</a></p>
          ${itemsHtml(row)}${override}${activity}${actionsHtml(row)}${ternosHtml(row)}${history}
        </div>
      </details>
    </article>`;
  }

  function render() {
    const filter = $("requisitionsResult").value;
    const rows = state.rows.filter(row => !filter || (filter === "aprovado" ? row.status.startsWith("aprovado") : row.status === filter));
    const counts = Object.fromEntries(["reprovado", "confirmar", "aprovado"].map(key => [key, state.rows.filter(row => key === "aprovado" ? row.status.startsWith("aprovado") : row.status === key).length]));
    $("requisitionsSummary").innerHTML = state.rows.length
      ? `<span class="req-badge is-error">${counts.reprovado} reprovada${counts.reprovado === 1 ? "" : "s"}</span><span class="req-badge is-warn">${counts.confirmar} para confirmar</span><span class="req-badge is-ok">${counts.aprovado} aprovada${counts.aprovado === 1 ? "" : "s"}</span>`
      : "";
    const byDay = new Map();
    rows.forEach(row => { if (!byDay.has(row.date)) byDay.set(row.date, []); byDay.get(row.date).push(row); });
    $("requisitionsList").innerHTML = rows.length
      ? [...byDay].map(([date, list]) => `<section class="req-day"><h3>${brDate(date)} · ${S.WEEKDAYS[S.weekday(date)]}</h3>${list.map(rowHtml).join("")}</section>`).join("")
      : `<p class="act-empty">${state.rows.length ? "Nenhuma requisição com esse resultado no período." : "Nenhuma requisição enviada no período."}</p>`;
    renderHolidays();
  }

  function renderHolidays() {
    const box = $("requisitionsHolidays");
    const year = $("requisitionsTo").value.slice(0, 4) || String(new Date().getFullYear());
    const list = state.holidays.filter(item => item.date.startsWith(year) || item.date.startsWith(String(Number(year) + 1)));
    const edit = state.editingHolidays;
    box.innerHTML = `<summary>Feriados (${list.length}) — capatazia própria não trabalha: 4 PE do OGMO</summary>
      <p class="act-muted">Em dia útil a requisição de ferro gusa atracado leva 2 PE (2 nossos + 2 do OGMO); em sábado, domingo e feriado, 4 PE.${state.customHolidays ? "" : " Lista inicial: nacionais, estado e cidade do Rio, Carnaval e Corpus Christi."}</p>
      ${edit
        ? `<form data-form="feriados" class="req-holiday-form"><textarea name="list" rows="12" aria-label="Feriados, um por linha: data e nome">${escapeHtml(state.holidays.map(item => `${brDate(item.date)} ${item.name}`).join("\n"))}</textarea><p class="act-muted">Um feriado por linha: dd/mm/aaaa e o nome.</p><div class="req-actions"><button type="submit" class="act-button is-primary">Salvar feriados</button><button type="button" class="act-link" data-action="cancel-holidays">Cancelar</button></div></form>`
        : `<ul class="req-holidays">${list.map(item => `<li><strong>${brDate(item.date).slice(0, 5)}</strong> ${S.WEEKDAYS[S.weekday(item.date)]} · ${escapeHtml(item.name)}</li>`).join("")}</ul>${state.canEditHolidays ? `<button type="button" class="act-button" data-action="edit-holidays">Editar feriados</button>` : ""}`}`;
  }

  async function load({ quiet = false } = {}) {
    const from = $("requisitionsFrom").value, to = $("requisitionsTo").value;
    if (!quiet) announce("Carregando…");
    try {
      const data = await api(`?de=${from}&ate=${to}`);
      state.rows = data.requisitions;
      state.holidays = data.holidays;
      state.customHolidays = data.custom;
      state.canEditHolidays = data.canEditHolidays;
      render();
      if (!quiet) announce("");
    } catch (error) {
      announce(error.message, true);
    }
  }

  async function act(run, success) {
    if (state.busy) return;
    state.busy = true;
    try { const row = await run(); if (row?.id) state.open.add(row.id); await load({ quiet: true }); announce(success); }
    catch (error) { announce(error.message, true); }
    finally { state.busy = false; }
  }

  function onSubmit(event) {
    const form = event.target.closest("form[data-form]");
    if (!form) return;
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    if (form.dataset.form === "hora") act(() => api("/hora", { id: form.dataset.id, at: data.at }), "Hora do pedido registrada e requisição conferida de novo.");
    if (form.dataset.form === "aprovar") act(() => api("/aprovar", { id: form.dataset.id, reason: data.reason }), "Requisição aprovada com justificativa.");
    if (form.dataset.form === "feriados") {
      const lines = String(data.list || "").split(/\n+/).map(line => line.trim()).filter(Boolean);
      const holidays = [];
      for (const line of lines) {
        const match = /^(\d{2})\/(\d{2})\/(\d{4})\s*[-–·]?\s*(.*)$/.exec(line);
        if (!match) { announce(`Linha inválida: "${line}". Use dd/mm/aaaa e o nome.`, true); return; }
        holidays.push({ date: `${match[3]}-${match[2]}-${match[1]}`, name: match[4] || "Feriado" });
      }
      act(async () => { await api("/feriados", { holidays }); state.editingHolidays = false; }, "Feriados salvos. Valem para as próximas conferências.");
    }
  }

  function onClick(event) {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    if (button.dataset.action === "edit-holidays") { state.editingHolidays = true; renderHolidays(); $("requisitionsHolidays").open = true; $("requisitionsHolidays").querySelector("textarea")?.focus(); }
    if (button.dataset.action === "cancel-holidays") { state.editingHolidays = false; renderHolidays(); }
  }

  function setup() {
    const today = S.zonedParts(new Date()).date;
    $("requisitionsFrom").value = S.addDays(today, -6);
    $("requisitionsTo").value = S.addDays(today, 1);
    $("requisitionsFilters").addEventListener("submit", event => { event.preventDefault(); load(); });
    $("requisitionsResult").addEventListener("change", render);
    $("requisitionsFile").addEventListener("change", event => { upload(event.target.files); event.target.value = ""; });
    const drop = $("requisitionsDrop");
    ["dragenter", "dragover"].forEach(type => drop.addEventListener(type, event => { event.preventDefault(); drop.classList.add("is-over"); }));
    ["dragleave", "drop"].forEach(type => drop.addEventListener(type, () => drop.classList.remove("is-over")));
    drop.addEventListener("drop", event => { event.preventDefault(); upload(event.dataTransfer.files); });
    $("requisitionsPanel").addEventListener("submit", onSubmit);
    $("requisitionsPanel").addEventListener("click", onClick);
    $("requisitionsList").addEventListener("toggle", event => { const id = event.target.dataset?.toggle; if (id) event.target.open ? state.open.add(id) : state.open.delete(id); }, true);
  }

  function show(open) {
    if (!open) return;
    if (!state.started) { state.started = true; setup(); }
    load();
  }

  window.requisitionsPanel = { show };
})();
