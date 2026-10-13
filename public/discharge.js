(() => {
  const months = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
  const number = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const integer = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
  const shortDate = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "UTC" });
  const $ = id => document.getElementById(id);
  const state = { data: null, ready: false, chartPoints: [] };
  const timeFormat = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
  const sourceNote = () => {
    const data = state.data || {};
    if (data.origin === "fallback") return "planilha do Google indisponível no momento · exibindo a última base salva";
    return data.generatedAt ? `planilha lida em ${timeFormat.format(new Date(data.generatedAt))}` : "base atualizada";
  };
  const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const tons = value => `${number.format(value)} t`;
  const duration = value => `${integer.format(Math.floor(value / 60))}h ${String(Math.round(value % 60)).padStart(2, "0")}min`;
  const dateLabel = value => shortDate.format(new Date(`${value}T00:00:00Z`));
  const todayISO = () => {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    const field = type => parts.find(part => part.type === type)?.value;
    return `${field("year")}-${field("month")}-${field("day")}`;
  };
  const addDays = (iso, offset) => {
    const date = new Date(`${iso}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + offset);
    return date.toISOString().slice(0, 10);
  };
  const monthKey = (year, month) => `${year}-${String(month).padStart(2, "0")}`;

  function fillSelect(id, values, allLabel) {
    $(id).innerHTML = `<option value="">${allLabel}</option>${values.map(value => `<option value="${value}">${value}</option>`).join("")}`;
  }
  function lastWeek() {
    const end = todayISO();
    $("dischargeEnd").value = end;
    $("dischargeStart").value = addDays(end, -7);
    $("dischargeYear").value = "";
    $("dischargeMonth").value = "";
    renderDischarge();
  }
  function setPeriodFromSelect() {
    const year = Number($("dischargeYear").value) || Number($("dischargeEnd").value.slice(0, 4)) || new Date().getFullYear();
    const month = Number($("dischargeMonth").value);
    if (month) {
      $("dischargeYear").value = String(year);
      $("dischargeStart").value = `${year}-${String(month).padStart(2, "0")}-01`;
      $("dischargeEnd").value = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    } else if ($("dischargeYear").value) {
      $("dischargeStart").value = `${year}-01-01`;
      $("dischargeEnd").value = `${year}-12-31`;
    } else {
      lastWeek(); return;
    }
    renderDischarge();
  }
  function applyDateInputs() {
    $("dischargeYear").value = "";
    $("dischargeMonth").value = "";
    renderDischarge();
  }
  function renderDischarge() {
    if (!state.data) return;
    const start = $("dischargeStart").value, end = $("dischargeEnd").value;
    if (!start || !end || start > end) { $("dischargeStatus").textContent = "Selecione um intervalo de datas válido."; return; }
    const days = state.data.dischargeDays.filter(item => item.date >= start && item.date <= end);
    const events = state.data.occurrences.filter(item => item.date >= start && item.date <= end);
    const total = days.reduce((sum, item) => sum + item.tons, 0);
    const wagons = days.reduce((sum, item) => sum + item.wagons, 0);
    const stopped = events.reduce((sum, item) => sum + item.minutes, 0);
    $("dischargeTons").textContent = tons(total);
    $("dischargeWagons").textContent = integer.format(wagons);
    $("dischargeAverage").textContent = tons(days.length ? total / days.length : 0);
    $("dischargeStopTime").textContent = duration(stopped);
    $("dischargeStatus").textContent = `${dateLabel(start)} a ${dateLabel(end)} · ${days.length} dias com descarga · ${sourceNote()}`;
    $("dischargeStatus").dataset.kind = state.data.origin === "fallback" ? "warning" : "";
    $("dischargeMethodNote").textContent = `Descarga reconhecida pela data da coluna “DATA DA DESCARGA” e status “FINALIZADO”. ${state.data.inProgress?.records || 0} registros “EM DESCARGA” sem data de conclusão não entram no volume realizado.`;
    renderDaily(days, start, end);
    renderPlan(start, end);
    renderOccurrences(events);
  }
  function renderDaily(days, start, end) {
    const map = new Map(days.map(item => [item.date, item]));
    const dayCount = Math.round((new Date(`${end}T00:00:00Z`) - new Date(`${start}T00:00:00Z`)) / 86400000) + 1;
    const monthly = dayCount > 45;
    const points = [];
    if (monthly) {
      let cursor = start.slice(0, 7);
      const last = end.slice(0, 7);
      for (let i = 0; cursor <= last && i < 120; i++) {
        const [year, month] = cursor.split("-").map(Number);
        const value = days.filter(item => item.date.startsWith(cursor)).reduce((sum, item) => sum + item.tons, 0);
        points.push({ label: `${months[month - 1].slice(0, 3)}/${String(year).slice(2)}`, value });
        cursor = month === 12 ? `${year + 1}-01` : monthKey(year, month + 1);
      }
    } else {
      for (let i = 0; i < dayCount; i++) {
        const date = addDays(start, i);
        points.push({ label: dayCount > 14 ? date.slice(8, 10) : dateLabel(date), fullLabel: dateLabel(date), value: map.get(date)?.tons || 0, showLabel: dayCount <= 14 || i % (dayCount > 28 ? 5 : 3) === 0 || i === dayCount - 1 });
      }
    }
    $("dischargeChartCaption").textContent = monthly ? "Agrupado por mês para períodos longos" : `${points.length} dias no intervalo`;
    state.chartPoints=points;
    $("dischargeDailyRows").innerHTML=points.map(point=>`<tr><td>${escape(point.fullLabel||point.label)}</td><td>${tons(point.value)}</td></tr>`).join("") || '<tr><td colspan="2">Sem dados.</td></tr>';
    const peak=[...points].sort((a,b)=>b.value-a.value)[0];
    $("dischargeDailyInsight").textContent=peak?.value>0?`Leitura: maior volume ${monthly?"mensal":"diário"} em ${peak.fullLabel||peak.label}, com ${tons(peak.value)}. Os períodos sem descarga concluída aparecem com zero.`:"Leitura: não há descarga concluída no intervalo selecionado.";
    const chart=$("dischargeDailyChart");
    chart.classList.toggle("is-compact",!monthly&&points.length>14);
    chart.classList.toggle("is-monthly",monthly);
    chart.closest(".base-chart-scroll").classList.toggle("long-range",monthly);
    $("dischargeChartDetail").textContent="Passe o mouse ou toque em uma coluna para ver o valor exato.";
    if (!points.some(point => point.value > 0)) { chart.innerHTML = '<p class="base-empty">Sem descarga concluída neste período.</p>'; return; }
    const max = Math.max(...points.map(point => point.value));
    chart.style.setProperty("--chart-columns",Math.max(7,points.length));
    chart.innerHTML=points.map((point,index)=>`<div class="base-day" data-index="${index}" role="img" aria-label="${escape(point.fullLabel||point.label)}: ${escape(tons(point.value))}" title="${escape(point.fullLabel||point.label)}: ${escape(tons(point.value))}"><div class="base-day-value">${point.value?(points.length>14&&!monthly?`${new Intl.NumberFormat("pt-BR",{maximumFractionDigits:1}).format(point.value/1000)} mil`:integer.format(point.value)):"0"}</div><div class="base-day-track"><i style="height:${point.value?Math.max(3,point.value/max*100):0}%"></i></div><span>${point.showLabel===false?"":escape(point.label)}</span></div>`).join("");
  }
  function renderPlan(start, end) {
    const selected = state.data.plans.filter(item => monthKey(item.year, item.month) >= start.slice(0, 7) && monthKey(item.year, item.month) <= end.slice(0, 7));
    const latest = selected.at(-1);
    $("dischargePlanPeriod").textContent = latest ? `${months[latest.month - 1]} de ${latest.year}` : "Sem plano para o período";
    $("dischargePlanCards").innerHTML = latest ? [["DESAFIO", latest.challenge], ["PLANO", latest.plan], ["REALIZADO", latest.actual]].map(([label, value]) => `<article><span>${label}</span><strong>${value === null ? "—" : tons(value)}</strong></article>`).join("") : '<p class="base-empty">Não há desafio, plano ou realizado mensal informado para o intervalo.</p>';
    const max = Math.max(1, ...selected.flatMap(item => [item.challenge || 0, item.plan || 0, item.actual || 0]));
    $("dischargePlanHistory").innerHTML = selected.map(item => `<div class="base-plan-month"><strong>${months[item.month - 1].slice(0, 3)} ${item.year}</strong>${[["Desafio", item.challenge, "challenge"], ["Plano", item.plan, "plan"], ["Realizado", item.actual, "actual"]].map(([label, value, kind]) => `<div class="base-plan-line"><span>${label}</span><div class="base-plan-track"><i class="${kind}" style="width:${value ? value / max * 100 : 0}%"></i></div><b>${value === null ? "—" : integer.format(value)}</b></div>`).join("")}</div>`).join("");
  }
  function renderOccurrences(events) {
    const groups = new Map();
    events.forEach(item => {
      const key = `${item.code}\u0000${item.reason}`;
      const row = groups.get(key) || { reason: item.reason, code: item.code, count: 0, minutes: 0 };
      row.count += item.count;
      row.minutes += item.minutes;
      groups.set(key, row);
    });
    const rows = [...groups.values()].sort((a, b) => b.minutes - a.minutes || b.count - a.count);
    $("dischargeOccurrenceCaption").textContent = `${events.reduce((sum, item) => sum + item.count, 0)} registros · ${rows.length} tipos`;
    if (!rows.length) { $("dischargeOccurrenceList").innerHTML = '<p class="base-empty">Sem ocorrências registradas neste período.</p>'; return; }
    const max = Math.max(1, ...rows.map(item => item.minutes));
    $("dischargeOccurrenceList").innerHTML = rows.map(item => `<div class="base-occurrence"><div><strong>${escape(item.reason)}</strong><small>${escape(item.code)} · ${integer.format(item.count)} ${item.count === 1 ? "registro" : "registros"}</small></div><div class="base-occurrence-track"><i style="width:${item.minutes ? Math.max(2, item.minutes / max * 100) : 0}%"></i></div><b>${duration(item.minutes)}</b></div>`).join("");
  }
  function weighingSelection() {
    const year = Number($("weighingYear").value), month = Number($("weighingMonth").value);
    return state.data.weighings.filter(item => (!year || item.year === year) && (!month || item.month === month));
  }
  function renderWeighing() {
    if (!state.data) return;
    const rows = weighingSelection();
    const sum = key => rows.reduce((value, row) => value + (Number.isFinite(row[key]) ? row[key] : 0), 0);
    const invoice = sum("invoiceTons"), unloaded = sum("unloadedTons"), draft = sum("draftTons");
    const delta = (value, base) => `${value - base > 0 ? "+" : ""}${tons(value - base)}`;
    const pct = (value, base) => base ? `${value - base > 0 ? "+" : ""}${number.format((value - base) / base * 100)}% sobre NF` : "NF indisponível";
    $("weighingInvoice").textContent = tons(invoice);
    $("weighingUnloaded").textContent = tons(unloaded);
    $("weighingDraft").textContent = tons(draft);
    $("weighingUnloadedDelta").textContent = delta(unloaded, invoice);
    $("weighingUnloadedPct").textContent = pct(unloaded, invoice);
    $("weighingDraftDelta").textContent = delta(draft, invoice);
    $("weighingDraftPct").textContent = pct(draft, invoice);
    $("weighingDraftUnloadedDelta").textContent = delta(draft, unloaded);
    $("weighingDraftUnloadedPct").textContent = unloaded ? `${draft - unloaded > 0 ? "+" : ""}${number.format((draft - unloaded) / unloaded * 100)}% sobre o descarregado` : "Peso descarregado indisponível";
    $("weighingStatus").textContent = `${rows.length} ${rows.length === 1 ? "navio" : "navios"} · dados consolidados por mês`;
    $("weighingCount").textContent = `${rows.length} registros`;
    const percentage = (value, base) => value !== null && base > 0 ? (value - base) / base * 100 : null;
    $("weighingTable").querySelector("tbody").innerHTML = rows.slice().sort((a, b) => b.year - a.year || b.month - a.month || a.vessel.localeCompare(b.vessel)).map(row => {
      const unloadedPct = percentage(row.unloadedTons, row.invoiceTons), draftPct = percentage(row.draftTons, row.invoiceTons), draftUnloadedPct = percentage(row.draftTons, row.unloadedTons);
      const pctCell = value => `<td class="${value !== null && Math.abs(value) > 0.5 ? "base-alert" : ""}">${value === null ? "—" : `${value > 0 ? "+" : ""}${number.format(value)}%`}</td>`;
      return `<tr><th><strong>${escape(row.vessel)}</strong><small>${months[row.month - 1]} ${row.year}</small></th><td>${row.invoiceTons === null ? "—" : number.format(row.invoiceTons)}</td><td>${row.unloadedTons === null ? "—" : number.format(row.unloadedTons)}</td><td>${row.draftTons === null ? "—" : number.format(row.draftTons)}</td>${pctCell(unloadedPct)}${pctCell(draftPct)}${pctCell(draftUnloadedPct)}</tr>`;
    }).join("") || '<tr><td colspan="7" class="base-empty">Nenhum navio nos filtros selecionados.</td></tr>';
  }
  function initialize(data) {
    state.data = data;
    const years = [...new Set(data.dischargeDays.map(row => Number(row.date.slice(0, 4))))].sort((a, b) => b - a);
    fillSelect("dischargeYear", years, "Todos os anos");
    $("dischargeMonth").innerHTML = `<option value="">Todos os meses</option>${months.map((month, index) => `<option value="${index + 1}">${month}</option>`).join("")}`;
    fillSelect("weighingYear", [...new Set(data.weighings.map(row => row.year))].sort((a, b) => b - a), "Todos os anos");
    $("weighingMonth").innerHTML = $("dischargeMonth").innerHTML;
    $("weighingYear").value = String(Math.max(...data.weighings.map(row => row.year)));
    lastWeek();
    renderWeighing();
  }
  async function load() {
    if (state.ready) return;
    $("dischargeStatus").textContent = "Lendo a planilha de indicadores no Google…";
    const response = await fetch("/api/discharge");
    if (!response.ok) throw new Error("Não foi possível carregar a base de descarga.");
    const data = await response.json();
    initialize(data);
    const link = $("dischargeSheetLink");
    if (link && data.sheetUrl) { link.href = data.sheetUrl; link.hidden = false; }
    state.ready = true;
  }
  function setup() {
    const chart=$("dischargeDailyChart");
    const showDay=event=>{const item=event.target.closest(".base-day");if(!item||!chart.contains(item))return;const point=state.chartPoints[Number(item.dataset.index)];if(point)$("dischargeChartDetail").textContent=`${point.fullLabel||point.label} · ${tons(point.value)}`};
    chart.addEventListener("pointerover",showDay);
    chart.addEventListener("click",showDay);
    $("dischargeYear").addEventListener("change", setPeriodFromSelect);
    $("dischargeMonth").addEventListener("change", setPeriodFromSelect);
    $("dischargeStart").addEventListener("change", applyDateInputs);
    $("dischargeEnd").addEventListener("change", applyDateInputs);
    $("dischargeLastWeek").addEventListener("click", lastWeek);
    $("weighingYear").addEventListener("change", renderWeighing);
    $("weighingMonth").addEventListener("change", renderWeighing);
  }
  window.dischargePanel = { setup, getUpdatedAt: () => state.ready ? state.data?.generatedAt : null, load: () => load().catch(error => { $("dischargeStatus").textContent = error.message; $("weighingStatus").textContent = error.message; }) };
})();
