/* Indicadores Operacional e Ocupação a partir da Base SOF (histórico 2025–2026 + SOFs enviados).
   Cálculos em sof-core.js (window.TpsSof); dados em /api/sof (netlify/functions/sof.mjs). */
(() => {
  const S = window.TpsSof;
  const MONTHS = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
  const MONTHS_FULL = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
  const STATUS_LABEL = { sof: "do SOF", auto: "automático", confirmar: "confirmar", nova: "nova" };
  const int = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
  const one = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const two = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const dateTime = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const state = { vessels: [], loaded: false, loading: null, view: "operacional", metric: "tons", stopResponsible: "", upload: null, dictionary: null };

  const fmtDate = iso => iso ? dateTime.format(new Date(iso)) : "—";
  const hours = daysValue => daysValue === null || daysValue === undefined ? "—" : `${int.format(Math.floor(daysValue * 24))}h ${String(Math.round(daysValue * 1440 % 60)).padStart(2, "0")}min`;
  const daysText = value => value === null || value === undefined ? "—" : `${one.format(value)} ${value >= 0.95 && value < 1.05 ? "dia" : "dias"}`;
  const rate = value => value === null || value === undefined ? "—" : `${int.format(value)} t/dia`;
  const pct = value => value === null || value === undefined || !Number.isFinite(value) ? "—" : `${one.format(value)}%`;
  const label = name => S.RESPONSIBLE_LABELS[name] || name;

  /* ---------- Dados ---------- */

  async function load(force = false) {
    if (state.loaded && !force) return;
    if (state.loading && !force) return state.loading;
    $("sofStatus").textContent = "Lendo a Base SOF…";
    state.loading = fetch("/api/sof").then(async response => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Não foi possível ler a Base SOF.");
      state.vessels = body.vessels;
      // Última data com SOF: o ano em andamento só é comparado (e a ocupação só é medida) até ela.
      state.lastData = Math.min(Date.now(), Math.max(0, ...body.vessels.map(v => Date.parse(v.operationEnd || "") || 0)));
      state.loaded = true;
      setupFilters();
      $("sofStatus").textContent = body.operationsAvailable ? "" : "Planilha de navios indisponível agora: desatracação e berço vêm só do SOF.";
      render();
    }).catch(error => { $("sofStatus").textContent = error.message; }).finally(() => { state.loading = null; });
    return state.loading;
  }

  /* ---------- Filtros ---------- */

  const unique = (key) => [...new Set(state.vessels.map(v => v[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR"));
  function fill(id, values, all, keep = true) {
    const node = $(id), current = node.value;
    node.innerHTML = `<option value="">${all}</option>${values.map(v => `<option value="${escape(v)}">${escape(v)}</option>`).join("")}`;
    if (keep && values.map(String).includes(current)) node.value = current;
  }
  function setupFilters() {
    const years = [...new Set(state.vessels.map(v => S.vesselMonth(v)?.year).filter(Boolean))].sort((a, b) => b - a);
    const first = !$("sofYear").options.length;
    fill("sofYear", years, "Todos os anos");
    if (first && years.length) $("sofYear").value = String(years[0]);
    if (first) $("sofMonth").innerHTML = `<option value="">Todos os meses</option>${MONTHS_FULL.map((m, i) => `<option value="${i + 1}">${m}</option>`).join("")}`;
    fill("sofCargo", unique("cargo"), "Todas as cargas");
    fill("sofOperation", unique("operation"), "Todas as operações");
    fill("sofBerth", unique("berth"), "Todos os berços");
    $("sofVesselList").innerHTML = [...new Set(state.vessels.map(v => v.vessel))].sort().map(v => `<option value="${escape(v)}"></option>`).join("");
  }
  function filterValue() {
    const year = Number($("sofYear").value) || null, month = Number($("sofMonth").value) || null;
    return { year, month, cargo: $("sofCargo").value, operation: $("sofOperation").value, berth: $("sofBerth").value, vessel: $("sofVessel").value.trim() };
  }
  const common = f => ({ cargo: f.cargo, operation: f.operation, berth: f.berth, vessel: f.vessel });
  const nowParts = () => { const d = new Date((state.lastData || Date.now()) - 3 * 3600000); return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 }; };
  /** Meses comparáveis: o mês escolhido ou, no ano do último SOF, de janeiro até o mês desse SOF. */
  function comparableMonths(f) {
    if (f.month) return new Set([f.month]);
    const now = nowParts();
    if (f.year === now.year) return new Set(Array.from({ length: now.month }, (_, i) => i + 1));
    return new Set();
  }
  function selection(f = filterValue()) {
    return S.filterVessels(state.vessels, { ...common(f), years: f.year ? new Set([f.year]) : new Set(), months: f.month ? new Set([f.month]) : new Set() });
  }
  function previousSelection(f) {
    if (!f.year) return null;
    return S.filterVessels(state.vessels, { ...common(f), years: new Set([f.year - 1]), months: comparableMonths(f) });
  }
  function occupancyOf(vessels, year, months) {
    const years = year ? [year] : [...new Set(state.vessels.map(v => S.vesselMonth(v)?.year).filter(Boolean))];
    return S.occupancyFor(vessels.filter(v => v.berth), years, months, state.lastData || Date.now());
  }

  /* ---------- Desenho ---------- */

  function delta(current, previous, f, { lowerIsBetter = false, points = false } = {}) {
    if (current === null || previous === null || current === undefined || previous === undefined || !f.year) return "";
    const diff = points ? current - previous : previous ? (current - previous) / previous * 100 : null;
    if (diff === null || !Number.isFinite(diff)) return "";
    const direction = Math.abs(diff) < 0.05 ? "flat" : diff > 0 ? "up" : "down";
    const good = direction === "flat" ? "" : (direction === "up") !== lowerIsBetter ? "good" : "bad";
    const arrow = direction === "up" ? "▲" : direction === "down" ? "▼" : "=";
    return `<small class="sof-delta ${good}">${arrow} ${one.format(Math.abs(diff))}${points ? " p.p." : "%"} vs. ${f.year - 1}${f.month ? "" : comparableMonths(f).size ? " (mesmo período)" : ""}</small>`;
  }
  const kpi = (title, value, note, extra = "") => `<article><span>${title}</span><strong>${value}</strong>${extra}<small>${note}</small></article>`;

  function render() {
    if (!state.loaded) return;
    const f = filterValue();
    const rows = selection(f), before = previousSelection(f);
    const t = S.totals(rows), p = before ? S.totals(before) : null;
    const months = f.month ? new Set([f.month]) : new Set();
    // Ocupação: todos os navios atracados na janela, mesmo os que começaram a operar antes dela.
    const berthed = S.filterVessels(state.vessels, common(f));
    const occ = occupancyOf(berthed, f.year, months), occPrev = f.year ? occupancyOf(berthed, f.year - 1, comparableMonths(f)) : null;
    const stoppedPct = x => x && x.operationDays ? x.stoppedDays / x.operationDays * 100 : null;
    $("sofSummary").textContent = `${int.format(rows.length)} ${rows.length === 1 ? "navio" : "navios"} · ${f.year || "todos os anos"}${f.month ? ` · ${MONTHS_FULL[f.month - 1].toLowerCase()}` : ""}${f.cargo ? ` · ${f.cargo}` : ""}${f.operation ? ` · ${f.operation.toLowerCase()}` : ""}${f.berth ? ` · ${f.berth}` : ""}`;
    if (state.view === "operacional") {
      $("sofKpis").innerHTML = [
        kpi("NAVIOS", int.format(t.vessels), "operações com SOF", delta(t.vessels, p?.vessels, f)),
        kpi("VOLUME", `${int.format(t.tons)} t`, "peso final dos SOFs", delta(t.tons, p?.tons, f)),
        kpi("PRANCHA BRUTA", rate(t.grossRate), "volume ÷ tempo de operação", delta(t.grossRate, p?.grossRate, f)),
        kpi("PRANCHA LÍQUIDA", rate(t.netRate), "volume ÷ tempo operando", delta(t.netRate, p?.netRate, f)),
        kpi("PRANCHA TRIUNFO", rate(t.triunfoRate), "volume ÷ (operando + terminal)", delta(t.triunfoRate, p?.triunfoRate, f)),
        kpi("TEMPO PARADO", pct(stoppedPct(t)), `${hours(t.stoppedDays)} sem operar`, delta(stoppedPct(t), stoppedPct(p), f, { lowerIsBetter: true, points: true }))
      ].join("");
    } else {
      $("sofKpis").innerHTML = [
        kpi("OCUPAÇÃO MÉDIA DE BERÇO", pct(occ.overall), "atracação → desatracação no período", delta(occ.overall, occPrev?.overall, f, { points: true })),
        kpi("TEMPO MÉDIO ATRACADO", daysText(t.averageBerthDays), "por navio", delta(t.averageBerthDays, p?.averageBerthDays, f, { lowerIsBetter: true })),
        kpi("ESPERA PARA INICIAR", hours(t.averageWaitDays), "atracação → início, média", delta(t.averageWaitDays, p?.averageWaitDays, f, { lowerIsBetter: true })),
        kpi("TEMPO MÉDIO DE OPERAÇÃO", daysText(t.averageOperationDays), "início → término", delta(t.averageOperationDays, p?.averageOperationDays, f, { lowerIsBetter: true })),
        kpi("NAVIOS", int.format(t.vessels), `${int.format(rows.filter(v => !v.berthEnd).length)} sem desatracação`, delta(t.vessels, p?.vessels, f))
      ].join("");
    }
    renderChart(f);
    renderResponsibles(t, p, f);
    renderStoppages(rows);
    renderCargo(rows);
    renderBerths(occ, occPrev, f);
    renderVessels(rows);
    document.querySelectorAll("#sof [data-sof-view]").forEach(node => { node.hidden = node.dataset.sofView !== state.view; });
  }

  const METRICS = {
    tons: { label: "Volume (t)", value: t => t.tons, format: v => `${int.format(v)} t` },
    vessels: { label: "Navios", value: t => t.vessels, format: v => int.format(v) },
    grossRate: { label: "Prancha bruta (t/dia)", value: t => t.grossRate, format: rate },
    netRate: { label: "Prancha líquida (t/dia)", value: t => t.netRate, format: rate },
    triunfoRate: { label: "Prancha Triunfo (t/dia)", value: t => t.triunfoRate, format: rate },
    stopped: { label: "Tempo parado (%)", value: t => t.operationDays ? t.stoppedDays / t.operationDays * 100 : null, format: pct },
    occupancy: { label: "Ocupação de berço (%)", occupancy: true, format: pct },
    berthDays: { label: "Tempo médio atracado (dias)", value: t => t.averageBerthDays, format: daysText },
    waitDays: { label: "Espera para iniciar (h)", value: t => t.averageWaitDays, format: hours }
  };
  const VIEW_METRICS = { operacional: ["tons", "vessels", "grossRate", "netRate", "triunfoRate", "stopped"], ocupacao: ["occupancy", "berthDays", "waitDays", "vessels"] };

  function renderChart(f) {
    const allowed = VIEW_METRICS[state.view];
    if (!allowed.includes(state.metric)) state.metric = allowed[0];
    $("sofMetric").innerHTML = allowed.map(key => `<option value="${key}" ${key === state.metric ? "selected" : ""}>${METRICS[key].label}</option>`).join("");
    const metric = METRICS[state.metric];
    const current = f.year || nowParts().year;
    const years = [current - 1, current];
    // Ocupação do mês: navios atracados no mês, mesmo que a operação tenha começado no mês anterior.
    const everyMonth = S.filterVessels(state.vessels, common(f));
    const series = years.map(year => Array.from({ length: 12 }, (_, i) => {
      if (metric.occupancy) { const occ = occupancyOf(everyMonth, year, new Set([i + 1])); return occ.byBerth.length ? occ.overall : null; }
      const rows = S.filterVessels(state.vessels, { ...common(f), years: new Set([year]), months: new Set([i + 1]) });
      return rows.length ? metric.value(S.totals(rows)) : null;
    }));
    const max = Math.max(1, ...series.flat().filter(v => v !== null));
    $("sofChartTitle").textContent = `${years[0]} × ${years[1]} · ${metric.label}`;
    $("sofChartLegend").innerHTML = years.map((y, i) => `<span><i class="sof-legend s${i}"></i>${y}</span>`).join("");
    $("sofChart").innerHTML = MONTHS.map((m, i) => `<div class="sof-month${f.month === i + 1 ? " is-selected" : ""}">
      <div class="sof-bars">${years.map((y, s) => { const v = series[s][i]; return `<i class="s${s}" style="height:${v === null ? 0 : Math.max(2, v / max * 100)}%" title="${m}/${y}: ${v === null ? "sem dados" : escape(metric.format(v))}"></i>`; }).join("")}</div>
      <span>${m}</span></div>`).join("");
    $("sofChartRows").innerHTML = MONTHS_FULL.map((m, i) => `<tr><th>${m}</th>${years.map((y, s) => `<td>${series[s][i] === null ? "—" : escape(metric.format(series[s][i]))}</td>`).join("")}</tr>`).join("");
    $("sofChartHead").innerHTML = `<tr><th>Mês</th>${years.map(y => `<th>${y}</th>`).join("")}</tr>`;
  }

  function renderResponsibles(t, p, f) {
    const total = t.operationDays || 0, totalPrev = p?.operationDays || 0;
    $("sofResponsibles").innerHTML = total ? S.RESPONSIBLES.map(name => {
      const share = t.byResponsible[name] / total * 100;
      const prev = totalPrev ? p.byResponsible[name] / totalPrev * 100 : null;
      return `<div class="sof-resp${name === "Cargo" ? " is-work" : ""}"><div><strong>${label(name)}</strong><small>${hours(t.byResponsible[name])}</small></div>
        <div class="sof-track"><i style="width:${Math.min(100, share)}%"></i>${prev !== null ? `<b style="left:${Math.min(100, prev)}%" title="${f.year - 1}: ${one.format(prev)}%"></b>` : ""}</div>
        <span>${one.format(share)}%${prev !== null ? `<small>${f.year - 1}: ${one.format(prev)}%</small>` : ""}</span></div>`;
    }).join("") : '<div class="base-empty">Nenhum navio nos filtros.</div>';
  }

  function renderStoppages(rows) {
    const chips = ["", ...S.RESPONSIBLES.filter(n => n !== "Cargo")];
    $("sofStopFilter").innerHTML = chips.map(n => `<button type="button" data-resp="${n}" aria-pressed="${state.stopResponsible === n}">${n ? label(n) : "Todos"}</button>`).join("");
    const list = S.topStoppages(rows, 200).filter(s => !state.stopResponsible || s.responsible === state.stopResponsible).slice(0, 12);
    const max = list[0]?.days || 1;
    $("sofStoppages").innerHTML = list.length ? list.map(s => `<div class="base-occurrence"><div><strong>${escape(s.text)}</strong><small>${label(s.responsible)} · ${int.format(s.count)} ${s.count === 1 ? "registro" : "registros"} em ${int.format(s.vessels)} ${s.vessels === 1 ? "navio" : "navios"}</small></div><div class="base-occurrence-track"><i style="width:${s.days / max * 100}%"></i></div><b>${hours(s.days)}</b></div>`).join("")
      : '<div class="base-empty">Nenhuma paralisação nos filtros.</div>';
  }

  function renderCargo(rows) {
    const groups = new Map();
    rows.forEach(v => { if (!groups.has(v.cargo)) groups.set(v.cargo, []); groups.get(v.cargo).push(v); });
    const list = [...groups].map(([cargo, items]) => {
      const t = S.totals(items);
      const standards = items.map(v => v.standardRate).filter(x => x > 0);
      const standard = standards.length ? standards.sort((a, b) => a - b)[standards.length >> 1] : null;
      return { cargo, t, standard };
    }).sort((a, b) => b.t.tons - a.t.tons);
    $("sofCargoRows").innerHTML = list.length ? list.map(({ cargo, t, standard }) => `<tr><th>${escape(cargo || "Não informada")}</th><td>${int.format(t.vessels)}</td><td>${int.format(t.tons)}</td><td>${rate(t.grossRate)}</td><td>${rate(t.netRate)}</td><td>${rate(t.triunfoRate)}</td><td>${standard ? rate(standard) : "—"}</td><td class="${standard && t.grossRate < standard ? "base-alert" : ""}">${standard && t.grossRate ? pct(t.grossRate / standard * 100) : "—"}</td></tr>`).join("")
      : '<tr><td colspan="8" class="base-empty">Nenhum navio nos filtros.</td></tr>';
  }

  function renderBerths(occ, occPrev, f) {
    const prev = new Map((occPrev?.byBerth || []).map(r => [r.berth, r.pct]));
    $("sofBerths").innerHTML = occ.byBerth.length ? occ.byBerth.map(r => `<div class="sof-resp"><div><strong>${escape(r.berth)}</strong><small>${daysText(r.days)} ocupado</small></div>
      <div class="sof-track"><i style="width:${Math.min(100, r.pct)}%"></i>${prev.has(r.berth) ? `<b style="left:${Math.min(100, prev.get(r.berth))}%"></b>` : ""}</div>
      <span>${one.format(r.pct)}%${prev.has(r.berth) ? `<small>${f.year - 1}: ${one.format(prev.get(r.berth))}%</small>` : ""}</span></div>`).join("")
      : '<div class="base-empty">Nenhum navio com berço e desatracação nos filtros.</div>';
  }

  function renderVessels(rows) {
    const sorted = [...rows].sort((a, b) => b.operationStart.localeCompare(a.operationStart));
    $("sofVesselCount").textContent = `${int.format(rows.length)} ${rows.length === 1 ? "navio" : "navios"}`;
    $("sofVesselRows").innerHTML = sorted.length ? sorted.map(v => {
      const s = v.summary;
      const stopped = s.operationDays ? (s.operationDays - s.byResponsible.Cargo) / s.operationDays * 100 : null;
      return `<tr data-sof-id="${escape(v.id)}" tabindex="0" role="button" aria-label="Ver ocorrências do navio ${escape(v.vessel)}">
        <th><strong>${escape(v.vessel)}</strong><small>${escape(v.cargo)} · ${escape((v.operation || "").toLowerCase())}${v.source === "sof" ? " · SOF enviado" : ""}</small></th>
        <td>${escape(v.berth || "—")}</td><td>${fmtDate(v.berthStart)}</td><td>${fmtDate(v.operationStart)}</td><td>${fmtDate(v.operationEnd)}</td>
        <td title="${v.matched ? "Da planilha de navios" : "Do SOF ou da Base SOF"}">${fmtDate(v.berthEnd)}${v.matched ? "" : " *"}</td>
        <td>${int.format(v.tons)}</td><td>${rate(s.grossRate)}</td><td>${rate(s.netRate)}</td><td>${pct(stopped)}</td></tr>`;
    }).join("") : '<tr><td colspan="10" class="base-empty">Nenhum navio nos filtros.</td></tr>';
  }

  /* ---------- Detalhe do navio ---------- */

  async function openVessel(id) {
    const summaryRow = state.vessels.find(v => v.id === id);
    if (!summaryRow) return;
    window.showDrawer?.(summaryRow.vessel, "", '<div class="empty">Lendo as ocorrências…</div>');
    const response = await fetch(`/api/sof/navio?id=${encodeURIComponent(id)}`);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { $("vesselList").innerHTML = `<div class="empty">${escape(body.error || "Não foi possível abrir o navio.")}</div>`; return; }
    const v = body.vessel, s = summaryRow.summary;
    const stat = (title, value) => `<div class="drawer-stat"><span>${title}</span><strong>${value}</strong></div>`;
    $("drawerSummary").innerHTML = stat("Volume", `${int.format(v.tons)} t`) + stat("Prancha bruta", rate(s.grossRate)) + stat("Prancha líquida", rate(s.netRate)) + stat("Operação", daysText(s.operationDays));
    const resp = S.RESPONSIBLES.filter(n => s.byResponsible[n] > 0).map(n => `<span>${label(n)}: ${hours(s.byResponsible[n])}</span>`).join("");
    const remove = v.source === "sof" ? `<button type="button" class="sof-danger" data-sof-delete="${escape(v.id)}">Apagar este SOF enviado</button>` : "";
    $("vesselList").innerHTML = `<article class="vessel-item"><div class="vessel-meta"><span>${escape(v.cargo)}</span><span>${escape(v.operation)}</span><span>${escape(v.berth || "berço não informado")}</span>${v.client ? `<span>${escape(v.client)}</span>` : ""}</div>
      <div class="vessel-meta"><span>Atracação: ${fmtDate(v.berthStart)}</span><span>Início: ${fmtDate(v.operationStart)}</span><span>Término: ${fmtDate(v.operationEnd)}</span><span>Desatracação: ${fmtDate(v.berthEnd)}${v.matched ? " (planilha de navios)" : ""}</span></div>
      <div class="vessel-meta">${resp}</div>${v.source === "sof" ? `<p class="sof-note">SOF enviado${v.savedBy?.name ? ` por ${escape(v.savedBy.name)}` : ""} em ${fmtDate(v.savedAt)}${v.fileName ? ` · ${escape(v.fileName)}` : ""}.</p>${remove}` : '<p class="sof-note">Histórico da Base SOF (planilha de indicadores).</p>'}</article>
      <div class="sof-events">${v.events.map(e => `<div class="sof-event${e.responsible === "Cargo" ? "" : " is-stop"}"><time>${e.date.slice(8, 10)}/${e.date.slice(5, 7)} ${String(Math.floor(e.from / 60)).padStart(2, "0")}:${String(e.from % 60).padStart(2, "0")}</time><div><strong>${escape(e.description)}</strong><small>${label(e.responsible)} · ${e.minutes} min${e.gang ? ` · ${escape(e.gang)} terno` : ""}${e.hold ? ` · porão ${escape(e.hold)}` : ""}${e.weight ? ` · ${two.format(e.weight)} t` : ""}</small></div></div>`).join("")}</div>`;
  }

  async function deleteVessel(id) {
    if (!confirm("Apagar este SOF enviado? Os indicadores voltam a usar a Base SOF (se houver) para este navio.")) return;
    const response = await fetch(`/api/sof/navios?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { alert(body.error || "Não foi possível apagar."); return; }
    window.closeDrawer?.();
    await load(true);
  }

  /* ---------- Envio de SOF ---------- */

  async function dictionary(force = false) {
    if (state.dictionary && !force) return state.dictionary;
    const response = await fetch("/api/sof/dicionario");
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Não foi possível ler o dicionário de responsáveis.");
    return state.dictionary = body.dictionary;
  }

  const toLocalInput = iso => { if (!iso) return ""; const d = new Date(Date.parse(iso) - 3 * 3600000); return d.toISOString().slice(0, 16); };
  const fromLocalInput = value => value ? new Date(`${value}:00-03:00`).toISOString() : null;

  async function readFile(file) {
    const box = $("sofUpload");
    box.hidden = false;
    box.innerHTML = '<p class="base-status">Lendo o SOF…</p>';
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: "array", cellDates: false, cellFormula: false, cellHTML: false, cellText: false });
      const parsed = S.parseSofWorkbook(XLSX, workbook, file.name);
      const dict = await dictionary();
      const groups = new Map();
      for (const event of parsed.events) {
        const suggestion = S.suggest(event, dict);
        event.suggestion = suggestion;
        const id = event.key || event.description;
        if (!groups.has(id)) groups.set(id, { id, text: event.description, suggestion, events: [], choice: suggestion.responsible });
        groups.get(id).events.push(event);
      }
      // Navio da planilha de navios: carga, berço, cliente e desatracação.
      const known = state.vessels.find(v => S.vesselKey(v.vessel) === S.vesselKey(parsed.vessel) && Math.abs(Date.parse(v.operationStart) - Date.parse(parsed.operationStart)) < 2 * 86400000);
      const sheet = await fetch(`/api/sof/planilha?navio=${encodeURIComponent(parsed.vessel)}&inicio=${encodeURIComponent(parsed.berthStart || parsed.operationStart)}`).then(r => r.ok ? r.json() : {}).catch(() => ({}));
      state.upload = { parsed, groups: [...groups.values()], sheet: sheet.match || null, known, showAll: false };
      renderUpload();
    } catch (error) {
      box.innerHTML = `<div class="sof-upload-head"><h3>Não foi possível ler o arquivo</h3><button type="button" class="base-reset" data-sof-cancel>Fechar</button></div><p class="base-status">${escape(error.message)}</p>`;
    }
  }

  function renderUpload() {
    const u = state.upload, p = u.parsed, sheet = u.sheet || {};
    const cargos = [...new Set([...state.vessels.map(v => v.cargo), sheet.cargo].filter(Boolean))].sort();
    const count = status => u.groups.filter(g => g.suggestion.status === status).reduce((n, g) => n + g.events.length, 0);
    const pending = u.groups.filter(g => !g.choice).length;
    const visible = u.groups.filter(g => u.showAll || g.suggestion.status === "confirmar" || g.suggestion.status === "nova" || !g.choice);
    const operation = p.operation || sheet.operation || "";
    const options = choice => `<option value="">Escolha…</option>${S.RESPONSIBLES.map(n => `<option value="${n}" ${n === choice ? "selected" : ""}>${label(n)}</option>`).join("")}`;
    $("sofUpload").innerHTML = `<div class="sof-upload-head"><div><p class="eyebrow">ENVIAR SOF · ${escape(p.model)} · ${escape(p.fileName)}</p><h3>${escape(p.vessel)}</h3></div><button type="button" class="base-reset" data-sof-cancel>Cancelar</button></div>
      ${u.known ? `<p class="sof-warn">Este navio já está na base (${u.known.source === "sof" ? "SOF enviado" : "Base SOF"}). Ao salvar, este SOF substitui o registro atual.</p>` : ""}
      ${p.warnings.map(w => `<p class="sof-warn">${escape(w)}</p>`).join("")}
      <div class="sof-form">
        <label>Navio<input id="sofFVessel" value="${escape(p.vessel)}"></label>
        <label>Carga<input id="sofFCargo" list="sofCargoList" value="${escape(sheet.cargo || u.known?.cargo || "")}" placeholder="Ex.: FERRO GUSA"><datalist id="sofCargoList">${cargos.map(c => `<option value="${escape(c)}"></option>`).join("")}</datalist></label>
        <label>Operação<select id="sofFOperation"><option value="">Escolha…</option>${S.OPERATIONS.map(o => `<option ${o === operation ? "selected" : ""}>${o}</option>`).join("")}</select></label>
        <label>Volume (t)<input id="sofFTons" type="number" step="0.001" min="0" value="${p.tons}"></label>
        <label>Atracação<input id="sofFBerthStart" type="datetime-local" value="${toLocalInput(p.berthStart || sheet.berthStart)}"></label>
        <label>Início da operação<input id="sofFStart" type="datetime-local" value="${toLocalInput(p.operationStart)}"></label>
        <label>Término da operação<input id="sofFEnd" type="datetime-local" value="${toLocalInput(p.operationEnd)}"></label>
        <label>Desatracação<input id="sofFBerthEnd" type="datetime-local" value="${toLocalInput(sheet.berthEnd || p.berthEnd)}"><small>${sheet.berthEnd ? "da planilha de navios" : "a planilha de navios ainda não tem; o painel completa quando tiver"}</small></label>
        <label>Berço<input id="sofFBerth" value="${escape(sheet.berth || p.berth)}"></label>
        <label>Cliente<input id="sofFClient" value="${escape(sheet.client || p.client)}"></label>
      </div>
      <div class="sof-upload-stats"><span><b>${p.events.length}</b> ocorrências</span><span><b>${count("auto") + count("sof")}</b> com responsável automático</span><span class="${count("confirmar") ? "is-attention" : ""}"><b>${count("confirmar")}</b> para confirmar</span><span class="${count("nova") ? "is-attention" : ""}"><b>${count("nova")}</b> descrições novas</span></div>
      <div class="sof-upload-tools"><label><input type="checkbox" id="sofShowAll" ${u.showAll ? "checked" : ""}> Mostrar também as automáticas</label><span>${pending ? `${pending} ${pending === 1 ? "descrição sem responsável" : "descrições sem responsável"}` : "Todas as ocorrências têm responsável."}</span></div>
      <div class="base-table-scroll"><table class="base-table sof-choices"><thead><tr><th>Descrição</th><th>Vezes</th><th>Situação</th><th>Histórico</th><th>Responsável</th></tr></thead><tbody>
      ${visible.length ? visible.map(g => `<tr class="is-${g.suggestion.status}"><th><strong>${escape(g.text)}</strong></th><td>${g.events.length}</td><td><span class="sof-tag ${g.suggestion.status}">${STATUS_LABEL[g.suggestion.status]}</span></td><td>${g.suggestion.options.length ? g.suggestion.options.slice(0, 3).map(o => `${label(o.name)} ${o.count}`).join(" · ") : "—"}</td><td><select data-sof-group="${escape(g.id)}">${options(g.choice)}</select></td></tr>`).join("")
        : '<tr><td colspan="5" class="base-empty">Nada para revisar: todas as descrições são conhecidas.</td></tr>'}
      </tbody></table></div>
      <p class="base-footnote">As escolhas feitas aqui ficam guardadas: no próximo SOF, a mesma descrição já vem com o responsável sugerido.</p>
      <div class="sof-upload-actions"><p id="sofSaveStatus" class="base-status" role="status"></p><button type="button" class="sof-primary" id="sofSave" ${pending ? "disabled" : ""}>Salvar na Base SOF</button></div>`;
  }

  async function saveUpload() {
    const u = state.upload, p = u.parsed;
    const choice = new Map(u.groups.map(g => [g.id, g.choice]));
    const body = {
      vessel: $("sofFVessel").value, cargo: $("sofFCargo").value, operation: $("sofFOperation").value, tons: Number($("sofFTons").value),
      berthStart: fromLocalInput($("sofFBerthStart").value), operationStart: fromLocalInput($("sofFStart").value), operationEnd: fromLocalInput($("sofFEnd").value),
      berthEnd: fromLocalInput($("sofFBerthEnd").value), berth: $("sofFBerth").value, client: $("sofFClient").value,
      arrival: p.arrival, invoiceTons: p.invoiceTons, cargoDescription: p.cargoDescription, fileName: p.fileName, model: p.model,
      events: p.events.map(e => ({ date: e.date, start: e.start, minutes: e.minutes, gang: e.gang, hold: e.hold, description: e.description, volume: e.volume, weight: e.weight, responsible: choice.get(e.key || e.description) }))
    };
    $("sofSave").disabled = true;
    $("sofSaveStatus").textContent = "Salvando…";
    const response = await fetch("/api/sof/navios", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) { $("sofSaveStatus").textContent = result.error || "Não foi possível salvar."; $("sofSave").disabled = false; return; }
    state.upload = null; state.dictionary = null;
    $("sofUpload").innerHTML = `<div class="sof-upload-head"><h3>SOF salvo${result.replaced ? " (substituiu o anterior)" : ""}</h3><button type="button" class="base-reset" data-sof-cancel>Fechar</button></div><p class="base-status">Os indicadores já consideram o navio ${escape(body.vessel.toUpperCase())}.</p>`;
    await load(true);
  }

  /* ---------- Dicionário de responsáveis ---------- */

  async function openDictionary() {
    const box = $("sofDictionary");
    box.hidden = false;
    box.innerHTML = '<p class="base-status">Lendo o dicionário…</p>';
    try { await dictionary(true); renderDictionary(); } catch (error) { box.innerHTML = `<p class="base-status">${escape(error.message)}</p>`; }
  }
  function renderDictionary() {
    const search = ($("sofDictSearch")?.value || "").trim();
    const onlyMixed = $("sofDictMixed")?.checked || false;
    const key = S.normalizeDescription(search);
    const entries = Object.entries(state.dictionary).map(([id, entry]) => ({ id, entry, rank: S.ranking(entry) }))
      .filter(({ id, entry, rank }) => (!key || id.includes(key) || S.normalizeDescription(entry.text).includes(key)) && (!onlyMixed || (!entry.fixed && rank.share < S.AUTO_SHARE)))
      .sort((a, b) => b.rank.total - a.rank.total);
    const shown = entries.slice(0, 150);
    const box = $("sofDictionary");
    const keepFocus = document.activeElement?.id === "sofDictSearch";
    box.innerHTML = `<div class="sof-upload-head"><div><p class="eyebrow">DICIONÁRIO DE RESPONSÁVEIS</p><h3>${int.format(Object.keys(state.dictionary).length)} descrições conhecidas</h3></div><button type="button" class="base-reset" data-sof-dict-close>Fechar</button></div>
      <p class="base-footnote">Cada descrição guarda quantas vezes recebeu cada responsável. Acima de ${int.format(S.AUTO_SHARE * 100)}% para o mesmo responsável, ele é aplicado automaticamente. “Fixar” vale sempre, mesmo com histórico dividido.</p>
      <div class="base-filters"><label class="base-search">Buscar descrição<input id="sofDictSearch" type="search" value="${escape(search)}" placeholder="Ex.: awaiting trucks"></label><label class="sof-check"><input type="checkbox" id="sofDictMixed" ${onlyMixed ? "checked" : ""}> Só as divididas (sem fixar)</label></div>
      <div class="base-table-scroll"><table class="base-table sof-choices"><thead><tr><th>Descrição</th><th>Registros</th><th>Histórico</th><th>Usado hoje</th><th>Fixar</th></tr></thead><tbody>
      ${shown.map(({ id, entry, rank }) => `<tr><th><strong>${escape(entry.text)}</strong>${entry.fixed && entry.fixedBy ? `<small>fixado por ${escape(entry.fixedBy)}</small>` : ""}</th><td>${int.format(rank.total)}</td><td>${rank.counts.slice(0, 4).map(([n, c]) => `${label(n)} ${int.format(c)}`).join(" · ") || "—"}</td><td>${entry.fixed ? `<span class="sof-tag auto">${label(entry.fixed)} (fixo)</span>` : rank.share >= S.AUTO_SHARE ? `<span class="sof-tag auto">${label(rank.top)}</span>` : `<span class="sof-tag confirmar">confirmar</span>`}</td>
        <td><select data-sof-fix="${escape(id)}"><option value="">${entry.fixed ? "Soltar" : "—"}</option>${S.RESPONSIBLES.map(n => `<option value="${n}" ${entry.fixed === n ? "selected" : ""}>${label(n)}</option>`).join("")}</select></td></tr>`).join("") || '<tr><td colspan="5" class="base-empty">Nenhuma descrição encontrada.</td></tr>'}
      </tbody></table></div>${entries.length > shown.length ? `<p class="base-footnote">Mostrando ${shown.length} de ${int.format(entries.length)}. Use a busca para achar as demais.</p>` : ""}`;
    if (keepFocus) { const input = $("sofDictSearch"); input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  }
  async function fix(id, responsible) {
    const response = await fetch("/api/sof/dicionario", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: id, responsible }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { alert(body.error || "Não foi possível gravar."); return; }
    const entry = state.dictionary[id];
    if (responsible) entry.fixed = responsible; else delete entry.fixed;
    renderDictionary();
  }

  /* ---------- Exportação para Excel ---------- */

  // Datas como data do Excel (hora de Brasília), para o arquivo poder ser filtrado e somado.
  const xlDate = iso => { const t = Date.parse(iso || ""); return Number.isFinite(t) ? { t: "n", v: (t - 3 * 3600000) / 86400000 + 25569, z: "dd/mm/yyyy hh:mm" } : null; };
  const xlDay = day => /^\d{4}-\d{2}-\d{2}$/.test(day || "") ? { t: "n", v: Date.parse(day) / 86400000 + 25569, z: "dd/mm/yyyy" } : day || "";
  const xlNum = (value, z = "#,##0.00") => value === null || value === undefined || !Number.isFinite(value) ? null : { t: "n", v: value, z };
  const xlHours = daysValue => xlNum(daysValue === null || daysValue === undefined ? null : daysValue * 24);
  function sheet(header, rows, widths) {
    const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
    ws["!cols"] = widths.map(wch => ({ wch }));
    ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: header.length - 1 } }) };
    ws["!freeze"] = { xSplit: 0, ySplit: 1 };
    return ws;
  }

  async function exportBase() {
    const button = $("sofExport");
    button.disabled = true;
    $("sofStatus").textContent = "Montando o Excel da Base SOF…";
    try {
      const response = await fetch("/api/sof/exportar");
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Não foi possível exportar a Base SOF.");
      const origin = v => v.source === "sof" ? "SOF enviado" : "Histórico";
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, sheet(
        ["ID", "Origem", "Navio", "Operação", "Carga", "Cliente", "Berço", "Atracação", "Início da operação", "Fim da operação", "Desatracação", "Toneladas",
          "Espera p/ operar (h)", "Tempo atracado (h)", "Tempo de operação (h)", ...S.RESPONSIBLES.map(n => `Horas: ${label(n)}`),
          "Prancha bruta (t/dia)", "Prancha líquida (t/dia)", "Prancha Triunfo (t/dia)", "Ocorrências", "Na planilha de navios", "Arquivo do SOF", "Enviado por", "Enviado em"],
        body.vessels.map(v => {
          const s = v.summary;
          return [v.id, origin(v), v.vessel, v.operation, v.cargo, v.client || "", v.berth || "", xlDate(v.berthStart), xlDate(v.operationStart), xlDate(v.operationEnd), xlDate(v.berthEnd), xlNum(v.tons, "#,##0.000"),
            xlHours(s.waitDays), xlHours(s.berthDays), xlHours(s.operationDays), ...S.RESPONSIBLES.map(n => xlHours(s.byResponsible[n])),
            xlNum(s.grossRate, "#,##0"), xlNum(s.netRate, "#,##0"), xlNum(s.triunfoRate, "#,##0"), v.events.length, v.matched ? "Sim" : "Não", v.fileName || "", v.savedBy || "", xlDate(v.savedAt)];
        }),
        [16, 12, 26, 13, 18, 22, 12, 16, 16, 16, 16, 12, 11, 11, 11, ...S.RESPONSIBLES.map(() => 11), 12, 12, 12, 11, 11, 30, 18, 16]), "Navios");
      XLSX.utils.book_append_sheet(book, sheet(
        ["ID do navio", "Navio", "Origem", "Data", "Início", "Fim", "Duração (min)", "Período", "Terno", "Porão", "Descrição", "Responsável", "Volume", "Peso (t)"],
        body.vessels.flatMap(v => v.events.map(e => [v.id, v.vessel, origin(v), xlDay(e.date), xlDate(e.start), xlDate(e.end), e.minutes, e.period || "", e.gang || "", e.hold || "",
          e.description, label(e.responsible), xlNum(e.volume, "#,##0"), xlNum(e.weight, "#,##0.000")])),
        [16, 24, 12, 11, 16, 16, 10, 9, 8, 8, 70, 14, 9, 10]), "Ocorrências");
      XLSX.utils.book_append_sheet(book, sheet(
        ["Descrição", "Responsável fixado", "Responsável mais usado", "% do mais usado", "Vezes usada", ...S.RESPONSIBLES.map(label)],
        Object.values(body.dictionary).map(entry => {
          const rank = S.ranking(entry);
          return [entry.text, entry.fixed ? label(entry.fixed) : "", rank.top ? label(rank.top) : "", xlNum(rank.share, "0%"), rank.total, ...S.RESPONSIBLES.map(n => entry.counts[n] || null)];
        }).sort((a, b) => b[4] - a[4]),
        [70, 14, 16, 10, 10, ...S.RESPONSIBLES.map(() => 10)]), "Dicionário");
      XLSX.writeFile(book, `base-sof-${new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10)}.xlsx`);
      $("sofStatus").textContent = "";
    } catch (error) {
      $("sofStatus").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  /* ---------- Eventos ---------- */

  function setup() {
    ["sofYear", "sofMonth", "sofCargo", "sofOperation", "sofBerth"].forEach(id => $(id).addEventListener("change", render));
    $("sofVessel").addEventListener("input", render);
    $("sofClear").addEventListener("click", () => { ["sofMonth", "sofCargo", "sofOperation", "sofBerth"].forEach(id => { $(id).value = ""; }); $("sofVessel").value = ""; render(); });
    $("sofMetric").addEventListener("change", event => { state.metric = event.target.value; render(); });
    $("sofStopFilter").addEventListener("click", event => { const b = event.target.closest("[data-resp]"); if (!b) return; state.stopResponsible = b.dataset.resp; render(); });
    $("sofFile").addEventListener("change", event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) readFile(file); });
    $("sofOpenDictionary").addEventListener("click", openDictionary);
    $("sofExport").addEventListener("click", exportBase);
    $("sofVesselRows").addEventListener("click", event => { const row = event.target.closest("[data-sof-id]"); if (row) openVessel(row.dataset.sofId); });
    $("sofVesselRows").addEventListener("keydown", event => { const row = event.target.closest("[data-sof-id]"); if (row && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); openVessel(row.dataset.sofId); } });
    $("vesselList").addEventListener("click", event => { const b = event.target.closest("[data-sof-delete]"); if (b) deleteVessel(b.dataset.sofDelete); });
    const upload = $("sofUpload");
    upload.addEventListener("click", event => {
      if (event.target.closest("[data-sof-cancel]")) { state.upload = null; upload.hidden = true; upload.innerHTML = ""; }
      if (event.target.closest("#sofSave")) saveUpload();
    });
    upload.addEventListener("change", event => {
      if (event.target.id === "sofShowAll") { state.upload.showAll = event.target.checked; renderUpload(); return; }
      const select = event.target.closest("[data-sof-group]");
      if (!select) return;
      const group = state.upload.groups.find(g => g.id === select.dataset.sofGroup);
      if (group) group.choice = select.value;
      const pending = state.upload.groups.filter(g => !g.choice).length;
      $("sofSave").disabled = Boolean(pending);
      upload.querySelector(".sof-upload-tools span").textContent = pending ? `${pending} ${pending === 1 ? "descrição sem responsável" : "descrições sem responsável"}` : "Todas as ocorrências têm responsável.";
    });
    const dict = $("sofDictionary");
    dict.addEventListener("click", event => { if (event.target.closest("[data-sof-dict-close]")) { dict.hidden = true; dict.innerHTML = ""; } });
    dict.addEventListener("input", event => { if (event.target.id === "sofDictSearch") renderDictionary(); });
    dict.addEventListener("change", event => {
      if (event.target.id === "sofDictMixed") { renderDictionary(); return; }
      const select = event.target.closest("[data-sof-fix]");
      if (select) fix(select.dataset.sofFix, select.value);
    });
  }

  let ready = false;
  window.sofPanel = {
    /** Mostra a visão (operacional | ocupacao) e carrega a base na primeira vez. */
    show(view) {
      if (!ready) { setup(); ready = true; }
      state.view = view === "ocupacao" ? "ocupacao" : "operacional";
      $("sofTitle").textContent = state.view === "ocupacao" ? "Ocupação de berço" : "Operacional";
      if (state.loaded) render(); else load();
    }
  };
})();
