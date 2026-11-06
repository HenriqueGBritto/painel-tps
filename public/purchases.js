/* Compras: indicadores do Controle de RMS (planilha no Drive, lida pelo servidor em /api/compras).
   Cálculos em purchases-core.js (window.TpsPurchases). Reaproveita as classes base-* (discharge.css) e sof-* (sof.css). */
(() => {
  const P = window.TpsPurchases;
  const MONTHS = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
  const MONTHS_FULL = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const int = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
  const one = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
  const brl2 = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const money = value => value === null || value === undefined ? "—" : brl.format(value);
  /** Valor curto para gráficos e cartões: R$ 1,2 mi / R$ 350 mil. */
  const short = value => value === null || value === undefined ? "—" : Math.abs(value) >= 1e6 ? `R$ ${one.format(value / 1e6)} mi` : Math.abs(value) >= 1e4 ? `R$ ${int.format(value / 1e3)} mil` : brl.format(value);
  const pct = value => value === null || value === undefined || !Number.isFinite(value) ? "—" : `${one.format(value * 100)}%`;
  const date = day => day ? `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}` : "—";
  const today = () => new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
  const state = { data: null, vessels: null, vesselsError: "", loading: null, filter: { year: null, months: new Set(), type: "", buyer: "", status: "", supplier: "", search: "" }, metric: "value", allSuppliers: false, ready: false };

  async function load(force = false) {
    if (state.data && !force) return;
    if (state.loading) return state.loading;
    $("purchasesStatus").textContent = "Lendo o Controle de RMS…";
    state.loading = fetch("/api/compras").then(async response => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Não foi possível ler o Controle de RMS.");
      state.data = { ...body, records: P.prepare(body.records || []) };
      setupFilters();
      $("purchasesStatus").textContent = "";
      const link = body.files?.[0]?.url;
      $("purchasesSheet").hidden = !link;
      if (link) $("purchasesSheet").href = link;
      render();
      window.renderDataSeal?.();
      loadVessels();
    }).catch(error => { $("purchasesStatus").textContent = error.message; }).finally(() => { state.loading = null; });
    return state.loading;
  }

  /** Navios da Base SOF (toneladas de cada escala), para o custo por navio. Lido uma vez, sem travar a tela. */
  async function loadVessels() {
    if (state.vessels) return;
    try {
      const response = await fetch("/api/sof");
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Base SOF indisponível agora.");
      state.vessels = body.vessels;
    } catch (error) {
      state.vesselsError = `Não foi possível ler a Base SOF: ${error.message}`;
    }
    if (state.data) renderVessels(filter());
  }

  function setupFilters() {
    const records = state.data.records;
    const years = [...new Set(records.map(r => P.monthOf(r)?.year).filter(Boolean))].sort((a, b) => b - a);
    if (!years.includes(state.filter.year)) state.filter.year = years[0] || null;
    const options = (values, all) => `<option value="">${all}</option>${values.map(v => `<option value="${escape(v)}">${escape(v)}</option>`).join("")}`;
    const distinct = key => [...new Set(records.map(key).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR"));
    $("purchasesYear").innerHTML = `<option value="">Todos</option>${years.map(y => `<option value="${y}">${y}</option>`).join("")}`;
    $("purchasesYear").value = state.filter.year || "";
    $("purchasesMonth").innerHTML = `<option value="">Todos</option>${MONTHS_FULL.map((m, i) => `<option value="${i + 1}">${m}</option>`).join("")}`;
    $("purchasesType").innerHTML = options(distinct(r => r.type), "Todos");
    $("purchasesBuyer").innerHTML = options(distinct(r => r.buyer), "Todos");
    $("purchasesStatusFilter").innerHTML = options(distinct(r => r.status), "Todos");
    $("purchasesSupplierList").innerHTML = distinct(r => r.supplier).map(s => `<option value="${escape(s)}"></option>`).join("");
  }

  const filter = (extra = {}) => P.filterRecords(state.data.records, { ...state.filter, search: "", ...extra });
  const kpi = (title, value, note, extra = "") => `<article><span>${title}</span><strong>${value}</strong>${extra}<small>${note}</small></article>`;

  /** Mesmo período do ano anterior, para o cartão de gasto. */
  function previousPeriod() {
    const f = state.filter;
    if (!f.year) return null;
    const months = f.months.size ? f.months : new Set(P.budgetMonths(state.data.records, f.year, null));
    return P.filterRecords(state.data.records, { ...f, search: "", year: f.year - 1, months });
  }

  function render() {
    if (!state.data) return;
    const f = state.filter, rows = filter(), now = today();
    const t = P.totals(rows, now);
    const prevRows = previousPeriod();
    const prev = prevRows && prevRows.length ? P.totals(prevRows, now) : null;
    const months = f.year ? P.budgetMonths(state.data.records, f.year, f.months) : [];
    // Tipo com orçamento que nunca aparece nas RMS (rebocadores, pesagem) é pago por outro caminho: fica fora do cartão.
    const inRms = new Set(state.data.records.map(r => r.type));
    const compare = (f.year ? P.budgetCompare(rows, state.data.budget?.byType, months) : []).map(c => ({ ...c, outside: !inRms.has(c.type) }));
    const counted = compare.filter(c => !c.outside);
    const budgetTotal = counted.reduce((s, c) => s + c.budget, 0), budgetSpent = counted.reduce((s, c) => s + c.value, 0);
    const delta = prev && prev.value ? (t.value / prev.value - 1) : null;
    const period = `${f.year || "todos os anos"}${f.months.size ? ` · ${[...f.months].map(m => MONTHS_FULL[m - 1].toLowerCase()).join(", ")}` : ""}${f.type ? ` · ${f.type}` : ""}${f.buyer ? ` · ${f.buyer}` : ""}${f.status ? ` · ${f.status}` : ""}${f.supplier ? ` · ${f.supplier}` : ""}`;
    $("purchasesSummary").textContent = `${int.format(t.count)} RMS · ${period}`;
    $("purchasesKpis").innerHTML = [
      kpi("GASTO", short(t.value), "valor da NF (sem NF, o da RMS) · sem canceladas", delta === null ? "" : `<small class="sof-delta ${delta > 0 ? "bad" : "good"}">${delta > 0 ? "▲" : "▼"} ${pct(Math.abs(delta))} × ${f.year - 1}</small>`),
      kpi("RMS", int.format(t.count), prev ? `${f.year - 1}: ${int.format(prev.count)} no mesmo período` : "no período"),
      kpi("ORÇADO × REALIZADO", budgetTotal ? pct(budgetSpent / budgetTotal) : "—", budgetTotal ? `${short(budgetSpent)} de ${short(budgetTotal)} nos tipos com orçamento que passam por RMS` : "escolha um ano para comparar"),
      kpi("EM ABERTO", int.format(t.open.count), `${short(t.open.value)} · ${int.format(t.open.late)} fora do prazo`),
      kpi("PRAZO DE ATENDIMENTO", t.onTime === null ? "—" : pct(t.onTime), t.medianDays === null ? "sem RMS finalizadas com término" : `dentro do prazo · mediana de ${int.format(t.medianDays)} dias`),
      kpi("FORA DO ORÇAMENTO", short(t.unbudgeted.value), `${int.format(t.unbudgeted.count)} RMS em tipos sem orçamento no TPS · ponto de atenção abaixo`)
    ].join("");
    renderChart();
    renderBudget(compare, months);
    renderTypes(rows);
    renderAttention(rows, t.value);
    renderSuppliers(rows, t.value);
    renderNf(rows, t.nf);
    renderOpen(rows, now);
    renderApplications(rows);
    renderVessels(rows);
    renderPrices(rows);
    renderIssues(rows, now);
    renderList();
  }

  function renderChart() {
    const f = state.filter;
    const current = f.year || Math.max(...state.data.records.map(r => P.monthOf(r)?.year || 0));
    const years = [current - 1, current];
    const series = P.monthly(state.data.records, years, f, state.metric);
    const format = state.metric === "count" ? v => `${int.format(v)} RMS` : short;
    const max = Math.max(1, ...series.flat().filter(v => v !== null));
    $("purchasesChartTitle").textContent = `${years[0]} × ${years[1]} · ${state.metric === "count" ? "Quantidade de RMS" : "Gasto"}`;
    $("purchasesChartLegend").innerHTML = years.map((y, i) => `<span><i class="sof-legend s${i}"></i>${y}</span>`).join("");
    $("purchasesChart").innerHTML = MONTHS.map((m, i) => `<div class="sof-month${f.months.has(i + 1) ? " is-selected" : ""}">
      <div class="sof-bars">${years.map((y, s) => { const v = series[s][i]; return `<i class="s${s}" style="height:${v === null ? 0 : Math.max(2, v / max * 100)}%" title="${m}/${y}: ${v === null ? "sem RMS" : escape(format(v))}"></i>`; }).join("")}</div>
      <span>${m}</span></div>`).join("");
    $("purchasesChartHead").innerHTML = `<tr><th>Mês</th>${years.map(y => `<th>${y}</th>`).join("")}</tr>`;
    $("purchasesChartRows").innerHTML = MONTHS_FULL.map((m, i) => `<tr><th>${m}</th>${years.map((y, s) => `<td>${series[s][i] === null ? "—" : escape(state.metric === "count" ? int.format(series[s][i]) : money(series[s][i]))}</td>`).join("")}</tr>`).join("");
  }

  function renderBudget(compare, months) {
    const label = months.length ? (months.length === 1 ? MONTHS_FULL[months[0] - 1] : `${MONTHS[months[0] - 1]} a ${MONTHS[months.at(-1) - 1]}`) : "";
    $("purchasesBudgetPeriod").textContent = label ? `${label} de ${state.filter.year}` : "";
    $("purchasesBudget").innerHTML = compare.length ? compare.map(c => {
      const share = c.share === null ? 0 : c.share;
      return `<div class="sof-resp${share > 1 ? " is-over" : ""}${c.outside ? " is-outside" : ""}"><div><strong>${escape(c.type)}</strong><small>${c.outside ? `orçado ${short(c.budget)} · pago pela Controladoria, sem RMS` : `${short(c.value)} de ${short(c.budget)}`}</small></div>
        <div class="sof-track"><i style="width:${Math.min(100, share * 100)}%"></i><b style="left:100%" title="Limite do orçamento"></b></div><span>${c.outside ? "—" : pct(c.share)}</span></div>`;
    }).join("") + '<p class="base-footnote">Tipos com orçamento no TPS (aba Orçamento por Categoria). Os que nunca aparecem nas RMS, como rebocadores, são pagos pela Controladoria (estão no nosso centro de custo porque nós usamos) e ficam fora do cartão Orçado × realizado.</p>'
      : '<div class="base-empty">Escolha um ano para comparar com o orçamento.</div>';
  }

  function renderTypes(rows) {
    const groups = P.groupBy(rows, r => r.type);
    const max = Math.max(1, ...groups.map(g => g.value));
    const total = groups.reduce((s, g) => s + g.value, 0);
    $("purchasesTypes").innerHTML = groups.length ? groups.slice(0, 14).map(g => `<div class="sof-resp"><div><strong>${escape(g.key)}</strong><small>${int.format(g.count)} RMS${g.budgeted === false ? " · sem orçamento" : ""}</small></div>
      <div class="sof-track"><i style="width:${g.value / max * 100}%"${g.budgeted === false ? ' class="is-muted"' : ""}></i></div><span>${short(g.value)}<small>${pct(total ? g.value / total : null)}</small></span></div>`).join("")
      + (groups.length > 14 ? `<p class="base-footnote">E mais ${groups.length - 14} tipos, somando ${short(groups.slice(14).reduce((s, g) => s + g.value, 0))}.</p>` : "")
      : '<div class="base-empty">Nenhuma RMS nos filtros.</div>';
  }

  /** Ponto de atenção: gasto em tipos sem orçamento no TPS. Entra no total, mas fica separado para avaliar se deve ir para o orçamento. */
  function renderAttention(rows, total) {
    const groups = P.groupBy(rows.filter(r => r.budgeted === false), r => r.type);
    const value = groups.reduce((s, g) => s + g.value, 0);
    $("purchasesAttentionTotal").textContent = groups.length ? `${short(value)} · ${pct(total ? value / total : null)} do gasto` : "";
    $("purchasesAttention").innerHTML = groups.map(g => `<tr><th>${escape(g.key)}</th><td>${int.format(g.count)}</td><td>${money(g.value)}</td><td>${pct(total ? g.value / total : null)}</td></tr>`).join("")
      || '<tr><td colspan="4" class="base-empty">Nenhum gasto em tipo sem orçamento nos filtros.</td></tr>';
  }

  function renderSuppliers(rows, total) {
    const groups = P.groupBy(rows, r => r.supplier);
    const shown = state.allSuppliers ? groups : groups.slice(0, 15);
    $("purchasesSupplierCount").textContent = `${int.format(groups.length)} fornecedores`;
    $("purchasesSuppliers").innerHTML = shown.map((g, i) => `<tr><th>${i + 1}. ${escape(g.key)}</th><td>${int.format(g.count)}</td><td>${money(g.value)}</td><td>${pct(total ? g.value / total : null)}</td><td>${g.medianDays === null ? "—" : `${int.format(g.medianDays)} dias`}</td></tr>`).join("")
      || '<tr><td colspan="5" class="base-empty">Nenhuma RMS nos filtros.</td></tr>';
    $("purchasesSuppliersMore").hidden = groups.length <= 15;
    $("purchasesSuppliersMore").textContent = state.allSuppliers ? "Mostrar só os 15 maiores" : `Mostrar todos os ${groups.length}`;
  }

  function renderNf(rows, nf) {
    const list = P.nfDifferences(rows);
    $("purchasesNfSummary").textContent = nf.count ? `${int.format(nf.count)} RMS com NF baixada · NF ${nf.diff >= 0 ? "acima" : "abaixo"} da RMS em ${money(Math.abs(nf.diff))} no total · ${int.format(nf.over10)} com diferença maior que 10%` : "Nenhuma RMS com valor de NF nos filtros.";
    $("purchasesNf").innerHTML = list.slice(0, 15).map(r => `<tr><th>${escape(r.rms || "—")}<small>${escape(r.product)}</small></th><td>${escape(r.supplier)}</td><td>${money(r.total)}</td><td>${money(r.nfTotal)}</td><td class="${r.diff > 0 ? "base-alert" : ""}">${r.diff > 0 ? "+" : ""}${pct(r.diffShare)}</td></tr>`).join("")
      || '<tr><td colspan="5" class="base-empty">Nenhuma diferença acima de 10%.</td></tr>';
  }

  function renderOpen(rows, now) {
    const list = P.openList(rows, now);
    $("purchasesOpenCount").textContent = `${int.format(list.length)} em aberto`;
    $("purchasesOpen").innerHTML = list.slice(0, 60).map(r => `<tr class="${r.late ? "is-late" : ""}"><th>${escape(r.rms || "—")}<small>${escape(r.product)}</small></th><td>${escape(r.supplier)}</td><td>${escape(r.buyer)}</td><td>${date(r.opened)}</td><td>${r.daysOpen === null ? "—" : `${int.format(r.daysOpen)} dias`}</td><td>${r.deadline} dias${r.purchaseType ? `<small>${r.purchaseType.toLowerCase()}</small>` : ""}</td><td>${money(r.amount)}</td></tr>`).join("")
      || '<tr><td colspan="7" class="base-empty">Nenhuma RMS em aberto nos filtros.</td></tr>';
    $("purchasesOpenNote").textContent = state.data.hasPurchaseType ? "Em vermelho, fora do prazo: compra cotada 30 dias, compra direta 15 dias." : "Em vermelho, fora do prazo. A planilha ainda não tem a coluna Tipo de compra (cotada ou direta): por enquanto todas contam 30 dias; com a coluna, a compra direta passa a contar 15.";
  }

  function renderApplications(rows) {
    const groups = P.groupBy(rows, r => r.application);
    const max = Math.max(1, ...groups.map(g => g.value)), total = groups.reduce((s, g) => s + g.value, 0);
    $("purchasesAppCount").textContent = `${int.format(groups.length)} aplicações`;
    $("purchasesApps").innerHTML = groups.slice(0, 15).map(g => `<div class="sof-resp"><div><strong>${escape(g.key)}</strong><small>${int.format(g.count)} RMS</small></div>
      <div class="sof-track"><i style="width:${g.value / max * 100}%"></i></div><span>${short(g.value)}<small>${pct(total ? g.value / total : null)}</small></span></div>`).join("")
      || '<div class="base-empty">Nenhuma RMS nos filtros.</div>';
  }

  function renderVessels(rows) {
    if (!state.vessels) { $("purchasesVessels").innerHTML = `<tr><td colspan="5" class="base-empty">${escape(state.vesselsError || "Lendo a Base SOF…")}</td></tr>`; $("purchasesVesselCount").textContent = ""; return; }
    const list = P.vesselCosts(rows, state.vessels, window.TpsSof.vesselKey);
    $("purchasesVesselCount").textContent = `${int.format(list.length)} escalas · ${short(list.reduce((s, v) => s + v.value, 0))}`;
    $("purchasesVessels").innerHTML = list.slice(0, 20).map(v => `<tr><th>${escape(v.vessel)}<small>${escape([v.cargo, (v.operation || "").toLowerCase(), date((v.operationStart || "").slice(0, 10))].filter(Boolean).join(" · "))}</small></th><td>${int.format(v.count)}</td><td>${money(v.value)}</td><td>${v.tons ? int.format(v.tons) : "—"}</td><td>${v.perTon === null ? "—" : brl2.format(v.perTon)}</td></tr>`).join("")
      || '<tr><td colspan="5" class="base-empty">Nenhuma RMS com nome de navio da Base SOF nos filtros.</td></tr>';
  }

  function renderPrices(rows) {
    const list = P.priceHistory(rows);
    $("purchasesPriceCount").textContent = `${int.format(list.length)} itens`;
    $("purchasesPrices").innerHTML = list.slice(0, 25).map(p => {
      const history = p.prices.map(x => `${date(x.date)} · ${brl2.format(x.price)} · ${x.supplier}`).join("\n");
      return `<tr title="${escape(history)}"><th>${escape(p.product)}</th><td>${int.format(p.times)}</td><td>${int.format(p.suppliers)}</td><td>${brl2.format(p.min)}</td><td>${brl2.format(p.median)}</td><td>${brl2.format(p.max)}</td>
        <td>${brl2.format(p.last.price)}<small>${date(p.last.date)} · ${escape(p.last.supplier)}</small></td><td class="${p.change > 0.2 ? "base-alert" : ""}">${p.change === null ? "—" : `${p.change > 0 ? "+" : ""}${pct(p.change)}`}</td></tr>`;
    }).join("") || '<tr><td colspan="8" class="base-empty">Nenhum item comprado 3 vezes ou mais nos filtros.</td></tr>';
  }

  function renderIssues(rows, now) {
    const list = P.issues(rows, now);
    const lines = new Set(list.flatMap(i => i.rows.map(r => r.line)));
    $("purchasesIssueCount").textContent = `${int.format(lines.size)} de ${int.format(rows.length)} linhas com alguma pendência`;
    const row = r => `<tr><th>${escape(r.rms || "—")}<small>${escape(r.product)}</small></th><td>linha ${r.line}</td><td>${escape(r.supplier)}</td><td>${escape(r.status)}</td><td>${date(r.opened)}</td><td>${money(r.total)}</td></tr>`;
    $("purchasesIssues").innerHTML = list.map(i => `<details><summary><b>${int.format(i.rows.length)}</b> ${escape(i.label)}</summary>
      <div class="base-table-scroll"><table class="base-table purchases-table"><thead><tr><th>RMS</th><th>Linha na planilha</th><th>Fornecedor</th><th>Status</th><th>Abertura</th><th>Valor</th></tr></thead><tbody>${i.rows.slice(0, 50).map(row).join("")}</tbody></table></div>
      ${i.rows.length > 50 ? `<p class="base-footnote">Mostrando 50 de ${int.format(i.rows.length)}.</p>` : ""}</details>`).join("") || '<p class="base-empty">Nenhuma pendência nos filtros.</p>';
  }

  function renderList() {
    const rows = P.filterRecords(state.data.records, state.filter).sort((a, b) => (b.opened || "").localeCompare(a.opened || ""));
    $("purchasesListCount").textContent = `${int.format(rows.length)} ${rows.length === 1 ? "linha" : "linhas"}`;
    $("purchasesList").innerHTML = rows.slice(0, 100).map(r => `<tr><th>${escape(r.rms || "—")}<small>${escape(r.product)}</small></th><td>${escape(r.nf || "—")}</td><td>${escape(r.supplier)}</td><td>${escape(r.application)}</td><td>${escape(r.type)}</td><td><span class="purchases-status s-${escape(r.status.toLowerCase().replace(/\s+/g, "-"))}">${escape(r.status)}</span></td><td>${date(r.opened)}</td><td>${date(r.closed)}</td><td>${money(r.amount)}</td></tr>`).join("")
      || '<tr><td colspan="9" class="base-empty">Nenhuma RMS encontrada.</td></tr>';
    $("purchasesListMore").textContent = rows.length > 100 ? `Mostrando as 100 mais recentes de ${int.format(rows.length)}. Use a busca ou os filtros para achar as demais.` : "";
  }

  function setup() {
    const f = state.filter;
    $("purchasesYear").addEventListener("change", event => { f.year = Number(event.target.value) || null; render(); });
    $("purchasesMonth").addEventListener("change", event => { f.months = event.target.value ? new Set([Number(event.target.value)]) : new Set(); render(); });
    $("purchasesType").addEventListener("change", event => { f.type = event.target.value; render(); });
    $("purchasesBuyer").addEventListener("change", event => { f.buyer = event.target.value; render(); });
    $("purchasesStatusFilter").addEventListener("change", event => { f.status = event.target.value; render(); });
    $("purchasesSupplier").addEventListener("input", event => { f.supplier = event.target.value; render(); });
    $("purchasesClear").addEventListener("click", () => {
      Object.assign(f, { months: new Set(), type: "", buyer: "", status: "", supplier: "", search: "" });
      ["purchasesMonth", "purchasesType", "purchasesBuyer", "purchasesStatusFilter", "purchasesSupplier", "purchasesSearch"].forEach(id => { $(id).value = ""; });
      render();
    });
    $("purchasesMetric").addEventListener("change", event => { state.metric = event.target.value; renderChart(); });
    $("purchasesSuppliersMore").addEventListener("click", () => { state.allSuppliers = !state.allSuppliers; render(); });
    $("purchasesSearch").addEventListener("input", event => { f.search = event.target.value; renderList(); });
  }

  window.purchasesPanel = {
    /** Mostra a aba e lê a planilha na primeira vez. */
    show(active) {
      if (!active) return;
      if (!state.ready) { setup(); state.ready = true; }
      load();
    },
    /** Depois do botão "Atualizar dados": lê de novo e redesenha. */
    reload: () => load(true),
    getMeta: () => state.data ? { origin: state.data.origin, generatedAt: state.data.generatedAt, files: state.data.files, changeLog: [] } : null
  };
})();
