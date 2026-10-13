/* Leitura das duas planilhas-base (navios e indicadores) no servidor.
   Mesmo código que antes rodava no navegador na importação manual. */
import XLSX from "./vendor/xlsx.cjs";

export { XLSX };

export function parseOperationsWorkbook(workbook, source) {
  const required = ["2024", "2025", "2026", "BASE_GUSA_2026", "LINEUP"];
  const missing = required.filter(name => !workbook.Sheets[name]);
  if (missing.length) throw new Error(`Abas obrigatórias ausentes: ${missing.join(", ")}.`);
  const rows = name => XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: true, defval: null });
  const date = value => {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
    if (typeof value === "number" && value > 30000 && value < 100000) {
      const parsed = XLSX.SSF.parse_date_code(value);
      if (parsed) return new Date(parsed.y, parsed.m - 1, parsed.d, parsed.H, parsed.M, parsed.S);
    }
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    return null;
  };
  const iso = value => date(value)?.toISOString() || null;
  const num = value => typeof value === "number" && Number.isFinite(value) ? value : 0;
  const maybeNum = value => value === null || value === undefined || value === "" ? null : num(value);
  const draftWeight = row => {
    const total = maybeNum(row[17]);
    if (total !== null) return total;
    const berth = maybeNum(row[15]), offshore = maybeNum(row[16]);
    return berth === null && offshore === null ? null : (berth || 0) + (offshore || 0);
  };
  const label = value => String(value || "Não informado").trim();
  const records = [], activeRecords = [], gusaRecords = [], gusaActiveRecords = [];
  for (const sheet of ["2024", "2025", "2026"]) {
    const legacy = sheet === "2024";
    for (const [index, row] of rows(sheet).entries()) {
      if (index === 0 || !row?.[0]) continue;
      const berthStart = row[legacy ? 2 : 3], berthEnd = row[legacy ? 3 : 4];
      const operationStart = row[legacy ? 4 : 5], operationEnd = row[legacy ? 5 : 6];
      const start = date(operationStart) || date(berthStart);
      const end = date(operationEnd) || date(berthEnd);
      if (!start) continue;
      const tons = num(row[legacy ? 14 : 16]) || num(row[legacy ? 13 : 15]) / 1000;
      const common = {
        id: `${sheet}-${index}`, vessel: String(row[0]).trim(),
        berthStart: iso(berthStart), operationStart: iso(operationStart),
        berth: label(row[legacy ? 6 : 7]), operation: label(row[legacy ? 7 : 8]),
        client: label(row[legacy ? 8 : 9]), cargo: label(row[legacy ? 9 : 11]),
      };
      if (!date(berthEnd)) {
        activeRecords.push({ ...common, year: start.getFullYear(), month: start.getMonth() + 1, partialTons: Math.round(tons * 1000) / 1000 });
        continue;
      }
      let productivity = num(row[legacy ? 15 : 17]);
      if (!productivity && end > start) productivity = tons / ((end - start) / 86400000);
      records.push({ ...common, year: start.getFullYear(), month: start.getMonth() + 1,
        berthEnd: iso(berthEnd), operationEnd: iso(operationEnd),
        tons: Math.round(tons * 1000) / 1000, productivity: Math.round(productivity * 1000) / 1000 });
    }
  }
  for (const [index, row] of rows("BASE_GUSA_2026").entries()) {
    if (index === 0 || !row?.[0]) continue;
    const departure = date(row[4]);
    const start = date(row[5]) || date(row[3]);
    if (departure) {
      gusaRecords.push({ vessel: String(row[0]).trim(), departure: departure.toISOString(), operationStart: iso(row[5]), berthStart: iso(row[3]),
        year: start?.getFullYear() ?? departure.getFullYear(), month: start ? start.getMonth() + 1 : departure.getMonth() + 1,
        draftTons: draftWeight(row), invoiceTons: num(row[18]), scaleTons: num(row[19]) });
    } else if (start) {
      gusaActiveRecords.push({ vessel: String(row[0]).trim(), year: start.getFullYear(), month: start.getMonth() + 1,
        berthStart: iso(row[3]), operationStart: iso(row[5]), partialTons: num(row[15]),
        berthDraftTons: maybeNum(row[15]), offshoreDraftTons: maybeNum(row[16]),
        draftTons: draftWeight(row), invoiceTons: maybeNum(row[18]), scaleTons: maybeNum(row[19]) });
    }
  }
  const lineupRows = rows("LINEUP");
  const hasOffshoreWeight = lineupRows[0]?.some(cell => /AO\s+LARGO/i.test(String(cell || "")));
  const geportColumn = lineupRows[0]?.findIndex(cell => /GEPORT/i.test(String(cell || ""))) ?? -1;
  const offset = hasOffshoreWeight ? 1 : 0;
  // Berço em maiúsculas, como na planilha de navios, para o Gantt juntar navio atracado e previsto na mesma linha.
  const upper = value => value === null || value === undefined ? value : String(value).toLocaleUpperCase("pt-BR");
  const lineupCell = (row, index) => row[index + (geportColumn >= 0 && geportColumn <= index ? 1 : 0)];
  const lineupRecords = lineupRows.slice(1).filter(row => lineupCell(row, 0)).map((row, index) => ({
    id: `lineup-${index + 1}`, vessel: String(lineupCell(row, 0)).trim(), geport: geportColumn >= 0 ? String(row[geportColumn] ?? "").trim() : "",
    operation: label(lineupCell(row, 2)), cargo: label(lineupCell(row, 3)),
    plannedBerthTons: maybeNum(lineupCell(row, 4)), plannedOffshoreTons: hasOffshoreWeight ? maybeNum(lineupCell(row, 5)) : null,
    client: label(lineupCell(row, 5 + offset)), berth: label(upper(lineupCell(row, 6 + offset))), agent: label(lineupCell(row, 7 + offset)),
    progress: maybeNum(lineupCell(row, 8 + offset)), plannedBerthStart: iso(lineupCell(row, 9 + offset)), plannedBerthEnd: iso(lineupCell(row, 10 + offset))
  }));
  if (!records.length) throw new Error("Nenhuma operação concluída foi encontrada nas abas anuais.");
  return { source, generatedAt: new Date().toISOString(), records, activeRecords,
    gusaSource: "BASE_GUSA_2026", gusaRecords, gusaActiveRecords, lineupRecords, lineupSchemaVersion: 2 };
}

const round2 = value => Math.round((value + Number.EPSILON) * 100) / 100;
const monthKey = (year, month) => `${year}-${String(month).padStart(2, "0")}`;
const dateFromCell = value => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === "number" && value > 30000 && value < 100000) {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return `${parsed.y}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}`;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^20\d\d-\d\d-\d\d/.test(trimmed)) return trimmed.slice(0, 10);
    const match = /^(\d{1,2})\/(\d{1,2})\/(20\d\d)/.exec(trimmed);
    if (match) return `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
  }
  return null;
};
const numeric = value => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(?:[.,]\d+)?$/.test(value.trim())) return Number(value.replace(",", "."));
  return null;
};
const cellMinutes = value => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.round(value * 1440));
  if (value instanceof Date) return Math.max(0, Math.round((value.getTime() - Date.UTC(1899, 11, 31)) / 60000));
  if (typeof value === "string") {
    const parts = value.trim().split(":");
    if ((parts.length === 2 || parts.length === 3) && parts.every(part => /^\d+$/.test(part))) return Number(parts[0]) * 60 + Number(parts[1]) + (parts[2] ? Math.round(Number(parts[2]) / 60) : 0);
  }
  return 0;
};
const sheetCell = (sheet, row, col) => {
  const cell = sheet["!data"]?.[row]?.[col] || sheet[XLSX.utils.encode_cell({ r: row, c: col })];
  return cell?.v ?? null;
};
const text = value => String(value ?? "").trim();

export function parseDischargeWorkbook(workbook, source, modified) {
  const dischargeSheet = workbook.Sheets["Base Descarga"];
  const weighingSheet = workbook.Sheets["Base Pesagens"];
  if (!dischargeSheet || !weighingSheet) throw new Error("A planilha precisa ter as abas Base Descarga e Base Pesagens.");
  const days = new Map(), vessels = new Map(), occurrences = new Map(), plans = new Map();
  const inProgress = { records: 0, tonsListed: 0 };
  const maxRow = XLSX.utils.decode_range(dischargeSheet["!ref"]).e.r;
  for (let row = 2; row <= maxRow; row++) {
    const date = dateFromCell(sheetCell(dischargeSheet, row, 18));
    const weight = numeric(sheetCell(dischargeSheet, row, 10));
    const status = text(sheetCell(dischargeSheet, row, 23)).toUpperCase();
    if (date && weight !== null && status === "FINALIZADO") {
      const wagons = numeric(sheetCell(dischargeSheet, row, 22)) || 0;
      const day = days.get(date) || { date, tons: 0, wagons: 0, records: 0 };
      day.tons += weight; day.wagons += wagons; day.records++;
      days.set(date, day);
      const vessel = text(sheetCell(dischargeSheet, row, 15)) || "Não informado";
      const key = `${date}\u0000${vessel}`;
      const item = vessels.get(key) || { date, vessel, tons: 0, wagons: 0 };
      item.tons += weight; item.wagons += wagons;
      vessels.set(key, item);
    } else if (status === "EM DESCARGA") {
      inProgress.records++;
      inProgress.tonsListed += weight || 0;
    }
    const occurred = dateFromCell(sheetCell(dischargeSheet, row, 33));
    const reason = text(sheetCell(dischargeSheet, row, 38));
    if (occurred && reason) {
      const code = text(sheetCell(dischargeSheet, row, 37));
      const responsible = text(sheetCell(dischargeSheet, row, 39)) || "Não informado";
      const key = `${occurred}\u0000${code}\u0000${reason}\u0000${responsible}`;
      const item = occurrences.get(key) || { date: occurred, code, reason, responsible, count: 0, minutes: 0 };
      item.count++;
      item.minutes += cellMinutes(sheetCell(dischargeSheet, row, 36));
      occurrences.set(key, item);
    }
    const year = numeric(sheetCell(dischargeSheet, row, 60));
    const month = numeric(sheetCell(dischargeSheet, row, 61));
    if (year && month >= 1 && month <= 12) {
      const challenge = numeric(sheetCell(dischargeSheet, row, 63));
      const plan = numeric(sheetCell(dischargeSheet, row, 64));
      const actual = numeric(sheetCell(dischargeSheet, row, 65));
      if ([challenge, plan, actual].some(value => value !== null)) plans.set(monthKey(year, month), { year, month, challenge, plan, actual });
    }
  }
  const weighings = [];
  const weighingLast = XLSX.utils.decode_range(weighingSheet["!ref"]).e.r;
  for (let row = 2; row <= weighingLast; row++) {
    const vessel = text(sheetCell(weighingSheet, row, 0));
    const date = dateFromCell(sheetCell(weighingSheet, row, 1));
    if (!vessel || !date) continue;
    weighings.push({ vessel, year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)), invoiceTons: numeric(sheetCell(weighingSheet, row, 5)), unloadedTons: numeric(sheetCell(weighingSheet, row, 6)), draftTons: numeric(sheetCell(weighingSheet, row, 7)), client: text(sheetCell(weighingSheet, row, 9)), trader: text(sheetCell(weighingSheet, row, 10)), status: text(sheetCell(weighingSheet, row, 11)), layDays: text(sheetCell(weighingSheet, row, 4)) });
  }
  return { source, sourceModifiedAt: new Date(modified).toISOString(), generatedAt: new Date().toISOString(),
    dischargeDays: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).map(item => ({ ...item, tons: round2(item.tons), wagons: Math.round(item.wagons) })),
    dischargeVessels: [...vessels.values()].sort((a, b) => a.date.localeCompare(b.date)).map(item => ({ ...item, tons: round2(item.tons), wagons: Math.round(item.wagons) })),
    occurrences: [...occurrences.values()].sort((a, b) => a.date.localeCompare(b.date)),
    plans: [...plans.values()].sort((a, b) => a.year - b.year || a.month - b.month), weighings,
    inProgress: { records: inProgress.records, tonsListed: round2(inProgress.tonsListed) } };
}
