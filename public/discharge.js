(() => {
  const months = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
  const number = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const integer = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
  const shortDate = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "UTC" });
  const $ = id => document.getElementById(id);
  const savedMode = (() => { try { return localStorage.getItem("tps-descarga-grafico"); } catch { return null; } })();
  const state = { data: null, ready: false, chartPoints: [], selectedKey: null, chartMode: ["tons", "wagons", "both"].includes(savedMode) ? savedMode : "tons" };
  const fullDate = value => `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}`;
  const isLastDischargeWindow = (start, end) => {
    const range = TpsMetrics.lastDischargeWindow(state.data.dischargeDays);
    return range.hasData && range.start === start && range.end === end;
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
  /* Padrão e botão "Últimos 7 dias": os 7 dias que terminam na última descarga registrada,
     para nunca abrir num período vazio quando a planilha está alguns dias atrasada. */
  function lastWeek() {
    const range = TpsMetrics.lastDischargeWindow(state.data?.dischargeDays || [], 7, todayISO());
    $("dischargeEnd").value = range.end;
    $("dischargeStart").value = range.start;
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
    renderTargetCard(start, end, days.length ? total / days.length : 0);
    const context = isLastDischargeWindow(start, end) ? " · 7 dias até a última descarga registrada" : "";
    $("dischargeStatus").textContent = `Exibindo ${fullDate(start)} a ${fullDate(end)}${context} · ${days.length} ${days.length === 1 ? "dia" : "dias"} com descarga`;
    $("dischargeMethodNote").textContent = `Descarga reconhecida pela data da coluna “DATA DA DESCARGA” e status “FINALIZADO”. ${state.data.inProgress?.records || 0} registros “EM DESCARGA” sem data de conclusão não entram no volume realizado.`;
    renderDaily(days, start, end);
    renderWeekSummary(start, end);
    renderPlan(start, end);
    renderForecast();
    renderOccurrences(events);
  }
  /* Card "Meta diária": peso que deveria ser descarregado por dia (plano do mês ÷ dias do mês).
     Com mais de um mês no período, mostra a média das metas dos dias do período. */
  function renderTargetCard(start, end, average) {
    const rates = TpsMetrics.dailyTargets(state.data.plans || [], start, end).days.map(day => day.rate).filter(rate => rate !== null);
    if (!rates.length) {
      $("dischargeTarget").textContent = "—";
      $("dischargeTargetNote").textContent = "sem plano do mês para o período";
      return;
    }
    const target = rates.reduce((sum, rate) => sum + rate, 0) / rates.length;
    const sameMonth = rates.every(rate => Math.abs(rate - rates[0]) < 0.5);
    $("dischargeTarget").textContent = `${integer.format(target)} t`;
    const reached = average ? ` · média diária: ${integer.format(average / target * 100)}% da meta` : "";
    $("dischargeTargetNote").textContent = `${sameMonth ? "plano do mês ÷ dias do mês" : "média das metas do período"}${reached}`;
  }

  /* Gráfico diário: "tons" (colunas de peso + meta diária), "wagons" (colunas de vagões)
     ou "both" (colunas de peso + meta, com a linha de vagões numa escala própria). */
  const CHART_TITLES = { tons: "Toneladas descarregadas", wagons: "Vagões descarregados", both: "Toneladas e vagões descarregados" };
  const wagonsText = value => `${integer.format(value)} ${value === 1 ? "vagão" : "vagões"}`;
  function pointDetail(point, mode) {
    const parts = [point.fullLabel || point.label];
    if (mode !== "wagons") parts.push(tons(point.value));
    if (mode !== "tons") parts.push(wagonsText(point.wagons));
    if (mode !== "wagons" && point.target) parts.push(`meta diária ${tons(point.target)}`);
    return parts.join(" · ");
  }
  function renderDaily(days, start, end) {
    const mode = state.chartMode;
    const map = new Map(days.map(item => [item.date, item]));
    const dayCount = Math.round((new Date(`${end}T00:00:00Z`) - new Date(`${start}T00:00:00Z`)) / 86400000) + 1;
    const monthly = dayCount > 45;
    const points = [];
    if (monthly) {
      let cursor = start.slice(0, 7);
      const last = end.slice(0, 7);
      for (let i = 0; cursor <= last && i < 120; i++) {
        const [year, month] = cursor.split("-").map(Number);
        const inMonth = days.filter(item => item.date.startsWith(cursor));
        points.push({ key: cursor, label: `${months[month - 1].slice(0, 3)}/${String(year).slice(2)}`, fullLabel: `${months[month - 1]} de ${year}`, value: inMonth.reduce((sum, item) => sum + item.tons, 0), wagons: inMonth.reduce((sum, item) => sum + item.wagons, 0) });
        cursor = month === 12 ? `${year + 1}-01` : monthKey(year, month + 1);
      }
    } else {
      for (let i = 0; i < dayCount; i++) {
        const date = addDays(start, i);
        points.push({ key: date, label: dayCount > 14 ? date.slice(8, 10) : dateLabel(date), fullLabel: dateLabel(date), value: map.get(date)?.tons || 0, wagons: map.get(date)?.wagons || 0, showLabel: dayCount <= 14 || i % (dayCount > 28 ? 5 : 3) === 0 || i === dayCount - 1 });
      }
    }
    // Meta diária de peso (plano do mês ÷ dias do mês), só na visão por dia.
    const targets = monthly ? { days: [], segments: [] } : TpsMetrics.dailyTargets(state.data.plans || [], start, end);
    const rates = targets.days.map(day => day.rate);
    points.forEach((point, index) => { point.target = rates[index] || null; });
    const showTarget = mode !== "wagons" && targets.segments.length > 0;

    $("dischargeChartTitle").textContent = CHART_TITLES[mode];
    $("dischargeChartCaption").textContent = monthly ? "Agrupado por mês para períodos longos" : `${points.length} dias no intervalo`;
    state.chartPoints = points;
    $("dischargeDailyRows").innerHTML = points.map(point => `<tr><td>${escape(point.fullLabel || point.label)}</td><td>${tons(point.value)}</td><td>${integer.format(point.wagons)}</td><td>${point.target ? tons(point.target) : "—"}</td></tr>`).join("") || '<tr><td colspan="4">Sem dados.</td></tr>';
    const key = mode === "wagons" ? "wagons" : "value";
    const peak = [...points].sort((a, b) => b[key] - a[key])[0];
    const peakText = mode === "wagons" ? wagonsText(peak?.wagons || 0) : tons(peak?.value || 0);
    $("dischargeDailyInsight").textContent = peak?.[key] > 0 ? `Leitura: maior ${mode === "wagons" ? "quantidade de vagões" : "volume"} ${monthly ? "mensal" : mode === "wagons" ? "diária" : "diário"} em ${peak.fullLabel || peak.label}, com ${peakText}. Os períodos sem descarga concluída aparecem com zero.` : "Leitura: não há descarga concluída no intervalo selecionado.";

    const chart = $("dischargeDailyChart");
    chart.classList.toggle("is-compact", !monthly && points.length > 14);
    chart.classList.toggle("is-monthly", monthly);
    chart.closest(".base-chart-scroll").classList.toggle("long-range", monthly);
    $("dischargeChartDetail").textContent = `Passe o mouse para ver o valor exato. Clique em uma coluna para ver as ocorrências ${monthly ? "do mês" : "do dia"}.`;

    const legend = $("dischargeTargetLegend");
    const targetLegend = showTarget ? `<span><i class="base-legend-target" aria-hidden="true"></i>Meta diária: ${[...new Map(targets.segments.map(seg => [`${seg.year}-${seg.month}`, seg])).values()].map(seg => `<strong>${integer.format(seg.rate)} t/dia</strong> em ${months[seg.month - 1].slice(0, 3).toLowerCase()}/${seg.year}`).join(" · ")} (plano do mês ÷ dias do mês)</span>` : "";
    const wagonLegend = mode === "both" ? `<span><i class="base-legend-wagons" aria-hidden="true"></i>Vagões descarregados (linha, escala própria)</span>` : "";
    legend.innerHTML = targetLegend + wagonLegend;
    legend.hidden = !legend.innerHTML;

    if (!points.some(point => point.value > 0 || point.wagons > 0)) { chart.innerHTML = '<p class="base-empty">Sem descarga concluída neste período.</p>'; renderDayOccurrences(); return; }
    const barOf = point => mode === "wagons" ? point.wagons : point.value;
    // Com linha de meta, 8% de folga no topo para a linha não encostar nos rótulos.
    const max = Math.max(1, ...points.map(barOf), ...(showTarget ? rates.filter(rate => rate !== null) : [])) * (showTarget ? 1.08 : 1);
    const compactNumber = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
    const barLabel = point => {
      const value = barOf(point);
      if (!value) return "0";
      if (mode === "wagons") return integer.format(value);
      return points.length > 14 && !monthly ? `${compactNumber.format(value / 1000)} mil` : integer.format(value);
    };
    chart.style.setProperty("--chart-columns", Math.max(7, points.length));
    chart.classList.toggle("is-wagons", mode === "wagons");
    chart.classList.toggle("is-both", mode === "both");
    chart.innerHTML = points.map((point, index) => {
      const detail = escape(pointDetail(point, mode));
      const target = showTarget && rates[index] ? `<b class="base-day-target" style="bottom:${rates[index] / max * 100}%"></b>` : "";
      const selected = point.key === state.selectedKey;
      return `<div class="base-day${selected ? " is-selected" : ""}" data-index="${index}" role="button" tabindex="0" aria-pressed="${selected}" aria-label="${detail}. Ver ocorrências" title="${detail}"><div class="base-day-value">${barLabel(point)}</div><div class="base-day-track"><i style="height:${barOf(point) ? Math.max(3, barOf(point) / max * 100) : 0}%"></i>${target}</div><span>${point.showLabel === false ? "" : escape(point.label)}</span></div>`;
    }).join("") + (mode === "both" ? '<svg class="base-wagon-line" aria-hidden="true"></svg>' : "");
    drawWagonLine();
    renderDayOccurrences();
  }

  /* Linha de vagões sobre as colunas de peso (modo "Peso e vagões"). Desenhada pelas posições reais das colunas,
     por isso é refeita quando o gráfico muda de tamanho. */
  function drawWagonLine() {
    const chart = $("dischargeDailyChart");
    const svg = chart.querySelector(".base-wagon-line");
    if (!svg) return;
    const points = state.chartPoints;
    const tracks = [...chart.querySelectorAll(".base-day-track")];
    if (!tracks.length) return;
    const box = chart.getBoundingClientRect();
    const maxWagons = Math.max(1, ...points.map(point => point.wagons)) * 1.12;
    const coords = tracks.map((track, index) => {
      const rect = track.getBoundingClientRect();
      return { x: rect.left - box.left + rect.width / 2, y: rect.bottom - box.top - points[index].wagons / maxWagons * rect.height, wagons: points[index].wagons };
    });
    svg.setAttribute("width", box.width);
    svg.setAttribute("height", box.height);
    svg.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
    const showValues = points.length <= 14;
    svg.innerHTML = `<polyline points="${coords.map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ")}"></polyline>` +
      coords.map(point => `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="${showValues ? 4 : 3}"></circle>${showValues && point.wagons ? `<text x="${point.x.toFixed(1)}" y="${(point.y - 9).toFixed(1)}">${integer.format(point.wagons)}</text>` : ""}`).join("");
  }
  /* Desempenho da semana: só no filtro "Últimos 7 dias". Compara cada dia com a meta diária
     (plano do mês ÷ dias do mês) e, para os dias abaixo dela, aponta as ocorrências com mais tempo. */
  const WEEKDAYS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
  const weekday = iso => WEEKDAYS[new Date(`${iso}T12:00:00Z`).getUTCDay()];
  const percent = value => `${integer.format(value * 100)}%`;
  const roundTons = value => `${integer.format(value)} t`;
  /** Nome da ocorrência como na planilha, só sem os espaços sobrando dentro dos parênteses. */
  const tidyReason = reason => String(reason).replace(/\(\s+/g, "(").replace(/\s+\)/g, ")");
  function mainOccurrences(date, limit = 2) {
    const groups = new Map();
    state.data.occurrences.filter(item => item.date === date && item.minutes > 0).forEach(item => {
      groups.set(item.reason, (groups.get(item.reason) || 0) + item.minutes);
    });
    return [...groups].sort((a, b) => b[1] - a[1]).slice(0, limit);
  }
  function renderWeekSummary(start, end) {
    const box = $("dischargeWeekSummary");
    if (!isLastDischargeWindow(start, end)) { box.hidden = true; box.innerHTML = ""; return; }
    const targets = TpsMetrics.dailyTargets(state.data.plans || [], start, end).days;
    const byDate = new Map(state.data.dischargeDays.map(item => [item.date, item]));
    const days = targets.map(({ date, rate }) => ({ date, rate, tons: byDate.get(date)?.tons || 0, wagons: byDate.get(date)?.wagons || 0 }));
    const total = days.reduce((sum, day) => sum + day.tons, 0);
    const withTarget = days.filter(day => day.rate);
    const head = `<p class="eyebrow">DESEMPENHO DA SEMANA</p><h4 id="dischargeWeekTitle">${fullDate(start).slice(0, 5)} a ${fullDate(end)}</h4>`;
    if (!withTarget.length) {
      box.innerHTML = `${head}<p>Foram descarregadas <strong>${tons(total)}</strong> na semana. Não há plano do mês na planilha para comparar com a meta diária.</p>`;
      box.hidden = false;
      return;
    }
    const expected = withTarget.reduce((sum, day) => sum + day.rate, 0);
    const reachedTotal = withTarget.reduce((sum, day) => sum + day.tons, 0);
    const average = total / days.length;
    const averageTarget = expected / withTarget.length;
    const below = withTarget.filter(day => day.tons < day.rate);
    const hit = withTarget.length - below.length;
    const gap = expected - reachedTotal;
    const verdict = gap > 0
      ? `A semana fechou <strong>${tons(gap)} abaixo</strong> do esperado para ${withTarget.length} dias (${roundTons(expected)}), com ${percent(reachedTotal / expected)} da meta.`
      : `A semana fechou <strong>${tons(-gap)} acima</strong> do esperado para ${withTarget.length} dias (${roundTons(expected)}), com ${percent(reachedTotal / expected)} da meta.`;
    const summary = `<p>Foram descarregadas <strong>${tons(total)}</strong> em 7 dias, média de <strong>${tons(average)}</strong> por dia, contra a meta diária de ${roundTons(averageTarget)}. ${verdict}</p>
      <p>${hit === withTarget.length ? "<strong>Todos os dias atingiram a meta.</strong>" : `<strong>${hit} de ${withTarget.length} dias</strong> atingiram a meta; ${below.length} ${below.length === 1 ? "ficou abaixo" : "ficaram abaixo"}:`}</p>`;
    const items = below.map(day => {
      const missing = day.rate - day.tons;
      const reasons = mainOccurrences(day.date);
      const why = day.tons === 0 ? "sem descarga concluída" : `${tons(day.tons)} (${percent(day.tons / day.rate)} da meta), faltaram ${tons(missing)}`;
      const causes = reasons.length ? ` Principais ocorrências: ${reasons.map(([reason, minutes]) => `${escape(tidyReason(reason))} (${duration(minutes)})`).join(", ")}.` : " Sem ocorrências com tempo registrado nesse dia.";
      return `<li><strong>${fullDate(day.date).slice(0, 5)} (${weekday(day.date)})</strong>: ${why}.${causes}</li>`;
    }).join("");
    box.innerHTML = `${head}${summary}${items ? `<ul>${items}</ul><p class="base-week-hint">Clique no dia no gráfico para ver todas as ocorrências.</p>` : ""}`;
    box.hidden = false;
  }

  /* Ocorrências do dia (ou do mês, na visão agrupada) da coluna clicada no gráfico. */
  function renderDayOccurrences() {
    const box = $("dischargeDayOccurrences");
    const point = state.chartPoints.find(item => item.key === state.selectedKey);
    if (!point) { box.hidden = true; box.innerHTML = ""; return; }
    const isMonth = point.key.length === 7;
    const events = state.data.occurrences.filter(item => isMonth ? item.date.startsWith(point.key) : item.date === point.key);
    const groups = new Map();
    events.forEach(item => {
      const key = `${item.code}\u0000${item.reason}\u0000${item.responsible}`;
      const row = groups.get(key) || { reason: item.reason, code: item.code, responsible: item.responsible, count: 0, minutes: 0 };
      row.count += item.count;
      row.minutes += item.minutes;
      groups.set(key, row);
    });
    const rows = [...groups.values()].sort((a, b) => b.minutes - a.minutes || b.count - a.count);
    const records = rows.reduce((sum, item) => sum + item.count, 0);
    const minutes = rows.reduce((sum, item) => sum + item.minutes, 0);
    const max = Math.max(1, ...rows.map(item => item.minutes));
    const discharged = `${tons(point.value)} · ${wagonsText(point.wagons)} descarregados`;
    box.innerHTML = `<div class="base-day-occurrences-head">
        <div><p class="eyebrow">OCORRÊNCIAS ${isMonth ? "DO MÊS" : "DO DIA"}</p><h4>${escape(isMonth ? point.fullLabel : fullDate(point.key))}</h4><small>${discharged}${rows.length ? ` · ${integer.format(records)} ${records === 1 ? "registro" : "registros"} · ${duration(minutes)} de ocorrências` : ""}</small></div>
        <button type="button" class="base-day-close" data-close-day aria-label="Fechar ocorrências">×</button>
      </div>
      ${rows.length ? `<div class="base-occurrence-list">${rows.map(item => `<div class="base-occurrence"><div><strong>${escape(item.reason)}</strong><small>${escape(item.code)}${item.code ? " · " : ""}${escape(item.responsible)} · ${integer.format(item.count)} ${item.count === 1 ? "registro" : "registros"}</small></div><div class="base-occurrence-track"><i style="width:${item.minutes / max * 100}%"></i></div><b>${duration(item.minutes)}</b></div>`).join("")}</div>`
        : `<p class="base-empty">Nenhuma ocorrência registrada ${isMonth ? "neste mês" : "neste dia"}.</p>`}`;
    box.hidden = false;
  }
  function selectPoint(index) {
    const point = state.chartPoints[index];
    if (!point) return;
    state.selectedKey = state.selectedKey === point.key ? null : point.key; // clicar de novo fecha
    document.querySelectorAll("#dischargeDailyChart .base-day").forEach(item => {
      const selected = state.chartPoints[Number(item.dataset.index)]?.key === state.selectedKey;
      item.classList.toggle("is-selected", selected);
      item.setAttribute("aria-pressed", String(selected));
    });
    renderDayOccurrences();
    if (state.selectedKey) $("dischargeDayOccurrences").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  function setChartMode(mode) {
    if (!CHART_TITLES[mode]) return;
    state.chartMode = mode;
    try { localStorage.setItem("tps-descarga-grafico", mode); } catch { /* sem armazenamento: vale só nesta visita */ }
    document.querySelectorAll("#dischargeChartMode [data-mode]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.mode === mode)));
    renderDischarge();
  }
  /* Previsão de fechamento do mês atual (qualquer que seja o filtro): no ritmo de hoje, quanto o mês fecha
     contra o plano e o desafio, e quanto falta por dia para alcançá-los. */
  function renderForecast() {
    const box = $("dischargeForecast");
    const today = todayISO();
    const year = Number(today.slice(0, 4)), month = Number(today.slice(5, 7));
    const plan = (state.data.plans || []).find(item => item.year === year && item.month === month) || {};
    const forecast = TpsMetrics.monthForecast(state.data.dischargeDays, { year, month, plan: plan.plan, challenge: plan.challenge });
    const monthName = `${months[month - 1].toLowerCase()}/${year}`;
    const head = `<p class="eyebrow">PREVISÃO DO MÊS</p><h4 id="dischargeForecastTitle">Fechamento de ${monthName}</h4>`;
    if (!forecast) { box.innerHTML = `${head}<p>Ainda não há descarga concluída registrada em ${monthName}.</p>`; box.hidden = false; return; }
    const roundTons = value => `${integer.format(value)} t`;
    const goal = target => {
      if (!target) return "";
      if (target.reached) return `<li class="is-ok"><strong>${target.label[0].toUpperCase()}${target.label.slice(1)} já alcançado</strong>: ${roundTons(forecast.realized)} de ${roundTons(target.value)}.</li>`;
      const status = target.onTrack ? `no ritmo atual, <strong>alcança</strong> (${integer.format(target.share * 100)}% do ${target.label})` : `no ritmo atual, <strong>fica ${roundTons(target.value - forecast.projection)} abaixo</strong> (${integer.format(target.share * 100)}% do ${target.label})`;
      const need = forecast.remaining ? ` Para alcançar: <strong>${roundTons(target.neededPerDay)} por dia</strong> nos ${forecast.remaining} ${forecast.remaining === 1 ? "dia restante" : "dias restantes"}${target.neededPerDay > forecast.pace ? ` (${integer.format((target.neededPerDay / forecast.pace - 1) * 100)}% acima do ritmo atual)` : ""}.` : "";
      return `<li class="${target.onTrack ? "is-ok" : "is-late"}">${target.label[0].toUpperCase()}${target.label.slice(1)} de ${roundTons(target.value)}: ${status}.${need}</li>`;
    };
    const goals = [goal(forecast.plan), goal(forecast.challenge)].join("");
    box.innerHTML = `${head}
      <p>Realizado até ${fullDate(forecast.lastDate)}: <strong>${roundTons(forecast.realized)}</strong> em ${forecast.elapsed} ${forecast.elapsed === 1 ? "dia" : "dias"}, ritmo de <strong>${roundTons(forecast.pace)} por dia</strong>.
      ${forecast.remaining ? `Mantido esse ritmo, o mês fecha em cerca de <strong>${roundTons(forecast.projection)}</strong>.` : "O mês está completo na planilha."}</p>
      ${goals ? `<ul>${goals}</ul>` : `<p class="base-footnote">Sem plano ou desafio do mês na planilha para comparar.</p>`}
      <p class="base-footnote">Ritmo pelos dias corridos até a última descarga registrada (dias sem descarga contam como zero). Realizado pela soma das descargas FINALIZADAS, como no gráfico.</p>`;
    box.hidden = false;
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
  /* Busca pelo nome do navio: trecho do nome, sem diferenciar maiúsculas nem acentos. */
  const searchable = value => String(value || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
  function weighingSelection() {
    const year = Number($("weighingYear").value), month = Number($("weighingMonth").value);
    const query = searchable($("weighingVessel").value);
    return state.data.weighings.filter(item => (!year || item.year === year) && (!month || item.month === month) && (!query || searchable(item.vessel).includes(query)));
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
    const query = $("weighingVessel").value.trim();
    $("weighingStatus").textContent = `${rows.length} ${rows.length === 1 ? "navio" : "navios"}${query ? ` com “${query}” no nome` : ""} · dados consolidados por mês`;
    $("weighingCount").textContent = `${rows.length} registros`;
    const percentage = (value, base) => value !== null && base > 0 ? (value - base) / base * 100 : null;
    $("weighingTable").querySelector("tbody").innerHTML = rows.slice().sort((a, b) => b.year - a.year || b.month - a.month || a.vessel.localeCompare(b.vessel)).map(row => {
      const unloadedPct = percentage(row.unloadedTons, row.invoiceTons), draftPct = percentage(row.draftTons, row.invoiceTons), draftUnloadedPct = percentage(row.draftTons, row.unloadedTons);
      const pctCell = value => `<td class="${value !== null && Math.abs(value) > 0.5 ? "base-alert" : ""}">${value === null ? "—" : `${value > 0 ? "+" : ""}${number.format(value)}%`}</td>`;
      return `<tr><th><strong>${escape(row.vessel)}</strong><small>${months[row.month - 1]} ${row.year}</small></th><td>${row.invoiceTons === null ? "—" : number.format(row.invoiceTons)}</td><td>${row.unloadedTons === null ? "—" : number.format(row.unloadedTons)}</td><td>${row.draftTons === null ? "—" : number.format(row.draftTons)}</td>${pctCell(unloadedPct)}${pctCell(draftPct)}${pctCell(draftUnloadedPct)}</tr>`;
    }).join("") || `<tr><td colspan="7" class="base-empty">${query ? `Nenhum navio com “${escape(query)}” no nome nos filtros selecionados. Para buscar em todo o histórico, escolha “Todos os anos”.` : "Nenhum navio nos filtros selecionados."}</td></tr>`;
  }
  function initialize(data) {
    state.data = data;
    const years = [...new Set(data.dischargeDays.map(row => Number(row.date.slice(0, 4))))].sort((a, b) => b - a);
    fillSelect("dischargeYear", years, "Todos os anos");
    $("dischargeMonth").innerHTML = `<option value="">Todos os meses</option>${months.map((month, index) => `<option value="${index + 1}">${month}</option>`).join("")}`;
    fillSelect("weighingYear", [...new Set(data.weighings.map(row => row.year))].sort((a, b) => b - a), "Todos os anos");
    $("weighingMonth").innerHTML = $("dischargeMonth").innerHTML;
    $("weighingYear").value = String(Math.max(...data.weighings.map(row => row.year)));
    $("weighingVesselList").innerHTML = [...new Set(data.weighings.map(row => row.vessel).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR")).map(name => `<option value="${escape(name)}"></option>`).join("");
    lastWeek();
    renderWeighing();
  }
  let loading = null;
  function load() {
    if (state.ready) return Promise.resolve();
    loading ||= (async () => {
      $("dischargeStatus").textContent = "Lendo a planilha de indicadores no Google…";
      window.renderDataSeal?.();
      const response = await fetch("/api/discharge");
      if (!response.ok) throw new Error("Não foi possível carregar a base de descarga.");
      const data = await response.json();
      initialize(data);
      const link = $("dischargeSheetLink");
      if (link && data.sheetUrl) { link.href = data.sheetUrl; link.hidden = false; }
      state.ready = true;
      window.renderDataSeal?.();
      window.onDischargeReady?.();
    })().finally(() => { loading = null; });
    return loading;
  }
  function setup() {
    const chart=$("dischargeDailyChart");
    const showDay=event=>{const item=event.target.closest(".base-day");if(!item||!chart.contains(item))return;const point=state.chartPoints[Number(item.dataset.index)];if(point)$("dischargeChartDetail").textContent=pointDetail(point,state.chartMode)};
    $("dischargeChartMode").addEventListener("click",event=>{const button=event.target.closest("[data-mode]");if(button)setChartMode(button.dataset.mode)});
    document.querySelectorAll("#dischargeChartMode [data-mode]").forEach(button=>button.setAttribute("aria-pressed",String(button.dataset.mode===state.chartMode)));
    // A linha de vagões depende da largura das colunas: redesenha quando o gráfico muda de tamanho.
    if(window.ResizeObserver)new ResizeObserver(()=>drawWagonLine()).observe(chart);
    chart.addEventListener("pointerover",showDay);
    chart.addEventListener("click",event=>{showDay(event);const item=event.target.closest(".base-day");if(item&&chart.contains(item))selectPoint(Number(item.dataset.index))});
    chart.addEventListener("keydown",event=>{const item=event.target.closest(".base-day");if(!item||!["Enter"," "].includes(event.key))return;event.preventDefault();showDay(event);selectPoint(Number(item.dataset.index))});
    $("dischargeDayOccurrences").addEventListener("click",event=>{if(!event.target.closest("[data-close-day]"))return;state.selectedKey=null;document.querySelectorAll("#dischargeDailyChart .base-day.is-selected").forEach(item=>{item.classList.remove("is-selected");item.setAttribute("aria-pressed","false")});renderDayOccurrences()});
    const userChange = handler => event => { handler(event); window.syncUrl?.(); };
    $("dischargeYear").addEventListener("change", userChange(setPeriodFromSelect));
    $("dischargeMonth").addEventListener("change", userChange(setPeriodFromSelect));
    $("dischargeStart").addEventListener("change", userChange(applyDateInputs));
    $("dischargeEnd").addEventListener("change", userChange(applyDateInputs));
    $("dischargeLastWeek").addEventListener("click", userChange(lastWeek));
    $("weighingYear").addEventListener("change", userChange(renderWeighing));
    $("weighingMonth").addEventListener("change", userChange(renderWeighing));
    $("weighingVessel").addEventListener("input", renderWeighing);
    $("weighingVessel").addEventListener("keydown", event => { if (event.key === "Escape" && event.target.value) { event.target.value = ""; renderWeighing(); } });
  }
  window.dischargePanel = { setup, getUpdatedAt: () => state.ready ? state.data?.generatedAt : null,
    getMeta: () => state.data ? { origin: state.data.origin, lastRecordAt: state.data.lastRecordAt, generatedAt: state.data.generatedAt, fallbackReason: state.data.fallbackReason, changeLog: state.data.changeLog, files: state.data.files } : null,
    isLoading: () => !state.ready,
    getRange: () => ({ start: $("dischargeStart").value || null, end: $("dischargeEnd").value || null }),
    /* Abre um intervalo vindo da URL; sem intervalo, volta ao padrão (7 dias até a última descarga). */
    setRange: (start, end) => {
      if (!state.ready) return;
      if (start && end) { $("dischargeStart").value = start; $("dischargeEnd").value = end; $("dischargeYear").value = ""; $("dischargeMonth").value = ""; renderDischarge(); }
      else lastWeek();
    },
    getWeighing: () => ({ year: Number($("weighingYear").value) || null, month: Number($("weighingMonth").value) || null }),
    setWeighing: (year, month) => {
      if (!state.ready) return;
      const yearSelect = $("weighingYear");
      if (year && [...yearSelect.options].some(option => option.value === String(year))) yearSelect.value = String(year);
      $("weighingMonth").value = month ? String(month) : "";
      renderWeighing();
    }, load: () => load().catch(error => { $("dischargeStatus").textContent = error.message; $("weighingStatus").textContent = error.message; }) };
})();
