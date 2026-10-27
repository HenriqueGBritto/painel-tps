/* Aba Requisições: envio dos PDFs de requisição de estiva do OGMO e a conferência pela instrução de trabalho.
   "Buscar no OGMO" aciona o robô para ler o dia ou período escolhido; o DA9 aparece nas requisições já escaladas.
   Dados de /api/requisicoes (netlify/functions/requisicoes.mjs). Expõe window.requisitionsPanel = { show(open) }. */
(function () {
  const $ = id => document.getElementById(id);
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const S = window.TpsShifts;
  const state = { sync: null, rows: [], holidays: [], customHolidays: false, canEditHolidays: false, started: false, busy: false, open: new Set(), editingHolidays: false, search: null, polling: null, upcoming: [], alertTimer: null };
  const RESULT = {
    reprovado: { label: "Reprovada", css: "is-error" }, confirmar: { label: "Confirmar", css: "is-warn" },
    aprovado: { label: "Aprovada", css: "is-ok" }, cancelada: { label: "Cancelada", css: "is-off" }, informativo: { label: "Vigia", css: "is-off" }, "aprovado-justificado": { label: "Justificada", css: "is-ok" }
  };
  const brDate = iso => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
  const period = value => String(value || "").replace("-", "x");
  const when = value => value ? new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)).replace(",", " às") : "";

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

  /* ---------- Lista (tabela compacta: uma linha por requisição; abre só o que precisa corrigir) ---------- */

  /** Problemas da conferência, juntando o mesmo problema em vários ternos ("Ternos 1 e 2: CMG no lugar do CMP"). */
  function problems(row) {
    const groups = new Map();
    for (const item of row.check.items.filter(entry => entry.level !== "ok")) {
      const match = /^Terno (\d+)(?: \([^)]*\))?: (.*)$/.exec(item.text);
      const text = match ? match[2] : item.text;
      const key = `${item.level}|${text}`;
      if (!groups.has(key)) groups.set(key, { level: item.level, text, ternos: [] });
      if (match) groups.get(key).ternos.push(match[1]);
    }
    const order = { erro: 0, confirmar: 1 };
    return [...groups.values()].sort((a, b) => order[a.level] - order[b.level]).map(group => ({
      level: group.level,
      text: group.ternos.length ? `${group.ternos.length > 1 ? `Ternos ${group.ternos.slice(0, -1).join(", ")} e ${group.ternos.at(-1)}` : `Terno ${group.ternos[0]}`}: ${group.text}` : group.text
    }));
  }

  function detailsHtml(row) {
    const ok = row.check.items.filter(item => item.level === "ok");
    const history = row.history?.length ? `<p><strong>Envios anteriores:</strong> ${row.history.map(item => `${when(item.at)} por ${escapeHtml(item.by?.name || "—")} (${escapeHtml(RESULT[item.status]?.label || item.status)}, <a href="/api/requisicoes/pdf?id=${encodeURIComponent(row.id)}&versao=${encodeURIComponent(item.fileKey.split("/").pop().replace(".pdf", ""))}" target="_blank" rel="noopener">PDF</a>)`).join(" · ")}</p>` : "";
    return `<details class="req-more"><summary>Ver detalhes</summary>
      <p>${escapeHtml([row.local, `${row.ternos.length} ${row.ternos.length === 1 ? "terno" : "ternos"}`, row.check.operation.title].join(" · "))}. Enviada por ${escapeHtml(row.uploadedBy?.name || "—")} em ${when(row.uploadedAt)}.</p>
      ${ok.length ? `<ul class="req-oklist">${ok.map(item => `<li>${escapeHtml(item.text)}</li>`).join("")}</ul>` : ""}
      <div class="base-table-scroll"><table class="base-table req-ternos"><thead><tr><th>Terno</th><th>Faina</th><th>Observação</th><th>Funções</th></tr></thead><tbody>${row.ternos.map(terno => `<tr><td>${terno.equipe}</td><td>${escapeHtml(terno.fainas.map(f => f.code).join(", ") || "—")}</td><td>${escapeHtml(terno.observation || "—")}</td><td>${terno.functions.filter(f => f.vagas).map(f => `${escapeHtml(f.code)} ${f.vagas}`).join(" · ")}</td></tr>`).join("")}</tbody></table></div>
      ${history}
    </details>`;
  }

  /** Por que o DA9 (trabalhadores escalados) ainda não está no painel. */
  function da9Missing(row) {
    if (row.cancelled) return "Requisição cancelada no OGMO: não tem DA9.";
    if (row.ogmo?.scaled) return "DA9 ainda não disponível. A requisição já foi escalada; o robô baixa o DA9 na próxima rodada (de hora em hora) ou em uma busca no OGMO deste dia.";
    if (row.source !== "ogmo") return "DA9 ainda não disponível. Ele é baixado pelo robô do OGMO depois que o OGMO escala a requisição.";
    return "DA9 ainda não disponível. O OGMO só gera o DA9 depois de escalar os trabalhadores; o robô baixa sozinho na rodada seguinte à escala.";
  }

  function rowHtml(row) {
    const result = RESULT[row.status];
    const v = row.vessel;
    const name = v.kind === "balsa" ? `Balsa ${escapeHtml(v.name)}${v.attachedTo ? ` <small>(at. ${escapeHtml(v.attachedTo)})</small>` : ""}` : escapeHtml(v.raw);
    const list = problems(row);
    const override = row.override ? `<p class="req-note">Aprovada com justificativa por <strong>${escapeHtml(row.override.by?.name)}</strong> em ${when(row.override.at)}: ${escapeHtml(row.override.reason)}</p>` : "";
    const activity = row.activity?.done ? `<p class="req-note">Atividade do turno marcada como feita (${escapeHtml(S.label(row.activity.shiftId))}), com o PDF anexado.</p>` : "";
    const canApprove = row.status === "reprovado" || row.status === "confirmar";
    const origin = row.source === "ogmo" ? `<p class="req-note">Lida automaticamente no OGMO${row.ogmo?.scaled ? " · já escalada" : ""}${row.cancelled ? ` · cancelada no OGMO em ${when(row.cancelledAt)}` : ""}.</p>` : row.cancelled ? `<p class="req-note">Cancelada no OGMO em ${when(row.cancelledAt)}.</p>` : "";
    return `<details class="req-row is-${row.status}" data-toggle="${escapeHtml(row.id)}"${state.open.has(row.id) ? " open" : ""}>
      <summary class="req-line"><span class="req-badge ${result.css}">${escapeHtml(result.label)}</span><span class="req-period">${period(row.period)}</span><span class="req-ship">${name}</span><span class="req-number">${escapeHtml(row.number.replace(/-1$/, ""))}</span><span class="req-chevron" aria-hidden="true"></span></summary>
      <div class="req-open">
        ${list.length ? `<ul class="req-problems">${list.map(item => `<li class="is-${item.level}">${escapeHtml(item.text)}</li>`).join("")}</ul>` : `<p class="req-allok">Tudo conforme a instrução de trabalho.</p>`}
        ${override}${activity}${origin}
        <div class="req-links"><a href="/api/requisicoes/pdf?id=${encodeURIComponent(row.id)}" target="_blank" rel="noopener">Abrir PDF</a>${row.da9 ? `<a href="/api/requisicoes/da9?id=${encodeURIComponent(row.id)}" target="_blank" rel="noopener">Abrir DA9</a>` : `<button type="button" class="act-link" data-action="da9-missing" data-id="${escapeHtml(row.id)}">Abrir DA9</button>`}${canApprove ? `<button type="button" class="act-link" data-action="approve" data-id="${escapeHtml(row.id)}">Aprovar com justificativa</button>` : ""}</div>
        ${row.da9 ? "" : `<p class="req-da9-missing" data-da9-note="${escapeHtml(row.id)}" role="status" hidden>${da9Missing(row)}</p>`}
        ${canApprove ? `<form class="req-inline" data-form="aprovar" data-id="${escapeHtml(row.id)}" hidden><label>Motivo da aprovação<textarea name="reason" rows="2" maxlength="1000" required placeholder="CMG pedido pelo especialista para esta operação."></textarea></label><button type="submit" class="act-button is-primary">Aprovar</button></form>` : ""}
        ${detailsHtml(row)}
      </div>
    </details>`;
  }

  /** Verificação automática no OGMO: última rodada, erro e o que falta pedir antes do limite. */
  function renderSync() {
    const box = $("requisitionsSync");
    const sync = state.sync;
    if (!sync) { box.hidden = true; return; }
    const nowLocal = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date()).replace(" ", "T");
    const missing = (sync.missing || []).filter(item => item.deadline > nowLocal);
    const failed = sync.error && Date.parse(sync.errorAt || 0) > Date.parse(sync.lastRunAt || 0);
    const stale = sync.lastRunAt && Date.now() - Date.parse(sync.lastRunAt) > 150 * 60000;
    box.hidden = false;
    box.className = `req-sync${missing.length || failed ? " is-alert" : stale ? " is-warn" : ""}`;
    box.innerHTML = `<p class="req-sync-line"><strong>Verificação automática no OGMO</strong> · ${sync.lastRunAt ? `última em ${when(sync.lastRunAt)}: ${sync.active} ${sync.active === 1 ? "ativa" : "ativas"}, ${sync.cancelled} ${sync.cancelled === 1 ? "cancelada" : "canceladas"}` : "ainda sem rodada completa"}${stale ? " · <span>parada há mais de 2 horas</span>" : ""}</p>
      ${failed ? `<p class="req-sync-error">A última tentativa falhou (${when(sync.errorAt)}): ${escapeHtml(sync.error)}</p>` : ""}
      ${missing.length ? `<ul class="req-missing">${missing.map(item => `<li><strong>${escapeHtml(item.vessel)}</strong>: falta a requisição do ${period(item.period)} de ${brDate(item.date).slice(0, 5)} · limite ${item.deadline.slice(11, 16)} <small>(${escapeHtml(item.reason)})</small></li>`).join("")}</ul>` : ""}`;
  }

  /** Próximos períodos (limites nas próximas 24 h) e o que ainda falta pedir em cada um. */
  function renderUpcoming() {
    const box = $("requisitionsUpcoming");
    const items = (state.upcoming || []).filter(item => deadlineAt(item) > Date.now());
    if (!items.length) { box.hidden = true; return; }
    const missingCount = items.filter(item => item.missing.length).length;
    box.hidden = false;
    box.className = `req-upcoming${missingCount ? " is-alert" : ""}`;
    box.innerHTML = `<p class="req-up-title"><strong>Próximos períodos</strong> · ${missingCount ? `${missingCount} ${missingCount === 1 ? "período com requisição faltando" : "períodos com requisição faltando"}` : "tudo pedido até agora"}${alertsOn() ? "" : " · <span>ative os alertas para ser avisado antes do limite</span>"}</p>
      <ul class="req-up-list">${items.map(item => `<li class="${item.missing.length ? "is-missing" : item.requested ? "is-ok" : "is-none"}">
        <span class="req-up-period">${period(item.period)} <small>${S.WEEKDAYS[S.weekday(item.date)]} ${brDate(item.date).slice(0, 5)}</small></span>
        <span class="req-up-deadline">limite ${item.deadline.slice(11, 16)} <small>${left(item)}</small></span>
        <span class="req-up-status">${item.missing.length
          ? `Falta pedir: ${item.missing.map(miss => `<strong>${escapeHtml(miss.vessel)}</strong> <small>(${escapeHtml(miss.reason)})</small>`).join(", ")}`
          : item.requested ? `${item.requested} ${item.requested === 1 ? "requisição pedida" : "requisições pedidas"}` : "Nenhuma requisição (nenhum navio em operação)"}</span>
      </li>`).join("")}</ul>`;
  }

  function render() {
    renderSync();
    renderUpcoming();
    const filter = $("requisitionsResult").value;
    const rows = state.rows.filter(row => !filter || (filter === "aprovado" ? row.status.startsWith("aprovado") : row.status === filter)).sort((a, b) => ["cancelada", "informativo"].includes(a.status) - ["cancelada", "informativo"].includes(b.status));
    const counts = Object.fromEntries(["reprovado", "confirmar", "aprovado"].map(key => [key, state.rows.filter(row => key === "aprovado" ? row.status.startsWith("aprovado") : row.status === key).length]));
    $("requisitionsSummary").innerHTML = state.rows.length
      ? `<span class="req-badge is-error">${counts.reprovado} reprovada${counts.reprovado === 1 ? "" : "s"}</span><span class="req-badge is-warn">${counts.confirmar} para confirmar</span><span class="req-badge is-ok">${counts.aprovado} aprovada${counts.aprovado === 1 ? "" : "s"}</span>`
      : "";
    const byDay = new Map();
    rows.forEach(row => { if (!byDay.has(row.date)) byDay.set(row.date, []); byDay.get(row.date).push(row); });
    $("requisitionsList").innerHTML = rows.length
      ? `<div class="req-table"><div class="req-line req-header" aria-hidden="true"><span>Situação</span><span>Período</span><span>Navio</span><span class="req-number">Requisição</span><span></span></div>
        ${[...byDay].map(([date, list]) => `<div class="req-day">${S.WEEKDAYS[S.weekday(date)]} ${brDate(date).slice(0, 5)}</div>${list.map(rowHtml).join("")}`).join("")}</div>`
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

  /** Período na tela: em "Um dia", De e Até são o mesmo dia. */
  function range() {
    const from = $("requisitionsFrom").value;
    return { from, to: $("requisitionsMode").value === "dia" ? from : $("requisitionsTo").value };
  }

  function setMode() {
    const day = $("requisitionsMode").value === "dia";
    if (day) $("requisitionsFrom").value = S.zonedParts(new Date()).date; // começa em hoje
    $("requisitionsToLabel").style.display = day ? "none" : "";
    $("requisitionsTo").required = !day;
    $("requisitionsFromText").textContent = day ? "Dia" : "De";
  }

  /* ---------- Alertas no computador: requisição faltando perto do limite do OGMO ---------- */

  const ALERT_KEY = "tps-requisicoes-alertas", SENT_KEY = "tps-requisicoes-alertas-enviados";
  const REFRESH_MS = 5 * 60000, CHECK_MS = 60000;
  const storage = {
    get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* navegador sem armazenamento: alerta só nesta sessão */ } }
  };
  const deadlineAt = item => Date.parse(`${item.deadline}-03:00`);
  function left(item) {
    const minutes = Math.round((deadlineAt(item) - Date.now()) / 60000);
    return minutes < 60 ? `em ${minutes} min` : `em ${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
  }
  const notificationsSupported = () => "Notification" in window;
  const alertsOn = () => notificationsSupported() && Notification.permission === "granted" && storage.get(ALERT_KEY) === true;

  function renderAlertButton() {
    const button = $("requisitionsAlerts");
    if (!button) return;
    const on = alertsOn();
    button.textContent = on ? "Alertas ligados" : "Ativar alertas";
    button.classList.toggle("is-on", on);
    button.setAttribute("aria-pressed", String(on));
    button.title = on ? "Clique para desligar os alertas neste computador" : "Avisar no computador 1 hora e 30 minutos antes do limite quando faltar requisição";
  }

  async function toggleAlerts() {
    if (!notificationsSupported()) { announce("Este navegador não mostra notificações.", true); return; }
    if (alertsOn()) { storage.set(ALERT_KEY, false); stopAlerts(); renderAlertButton(); renderUpcoming(); announce("Alertas de requisição desligados neste computador."); return; }
    const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (permission !== "granted") { announce("O navegador bloqueou as notificações. Libere em Configurações do site (cadeado ao lado do endereço).", true); renderAlertButton(); return; }
    storage.set(ALERT_KEY, true);
    renderAlertButton();
    renderUpcoming();
    startAlerts();
    announce("Alertas ligados: o painel avisa 1 hora e 30 minutos antes do limite quando faltar requisição. Funciona com o painel aberto em alguma aba.");
  }

  /** Registra o alerta como enviado; devolve false se outra aba já enviou. */
  function claim(key) {
    const sent = storage.get(SENT_KEY) || {};
    if (sent[key]) return false;
    const cutoff = Date.now() - 3 * 86400000;
    for (const [old, at] of Object.entries(sent)) if (at < cutoff) delete sent[old];
    sent[key] = Date.now();
    storage.set(SENT_KEY, sent);
    return true;
  }

  function checkAlerts() {
    if (!alertsOn()) return;
    const now = Date.now();
    for (const item of state.upcoming || []) {
      const minutes = (deadlineAt(item) - now) / 60000;
      if (!item.missing.length || minutes <= 0 || minutes > 60) continue;
      const stage = minutes <= 30 ? 30 : 60;
      if (!claim(`${item.date}|${item.period}|${stage}`)) continue;
      try {
        const notification = new Notification(`Falta requisição do ${period(item.period)} · limite ${item.deadline.slice(11, 16)}`, {
          body: `${item.missing.map(miss => miss.vessel).join(", ")}
${S.WEEKDAYS[S.weekday(item.date)]} ${brDate(item.date).slice(0, 5)} · faltam ${Math.round(minutes)} min`,
          tag: `requisicao-${item.date}-${item.period}`, requireInteraction: true, icon: "/favicon.svg"
        });
        notification.onclick = () => { window.focus(); window.openRequisitions?.(); notification.close(); };
      } catch { /* alguns navegadores só notificam via service worker; a lista na aba continua valendo */ }
    }
    if (state.started) renderUpcoming();
  }

  async function refreshUpcoming() {
    try { state.upcoming = (await api("/proximos")).upcoming || []; }
    catch { /* sem login ou sem acesso: tenta de novo na próxima volta */ }
    checkAlerts();
  }

  function startAlerts() {
    stopAlerts();
    if (!alertsOn()) return;
    let ticks = 0;
    const tick = () => { (ticks++ % (REFRESH_MS / CHECK_MS) === 0 ? refreshUpcoming() : Promise.resolve(checkAlerts())).finally(() => { state.alertTimer = setTimeout(tick, CHECK_MS); }); };
    tick();
  }
  function stopAlerts() { clearTimeout(state.alertTimer); state.alertTimer = null; }

  /* ---------- Busca no OGMO sob demanda ---------- */

  function renderSearch() {
    const box = $("requisitionsSearchStatus"), search = state.search;
    const running = search && ["enviada", "lendo"].includes(search.status);
    $("requisitionsSearch").disabled = Boolean(running);
    if (!search) { box.hidden = true; return; }
    const days = search.de === search.ate ? brDate(search.de) : `${brDate(search.de).slice(0, 5)} a ${brDate(search.ate)}`;
    box.hidden = false;
    box.className = `req-search${search.status === "falhou" ? " is-error" : running ? " is-busy" : " is-ok"}`;
    box.textContent = search.status === "enviada" ? `Robô do OGMO acionado para ${days}. Ele leva cerca de 1 minuto para começar; a lista se atualiza sozinha.`
      : search.status === "lendo" ? `Lendo o OGMO (${days})…${search.totalDays > 1 ? ` ${search.days} de ${search.totalDays} dias prontos, ${search.active} requisições ativas até agora.` : ""}`
      : search.status === "concluida" ? `Busca no OGMO concluída (${days}) em ${when(search.finishedAt)}: ${search.active} ativas, ${search.cancelled} canceladas.`
      : `A busca no OGMO (${days}) falhou: ${search.error || "sem detalhe"}`;
  }

  function follow(search) {
    state.search = search;
    renderSearch();
    clearTimeout(state.polling);
    if (!search || !["enviada", "lendo"].includes(search.status)) return;
    state.polling = setTimeout(async () => {
      try {
        const next = await api(`/buscar?id=${encodeURIComponent(search.id)}`);
        const progressed = next.status !== search.status || next.days !== search.days;
        follow({ ...search, ...next });
        // Cada dia lido já aparece na lista, se estiver no período da tela.
        if (progressed && next.status !== "falhou" && !(next.ate < range().from || next.de > range().to)) await load({ quiet: true, keepSearch: true });
      } catch { follow(search); }
    }, 5000);
  }

  async function requestSearch() {
    const { from, to } = range();
    if (!from || !to) { announce("Escolha o dia ou o período para buscar no OGMO.", true); return; }
    $("requisitionsSearch").disabled = true;
    try { follow(await api("/buscar", { de: from, ate: to })); announce(""); }
    catch (error) { announce(error.message, true); renderSearch(); }
  }

  async function load({ quiet = false, keepSearch = false } = {}) {
    const { from, to } = range();
    if (!quiet) announce("Carregando…");
    try {
      const data = await api(`?de=${from}&ate=${to}`);
      state.rows = data.requisitions;
      state.sync = data.sync || null;
      state.holidays = data.holidays;
      state.customHolidays = data.custom;
      state.canEditHolidays = data.canEditHolidays;
      state.upcoming = data.upcoming || [];
      if (!keepSearch && data.search && (!state.search || state.search.id !== data.search.id || !state.polling)) follow(data.search);
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
    if (button.dataset.action === "da9-missing") { const note = $("requisitionsList").querySelector(`[data-da9-note="${CSS.escape(button.dataset.id)}"]`); if (note) note.hidden = false; }
    if (button.dataset.action === "approve") { const form = $("requisitionsList").querySelector(`form[data-form="aprovar"][data-id="${CSS.escape(button.dataset.id)}"]`); if (form) { form.hidden = false; form.querySelector("textarea").focus(); } }
  }

  function setup() {
    const today = S.zonedParts(new Date()).date;
    $("requisitionsFrom").value = S.addDays(today, -6);
    $("requisitionsTo").value = S.addDays(today, 1);
    $("requisitionsFilters").addEventListener("submit", event => { event.preventDefault(); load(); });
    $("requisitionsMode").addEventListener("change", () => { setMode(); load(); });
    $("requisitionsSearch").addEventListener("click", requestSearch);
    $("requisitionsAlerts").addEventListener("click", toggleAlerts);
    renderAlertButton();
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
    if (!open) { clearTimeout(state.polling); state.polling = null; return; }
    if (!state.started) { state.started = true; setup(); }
    load();
  }

  window.requisitionsPanel = { show };
  // Alertas ligados neste computador: conferem em segundo plano, com o painel aberto em qualquer aba.
  if (alertsOn()) setTimeout(startAlerts, 3000);
})();
