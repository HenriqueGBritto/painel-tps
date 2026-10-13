/* Cálculos do painel sem dependência da página (testados em tests/metrics.test.mjs).
   Carregado como script comum no navegador: expõe window.TpsMetrics. */
(function (root) {
  /** Dias sem registro novo na planilha até o selo ficar em alerta. */
  const STALE_DAYS = 7;
  const MONTHS_SHORT = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  const DAY = 86400000;
  const parseDate = value => value ? new Date(value) : null;

  /* ---------- KPIs (mesma lógica que estava em app.js) ---------- */

  function filterRecords(records, years, months) {
    return records.filter(r => (!years.size || years.has(r.year)) && (!months.size || months.has(r.month)));
  }

  function overlapHours(start, end, windowStart, windowEnd) {
    const a = Math.max(start.getTime(), windowStart.getTime());
    const b = Math.min(end.getTime(), windowEnd.getTime());
    return Math.max(0, b - a) / 36e5;
  }

  /** Ocupação média de berço (%). Janelas = meses inteiros dos anos/meses selecionados. */
  function occupancy(records, years, months, periodRecords = records) {
    if (!records.length) return 0;
    const selectedYears = years.size ? [...years] : [...new Set(periodRecords.map(r => r.year))];
    const selectedMonths = months.size ? [...months] : [...Array(12)].map((_, i) => i + 1);
    const windows = [];
    selectedYears.forEach(y => selectedMonths.forEach(m => windows.push([new Date(y, m - 1, 1), new Date(y, m, 1)])));
    const berthNames = [...new Set(records.map(r => r.berth))];
    if (!berthNames.length) return 0;
    const capacity = windows.reduce((sum, [a, b]) => sum + (b - a) / 36e5, 0);
    let totalRatio = 0;
    berthNames.forEach(berth => {
      const intervals = records.filter(r => r.berth === berth).map(r => [parseDate(r.berthStart), parseDate(r.berthEnd)]).filter(([a, b]) => a && b && b > a);
      let used = 0;
      windows.forEach(([wa, wb]) => {
        const clipped = intervals.map(([a, b]) => [new Date(Math.max(a, wa)), new Date(Math.min(b, wb))]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
        const merged = [];
        clipped.forEach(([a, b]) => { const last = merged.at(-1); if (last && a <= last[1]) last[1] = new Date(Math.max(last[1], b)); else merged.push([a, b]); });
        used += merged.reduce((s, [a, b]) => s + overlapHours(a, b, wa, wb), 0);
      });
      totalRatio += capacity ? used / capacity : 0;
    });
    return totalRatio / berthNames.length * 100;
  }

  /** Os quatro cards: navios atendidos, volume total, prancha média/dia e ocupação. */
  function kpis(records, years, months) {
    const data = filterRecords(records, years, months);
    const withProductivity = data.filter(r => r.productivity > 0);
    return {
      vessels: data.length,
      tons: data.reduce((s, r) => s + r.tons, 0),
      productivity: withProductivity.length ? withProductivity.reduce((s, r) => s + r.productivity, 0) / withProductivity.length : 0,
      occupancy: occupancy(data, years, months)
    };
  }

  /* ---------- Comparação com o período anterior ---------- */

  const recordStart = r => parseDate(r.operationStart || r.berthStart);
  const monthLabel = (year, month) => `${MONTHS_SHORT[month - 1]}/${year}`;
  const shiftMonths = (date, delta) => {
    const target = new Date(date.getFullYear(), date.getMonth() + delta, 1, date.getHours(), date.getMinutes());
    const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    target.setDate(Math.min(date.getDate(), lastDay));
    return target;
  };

  /**
   * Período anterior equivalente ao filtro, ou null quando não há comparação
   * ("todos os anos", vários anos ou mês sem ano).
   * Se o período escolhido ainda está em andamento, o anterior é cortado no mesmo ponto
   * (ex.: 1–13/out contra 1–13/set), para não comparar mês parcial com mês inteiro.
   */
  function previousPeriod(years, months, now = new Date()) {
    if (years.size !== 1) return null;
    const year = [...years][0];
    const sortedMonths = [...months].sort((a, b) => a - b);
    let prevYears, prevMonths, label, shift;
    if (sortedMonths.length === 1) {
      const month = sortedMonths[0];
      const prevYear = month === 1 ? year - 1 : year, prevMonth = month === 1 ? 12 : month - 1;
      prevYears = [prevYear]; prevMonths = [prevMonth];
      label = monthLabel(prevYear, prevMonth);
      shift = date => shiftMonths(date, -1);
    } else {
      prevYears = [year - 1]; prevMonths = sortedMonths;
      label = sortedMonths.length ? `mesmos meses de ${year - 1}` : String(year - 1);
      shift = date => shiftMonths(date, -12);
    }
    const lastMonth = sortedMonths.length ? sortedMonths.at(-1) : 12;
    const periodEnd = new Date(year, lastMonth, 1);
    const inProgress = now < periodEnd && now >= new Date(year, (sortedMonths[0] || 1) - 1, 1);
    const cutoff = inProgress ? shift(now) : null;
    if (cutoff) {
      const day = cutoff.getDate(), monthText = MONTHS_SHORT[cutoff.getMonth()];
      label = sortedMonths.length === 1 ? `${label} até dia ${day}` : `${label} até ${day}/${monthText}`;
    }
    return { years: new Set(prevYears), months: new Set(prevMonths), label, inProgress, cutoff };
  }

  /** KPIs do período anterior, já cortados no mesmo ponto quando o atual está em andamento. */
  function previousKpis(records, period) {
    const pool = period.cutoff ? records.filter(r => { const d = recordStart(r); return d && d <= period.cutoff; }) : records;
    return kpis(pool, period.years, period.months);
  }

  /** Variação percentual: { pct, direction: "up" | "down" | "flat" } ou null sem base. */
  function variation(current, previous) {
    if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
    const pct = (current - previous) / Math.abs(previous) * 100;
    const rounded = Math.round(pct * 10) / 10;
    return { pct, direction: rounded > 0 ? "up" : rounded < 0 ? "down" : "flat" };
  }

  /** Variação de um card. A prancha é uma média: período sem navio não tem prancha, não é "zero". */
  function kpiVariation(field, current, previous) {
    if (field === "productivity" && (!current.productivity || !previous.productivity)) return null;
    return variation(current[field], previous[field]);
  }

  /* ---------- Selo de atualização ---------- */

  const isoDay = date => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date).map(p => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  const dayNumber = iso => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / DAY;
  const brDate = iso => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
  const brTime = date => new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }).format(date);

  /**
   * Estado do selo: "ok", "warning" (último registro com mais de STALE_DAYS dias)
   * ou "critical" (base de reserva).
   */
  function freshness({ origin, lastRecordAt, generatedAt } = {}, now = new Date(), staleDays = STALE_DAYS) {
    if (origin === "fallback") {
      return { level: "critical", text: "Exibindo base de reserva, dados podem estar desatualizados", ageDays: null };
    }
    const lastDay = lastRecordAt ? (/^\d{4}-\d{2}-\d{2}$/.test(lastRecordAt) ? lastRecordAt : isoDay(new Date(lastRecordAt))) : null;
    const read = generatedAt ? new Date(generatedAt) : null;
    const readText = read && !Number.isNaN(read.getTime()) ? ` · lidos às ${brTime(read)}` : "";
    if (!lastDay) return { level: "warning", text: `Sem data de último registro${readText}`, ageDays: null };
    const ageDays = dayNumber(isoDay(now)) - dayNumber(lastDay);
    return { level: ageDays > staleDays ? "warning" : "ok", text: `Dados até ${brDate(lastDay)}${readText}`, ageDays };
  }

  /* ---------- Participação por carga ---------- */

  /** Ranking de cargas por toneladas, com participação no total (cargas sem volume ficam de fora). */
  function cargoRanking(records) {
    const totals = new Map();
    records.forEach(r => totals.set(r.cargo, (totals.get(r.cargo) || 0) + r.tons));
    const items = [...totals].map(([label, tons]) => ({ label, tons })).filter(item => item.tons > 0).sort((a, b) => b.tons - a.tons);
    const total = items.reduce((sum, item) => sum + item.tons, 0);
    return { total, items: items.map(item => ({ ...item, share: item.tons / total })) };
  }

  /* ---------- Descarga ---------- */

  const addDays = (iso, offset) => new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)) + offset)).toISOString().slice(0, 10);

  /** Os `length` dias que terminam na última data com descarga (inclusive). */
  function lastDischargeWindow(dischargeDays, length = 7, fallbackEnd = isoDay(new Date())) {
    const last = dischargeDays.reduce((max, row) => row.date > max ? row.date : max, "");
    const end = last || fallbackEnd;
    return { start: addDays(end, -(length - 1)), end, hasData: Boolean(last) };
  }

  const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

  /**
   * Ritmo diário necessário para cumprir o plano do mês (plano ÷ dias do mês), dia a dia no intervalo.
   * Dias de meses sem plano ficam sem meta (null).
   */
  function dailyTargets(plans, start, end) {
    const byMonth = new Map(plans.filter(p => Number.isFinite(p.plan) && p.plan > 0).map(p => [`${p.year}-${String(p.month).padStart(2, "0")}`, p]));
    const days = [];
    for (let date = start; date <= end && days.length < 400; date = addDays(date, 1)) {
      const plan = byMonth.get(date.slice(0, 7));
      days.push({ date, rate: plan ? plan.plan / daysInMonth(plan.year, plan.month) : null });
    }
    const segments = [];
    days.forEach(day => {
      const last = segments.at(-1);
      if (day.rate === null) return;
      if (last && last.rate === day.rate && addDays(last.end, 1) === day.date) last.end = day.date;
      else segments.push({ start: day.date, end: day.date, rate: day.rate, year: Number(day.date.slice(0, 4)), month: Number(day.date.slice(5, 7)) });
    });
    return { days, segments };
  }

  root.TpsMetrics = { STALE_DAYS, filterRecords, occupancy, kpis, previousPeriod, previousKpis, variation, kpiVariation, freshness, lastDischargeWindow, isoDay, cargoRanking, dailyTargets };
})(typeof window !== "undefined" ? window : globalThis);
