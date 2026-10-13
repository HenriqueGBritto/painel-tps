/* Cópia literal dos cálculos de KPI de public/app.js antes da extração para metrics.js (13/10/2026).
   Usada só em tests/metrics.test.mjs para provar que os resultados não mudaram. */
const parseDate = (value) => value ? new Date(value) : null;
function selected(records = state.records) {
  return records.filter(r => (!state.years.size || state.years.has(r.year)) && (!state.months.size || state.months.has(r.month)));
}

function overlapHours(start, end, windowStart, windowEnd) {
  const a = Math.max(start.getTime(), windowStart.getTime());
  const b = Math.min(end.getTime(), windowEnd.getTime());
  return Math.max(0, b - a) / 36e5;
}

function occupancy(records, periodRecords = records) {
  if (!records.length) return 0;
  const selectedYears = state.years.size ? [...state.years] : [...new Set(periodRecords.map(r => r.year))];
  const selectedMonths = state.months.size ? [...state.months] : [...Array(12)].map((_, i) => i + 1);
  const windows = [];
  selectedYears.forEach(y => selectedMonths.forEach(m => windows.push([new Date(y, m - 1, 1), new Date(y, m, 1)])));
  const berthNames = [...new Set(records.map(r => r.berth))];
  if (!berthNames.length) return 0;
  const capacity = windows.reduce((sum, [a, b]) => sum + (b - a) / 36e5, 0);
  let totalRatio = 0;
  berthNames.forEach(berth => {
    const intervals = records.filter(r => r.berth === berth).map(r => [parseDate(r.berthStart), parseDate(r.berthEnd)]).filter(([a,b]) => a && b && b > a);
    let used = 0;
    windows.forEach(([wa, wb]) => {
      const clipped = intervals.map(([a,b]) => [new Date(Math.max(a,wa)), new Date(Math.min(b,wb))]).filter(([a,b]) => b > a).sort((x,y) => x[0] - y[0]);
      let merged = [];
      clipped.forEach(([a,b]) => { const last = merged.at(-1); if (last && a <= last[1]) last[1] = new Date(Math.max(last[1], b)); else merged.push([a,b]); });
      used += merged.reduce((s,[a,b]) => s + overlapHours(a,b,wa,wb), 0);
    });
    totalRatio += capacity ? used / capacity : 0;
  });
  return totalRatio / berthNames.length * 100;
}

function legacyKpis(){
  const data = selected();
  const totalTons = data.reduce((s,r) => s + r.tons, 0);
  const productivity = data.filter(r => r.productivity > 0);
  const weightedProductivity = productivity.length ? productivity.reduce((s,r) => s + r.productivity, 0) / productivity.length : 0;
  return { vessels: data.length, tons: totalTons, productivity: weightedProductivity, occupancy: occupancy(data) };
}
