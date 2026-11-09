/* Indicadores Operacional e Ocupação a partir da Base SOF (histórico 2025–2026 + SOFs enviados).
   Cálculos em sof-core.js (window.TpsSof); dados em /api/sof (netlify/functions/sof.mjs). */
(() => {
  const S = window.TpsSof;
  const MONTHS = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
  const MONTHS_FULL = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
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
      $("sofOpenStandardize").hidden = !body.canStandardize;
      const mirror = body.mirror || {};
      $("sofMirror").hidden = !mirror.url;
      $("sofMirror").href = mirror.url || "#";
      $("sofMirror").title = mirror.syncedAt ? `Cópia só para consulta, atualizada em ${fmtDate(mirror.syncedAt)}` : "Cópia só para consulta (ainda não atualizada)";
      // Última data com SOF: o ano em andamento só é comparado (e a ocupação só é medida) até ela.
      state.lastData = Math.min(Date.now(), Math.max(0, ...body.vessels.map(v => Date.parse(v.operationEnd || "") || 0)));
      state.loaded = true;
      setupFilters();
      $("sofStatus").textContent = [body.operationsAvailable ? "" : "Planilha de navios indisponível agora: desatracação e berço vêm só do SOF.", body.mirror?.error ? `Espelho no Google Planilhas não atualizou: ${body.mirror.error}` : ""].filter(Boolean).join(" ");
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

  /* ---------- Página do navio ---------- */

  const RESP_COLORS = { Cargo: "#5b6470", Terminal: "#c8102e", Vessel: "#1f5fae", Client: "#c27a00", Rain: "#1a8fa3", Port: "#7a4bb3", Others: "#9aa1a9" };
  const localParts = iso => { const t = Date.parse(iso || ""); if (!Number.isFinite(t)) return { date: "", time: "" }; const d = new Date(t - 3 * 3600000).toISOString(); return { date: d.slice(0, 10), time: d.slice(11, 16) }; };
  const shortDate = iso => { const { date, time } = localParts(iso); return date ? `${date.slice(8, 10)}/${date.slice(5, 7)} ${time}` : "—"; };
  const minutesText = m => m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${String(m % 60).padStart(2, "0")}min` : ""}` : `${int.format(m)} min`;

  async function openVessel(id) {
    const page = $("sofVesselPage");
    $("sof").classList.add("is-vessel");
    page.hidden = false;
    page.innerHTML = '<p class="base-status">Lendo o navio…</p>';
    window.scrollTo({ top: $("sof").offsetTop - 70 });
    const response = await fetch(`/api/sof/navio?id=${encodeURIComponent(id)}`);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { page.innerHTML = `<button type="button" class="base-reset" data-sof-back>← Voltar aos navios</button><p class="base-status">${escape(body.error || "Não foi possível abrir o navio.")}</p>`; return; }
    state.page = { vessel: body.vessel, canEdit: body.canEdit, draft: null };
    renderVesselPage();
  }

  function closeVesselPage() {
    $("sof").classList.remove("is-vessel");
    const page = $("sofVesselPage");
    page.hidden = true; page.innerHTML = "";
    state.page = null;
    $("sofVesselRows").closest("section").scrollIntoView({ block: "start" });
  }

  /** Linha do tempo: atracado, operação e uma faixa por responsável com as ocorrências no horário real. */
  function timeline(v) {
    const valid = v.events.filter(e => e.minutes > 0 && Number.isFinite(Date.parse(e.start)));
    // A janela é a estadia do navio (com folga de 6 h); ocorrência com data fora dela costuma ser erro de digitação no SOF.
    const stay = [v.berthStart, v.operationStart, v.operationEnd, v.berthEnd].map(x => Date.parse(x || "")).filter(Number.isFinite);
    const times = stay.length >= 2 ? [Math.min(...stay) - 6 * 3600000, Math.max(...stay) + 6 * 3600000] : valid.flatMap(e => [Date.parse(e.start), Date.parse(e.end)]);
    const a = Math.min(...times), b = Math.max(...times);
    if (!(b > a)) return '<p class="base-empty">Sem horários para montar a linha do tempo.</p>';
    const events = valid.filter(e => Date.parse(e.end) > a && Date.parse(e.start) < b);
    const outside = valid.filter(e => !events.includes(e));
    const span = (start, end) => [Date.parse(start || ""), Date.parse(end || "")];
    const rows = [
      ["Atracado", [[...span(v.berthStart, v.berthEnd), `Atracado: ${fmtDate(v.berthStart)} → ${fmtDate(v.berthEnd)}`]], "#d6d9dd"],
      ["Operação", [[...span(v.operationStart, v.operationEnd), `Operação: ${fmtDate(v.operationStart)} → ${fmtDate(v.operationEnd)}`]], "#aab0b7"],
      ...S.RESPONSIBLES.filter(n => events.some(e => e.responsible === n)).map(n => [label(n),
        events.filter(e => e.responsible === n).map(e => [...span(e.start, e.end), `${shortDate(e.start)} → ${shortDate(e.end)} (${minutesText(e.minutes)}) · ${e.description}`]), RESP_COLORS[n]])
    ];
    const W = 1000, L = 96, R = 8, H = 22, TOP = 22;
    const x = t => L + (Math.min(Math.max(t, a), b) - a) / (b - a) * (W - L - R);
    const height = TOP + rows.length * H + 4;
    const step = Math.max(1, Math.ceil((b - a) / 86400000 / 16));
    const ticks = [];
    for (let t = Date.parse(`${localParts(new Date(a).toISOString()).date}T00:00:00-03:00`) + 86400000; t < b; t += step * 86400000) ticks.push(t);
    return `<svg viewBox="0 0 ${W} ${height}" role="img" aria-label="Linha do tempo do navio por responsável">
      ${ticks.map(t => `<line x1="${x(t)}" x2="${x(t)}" y1="${TOP - 6}" y2="${height}" class="sof-tl-grid"/><text x="${x(t) + 3}" y="${TOP - 9}" class="sof-tl-day">${shortDate(new Date(t).toISOString()).slice(0, 5)}</text>`).join("")}
      ${rows.map(([name, spans, color], i) => `<text x="0" y="${TOP + i * H + 15}" class="sof-tl-label">${escape(name)}</text>
        ${spans.filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s).map(([s, e, title]) => `<rect x="${x(s)}" y="${TOP + i * H + 4}" width="${Math.max(1.5, x(e) - x(s))}" height="${H - 8}" rx="2" fill="${color}"><title>${escape(title)}</title></rect>`).join("")}`).join("")}
    </svg>${outside.length ? `<p class="sof-warn">${outside.length === 1 ? "1 ocorrência está" : `${outside.length} ocorrências estão`} com data fora da estadia do navio e não ${outside.length === 1 ? "aparece" : "aparecem"} na linha do tempo: ${outside.slice(0, 3).map(e => `${shortDate(e.start)} · ${escape(e.description)}`).join("; ")}${outside.length > 3 ? "…" : ""}. Confira a data no SOF.</p>` : ""}`;
  }

  function renderVesselPage() {
    const { vessel: v, canEdit, draft } = state.page;
    const s = S.vesselSummary(v);
    const stopped = s.operationDays ? (s.operationDays - s.byResponsible.Cargo) / s.operationDays * 100 : null;
    const edited = v.source === "sof" && v.origin === "base";
    const origin = v.source !== "sof" ? "Histórico da Base SOF (planilha de indicadores)."
      : edited ? `Histórico da Base SOF, editado no painel${v.editedBy?.name ? ` por ${escape(v.editedBy.name)}` : ""} em ${fmtDate(v.editedAt)}.`
      : `SOF enviado${v.savedBy?.name ? ` por ${escape(v.savedBy.name)}` : ""} em ${fmtDate(v.savedAt)}${v.fileName ? ` · ${escape(v.fileName)}` : ""}${v.editedAt ? ` · editado em ${fmtDate(v.editedAt)}` : ""}.`;
    const undo = !draft && (edited ? (canEdit ? `<button type="button" class="sof-danger" data-sof-delete="${escape(v.id)}" data-sof-undo>Desfazer edições</button>` : "")
      : v.source === "sof" ? `<button type="button" class="sof-danger" data-sof-delete="${escape(v.id)}">Apagar este SOF enviado</button>` : "");
    const fromSheet = field => v.matched && !(v.locked || []).includes(field) ? ' <small title="Da planilha de navios">(planilha)</small>' : "";
    const head = `<div class="sof-page-head"><button type="button" class="base-reset" data-sof-back>← Voltar aos navios</button>
        <div class="sof-page-actions">${canEdit && !draft ? '<button type="button" class="base-upload" data-sof-edit>Editar</button>' : ""}${undo || ""}</div></div>
      <p class="eyebrow">NAVIO · ${escape(v.operation)} · ${escape(v.cargo)}</p><h2 class="sof-page-title">${escape(v.vessel)}</h2><p class="sof-note">${origin}</p>`;
    if (draft) { $("sofVesselPage").innerHTML = head + editorHtml(v); renderDraftRows(); return; }
    const stops = s.stoppages;
    const stopTotal = stops.reduce((sum, x) => sum + x.days, 0);
    $("sofVesselPage").innerHTML = `${head}
      <div class="sof-meta"><span><b>Berço</b> ${escape(v.berth || "—")}${fromSheet("berth")}</span><span><b>Cliente</b> ${escape(v.client || "—")}${fromSheet("client")}</span>
        <span><b>Atracação</b> ${fmtDate(v.berthStart)}</span><span><b>Início</b> ${fmtDate(v.operationStart)}</span><span><b>Término</b> ${fmtDate(v.operationEnd)}</span><span><b>Desatracação</b> ${fmtDate(v.berthEnd)}${fromSheet("berthEnd")}</span></div>
      <div class="base-kpis sof-kpis">${[
        kpi("VOLUME", `${int.format(v.tons)} t`, v.tonsSource ? `${escape(v.cargo)} · corrigido pela ${escape(v.tonsSource)} (a Base SOF tinha ${int.format(v.tonsBase)} t)` : escape(v.cargo)),
        kpi("TEMPO ATRACADO", daysText(s.berthDays || null), `espera até operar: ${s.waitDays ? hours(s.waitDays) : "—"}`),
        kpi("TEMPO DE OPERAÇÃO", daysText(s.operationDays), "início → término"),
        kpi("PRANCHA BRUTA", rate(s.grossRate), `líquida ${rate(s.netRate)}`),
        kpi("PRANCHA TRIUNFO", rate(s.triunfoRate), "volume ÷ (operando + terminal)"),
        kpi("TEMPO PARADO", pct(stopped), `${hours(s.operationDays - s.byResponsible.Cargo)} sem operar`)].join("")}</div>
      <section class="base-sheet"><div class="base-sheet-head"><div><p class="eyebrow">LINHA DO TEMPO</p><h3>Quem estava com a operação</h3></div><span>passe o mouse numa faixa para ver a ocorrência</span></div>
        <div class="base-chart-scroll sof-timeline">${timeline(v)}</div>
        <div class="sof-legend-row">${S.RESPONSIBLES.filter(n => s.byResponsible[n] > 0).map(n => `<span><i class="sof-dot" style="background:${RESP_COLORS[n]}"></i>${label(n)}</span>`).join("")}</div></section>
      <div class="sof-grid">
        <section class="base-sheet"><div class="base-sheet-head"><div><p class="eyebrow">TEMPO DE OPERAÇÃO</p><h3>Por responsável</h3></div></div><div class="sof-resp-list">
          ${S.RESPONSIBLES.filter(n => s.byResponsible[n] > 0).map(n => { const share = s.operationDays ? s.byResponsible[n] / s.operationDays * 100 : 0; return `<div class="sof-resp${n === "Cargo" ? " is-work" : ""}"><div><strong>${label(n)}</strong><small>${hours(s.byResponsible[n])}</small></div><div class="sof-track"><i style="width:${Math.min(100, share)}%;background:${RESP_COLORS[n]}"></i></div><span>${pct(share)}</span></div>`; }).join("")}
        </div></section>
        <section class="base-sheet"><div class="base-sheet-head"><div><p class="eyebrow">PARALISAÇÕES</p><h3>Por motivo</h3></div><span>${hours(stopTotal)}</span></div>
          <div class="base-table-scroll"><table class="base-table sof-stop-table"><thead><tr><th>Motivo</th><th>Responsável</th><th>Vezes</th><th>Tempo</th></tr></thead><tbody>
          ${stops.map(x => `<tr><th>${escape(x.text)}</th><td><i class="sof-dot" style="background:${RESP_COLORS[x.responsible]}"></i>${label(x.responsible)}</td><td>${int.format(x.count)}</td><td>${hours(x.days)}</td></tr>`).join("") || '<tr><td colspan="4" class="base-empty">Nenhuma paralisação.</td></tr>'}
          </tbody></table></div></section>
      </div>
      <section class="base-sheet"><div class="base-sheet-head"><div><p class="eyebrow">OCORRÊNCIAS</p><h3>${int.format(v.events.length)} registros do SOF</h3></div><span>tempos como no SOF; nos indicadores, proporcionais ao tempo de operação</span></div>
        <div class="base-table-scroll"><table class="base-table sof-event-table"><thead><tr><th>Início</th><th>Fim</th><th>Duração</th><th>Período</th><th>Terno</th><th>Porão</th><th>Descrição</th><th>Motivo</th><th>Peso (t)</th></tr></thead><tbody>
        ${v.events.map(e => `<tr class="${e.responsible === "Cargo" ? "" : "is-stop"}"><td>${shortDate(e.start)}</td><td>${shortDate(e.end)}</td><td>${minutesText(e.minutes)}</td><td>${escape(e.period || "")}</td><td>${escape(e.gang || "")}</td><td>${escape(e.hold || "")}</td>
          <th>${escape(e.description)}</th><td><i class="sof-dot" style="background:${RESP_COLORS[e.responsible] || "#ccc"}"></i>${escape((e.reasonText || "").replace(/^Not worked due to /, "").replace(/\.$/, "") || "—")}<small>${label(e.responsible)}${e.reasonFixed ? " · motivo fixado nesta ocorrência" : ""}</small></td><td>${e.weight ? two.format(e.weight) : ""}</td></tr>`).join("")}
        </tbody></table></div></section>
      <section class="base-sheet"><div class="base-sheet-head"><div><p class="eyebrow">HISTÓRICO</p><h3>Alterações feitas no painel</h3></div></div>
        ${(v.changes || []).length ? `<ol class="sof-history">${[...v.changes].reverse().map(c => `<li><p><b>${fmtDate(c.at)}</b> · ${escape(c.by || "—")}</p><ul>${c.items.map(item => `<li>${escape(item)}</li>`).join("")}</ul></li>`).join("")}</ol>` : '<p class="base-empty">Nenhuma alteração: os dados estão como vieram do SOF.</p>'}
      </section>`;
  }

  /* Edição: campos do navio em cima e a tabela de ocorrências (redesenhada sozinha ao incluir ou tirar linhas). */
  async function startEdit() {
    try { await dictionary(); } catch (error) { alert(error.message); return; }
    const v = state.page.vessel;
    state.page.draft = { events: v.events.map(e => ({ id: e.id, ...localParts(e.start), minutes: e.minutes, gang: e.gang || "", hold: e.hold || "", description: e.description, reason: e.reason || "", volume: e.volume ?? "", weight: e.weight ?? "" })) };
    renderVesselPage();
  }

  function editorHtml(v) {
    return `<div class="sof-form">
        <label>Navio<input id="sofEVessel" value="${escape(v.vessel)}"></label>
        <label>Carga<input id="sofECargo" value="${escape(v.cargo)}"></label>
        <label>Operação<select id="sofEOperation">${S.OPERATIONS.map(o => `<option ${o === v.operation ? "selected" : ""}>${o}</option>`).join("")}</select></label>
        <label>Volume (t)<input id="sofETons" type="number" step="0.001" min="0" value="${v.tons}"></label>
        <label>Berço<input id="sofEBerth" value="${escape(v.berth || "")}"></label>
        <label>Cliente<input id="sofEClient" value="${escape(v.client || "")}"></label>
        <label>Atracação<input id="sofEBerthStart" type="datetime-local" value="${toLocalInput(v.berthStart)}"></label>
        <label>Início da operação<input id="sofEStart" type="datetime-local" value="${toLocalInput(v.operationStart)}"></label>
        <label>Término da operação<input id="sofEEnd" type="datetime-local" value="${toLocalInput(v.operationEnd)}"></label>
        <label>Desatracação<input id="sofEBerthEnd" type="datetime-local" value="${toLocalInput(v.berthEnd)}"></label>
      </div>
      <p class="sof-note">Berço, cliente, atracação e desatracação vêm da planilha de navios; mudados aqui, passam a valer o que você digitou. Trocar o motivo de uma ocorrência vale só para ela; para mudar todas as da mesma descrição, use Padronizar.</p>
      <div class="base-table-scroll"><table class="base-table sof-edit-table"><thead><tr><th>Data</th><th>Hora</th><th>Minutos</th><th>Terno</th><th>Porão</th><th>Descrição</th><th>Motivo</th><th>Peso (t)</th><th></th></tr></thead><tbody id="sofEditRows"></tbody></table></div>
      <div class="sof-upload-actions"><button type="button" class="base-upload" data-sof-add-event>+ Incluir ocorrência</button><p id="sofEditStatus" class="base-status" role="status"></p>
        <button type="button" class="base-reset" data-sof-cancel-edit>Cancelar</button><button type="button" class="sof-primary" data-sof-save-edit>Salvar alterações</button></div>`;
  }

  function renderDraftRows() {
    const cell = (i, field, value, attrs = "") => `<td><input data-ev="${i}" data-field="${field}" value="${escape(value)}" ${attrs}></td>`;
    $("sofEditRows").innerHTML = state.page.draft.events.map((e, i) => `<tr>
      ${cell(i, "date", e.date, 'type="date"')}${cell(i, "time", e.time, 'type="time"')}${cell(i, "minutes", e.minutes, 'type="number" min="0" max="2880" step="1"')}
      ${cell(i, "gang", e.gang)}${cell(i, "hold", e.hold)}${cell(i, "description", e.description, 'class="is-wide"')}
      <td><select data-ev="${i}" data-field="reason" aria-label="Motivo">${e.reason ? "" : '<option value="">Escolha…</option>'}${reasonOptions(e.reason)}</select></td>
      ${cell(i, "weight", e.weight, 'type="number" step="0.001" min="0"')}
      <td><button type="button" class="sof-std-ok" data-sof-remove-event="${i}" aria-label="Tirar esta ocorrência">Tirar</button></td></tr>`).join("");
  }

  async function saveVesselEdit() {
    const p = state.page, status = $("sofEditStatus");
    const number = value => value === "" || value === null || value === undefined ? null : Number(value);
    const events = [];
    for (const [i, e] of p.draft.events.entries()) {
      const start = Date.parse(`${e.date}T${e.time || "00:00"}:00-03:00`);
      if (!Number.isFinite(start)) { status.textContent = `Confira a data e a hora da ocorrência ${i + 1}.`; return; }
      if (!e.reason) { status.textContent = `Escolha o motivo da ocorrência ${i + 1}.`; return; }
      events.push({ id: e.id || "", date: e.date, start: new Date(start).toISOString(), minutes: Number(e.minutes) || 0, gang: e.gang, hold: e.hold, description: e.description, reason: e.reason, volume: number(e.volume), weight: number(e.weight) });
    }
    const body = { vessel: $("sofEVessel").value, cargo: $("sofECargo").value, operation: $("sofEOperation").value, tons: Number($("sofETons").value), berth: $("sofEBerth").value, client: $("sofEClient").value,
      berthStart: fromLocalInput($("sofEBerthStart").value), operationStart: fromLocalInput($("sofEStart").value), operationEnd: fromLocalInput($("sofEEnd").value), berthEnd: fromLocalInput($("sofEBerthEnd").value), events };
    status.textContent = "Salvando…";
    const response = await fetch(`/api/sof/navio?id=${encodeURIComponent(p.vessel.id)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) { status.textContent = result.error || "Não foi possível salvar."; return; }
    if (!result.changes.length) { status.textContent = "Nada mudou."; return; }
    state.dictionary = null;
    await load(true);
    await openVessel(result.id);
  }

  async function deleteVessel(id, undo) {
    const question = undo ? "Desfazer as edições deste navio? Ele volta a ser como está no histórico da Base SOF, e o registro das alterações é apagado." : "Apagar este SOF enviado? Os indicadores voltam a usar a Base SOF (se houver) para este navio.";
    if (!confirm(question)) return;
    const response = await fetch(`/api/sof/navios?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { alert(body.error || "Não foi possível apagar."); return; }
    closeVesselPage();
    await load(true);
  }

  /* ---------- Envio de SOF ---------- */

  async function dictionary(force = false) {
    if (state.dictionary && !force) return state.dictionary;
    const response = await fetch("/api/sof/dicionario");
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Não foi possível ler o dicionário de responsáveis.");
    state.reasons = body.reasons || [];
    state.canStandardize = Boolean(body.canStandardize);
    return state.dictionary = body.dictionary;
  }

  /* Motivos padrão: o texto sem o "Not worked due to", e a lista agrupada por responsável para os seletores. */
  const reasonOf = code => (state.reasons || []).find(r => r.code === code);
  const reasonName = reason => reason ? reason.text.replace(/^Not worked due to /, "").replace(/\.$/, "") : "";
  const reasonOptions = (selected = "") => S.RESPONSIBLES.map(name => {
    const list = (state.reasons || []).filter(r => r.responsible === name && !r.milestone);
    return list.length ? `<optgroup label="${label(name)}">${list.map(r => `<option value="${r.code}" ${r.code === selected ? "selected" : ""}>${escape(reasonName(r))}</option>`).join("")}</optgroup>` : "";
  }).join("");

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
      // Descrição já ligada a um motivo entra sozinha; a nova mostra os 3 motivos mais parecidos para escolher.
      const known = Object.entries(dict).filter(([, entry]) => entry.reason).map(([key, entry]) => [key, entry.reason]);
      const groups = new Map();
      for (const event of parsed.events) {
        const id = event.key || event.description;
        if (!groups.has(id)) {
          const reason = (event.key && dict[event.key]?.reason) || "";
          groups.set(id, { id, text: event.description, events: [], status: reason ? "padrao" : "nova", reason,
            suggestions: reason ? [] : S.similarReasons(event.description, known, state.reasons) });
        }
        groups.get(id).events.push(event);
      }
      // Navio da planilha de navios: carga, berço, cliente e desatracação.
      const knownVessel = state.vessels.find(v => S.vesselKey(v.vessel) === S.vesselKey(parsed.vessel) && Math.abs(Date.parse(v.operationStart) - Date.parse(parsed.operationStart)) < 2 * 86400000);
      const sheet = await fetch(`/api/sof/planilha?navio=${encodeURIComponent(parsed.vessel)}&inicio=${encodeURIComponent(parsed.berthStart || parsed.operationStart)}`).then(r => r.ok ? r.json() : {}).catch(() => ({}));
      state.upload = { parsed, groups: [...groups.values()], sheet: sheet.match || null, known: knownVessel, showAll: false, creating: null };
      renderUpload();
    } catch (error) {
      box.innerHTML = `<div class="sof-upload-head"><h3>Não foi possível ler o arquivo</h3><button type="button" class="base-reset" data-sof-cancel>Fechar</button></div><p class="base-status">${escape(error.message)}</p>`;
    }
  }

  function renderUpload() {
    const u = state.upload, p = u.parsed, sheet = u.sheet || {};
    const cargos = [...new Set([...state.vessels.map(v => v.cargo), sheet.cargo].filter(Boolean))].sort();
    const count = status => u.groups.filter(g => g.status === status).reduce((n, g) => n + g.events.length, 0);
    const operation = p.operation || sheet.operation || "";
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
      <div class="sof-upload-stats"><span><b>${p.events.length}</b> ocorrências</span><span><b>${count("padrao")}</b> com motivo padrão</span><span class="${count("nova") ? "is-attention" : ""}"><b>${u.groups.filter(g => g.status === "nova").length}</b> descrições fora do padrão</span></div>
      <div id="sofChoices"></div>
      <p class="base-footnote">A escolha fica guardada: no próximo SOF, a mesma descrição já entra com o motivo. ${state.canStandardize ? "Para mudar depois, use Padronizar." : "Se faltar um motivo na lista, peça ao administrador do painel."}</p>
      <div class="sof-upload-actions"><p id="sofSaveStatus" class="base-status" role="status"></p><button type="button" class="sof-primary" id="sofSave">Salvar na Base SOF</button></div>`;
    renderChoices();
  }

  /** Tabela das descrições (redesenhada sozinha, para não apagar o que foi digitado nos campos do navio). */
  function renderChoices() {
    const u = state.upload;
    const pending = u.groups.filter(g => !g.reason).length;
    const visible = u.groups.map((g, i) => ({ g, i })).filter(({ g }) => u.showAll || g.status === "nova");
    const row = ({ g, i }) => {
      if (g.status === "padrao") {
        const reason = reasonOf(g.reason);
        return `<tr><th><strong>${escape(g.text)}</strong></th><td>${g.events.length}</td><td><span class="sof-tag auto">padrão</span></td><td>${escape(reasonName(reason))} <small>${reason ? label(reason.responsible) : ""}</small></td></tr>`;
      }
      const suggested = g.suggestions.map(s => reasonOf(s.code)).filter(Boolean);
      const creating = u.creating === i;
      return `<tr class="is-nova"><th><strong>${escape(g.text)}</strong></th><td>${g.events.length}</td><td><span class="sof-tag ${g.reason ? "auto" : "nova"}">${g.reason ? "escolhido" : "escolher"}</span></td><td>
        <div class="sof-suggest" role="radiogroup" aria-label="Motivos parecidos">${suggested.map(r => `<label class="${g.reason === r.code ? "is-on" : ""}"><input type="radio" name="sofPick${i}" value="${r.code}" data-sof-pick="${i}" ${g.reason === r.code ? "checked" : ""}>${escape(reasonName(r))} <small>${label(r.responsible)}</small></label>`).join("")}</div>
        <select data-sof-reason="${i}" aria-label="Outro motivo"><option value="">${g.reason && !suggested.some(r => r.code === g.reason) ? "" : "Outro motivo…"}</option>${reasonOptions(suggested.some(r => r.code === g.reason) ? "" : g.reason)}${state.canStandardize ? '<option value="__new">+ Criar motivo novo…</option>' : ""}</select>
        ${creating ? `<div class="sof-new-reason"><span>Not worked due to</span><input id="sofNewText" placeholder="Ex.: awaiting tug" value="${escape(u.newText || "")}"><select id="sofNewResp">${S.RESPONSIBLES.map(n => `<option value="${n}" ${n === u.newResp ? "selected" : ""}>${label(n)}</option>`).join("")}</select><button type="button" class="sof-primary" data-sof-create="${i}">Criar</button><button type="button" class="base-reset" data-sof-create-cancel>Cancelar</button><p id="sofNewStatus" class="base-status" role="status"></p></div>` : ""}
      </td></tr>`;
    };
    $("sofChoices").innerHTML = `<div class="sof-upload-tools"><label><input type="checkbox" id="sofShowAll" ${u.showAll ? "checked" : ""}> Mostrar também as que já têm motivo</label><span>${pending ? `${pending} ${pending === 1 ? "descrição sem motivo" : "descrições sem motivo"}` : "Todas as ocorrências têm motivo."}</span></div>
      <div class="base-table-scroll"><table class="base-table sof-choices"><thead><tr><th>Descrição</th><th>Vezes</th><th>Situação</th><th>Motivo</th></tr></thead><tbody>
      ${visible.length ? visible.map(row).join("") : '<tr><td colspan="4" class="base-empty">Nada para escolher: todas as descrições estão no padrão.</td></tr>'}
      </tbody></table></div>`;
    $("sofSave").disabled = Boolean(pending);
  }

  async function createReason(index) {
    const u = state.upload;
    u.newText = $("sofNewText").value; u.newResp = $("sofNewResp").value;
    const response = await fetch("/api/sof/motivos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: u.newText, responsible: u.newResp }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { $("sofNewStatus").textContent = body.error || "Não foi possível criar o motivo."; return; }
    state.reasons = [...state.reasons, body.reason];
    u.groups[index].reason = body.reason.code;
    u.creating = null; u.newText = "";
    renderChoices();
  }

  async function saveUpload() {
    const u = state.upload, p = u.parsed;
    const choice = new Map(u.groups.map(g => [g.id, g.reason]));
    const body = {
      vessel: $("sofFVessel").value, cargo: $("sofFCargo").value, operation: $("sofFOperation").value, tons: Number($("sofFTons").value),
      berthStart: fromLocalInput($("sofFBerthStart").value), operationStart: fromLocalInput($("sofFStart").value), operationEnd: fromLocalInput($("sofFEnd").value),
      berthEnd: fromLocalInput($("sofFBerthEnd").value), berth: $("sofFBerth").value, client: $("sofFClient").value,
      arrival: p.arrival, invoiceTons: p.invoiceTons, cargoDescription: p.cargoDescription, fileName: p.fileName, model: p.model,
      events: p.events.map(e => {
        const reason = reasonOf(choice.get(e.key || e.description));
        return { date: e.date, start: e.start, minutes: e.minutes, gang: e.gang, hold: e.hold, description: e.description, volume: e.volume, weight: e.weight, reason: reason?.code || "", responsible: reason?.responsible || "" };
      })
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
    const search = $("sofDictSearch")?.value || "";
    const onlyMixed = $("sofDictMixed")?.checked || false;
    const key = S.normalizeDescription(search);
    const entries = Object.entries(state.dictionary).map(([id, entry]) => ({ id, entry, rank: S.ranking(entry) }))
      .filter(({ id, entry, rank }) => (!key || id.includes(key) || S.normalizeDescription(entry.text).includes(key)) && (!onlyMixed || (!entry.fixed && rank.share < S.AUTO_SHARE)))
      .sort((a, b) => b.rank.total - a.rank.total);
    const shown = entries.slice(0, 150);
    const box = $("sofDictionary");
    const keepFocus = document.activeElement?.id === "sofDictSearch";
    box.innerHTML = `<div class="sof-upload-head"><div><p class="eyebrow">DICIONÁRIO DE RESPONSÁVEIS</p><h3>${int.format(Object.keys(state.dictionary).length)} descrições conhecidas</h3></div><button type="button" class="base-reset" data-sof-dict-close>Fechar</button></div>
      <p class="base-footnote">Cada descrição guarda quantas vezes recebeu cada responsável. Acima de ${int.format(S.AUTO_SHARE * 100)}% para o mesmo responsável, ele é aplicado automaticamente. “Fixar” vale sempre, mesmo com histórico dividido. Descrição ligada a um motivo padrão segue sempre o responsável do motivo.</p>
      <div class="base-filters"><label class="base-search">Buscar descrição<input id="sofDictSearch" type="search" value="${escape(search)}" placeholder="Ex.: awaiting trucks"></label><label class="sof-check"><input type="checkbox" id="sofDictMixed" ${onlyMixed ? "checked" : ""}> Só as divididas (sem fixar)</label></div>
      <div class="base-table-scroll"><table class="base-table sof-choices"><thead><tr><th>Descrição</th><th>Registros</th><th>Histórico</th><th>Usado hoje</th><th>Fixar</th></tr></thead><tbody>
      ${shown.map(({ id, entry, rank }) => `<tr><th><strong>${escape(entry.text)}</strong>${entry.reason ? `<small>motivo padrão: ${escape(entry.reasonText)}</small>` : entry.fixed && entry.fixedBy ? `<small>fixado por ${escape(entry.fixedBy)}</small>` : ""}</th><td>${int.format(rank.total)}</td><td>${rank.counts.slice(0, 4).map(([n, c]) => `${label(n)} ${int.format(c)}`).join(" · ") || "—"}</td><td>${entry.reason ? `<span class="sof-tag auto">${label(entry.fixed)} (motivo)</span>` : entry.fixed ? `<span class="sof-tag auto">${label(entry.fixed)} (fixo)</span>` : rank.share >= S.AUTO_SHARE ? `<span class="sof-tag auto">${label(rank.top)}</span>` : `<span class="sof-tag confirmar">confirmar</span>`}</td>
        <td>${entry.reason ? "—" : `<select data-sof-fix="${escape(id)}"><option value="">${entry.fixed ? "Soltar" : "—"}</option>${S.RESPONSIBLES.map(n => `<option value="${n}" ${entry.fixed === n ? "selected" : ""}>${label(n)}</option>`).join("")}</select>`}</td></tr>`).join("") || '<tr><td colspan="5" class="base-empty">Nenhuma descrição encontrada.</td></tr>'}
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

  /* ---------- Padronizar (administrador): cada descrição da base → motivo padrão ---------- */

  const STD_STATUS = { conferida: "conferida", importacao: "da importação", automatica: "automática", "sem-motivo": "sem motivo" };

  async function openStandardize() {
    const box = $("sofStandardize");
    box.hidden = false;
    box.innerHTML = '<p class="base-status">Lendo as descrições da base…</p>';
    const response = await fetch("/api/sof/padronizar");
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { box.innerHTML = `<div class="sof-upload-head"><h3>Padronizar</h3><button type="button" class="base-reset" data-sof-std-close>Fechar</button></div><p class="base-status">${escape(body.error || "Não foi possível ler as descrições.")}</p>`; return; }
    state.reasons = body.reasons;
    state.std = { items: body.descriptions, selected: new Set(), status: "pendentes", reason: "", search: "", operation: false, changed: false };
    box.innerHTML = `<div class="sof-upload-head"><div><p class="eyebrow">PADRONIZAR PARALISAÇÕES</p><h3 id="sofStdTitle"></h3></div><button type="button" class="base-reset" data-sof-std-close>Fechar</button></div>
      <div class="sof-std-progress"><span id="sofStdBar"></span></div>
      <p class="base-footnote">Cada descrição da base aponta para um motivo padrão, e o motivo define o responsável. Trocar o motivo vale para todas as ocorrências daquela descrição, inclusive as já salvas, e marca a descrição como conferida.</p>
      <div class="base-filters">
        <label class="base-search">Buscar descrição<input id="sofStdSearch" type="search" placeholder="Ex.: crane"></label>
        <label>Situação<select id="sofStdStatus"><option value="pendentes">Para conferir</option><option value="conferida">Conferidas</option><option value="">Todas</option></select></label>
        <label>Motivo<select id="sofStdReason"><option value="">Todos</option>${reasonOptions()}</select></label>
        <label class="sof-check"><input type="checkbox" id="sofStdOperation"> Incluir operação e marcos</label>
      </div>
      <div class="sof-std-bulk"><span id="sofStdCount"></span><select id="sofStdMoveTo" aria-label="Mover para o motivo"><option value="">Mover para…</option>${reasonOptions()}</select><button type="button" class="base-upload" id="sofStdMove">Mover</button><button type="button" class="base-upload" id="sofStdConfirm">Marcar como conferidas</button><span id="sofStdStatusText" class="base-status" role="status"></span></div>
      <details class="sof-std-new"><summary>Criar motivo novo</summary><div class="sof-new-reason"><span>Not worked due to</span><input id="sofStdNewText" placeholder="Ex.: awaiting tug"><select id="sofStdNewResp">${S.RESPONSIBLES.map(n => `<option value="${n}">${label(n)}</option>`).join("")}</select><button type="button" class="sof-primary" id="sofStdCreate">Criar</button></div><p class="sof-note">Para criar um motivo de Carga (operação), o texto entra sem o "Not worked due to".</p></details>
      <div id="sofStdTable"></div>`;
    renderStandardize();
  }

  const isOperation = item => reasonOf(item.reason)?.responsible === "Cargo";
  function stdVisible() {
    const s = state.std, key = S.normalizeDescription(s.search);
    return s.items.filter(item => (s.operation || !isOperation(item)) &&
      (!s.status || (s.status === "pendentes" ? item.status !== "conferida" : item.status === s.status)) &&
      (!s.reason || item.reason === s.reason) && (!key || item.key.includes(key) || S.normalizeDescription(item.text).includes(key)));
  }

  function renderStandardize() {
    const s = state.std;
    const stops = s.items.filter(item => !isOperation(item));
    const total = stops.reduce((sum, item) => sum + item.minutes, 0);
    const done = stops.filter(item => item.status === "conferida").reduce((sum, item) => sum + item.minutes, 0);
    const share = total ? done / total : 0;
    $("sofStdTitle").textContent = `${int.format(stops.length)} descrições de paralisação · ${int.format(share * 100)}% das horas conferidas`;
    $("sofStdBar").style.width = `${share * 100}%`;
    const visible = stdVisible(), shown = visible.slice(0, 200);
    $("sofStdCount").textContent = `${int.format(s.selected.size)} ${s.selected.size === 1 ? "selecionada" : "selecionadas"}`;
    const hours = minutes => `${minutes >= 600 ? int.format(minutes / 60) : (minutes / 60).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} h`;
    $("sofStdTable").innerHTML = `<div class="base-table-scroll"><table class="base-table sof-choices sof-std"><thead><tr><th><input type="checkbox" id="sofStdAll" aria-label="Selecionar todas as mostradas" ${shown.length && shown.every(i => s.selected.has(i.key)) ? "checked" : ""}></th><th>Descrição</th><th>Vezes</th><th>Horas</th><th>Navios</th><th>Motivo</th><th>Situação</th></tr></thead><tbody>
      ${shown.map(item => `<tr><td><input type="checkbox" data-sof-std-pick="${escape(item.key)}" ${s.selected.has(item.key) ? "checked" : ""} aria-label="Selecionar"></td>
        <th><strong>${escape(item.text)}</strong>${item.variants > 1 ? `<small>${item.variants} jeitos de escrever</small>` : ""}</th><td>${int.format(item.count)}</td><td>${hours(item.minutes)}</td><td>${int.format(item.vessels)}</td>
        <td><select data-sof-std-reason="${escape(item.key)}" aria-label="Motivo">${item.reason ? "" : '<option value="">Escolha…</option>'}${reasonOptions(item.reason)}</select><small>${label(reasonOf(item.reason)?.responsible || "")}</small></td>
        <td><span class="sof-tag ${item.status === "conferida" ? "auto" : item.status === "sem-motivo" ? "nova" : "confirmar"}">${STD_STATUS[item.status]}</span>${item.status !== "conferida" && item.reason ? `<button type="button" class="sof-std-ok" data-sof-std-ok="${escape(item.key)}">Conferir</button>` : ""}</td></tr>`).join("")
        || '<tr><td colspan="7" class="base-empty">Nenhuma descrição com esses filtros.</td></tr>'}
      </tbody></table></div>${visible.length > shown.length ? `<p class="base-footnote">Mostrando ${shown.length} de ${int.format(visible.length)}, das que têm mais horas para as que têm menos. Use a busca ou os filtros para achar as demais.</p>` : ""}`;
  }

  /** Grava o motivo (ou só confere, sem reason) das descrições e atualiza a lista sem recarregar. */
  async function applyStandard(keys, reason) {
    if (!keys.length) { $("sofStdStatusText").textContent = "Selecione pelo menos uma descrição."; return; }
    $("sofStdStatusText").textContent = "Gravando…";
    const response = await fetch("/api/sof/padronizar", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keys, reason }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { $("sofStdStatusText").textContent = body.error || "Não foi possível gravar."; renderStandardize(); return; }
    const set = new Set(keys);
    for (const item of state.std.items) if (set.has(item.key)) { if (reason) item.reason = reason; item.status = "conferida"; }
    state.std.selected.clear();
    state.std.changed = true; state.dictionary = null;
    $("sofStdStatusText").textContent = `${int.format(keys.length)} ${keys.length === 1 ? "descrição gravada" : "descrições gravadas"}.`;
    renderStandardize();
  }

  async function createStdReason() {
    const response = await fetch("/api/sof/motivos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: $("sofStdNewText").value, responsible: $("sofStdNewResp").value }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { $("sofStdStatusText").textContent = body.error || "Não foi possível criar o motivo."; return; }
    state.reasons = [...state.reasons, body.reason];
    $("sofStdNewText").value = "";
    $("sofStdStatusText").textContent = `Motivo criado: ${body.reason.text}`;
    // Os seletores de motivo passam a ter o novo.
    $("sofStdReason").innerHTML = `<option value="">Todos</option>${reasonOptions(state.std.reason)}`;
    $("sofStdMoveTo").innerHTML = `<option value="">Mover para…</option>${reasonOptions(body.reason.code)}`;
    renderStandardize();
  }

  async function closeStandardize() {
    const box = $("sofStandardize");
    box.hidden = true; box.innerHTML = "";
    const changed = state.std?.changed;
    state.std = null;
    if (changed) await load(true);
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
      // Colunas calculadas saem como fórmula do Excel (com o valor do painel já preenchido, para abrir pronto).
      // Navios: A ID … H Atracação, I Início, J Fim, K Desatracação, L Toneladas, M–O tempos, P–V horas por responsável, W–Y pranchas, Z ocorrências.
      // Ocorrências: A ID do navio, E Início, F Fim, G Duração (min), L Responsável, O código do motivo padrão.
      const last = 1 + body.vessels.reduce((sum, v) => sum + v.events.length, 0);
      const occ = column => `'Ocorrências'!$${column}$2:$${column}$${last}`;
      const respColumn = S.RESPONSIBLES.map((_, i) => String.fromCharCode(80 + i)); // P…V
      const resp = name => respColumn[S.RESPONSIBLES.indexOf(name)];
      const formula = (cell, f) => cell ? { ...cell, f } : { t: "s", v: "", f };
      XLSX.utils.book_append_sheet(book, sheet(
        ["ID", "Origem", "Navio", "Operação", "Carga", "Cliente", "Berço", "Atracação", "Início da operação", "Fim da operação", "Desatracação", "Toneladas",
          "Espera p/ operar (h)", "Tempo atracado (h)", "Tempo de operação (h)", ...S.RESPONSIBLES.map(n => `Horas: ${label(n)}`),
          "Prancha bruta (t/dia)", "Prancha líquida (t/dia)", "Prancha Triunfo (t/dia)", "Ocorrências", "Na planilha de navios", "Arquivo do SOF", "Enviado por", "Enviado em"],
        body.vessels.map((v, i) => {
          const s = v.summary, r = i + 2;
          return [v.id, origin(v), v.vessel, v.operation, v.cargo, v.client || "", v.berth || "", xlDate(v.berthStart), xlDate(v.operationStart), xlDate(v.operationEnd), xlDate(v.berthEnd), xlNum(v.tons, "#,##0.000"),
            formula(xlHours(s.waitDays), `IF(AND(H${r}<>"",I${r}<>""),(I${r}-H${r})*24,"")`),
            formula(xlHours(s.berthDays), `IF(AND(H${r}<>"",K${r}<>""),(K${r}-H${r})*24,"")`),
            formula(xlHours(s.operationDays), `(J${r}-I${r})*24`),
            // Tempo de cada responsável = minutos dele ÷ minutos de todas as ocorrências × tempo de operação.
            ...S.RESPONSIBLES.map(n => formula(xlHours(s.byResponsible[n]),
              `IFERROR(SUMIFS(${occ("G")},${occ("A")},$A${r},${occ("L")},"${label(n)}")/SUMIFS(${occ("G")},${occ("A")},$A${r})*$O${r},0)`)),
            formula(xlNum(s.grossRate, "#,##0"), `IFERROR(L${r}/(O${r}/24),"")`),
            formula(xlNum(s.netRate, "#,##0"), `IFERROR(L${r}/(${resp("Cargo")}${r}/24),"")`),
            formula(xlNum(s.triunfoRate, "#,##0"), `IFERROR(L${r}/((${resp("Cargo")}${r}+${resp("Terminal")}${r})/24),"")`),
            formula({ t: "n", v: v.events.length }, `COUNTIF(${occ("A")},A${r})`),
            v.matched ? "Sim" : "Não", v.fileName || "", v.savedBy || "", xlDate(v.savedAt)];
        }),
        [16, 12, 26, 13, 18, 22, 12, 16, 16, 16, 16, 12, 11, 11, 11, ...S.RESPONSIBLES.map(() => 11), 12, 12, 12, 11, 11, 30, 18, 16]), "Navios");
      let row = 1;
      XLSX.utils.book_append_sheet(book, sheet(
        ["ID do navio", "Navio", "Origem", "Data", "Início", "Fim", "Duração (min)", "Período", "Terno", "Porão", "Descrição", "Responsável", "Volume", "Peso (t)", "Código do motivo", "Motivo padrão"],
        body.vessels.flatMap(v => v.events.map(e => {
          row++;
          return [v.id, v.vessel, origin(v), xlDay(e.date), xlDate(e.start), formula(xlDate(e.end), `E${row}+G${row}/1440`), e.minutes, e.period || "", e.gang || "", e.hold || "",
            e.description, label(e.responsible), xlNum(e.volume, "#,##0"), xlNum(e.weight, "#,##0.000"), e.reason || "", e.reasonText || ""];
        })),
        [16, 24, 12, 11, 16, 16, 10, 9, 8, 8, 70, 14, 9, 10, 10, 50]), "Ocorrências");
      // Motivos: horas e ocorrências de cada motivo padrão somadas da aba Ocorrências (O = código, G = duração).
      XLSX.utils.book_append_sheet(book, sheet(
        ["Código", "Responsável", "Motivo padrão", "Ocorrências", "Horas"],
        body.reasons.map((reason, i) => {
          const r = i + 2, events = body.vessels.flatMap(v => v.events).filter(e => e.reason === reason.code);
          return [reason.code, label(reason.responsible), reason.text,
            formula({ t: "n", v: events.length }, `COUNTIF(${occ("O")},A${r})`),
            formula(xlNum(events.reduce((sum, e) => sum + (e.minutes || 0), 0) / 60, "#,##0.0"), `SUMIFS(${occ("G")},${occ("O")},A${r})/60`)];
        }),
        [10, 14, 60, 12, 10]), "Motivos");
      // Dicionário: F…L são as contagens por responsável; total, mais usado e % saem delas.
      XLSX.utils.book_append_sheet(book, sheet(
        ["Descrição", "Responsável fixado", "Responsável mais usado", "% do mais usado", "Vezes usada", ...S.RESPONSIBLES.map(label), "Motivo padrão"],
        Object.values(body.dictionary).map(entry => ({ entry, rank: S.ranking(entry) })).sort((a, b) => b.rank.total - a.rank.total).map(({ entry, rank }, i) => {
          const r = i + 2, counts = `F${r}:L${r}`;
          return [entry.text, entry.fixed ? label(entry.fixed) : "",
            formula({ t: "s", v: rank.top ? label(rank.top) : "" }, `IF(E${r}=0,"",INDEX($F$1:$L$1,MATCH(MAX(${counts}),${counts},0)))`),
            formula(xlNum(rank.share, "0%"), `IFERROR(MAX(${counts})/E${r},"")`),
            formula({ t: "n", v: rank.total }, `SUM(${counts})`),
            ...S.RESPONSIBLES.map(n => entry.counts[n] || null), entry.reasonText || ""];
        }),
        [70, 14, 16, 10, 10, ...S.RESPONSIBLES.map(() => 10), 50]), "Dicionário");
      XLSX.writeFile(book, `base-sof-${new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10)}.xlsx`, { compression: true });
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
    $("sofOpenStandardize").addEventListener("click", openStandardize);
    $("sofExport").addEventListener("click", exportBase);
    $("sofVesselRows").addEventListener("click", event => { const row = event.target.closest("[data-sof-id]"); if (row) openVessel(row.dataset.sofId); });
    $("sofVesselRows").addEventListener("keydown", event => { const row = event.target.closest("[data-sof-id]"); if (row && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); openVessel(row.dataset.sofId); } });
    const page = $("sofVesselPage");
    page.addEventListener("click", event => {
      const t = event.target;
      if (t.closest("[data-sof-back]")) { closeVesselPage(); return; }
      if (t.closest("[data-sof-edit]")) { startEdit(); return; }
      if (t.closest("[data-sof-cancel-edit]")) { state.page.draft = null; renderVesselPage(); return; }
      if (t.closest("[data-sof-save-edit]")) { saveVesselEdit(); return; }
      const del = t.closest("[data-sof-delete]");
      if (del) { deleteVessel(del.dataset.sofDelete, del.hasAttribute("data-sof-undo")); return; }
      if (t.closest("[data-sof-add-event]")) {
        const list = state.page.draft.events, last = list[list.length - 1];
        list.push({ id: "", date: last?.date || localParts(state.page.vessel.operationStart).date, time: "", minutes: 0, gang: "", hold: "", description: "", reason: "", volume: "", weight: "" });
        renderDraftRows();
        return;
      }
      const remove = t.closest("[data-sof-remove-event]");
      if (remove) { state.page.draft.events.splice(Number(remove.dataset.sofRemoveEvent), 1); renderDraftRows(); }
    });
    const editField = event => { const t = event.target; if (t.dataset.ev === undefined || !state.page?.draft) return; state.page.draft.events[Number(t.dataset.ev)][t.dataset.field] = t.value; };
    page.addEventListener("input", editField);
    page.addEventListener("change", editField);
    const upload = $("sofUpload");
    upload.addEventListener("click", event => {
      if (event.target.closest("[data-sof-cancel]")) { state.upload = null; upload.hidden = true; upload.innerHTML = ""; }
      if (event.target.closest("#sofSave")) saveUpload();
      const create = event.target.closest("[data-sof-create]");
      if (create) createReason(Number(create.dataset.sofCreate));
      if (event.target.closest("[data-sof-create-cancel]")) { state.upload.creating = null; renderChoices(); }
    });
    upload.addEventListener("change", event => {
      const u = state.upload;
      if (!u) return;
      if (event.target.id === "sofShowAll") { u.showAll = event.target.checked; renderChoices(); return; }
      const pick = event.target.closest("[data-sof-pick]");
      if (pick) { u.groups[Number(pick.dataset.sofPick)].reason = pick.value; u.creating = null; renderChoices(); return; }
      const select = event.target.closest("[data-sof-reason]");
      if (!select) return;
      const index = Number(select.dataset.sofReason);
      if (select.value === "__new") { u.creating = index; u.newResp ||= "Terminal"; renderChoices(); $("sofNewText").focus(); return; }
      if (select.value) { u.groups[index].reason = select.value; u.creating = null; renderChoices(); }
    });
    const std = $("sofStandardize");
    std.addEventListener("click", event => {
      if (event.target.closest("[data-sof-std-close]")) { closeStandardize(); return; }
      const ok = event.target.closest("[data-sof-std-ok]");
      if (ok) { applyStandard([ok.dataset.sofStdOk], ""); return; }
      if (event.target.id === "sofStdMove") {
        const to = $("sofStdMoveTo").value;
        if (!to) { $("sofStdStatusText").textContent = "Escolha o motivo de destino."; return; }
        applyStandard([...state.std.selected], to);
        return;
      }
      if (event.target.id === "sofStdConfirm") { applyStandard([...state.std.selected], ""); return; }
      if (event.target.id === "sofStdCreate") createStdReason();
    });
    std.addEventListener("input", event => { if (event.target.id === "sofStdSearch") { state.std.search = event.target.value; renderStandardize(); } });
    std.addEventListener("change", event => {
      const s = state.std, t = event.target;
      if (!s) return;
      if (t.id === "sofStdStatus") s.status = t.value;
      else if (t.id === "sofStdReason") s.reason = t.value;
      else if (t.id === "sofStdOperation") s.operation = t.checked;
      else if (t.id === "sofStdAll") { for (const item of stdVisible().slice(0, 200)) { if (t.checked) s.selected.add(item.key); else s.selected.delete(item.key); } }
      else if (t.dataset.sofStdPick !== undefined) { if (t.checked) s.selected.add(t.dataset.sofStdPick); else s.selected.delete(t.dataset.sofStdPick); }
      else if (t.dataset.sofStdReason !== undefined) { if (t.value) applyStandard([t.dataset.sofStdReason], t.value); return; }
      else return;
      renderStandardize();
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
