const productionWorkbooks = {
  outras: "1KDStqZVY5vBG4LwByytYa2QSyNcjg9KQJXlV1rN43PU",
  potassio: "12itSxDBxOiB9c-IsgN9lA0Xcyls0DgsLQ6cFeGugJ30"
};
const productionNumber = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const productionTime = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const productionDateTime = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const productionDay = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "America/Sao_Paulo" });

function parseProductionCsv(csv) {
  const rows = []; let row = [], cell = "", quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const char = csv[i];
    if (char === '"') {
      if (quoted && csv[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) { row.push(cell); cell = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && csv[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
function productionTons(value) {
  const text = String(value || "").split("/").at(-1).trim().replace(/\s/g, "");
  if (!text || /#(DIV|NUM|VALUE|REF)!/i.test(text)) return null;
  const comma = text.lastIndexOf(","), dot = text.lastIndexOf(".");
  let normalized;
  if (comma >= 0 && dot >= 0) normalized = comma > dot ? text.replace(/\./g, "").replace(",", ".") : text.replace(/,/g, "");
  else if (comma >= 0) normalized = text.replace(",", ".");
  else normalized = /^-?\d{1,3}(\.\d{3})+$/.test(text) ? text.replace(/\./g, "") : text;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}
function productionPlanTons(value) {
  const text = String(value ?? "").trim();
  return /^-?\d{1,3}(,\d{3})+$/.test(text) ? Number(text.replace(/,/g, "")) : productionTons(value);
}
function productionStart(rows, heading) {
  const label = rows.slice(0, heading).flat().find(cell => /INÍCIO\s*:?\s*\d{1,2}\/\d{1,2}\/\d{4}/i.test(cell || ""));
  const match = label?.match(/INÍCIO\s*:?\s*(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/i);
  return match ? new Date(`${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}T${(match[4] || "00").padStart(2, "0")}:${match[5] || "00"}:00-03:00`) : null;
}
function productionPeriodEnd(dateLabel, period, year) {
  const months = { jan: 1, fev: 2, feb: 2, mar: 3, abr: 4, apr: 4, mai: 5, may: 5, jun: 6, jul: 7, ago: 8, aug: 8, set: 9, sep: 9, out: 10, oct: 10, nov: 11, dez: 12, dec: 12 };
  const date = dateLabel.match(/^(\d{1,2})\/([a-zç]{3})\.?$/i);
  const hours = period.match(/^(\d{2}):00\s*(?:às|à)\s*(\d{2}):00/i);
  if (!date || !hours || !months[date[2].toLowerCase()] || !year) return null;
  const rollover = Number(hours[2]) <= Number(hours[1]) ? 1 : 0;
  return new Date(Date.UTC(year, months[date[2].toLowerCase()] - 1, Number(date[1]) + rollover, Number(hours[2]) + 3));
}
function productionClockMinutes(value) {
  const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}
function productionStopDuration(minutes) {
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
}
function productionIntervalUnionMs(intervals) {
  let total = 0, current = null;
  for (const interval of intervals.filter(([from, to]) => to > from).sort((a, b) => a[0] - b[0])) {
    if (!current) current = [...interval];
    else if (interval[0] <= current[1]) current[1] = Math.max(current[1], interval[1]);
    else { total += current[1] - current[0]; current = [...interval]; }
  }
  return total + (current ? current[1] - current[0] : 0);
}
function productionExcludesWeekend(cargo) {
  const normalized = String(cargo || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return /ferro\s+gusa|potassio|tarugo/.test(normalized);
}
function productionWeekendIntervals(start, end, cargo) {
  if (!productionExcludesWeekend(cargo) || end <= start) return [];
  const hour = 3600000, day = 24 * hour;
  const localStart = new Date(start - 3 * hour);
  const firstDay = Date.UTC(localStart.getUTCFullYear(), localStart.getUTCMonth(), localStart.getUTCDate() - 7);
  const intervals = [];
  for (let date = firstDay; date <= end - 3 * hour; date += day) {
    if (new Date(date).getUTCDay() !== 6) continue;
    const from = Math.max(start, date + 22 * hour); // sábado 19h em São Paulo
    const to = Math.min(end, date + 2 * day + 10 * hour); // segunda 07h
    if (to > from) intervals.push([from, to]);
  }
  return intervals;
}
function productionIntersectIntervals(left, right) {
  return left.flatMap(([leftFrom, leftTo]) => right.flatMap(([rightFrom, rightTo]) => {
    const from = Math.max(leftFrom, rightFrom), to = Math.min(leftTo, rightTo);
    return to > from ? [[from, to]] : [];
  }));
}
function productionTimeMetrics(data, rangeStart = data.start, rangeEnd = data.asOfEnd || data.lastShift?.end) {
  const start = rangeStart?.getTime(), end = rangeEnd?.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const intervals = (data.stops || []).map(stop => [Math.max(start, stop.startAt?.getTime() || 0), Math.min(end, stop.endAt?.getTime() || 0)])
    .filter(([from, to]) => to > from).sort((a, b) => a[0] - b[0]);
  let stoppedMs = 0, current = null;
  for (const interval of intervals) {
    if (!current) current = [...interval];
    else if (interval[0] <= current[1]) current[1] = Math.max(current[1], interval[1]);
    else { stoppedMs += current[1] - current[0]; current = [...interval]; }
  }
  if (current) stoppedMs += current[1] - current[0];
  const totalMinutes = Math.round((end - start) / 60000);
  const stoppedMinutes = Math.min(totalMinutes, Math.round(stoppedMs / 60000));
  return { totalMinutes, stoppedMinutes, productiveMinutes: totalMinutes - stoppedMinutes };
}
window.getProductionTimeMetrics = productionTimeMetrics;
function parseProductionStops(rows, year) {
  const headerIndex = rows.findIndex(row => /^Data$/i.test(row[0]?.trim() || "") && /^Início$/i.test(row[1]?.trim() || "") && /^Término$/i.test(row[2]?.trim() || "") && row.some(cell => /Descriç/i.test(cell || "")));
  if (headerIndex < 0) return [];
  const descriptionIndex = rows[headerIndex].findIndex(cell => /Descriç/i.test(cell || ""));
  const months = { jan: 0, fev: 1, feb: 1, mar: 2, abr: 3, apr: 3, mai: 4, may: 4, jun: 5, jul: 6, ago: 7, aug: 7, set: 8, sep: 8, out: 9, oct: 9, nov: 10, dez: 11, dec: 11 };
  const dateFormat = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", timeZone: "UTC" });
  const stops = []; let currentDate = null, previousStart = null;
  for (const row of rows.slice(headerIndex + 1)) {
    const dateMatch = String(row[0] || "").trim().match(/^(\d{1,2})\/([a-zç]{3})\.?$/i);
    if (dateMatch && months[dateMatch[2].toLowerCase()] !== undefined) {
      currentDate = new Date(Date.UTC(year, months[dateMatch[2].toLowerCase()], Number(dateMatch[1])));
      previousStart = null;
    }
    const start = productionClockMinutes(row[1]);
    const end = productionClockMinutes(row[2]);
    const description = String(row[descriptionIndex] || "").trim();
    if (start === null || end === null || !description || !currentDate) continue;
    if (!dateMatch && previousStart !== null && start < previousStart) currentDate = new Date(currentDate.getTime() + 86400000);
    previousStart = start;
    const duration = (end - start + 1440) % 1440;
    if (!duration) continue;
    const startAt = new Date(currentDate.getTime() + (start + 180) * 60000);
    stops.push({ date: dateFormat.format(currentDate), start: String(row[1]).slice(0, 5), end: String(row[2]).slice(0, 5), location: String(row[3] || "").trim(), description, duration, startAt, endAt: new Date(startAt.getTime() + duration * 60000) });
  }
  return stops;
}
function parseProductionStage(rows, heading, start, stage) {
  const totalColumn = rows[heading].findIndex(cell => /TOTAL P\/ TURNO/i.test(cell));
  const crewColumn = rows[heading].findIndex(cell => /Ternos p\/ Turno/i.test(cell));
  const holdColumns = rows[heading].flatMap((cell, index) => {
    const match = String(cell || "").match(/^Porão\s+(\d+)$/i);
    return match ? [{ number: Number(match[1]), index }] : [];
  });
  const shifts = [], periods = []; let currentDate = "", summaryRow = null;
  for (const row of rows.slice(heading + 1)) {
    const first = row[0]?.trim() || "";
    if (/^TOTAL (?:DESEMBARCADO|EMBARCADO) POR PORÃO/i.test(first)) { summaryRow = row; break; }
    if (/^NAVIO FUNDEADO/i.test(first)) break;
    if (/^\d{1,2}\/[a-zç]{3}\.?$/i.test(first)) currentDate = first;
    const period = row[2]?.trim() || "";
    if (!currentDate || !/^\d{2}:00\s*(?:às|à)\s*\d{2}:00/i.test(period)) continue;
    const end = productionPeriodEnd(currentDate, period, start?.getFullYear());
    if (!end) continue;
    const from = new Date(end.getTime() - 6 * 3600000);
    const tons = productionTons(row[totalColumn]);
    const entry = { date: productionDay.format(from), period, stage, tons: tons || 0, from, end,
      crewCount: crewColumn < 0 ? null : productionTons(row[crewColumn]),
      byHold: Object.fromEntries(holdColumns.map(hold => [hold.number, productionTons(row[hold.index]) || 0])) };
    periods.push(entry);
    if (tons !== null && tons > 0) shifts.push(entry);
  }
  const calculated = shifts.reduce((sum, shift) => sum + shift.tons, 0);
  const produced = productionTons(summaryRow?.[totalColumn]) ?? calculated;
  const holds = holdColumns.map(({ number, index }) => ({ number, index, planned: productionTons(rows[heading + 1]?.[index]), produced: productionTons(summaryRow?.[index]) ?? 0 }));
  return { shifts, periods, calculated, produced, holds, summaryRow };
}
function parseProductionSheet(csv, expectedVessel) {
  const rows = Array.isArray(csv) ? csv : parseProductionCsv(csv);
  const sheetVessel = rows[2]?.[0]?.trim();
  if (sheetVessel && sheetVessel.toLocaleUpperCase("pt-BR") !== expectedVessel.toLocaleUpperCase("pt-BR")) throw new Error(`A aba recebida não corresponde a ${expectedVessel}.`);
  const heading = rows.findIndex(row => row[0]?.trim() === "Data" && row.some(cell => /TOTAL P\/ TURNO/i.test(cell)));
  if (heading < 0) throw new Error("Não encontrei a tabela de produção nesta aba.");
  const quantityRow = rows.find(row => /^CARGA:/i.test(row[0]?.trim() || ""));
  const berthPlanned = productionTons(quantityRow?.[4]);
  const cargo = quantityRow?.[0]?.replace(/^CARGA:\s*/i, "").trim() || "Carga não informada";
  const start = productionStart(rows, heading);
  const berth = parseProductionStage(rows, heading, start, "Atracado");
  const offshoreMarker = rows.findIndex((row, index) => index > heading && /^NAVIO FUNDEADO/i.test(row[0]?.trim() || ""));
  const offshoreHeading = offshoreMarker < 0 ? -1 : rows.findIndex((row, index) => index > offshoreMarker && row[0]?.trim() === "Data" && row.some(cell => /TOTAL P\/ TURNO/i.test(cell)));
  const offshore = offshoreHeading < 0 ? null : parseProductionStage(rows, offshoreHeading, start, "Fundeado");
  const hasOffshore = !!(offshore && offshore.produced > 0);
  const combinedPlanRow = hasOffshore ? rows.find((row, index) => index > offshoreHeading && /^PLANO DE CARGA POR PORÃO/i.test(row[0]?.trim() || "")) : null;
  const holds = berth.holds.map(hold => ({
    number: hold.number,
    planned: productionPlanTons(combinedPlanRow?.[hold.index]) ?? hold.planned,
    produced: hold.produced + (hasOffshore ? offshore.holds.find(item => item.number === hold.number)?.produced || 0 : 0)
  }));
  const combinedPlanned = combinedPlanRow ? holds.reduce((sum, hold) => sum + (hold.planned || 0), 0) : null;
  const planned = combinedPlanned > 0 ? combinedPlanned : berthPlanned;
  const shifts = [...berth.shifts, ...(hasOffshore ? offshore.shifts : [])].sort((a, b) => (a.end?.getTime() || 0) - (b.end?.getTime() || 0));
  const periods = [...berth.periods, ...(hasOffshore ? offshore.periods : [])].sort((a, b) => a.from - b.from);
  const calculated = berth.calculated + (hasOffshore ? offshore.calculated : 0);
  const produced = berth.produced + (hasOffshore ? offshore.produced : 0);
  const lastShift = shifts.at(-1);
  const stops = parseProductionStops(rows, start?.getFullYear() || 2026);
  const latestStopEnd = Math.max(0, ...stops.filter(stop => stop.endAt.getTime() <= Date.now()).map(stop => stop.endAt.getTime()));
  const lastCompletedPeriod = periods.filter(period => period.end.getTime() <= latestStopEnd).at(-1);
  const asOfEnd = lastShift?.end && (!lastCompletedPeriod || lastShift.end >= lastCompletedPeriod.end) ? lastShift.end : lastCompletedPeriod?.end || null;
  const elapsedDays = start && asOfEnd && asOfEnd > start ? (asOfEnd - start) / 86400000 : null;
  const dailyRate = elapsedDays > 0 ? produced / elapsedDays : null;
  const remaining = planned === null ? null : Math.max(0, planned - produced);
  const eta = dailyRate > 0 && remaining !== null ? new Date(asOfEnd.getTime() + remaining / dailyRate * 86400000) : null;
  return { vessel: expectedVessel, cargo, planned, produced, calculated, holds, shifts, periods, stops, start, lastShift, asOfEnd, elapsedDays, dailyRate, eta, berthProduced: berth.produced, offshoreProduced: hasOffshore ? offshore.produced : 0 };
}
function productionEffectiveTime(data) {
  if (!data.start || !(data.asOfEnd || data.lastShift?.end) || !(data.elapsedDays > 0)) return { reason: "Período de operação indisponível." };
  if (data.offshoreProduced > 0) return { reason: "A operação reúne etapas atracada e fundeada; as paralisações não podem ser descontadas com segurança do tempo total das duas etapas." };
  const start = data.start.getTime(), end = (data.asOfEnd || data.lastShift.end).getTime();
  const weekendIntervals = productionWeekendIntervals(start, end, data.cargo);
  const weekendMs = productionIntervalUnionMs(weekendIntervals);
  const relevantStops = (data.stops || []).map(stop => ({ stop, from: Math.max(start, stop.startAt?.getTime() || 0), to: Math.min(end, stop.endAt?.getTime() || 0) }))
    .filter(({ from, to }) => to > from);
  if (!relevantStops.length && !weekendMs) return { reason: "Não há paradas válidas dentro do período analisado." };
  // Uma parada isolada de um terno não interrompe o navio. Registros separados
  // para ternos diferentes só contam no intervalo em que todos param juntos.
  const crewGroups = relevantStops.map(({ stop }) => [...new Set([...String(stop.location || "").split("/")[0].matchAll(/\d+\s*[º°]/g)].map(match => match[0].replace(/\D/g, "")))]);
  const crewSet = new Set(crewGroups.flat());
  const crewCounts = new Set((data.periods || []).filter(period => period.end.getTime() <= end && period.end.getTime() > start && period.crewCount > 0).map(period => period.crewCount));
  if (relevantStops.length && (crewGroups.some(group => !group.length) || crewCounts.size !== 1 || !crewCounts.has(crewSet.size))) {
    return { reason: "A identificação dos ternos nas paradas ou a quantidade de ternos escalados está incompleta." };
  }
  let sharedIntervals = relevantStops.length ? [[start, end]] : [];
  for (const crew of crewSet) {
    const crewIntervals = relevantStops.filter((_, index) => crewGroups[index].includes(crew))
      .map(({ from, to }) => [from, to]).sort((a, b) => a[0] - b[0]);
    sharedIntervals = productionIntersectIntervals(sharedIntervals, crewIntervals);
    if (!sharedIntervals.length) break;
  }
  const excludedMs = productionIntervalUnionMs([...sharedIntervals, ...weekendIntervals]);
  const stoppedMs = excludedMs - weekendMs;
  const worked = end - start - excludedMs;
  return worked > 0 && excludedMs > 0 ? {
    stoppedMinutes: Math.round(stoppedMs / 60000), weekendMinutes: Math.round(weekendMs / 60000),
    rate: data.produced / (worked / 86400000)
  } : { reason: "Não há tempo produtivo suficiente ou paradas simultâneas fora do fim de semana." };
}
function productionCrewPairs(location) {
  const parts = String(location || "").split("/");
  if (parts.length !== 2) return [];
  const crews = [...parts[0].matchAll(/\d+\s*[º°]/g)].map(match => Number(match[0].replace(/\D/g, "")));
  const holds = [...parts[1].matchAll(/\d+/g)].map(match => Number(match[0]));
  return crews.length && crews.length === holds.length && new Set(crews).size === crews.length && new Set(holds).size === holds.length
    ? crews.map((crew, index) => ({ crew, hold: holds[index] })) : [];
}
function productionCrewMetrics(data) {
  if (data.offshoreProduced > 0) return { reason: "Há produção fundeada; a escala dos ternos por etapa não está identificada." };
  if (!data.start || !(data.asOfEnd || data.lastShift?.end)) return { reason: "Início ou último período da operação não informado." };
  const start = data.start.getTime();
  const latestStop = Math.max(0, ...(data.stops || []).filter(stop => stop.endAt?.getTime() <= Date.now()).map(stop => stop.endAt.getTime()));
  const end = data.asOfEnd?.getTime() || Math.max(data.lastShift.end.getTime(), latestStop);
  const periods = (data.periods || []).filter(period => period.stage === "Atracado" && period.end > start && period.from < end && period.end.getTime() <= end);
  const relevantStops = (data.stops || []).filter(stop => stop.endAt?.getTime() > start && stop.startAt?.getTime() < end);
  const mapping = new Map(), holdOwners = new Map();
  for (const stop of relevantStops) {
    const pairs = productionCrewPairs(stop.location);
    if (!pairs.length) return { reason: "A identificação terno/porão das paralisações está incompleta." };
    for (const { crew, hold } of pairs) {
      if ((mapping.has(crew) && mapping.get(crew) !== hold) || (holdOwners.has(hold) && holdOwners.get(hold) !== crew))
        return { reason: "A relação entre terno e porão muda durante a operação; não é seguro atribuir a produção." };
      mapping.set(crew, hold); holdOwners.set(hold, crew);
    }
  }
  if (!mapping.size) return { reason: "A planilha não identifica qual terno operou cada porão." };
  const fullyStopped = period => [...mapping].every(([crew]) => {
    const intervals = relevantStops.filter(stop => productionCrewPairs(stop.location).some(pair => pair.crew === crew))
      .map(stop => [Math.max(period.from.getTime(), stop.startAt.getTime()), Math.min(period.end.getTime(), stop.endAt.getTime())]);
    return productionIntervalUnionMs(intervals) >= period.end - period.from;
  });
  const active = periods.filter(period => period.crewCount > 0 || ((period.crewCount === 0 || period.crewCount === null) && fullyStopped(period)));
  if (!active.length || periods.some(period => period.tons > 0 && !period.crewCount)) return { reason: "Falta o número de ternos em períodos com produção." };
  if (active.some(period => period.crewCount > 0 && period.crewCount !== mapping.size || Object.entries(period.byHold).some(([hold, tons]) => tons > 0 && !holdOwners.has(Number(hold)))))
    return { reason: "A quantidade de ternos ou os porões produzidos não coincidem com a identificação terno/porão." };
  const rows = [...mapping].sort((a, b) => a[0] - b[0]).map(([crew, hold]) => {
    const scheduled = active.map(period => [Math.max(start, period.from.getTime()), Math.min(end, period.end.getTime())]);
    const scheduledMs = productionIntervalUnionMs(scheduled);
    const stopped = [];
    for (const stop of relevantStops) {
      if (!productionCrewPairs(stop.location).some(pair => pair.crew === crew)) continue;
      for (const [from, to] of scheduled) stopped.push([Math.max(from, stop.startAt.getTime()), Math.min(to, stop.endAt.getTime())]);
    }
    const stoppedMs = Math.min(scheduledMs, productionIntervalUnionMs(stopped));
    const produced = active.reduce((sum, period) => sum + (period.byHold[hold] || 0), 0);
    const weekend = productionIntersectIntervals(scheduled, productionWeekendIntervals(start, end, data.cargo));
    const weekendMs = productionIntervalUnionMs(weekend);
    const excludedMs = productionIntervalUnionMs([...stopped, ...weekend]);
    const productiveMs = scheduledMs - excludedMs;
    return { crew, hold, produced, scheduledMinutes: Math.round(scheduledMs / 60000), stoppedMinutes: Math.round(stoppedMs / 60000),
      weekendMinutes: Math.round(weekendMs / 60000),
      gross: scheduledMs > 0 ? produced / (scheduledMs / 21600000) : null,
      effective: productiveMs > 0 ? produced / (productiveMs / 21600000) : null };
  });
  return { rows, target: 500, through: new Date(end) };
}
function productionStopsByDay(stops) {
  const intervals = new Map();
  for (const stop of stops) {
    let cursor = stop.startAt?.getTime(), end = stop.endAt?.getTime();
    if (!Number.isFinite(cursor) || !Number.isFinite(end) || end <= cursor) continue;
    while (cursor < end) {
      const local = new Date(cursor - 3 * 3600000);
      const nextMidnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1, 3);
      const segmentEnd = Math.min(end, nextMidnight);
      const day = productionDay.format(new Date(cursor));
      if (!intervals.has(day)) intervals.set(day, []);
      intervals.get(day).push([cursor, segmentEnd]);
      cursor = segmentEnd;
    }
  }
  return [...intervals].sort((a, b) => a[0].slice(3).localeCompare(b[0].slice(3)) || a[0].slice(0, 2).localeCompare(b[0].slice(0, 2)))
    .map(([day, items]) => ({ day, minutes: Math.round(productionIntervalUnionMs(items) / 60000) }));
}
function escapeProduction(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

const productionState = { selected: null, cargo: "all", hold: null, data: {}, sourceUrls: {}, fetchedAt: null, lastFetch: 0, loading: false, errors: {} };
window.getProductionExportData = () => productionState.data[productionState.selected] || null;
function syncProductionFilters() {
  const cargoSelect = document.getElementById("productionCargo"), vesselSelect = document.getElementById("productionVessel");
  const cargos = [...new Set(Object.values(productionState.data).map(data => data.cargo))].sort((a, b) => a.localeCompare(b, "pt-BR"));
  if (productionState.cargo !== "all" && !cargos.includes(productionState.cargo)) productionState.cargo = "all";
  cargoSelect.innerHTML = '<option value="all">Todas as cargas</option>' + cargos.map(cargo => `<option value="${escapeProduction(cargo)}">${escapeProduction(cargo)}</option>`).join("");
  cargoSelect.value = productionState.cargo;
  cargoSelect.disabled = !cargos.length;
  const vessels = Object.entries(productionState.data).filter(([, data]) => productionState.cargo === "all" || data.cargo === productionState.cargo).sort((a, b) => (b[1].start?.getTime() || 0) - (a[1].start?.getTime() || 0) || a[1].vessel.localeCompare(b[1].vessel, "pt-BR"));
  if (!vessels.some(([key]) => key === productionState.selected)) productionState.selected = vessels[0]?.[0] || null;
  vesselSelect.innerHTML = vessels.map(([key, data]) => `<option value="${key}">${escapeProduction(data.vessel)}</option>`).join("") || '<option value="">Nenhum navio disponível</option>';
  vesselSelect.disabled = !vessels.length;
  if (productionState.selected) vesselSelect.value = productionState.selected;
}
function renderProduction() {
  syncProductionFilters();
  const key = productionState.selected, data = productionState.data[key];
  const target = document.getElementById("productionContent");
  if (!data) { target.innerHTML = `<div class="production-empty">${escapeProduction(Object.values(productionState.errors)[0] || "Aguardando dados das planilhas.")}</div>`; return; }
  const { planned, produced, calculated, shifts, holds, lastShift, dailyRate, eta } = data;
  const effective = productionEffectiveTime(data);
  if (productionState.hold !== null && !holds.some(hold => hold.number === productionState.hold)) productionState.hold = null;
  const selectedHold = holds.find(hold => hold.number === productionState.hold);
  const daily = new Map();
  for (const shift of shifts) daily.set(shift.date, (daily.get(shift.date) || 0) + shift.tons);
  const top = Math.max(...daily.values(), 1);
  const remainder = planned === null ? null : Math.max(0, planned - produced);
  const excess = planned === null ? 0 : Math.max(0, produced - planned);
  const percent = planned > 0 ? produced / planned * 100 : null;
  const isDischarge = data.sourceKind === "potassio";
  const cards = `<article class="production-card"><span>TOTAL PRODUZIDO</span><strong>${productionNumber.format(produced)} t</strong><small>${data.offshoreProduced > 0 ? `Atracado: ${productionNumber.format(data.berthProduced)} t · Fundeado: ${productionNumber.format(data.offshoreProduced)} t` : percent === null ? "Sem meta informada" : productionNumber.format(percent) + "% do previsto"}</small></article><article class="production-card production-card-balance"><span>SALDO PREVISTO</span><strong>${remainder === null ? "—" : productionNumber.format(remainder) + " t"}</strong><small>${planned === null ? "Meta não informada" : excess > 0 ? productionNumber.format(excess) + " t acima do previsto" : "de " + productionNumber.format(planned) + " t previstas"}</small></article>`;
  const bars = [...daily].map(([date, tons]) => `<div class="production-day"><span>${escapeProduction(date)}</span><div class="production-track"><i style="width:${Math.max(2, tons / top * 100)}%"></i></div><strong>${productionNumber.format(tons)} t</strong></div>`).join("") || '<p class="production-empty">Nenhum período com produção registrada.</p>';
  const detail = shifts.map(shift => `<tr><td>${escapeProduction(shift.date)}</td><td>${escapeProduction(shift.period)}</td><td>${escapeProduction(shift.stage)}</td><td>${productionNumber.format(shift.tons)} t</td></tr>`).join("") || '<tr><td colspan="4">Nenhum período com produção registrada.</td></tr>';
  const mismatch = Math.abs(produced - calculated) > 0.1 ? `<p class="production-warning">O total da planilha difere da soma dos períodos em ${productionNumber.format(produced - calculated)} t. O card mostra o total informado na planilha.</p>` : "";
  const holdVisual = holds.length ? `<section class="production-holds"><div class="production-section-head"><div><h3>PRODUÇÃO POR PORÃO</h3></div><span>Selecione um porão para ver os períodos</span></div><div class="production-hull-scroll"><div class="production-vessel-diagram"><svg class="production-ship-outline" viewBox="0 0 1000 225" preserveAspectRatio="none" aria-hidden="true"><path d="M19 104H92V113H914L980 87L967 163Q962 193 918 199H91Q52 199 38 171L19 161Z" fill="#EAEAEA" stroke="#2F2F2F" stroke-width="2.5"/><path d="M40 164Q53 188 91 189H918Q949 189 964 164" fill="none" stroke="#B0B0B0" stroke-width="2"/><path d="M92 113H914" fill="none" stroke="#2F2F2F" stroke-width="3"/><path d="M44 104V75H64V46H145V104Z" fill="#FFFFFF" stroke="#2F2F2F" stroke-width="2.5"/><path d="M54 75H137M64 61H145M58 35H150M81 35V20H110V35M94 20V3M52 104H153" fill="none" stroke="#2F2F2F" stroke-width="3"/><path d="M66 52h9m8 0h9m8 0h9m8 0h9M58 67h9m8 0h9m8 0h9m8 0h9m8 0h9M55 83h8m7 0h8m7 0h8m7 0h8m7 0h8m7 0h8M55 93h8m7 0h8m7 0h8m7 0h8m7 0h8m7 0h8" stroke="#2F2F2F" stroke-width="2.5"/><path d="M945 98V61m-10 9h20M38 171l-8 10h-9v19h16l4-21" fill="none" stroke="#2F2F2F" stroke-width="2.5"/></svg><div class="production-hull"><span class="production-end-label">POPA</span><div class="production-hold-row">${[...holds].reverse().map((hold, index, order) => {
    const hasPlan = hold.planned > 0, hasProduction = hold.produced > 0;
    const percent = hasPlan ? hold.produced / hold.planned * 100 : null;
    const fill = percent === null ? 0 : Math.min(100, Math.max(0, isDischarge ? 100 - percent : percent));
    const label = hasPlan ? `${productionNumber.format(isDischarge ? Math.max(0, 100 - percent) : percent)}%` : hasProduction ? `${productionNumber.format(hold.produced)} t` : "sem carga";
    const amount = hasPlan ? `${productionNumber.format(isDischarge ? Math.max(0, hold.planned - hold.produced) : hold.produced)} t<br>de ${productionNumber.format(hold.planned)} t` : hasProduction ? `${productionNumber.format(hold.produced)} t produzidas<br>meta não informada` : "0 t<br>sem carga";
    return `<button type="button" class="production-hold ${!hasPlan && !hasProduction ? "production-hold-empty" : ""} ${!hasPlan && hasProduction ? "production-hold-unplanned" : ""} ${productionState.hold === hold.number ? "is-selected" : ""} ${percent > 100 ? "production-hold-over" : ""}" data-hold="${hold.number}" aria-pressed="${productionState.hold === hold.number}" aria-label="Porão ${hold.number}: ${productionNumber.format(hold.produced)} toneladas produzidas; ${hasPlan ? productionNumber.format(hold.planned) + " toneladas previstas" : hasProduction ? "meta não informada" : "sem carga"}">${index < order.length - 1 ? '<svg class="production-crane" viewBox="0 0 64 82" aria-hidden="true"><path d="M30 78V15L58 1M30 16L5 32M51 5V51M30 15L57 25M8 77h45M48 51q3 7 7 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' : ""}<span class="production-hatch"></span><span class="production-hold-box"><span class="production-hold-fill" style="height:${fill}%"></span><span class="production-hold-label ${fill >= 52 ? "is-on-fill" : ""}">${label}</span></span><strong>PORÃO ${hold.number}</strong><small>${amount}</small></button>`;
  }).join("")}</div><span class="production-end-label">PROA</span></div></div></div><div class="production-ship-legend"><span><i class="production-key-filled"></i>${isDischarge ? "Carga a bordo" : "Carga embarcada"}</span><span><i class="production-key-empty"></i>${isDischarge ? "Descarregado" : "Saldo a embarcar"}</span><span><i class="production-key-selected"></i>Porão selecionado</span></div>${selectedHold ? `<div class="production-hold-detail"><div class="production-hold-detail-head"><div><h4>Porão ${selectedHold.number}</h4><span>${selectedHold.planned > 0 ? productionNumber.format(selectedHold.produced / selectedHold.planned * 100) + "% concluído" : selectedHold.produced > 0 ? "Meta não informada" : "Sem carga prevista"}</span></div><div><span>PREVISTO</span><strong>${selectedHold.planned > 0 ? productionNumber.format(selectedHold.planned) + " t" : "—"}</strong></div><div><span>PRODUZIDO</span><strong>${productionNumber.format(selectedHold.produced)} t</strong></div><div><span>SALDO</span><strong>${selectedHold.planned > 0 ? productionNumber.format(Math.max(0, selectedHold.planned - selectedHold.produced)) + " t" : "—"}</strong></div></div><div class="production-hold-shifts"><h5>PRODUÇÃO POR PERÍODO NESTE PORÃO</h5>${shifts.filter(shift => shift.byHold?.[selectedHold.number] > 0).map(shift => `<div><span>${escapeProduction(shift.date)} · ${escapeProduction(shift.period)}${data.offshoreProduced > 0 ? ` · ${escapeProduction(shift.stage)}` : ""}</span><i><b style="width:${Math.max(2, shift.byHold[selectedHold.number] / Math.max(...shifts.map(item => item.byHold?.[selectedHold.number] || 0), 1) * 100)}%"></b></i><strong>${productionNumber.format(shift.byHold[selectedHold.number])} t</strong></div>`).join("") || '<p>Sem produção registrada neste porão.</p>'}</div></div>` : ""}</section>` : "";
  const tide = eta ? (window.dashboardTideDetail?.(eta) || "Tábua de maré indisponível") : "Aguardando previsão de término";
  const crewMetrics = productionCrewMetrics(data);
const crewPanel = `<section class="production-panel production-crew-panel"><div class="production-section-head"><div><p class="eyebrow">DESEMPENHO POR TERNO</p><h3>Prancha real e Triunfo</h3></div><span>Meta: 500 t por terno/turno</span></div>${crewMetrics.rows ? `<div class="production-crew-grid">${crewMetrics.rows.map(row => `<article class="production-crew-card"><div class="production-crew-title"><strong>${row.crew}º TERNO</strong><span>Porão ${row.hold}</span></div><div class="production-crew-rates"><div><span>PRANCHA REAL MÉDIA</span><strong>${row.gross === null ? "—" : productionNumber.format(row.gross) + " t/turno"}</strong><small>${row.gross === null ? "" : productionNumber.format(row.gross / crewMetrics.target * 100) + "% da meta"}</small></div><div><span>PRANCHA TRIUNFO MÉDIA</span><strong>${row.effective === null ? "—" : productionNumber.format(row.effective) + " t/turno"}</strong><small>${row.effective === null ? "Sem tempo produtivo apurável" : productionNumber.format(row.effective / crewMetrics.target * 100) + "% da meta"}</small></div></div><p>${productionNumber.format(row.produced)} t produzidas · ${productionStopDuration(row.scheduledMinutes)} escalado · ${productionStopDuration(row.stoppedMinutes)} parado${row.weekendMinutes ? ` · ${productionStopDuration(row.weekendMinutes)} de fim de semana` : ""}</p></article>`).join("")}</div><p class="production-footnote">Por terno, a prancha real divide a produção atribuída ao porão pelas horas escaladas; a prancha Triunfo desconta as paralisações identificadas para aquele terno e, para ferro gusa, potássio e tarugo, a janela de sábado 19h a segunda 07h, sem duplicar intervalos. Ambas são equivalentes a um turno de 6 horas, até ${productionDateTime.format(crewMetrics.through)}. Um período sem quantidade de ternos só entra quando as paralisações comprovam os mesmos ternos parados durante as seis horas completas. A relação terno/porão vem dos registros de paralisação e precisa permanecer consistente. São médias do período, não o resultado individual de cada turno.</p>` : `<p class="production-warning">Pranchas por terno indisponíveis: ${escapeProduction(crewMetrics.reason)}</p>`}</section>`;
  const forecast = `<section class="production-panel production-forecast"><div class="production-section-head"><div><p class="eyebrow">RITMO DA OPERAÇÃO</p><h3>Prancha e previsão de término</h3></div></div><div class="production-forecast-grid"><div><span>Prancha real</span><strong>${dailyRate > 0 ? productionNumber.format(dailyRate) + " t/dia" : "—"}</strong></div><div><span>Prancha Triunfo</span><strong>${effective.rate > 0 ? productionNumber.format(effective.rate) + " t/dia" : "—"}</strong></div><div><span>Tempo parado descontado</span><strong>${effective.stoppedMinutes ? productionStopDuration(effective.stoppedMinutes) : "—"}</strong></div>${productionExcludesWeekend(data.cargo) ? `<div><span>Fim de semana excluído</span><strong>${effective.weekendMinutes ? productionStopDuration(effective.weekendMinutes) : "—"}</strong></div>` : ""}<div><span>Término estimado</span><strong>${eta ? productionDateTime.format(eta) : "—"}</strong></div><div><span>Próxima preamar</span><strong>${escapeProduction(tide)}</strong></div></div><p class="chart-insight"><strong>Leitura:</strong> ${effective.rate > 0 ? `A prancha Triunfo é ${productionNumber.format((effective.rate / dailyRate - 1) * 100)}% maior que a real após descontar ${productionStopDuration(effective.stoppedMinutes || 0)} de paradas simultâneas dos ternos${effective.weekendMinutes ? ` e ${productionStopDuration(effective.weekendMinutes)} do fim de semana` : ""}, sem dupla contagem.` : escapeProduction(effective.reason)}</p><p class="production-footnote">Ambas usam a produção total até o fim do último período concluído com produção ou parada registrada${data.asOfEnd ? ` (${productionDateTime.format(data.asOfEnd)})` : ""}. Real: tempo corrido desde o início; Triunfo: tempo corrido menos paradas simultâneas de todos os ternos${productionExcludesWeekend(data.cargo) ? " e a janela de sábado 19h a segunda 07h" : ""}, sem duplicar intervalos. A previsão usa a prancha real, que já incorpora as paradas observadas. ${eta && eta < new Date() ? "A estimativa já passou; confira se a planilha contém os períodos mais recentes. " : ""}A preamar da Ilha Fiscal não confirma, sozinha, uma janela segura de navegação.</p></section>`;
  const stops = data.stops || [];
  const stopMinutes = stops.reduce((sum, stop) => sum + stop.duration, 0);
  const reasons = new Map();
  for (const stop of stops) {
    const reason = stop.description.replace(/\.+$/, "").trim();
    const key = reason.toLocaleLowerCase("pt-BR");
    const item = reasons.get(key) || { reason, minutes: 0, count: 0 };
    item.minutes += stop.duration; item.count++;
    reasons.set(key, item);
  }
  const reasonList = [...reasons.values()].sort((a, b) => b.minutes - a.minutes);
  const reasonMax = reasonList[0]?.minutes || 1;
  const reasonBars = reasonList.map(item => `<div class="production-stop-reason"><span>${escapeProduction(item.reason)}</span><div class="production-track"><i style="width:${Math.max(2, item.minutes / reasonMax * 100)}%"></i></div><strong>${productionStopDuration(item.minutes)}</strong><small>${item.count} ${item.count === 1 ? "ocorrência" : "ocorrências"}</small></div>`).join("");
  const dailyStops = productionStopsByDay(stops);
  const dailyStopMax = Math.max(...dailyStops.map(item => item.minutes), 1);
  const dailyStopBars = dailyStops.length ? `<div class="production-stop-days"><h4>POR DIA</h4><div class="production-stop-day-grid">${dailyStops.map(item => `<div class="production-stop-day"><span>${escapeProduction(item.day)}</span><i><b style="width:${Math.max(2, item.minutes / dailyStopMax * 100)}%"></b></i><strong>${productionStopDuration(item.minutes)}</strong></div>`).join("")}</div><p>Intervalos atribuídos ao dia em que ocorreram; as paradas que atravessam 00:00 são divididas entre os dois dias, sem dupla contagem.</p></div>` : "";
  const stopRows = stops.map(stop => `<tr><td>${escapeProduction(stop.date)}</td><td>${escapeProduction(stop.start)}–${escapeProduction(stop.end)}</td><td>${escapeProduction(stop.location || "—")}</td><td>${escapeProduction(stop.description)}</td><td>${productionStopDuration(stop.duration)}</td></tr>`).join("");
  const stoppages = `<section class="production-stops"><div class="production-section-head"><div><p class="eyebrow">PARALISAÇÕES REGISTRADAS</p><h3>Tempo parado por ocorrência</h3></div></div>${stops.length ? `<div class="production-stop-summary"><div><span>OCORRÊNCIAS</span><strong>${stops.length}</strong></div><div><span>TEMPO REGISTRADO</span><strong>${productionStopDuration(stopMinutes)}</strong></div></div>${dailyStopBars}<div class="production-stop-layout"><div><h4>POR MOTIVO</h4><div class="production-stop-reasons">${reasonBars}</div></div><div><h4>OCORRÊNCIAS</h4><div class="production-table-wrap production-stop-table-wrap"><table class="production-table production-stop-table"><thead><tr><th>Data</th><th>Horário</th><th>Terno / porão</th><th>Descrição</th><th>Duração</th></tr></thead><tbody>${stopRows}</tbody></table></div></div></div><p class="chart-insight"><strong>Leitura:</strong> ${reasonList.length ? `${escapeProduction(reasonList[0].reason)} representa ${productionNumber.format(reasonList[0].minutes / stopMinutes * 100)}% da soma dos tempos registrados.` : "Sem motivos identificados."}</p><p class="production-footnote">A soma reúne as durações registradas na planilha, inclusive DDS e paradas programadas. Ocorrências simultâneas de ternos diferentes podem se sobrepor; por isso, ela não representa necessariamente o tempo em que o navio inteiro ficou parado.</p>` : '<p class="production-empty">Nenhuma paralisação com início e término registrados nesta planilha.</p>'}</section>`;
  const source = productionState.sourceUrls[key];
  target.innerHTML = `<div class="production-report"><div class="production-vessel"><div><p class="eyebrow">RELATÓRIO DE OPERAÇÃO</p><h3>${escapeProduction(data.vessel)}</h3><p>${escapeProduction(data.cargo)} · ${planned === null ? "Meta não informada" : productionNumber.format(planned) + " t previstas"}</p></div>${source ? `<a href="${escapeProduction(source)}" target="_blank" rel="noopener noreferrer">Abrir planilha</a>` : ""}</div><div class="production-kpis">${cards}</div>${mismatch}${holdVisual}<div class="production-overall-progress"><div><span>AVANÇO DA OPERAÇÃO · ${percent === null ? "—" : productionNumber.format(percent) + "%"}</span><span>${planned === null ? "" : productionNumber.format(planned) + " t"}</span></div><i><b style="width:${Math.min(100, Math.max(0, percent || 0))}%"></b></i></div>${forecast}${crewPanel}${stoppages}<div class="production-grid"><section class="production-panel"><p class="eyebrow">EVOLUÇÃO</p><h3>PRODUÇÃO POR DIA</h3><div class="production-days">${bars}</div><p class="chart-insight"><strong>Leitura:</strong> ${daily.size ? `Maior volume diário em ${escapeProduction([...daily].sort((a, b) => b[1] - a[1])[0][0])}: ${productionNumber.format(top)} t.` : "Sem produção registrada."}</p></section><section class="production-panel"><p class="eyebrow">DETALHAMENTO</p><h3>PRODUÇÃO POR PERÍODO</h3><div class="production-table-wrap"><table class="production-table"><thead><tr><th>Data</th><th>Período</th><th>Etapa</th><th>Volume</th></tr></thead><tbody>${detail}</tbody></table></div></section></div><p class="production-footnote">Somente períodos com produção positiva aparecem no detalhamento; períodos futuros pré-preenchidos com zero não entram no total. ${data.offshoreProduced > 0 ? "Total e porões somam as etapas atracada e fundeada; " : ""}Fonte: aba ${escapeProduction(data.vessel)}.</p></div>`;
  const operationTime = productionTimeMetrics(data);
  if (operationTime) {
    const timePanel = document.createElement("section");
    timePanel.className = "production-time-panel";
    timePanel.innerHTML = `<div class="production-section-head"><div><p class="eyebrow">TEMPOS DA OPERAÇÃO</p><h3>Até o último período registrado</h3></div></div><div class="production-time-grid"><div><span>TEMPO TOTAL</span><strong>${productionStopDuration(operationTime.totalMinutes)}</strong></div><div><span>TEMPO PRODUTIVO ESTIMADO</span><strong>${productionStopDuration(operationTime.productiveMinutes)}</strong></div><div><span>TEMPO DE PARADA</span><strong>${productionStopDuration(operationTime.stoppedMinutes)}</strong></div></div><p class="production-footnote">Tempo total: início da operação até o fim do último período registrado. Tempo de parada: união dos intervalos registrados, sem dupla contagem de sobreposições. Tempo produtivo estimado: diferença entre os dois; em operações com ternos simultâneos, uma parada de um terno não significa necessariamente parada de todo o navio.</p>`;
    target.querySelector(".production-stops")?.before(timePanel);
  }
  target.querySelectorAll(".production-end-label").forEach(label => label.remove());
  target.querySelectorAll(".production-crane").forEach(crane => crane.remove());
  const vesselDiagram = target.querySelector(".production-vessel-diagram");
  const shipOutline = vesselDiagram?.querySelector(".production-ship-outline");
  if (shipOutline) shipOutline.innerHTML = `<path d="M16 112H984L968 181Q963 203 938 207H77Q46 207 31 184L16 170Z" fill="#636363" stroke="#2F2F2F" stroke-width="2.5"/><path d="M35 185Q51 202 77 203H939Q961 203 969 183" fill="none" stroke="#2F2F2F" stroke-width="2"/><path d="M38 110H964" stroke="#2F2F2F" stroke-width="4"/><path d="M43 111V63H61V40H118V30H137V111Z" fill="#636363" stroke="#2F2F2F" stroke-width="2"/><path d="M58 63H138M62 40H139M43 91H145M81 30V10M77 10H85M135 29H150V47H135" fill="none" stroke="#2F2F2F" stroke-width="2.5"/><path d="M56 73h9m6 0h9m6 0h9m6 0h9m6 0h9M56 84h9m6 0h9m6 0h9m6 0h9m6 0h9M70 48h10m6 0h10m6 0h10" stroke="#FFFFFF" stroke-width="3"/><path d="M972 111V80m-9 10h18M37 183l-11 7v17h15" fill="none" stroke="#2F2F2F" stroke-width="2.5"/><path d="M100 42h34" stroke="#DA202C" stroke-width="4"/>`;
  if (vesselDiagram && holds.length > 1) {
    const craneRow = document.createElement("div");
    craneRow.className = "production-crane-row";
    craneRow.style.setProperty("--hold-count", holds.length);
    craneRow.innerHTML = Array.from({ length: holds.length - 1 }, (_, index) => `<svg class="production-crane-silhouette" style="grid-column:${index + 1}" viewBox="0 0 100 100" preserveAspectRatio="xMidYMax meet" aria-hidden="true"><path d="M7 98V28H22V98Z" fill="#636363" stroke="#2F2F2F" stroke-width="1.5"/><path d="M5 29h20v9H5Z" fill="#636363" stroke="#2F2F2F" stroke-width="1.5"/><path d="M18 31 95 5 97 9 22 42Z" fill="#2F2F2F"/><path d="M18 31 95 5M19 40 91 10" fill="none" stroke="#8A8C91" stroke-width="1"/><path d="M95 9v46" fill="none" stroke="#2F2F2F" stroke-width="1.6"/><path d="M90 55h10l-5 8Z" fill="#DA202C"/><path d="M95 63v8m-5 0q5 9 10 0M3 98h25" fill="none" stroke="#2F2F2F" stroke-width="2"/></svg>`).join("");
    vesselDiagram.appendChild(craneRow);
  }
  if (!selectedHold && holds.length) {
    const detail = document.createElement("div");
    detail.className = "production-hold-detail";
    detail.innerHTML = `<div class="production-hold-detail-head"><div><h4>Produção total</h4><span>Todos os porões · clique em um porão para detalhar</span></div><div><span>PREVISTO</span><strong>${planned === null ? "—" : productionNumber.format(planned) + " t"}</strong></div><div><span>PRODUZIDO</span><strong>${productionNumber.format(produced)} t</strong></div><div><span>SALDO</span><strong>${remainder === null ? "—" : productionNumber.format(remainder) + " t"}</strong></div></div>`;
    target.querySelector(".production-holds")?.appendChild(detail);
  }
  target.querySelectorAll("[data-hold]").forEach(button => button.addEventListener("click", () => { const number = Number(button.dataset.hold); productionState.hold = productionState.hold === number ? null : number; renderProduction(); }));
}
async function loadProduction(force = false) {
  if (productionState.loading || (!force && Date.now() - productionState.lastFetch < 30000)) return;
  productionState.loading = true;
  const status = document.getElementById("productionStatus"), refresh = document.getElementById("productionRefresh");
  refresh.disabled = true; status.textContent = "Consultando as planilhas de produção…";
  try {
    const results = await Promise.all(Object.entries(productionWorkbooks).map(async ([sourceKind, id]) => {
      const response = await fetch(`/api/production-workbook?source=${sourceKind}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`Não foi possível consultar a planilha de ${sourceKind === "potassio" ? "potássio" : "outras cargas"}.`);
      const workbook = XLSX.read(await response.arrayBuffer(), { type: "array" });
      const data = {}, urls = {}, errors = {};
      for (const sheetName of workbook.SheetNames) {
        const rows = parseProductionCsv(XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName], { raw: false }));
        const start = productionStart(rows, Math.min(rows.length, 12));
        if (!start || new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone: "America/Sao_Paulo" }).format(start) !== "2026") continue;
        const key = `${sourceKind}:${sheetName}`;
        try {
          const vessel = rows[2]?.[0]?.trim() || sheetName.trim();
          data[key] = { ...parseProductionSheet(rows, vessel), sourceKind, sheetName };
          const gid = workbook.Sheets[sheetName]?.["!id"];
          urls[key] = `https://docs.google.com/spreadsheets/d/${id}/edit${gid === undefined ? "" : `?gid=${gid}`}`;
        } catch (error) { errors[key] = `${sheetName}: ${error.message}`; }
      }
      return { sourceKind, data, urls, errors };
    }).map(promise => promise.catch(error => ({ error }))));
    const nextData = { ...productionState.data }, nextUrls = { ...productionState.sourceUrls }, nextErrors = {};
    for (let index = 0; index < results.length; index++) {
      const sourceKind = Object.keys(productionWorkbooks)[index], result = results[index];
      if (result.error) { nextErrors[sourceKind] = result.error.message; continue; }
      for (const key of Object.keys(nextData)) if (key.startsWith(`${sourceKind}:`)) { delete nextData[key]; delete nextUrls[key]; }
      Object.assign(nextData, result.data); Object.assign(nextUrls, result.urls); Object.assign(nextErrors, result.errors);
    }
    productionState.data = nextData; productionState.sourceUrls = nextUrls; productionState.errors = nextErrors;
    productionState.fetchedAt = new Date().toISOString();
    productionState.lastFetch = Date.now();
    const failures = Object.keys(nextErrors).length;
    status.textContent = `${Object.keys(nextData).length} navios de 2026 · ${failures ? `${failures} ${failures === 1 ? "erro de leitura" : "erros de leitura"} · ` : ""}Consulta em ${productionTime.format(new Date(productionState.fetchedAt))}. Use “Atualizar produção” para consultar novamente.`;
  } catch {
    status.textContent = "Não foi possível atualizar agora. Os últimos dados consultados permanecem na tela; tente novamente.";
  } finally { productionState.loading = false; refresh.disabled = false; renderProduction(); }
}
document.getElementById("productionCargo").addEventListener("change", event => { productionState.cargo = event.target.value; productionState.hold = null; renderProduction(); });
document.getElementById("productionVessel").addEventListener("change", event => { productionState.selected = event.target.value; productionState.hold = null; renderProduction(); });
document.getElementById("productionRefresh").addEventListener("click", () => loadProduction(true));
window.productionPanel = { load: loadProduction };
