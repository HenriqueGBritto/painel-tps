/* Spreadsheet parsing stays in the browser; only normalized data is uploaded. */
function parseOperationsWorkbook(workbook, source) {
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
  const lineupCell = (row, index) => row[index + (geportColumn >= 0 && geportColumn <= index ? 1 : 0)];
  const lineupRecords = lineupRows.slice(1).filter(row => lineupCell(row, 0)).map((row, index) => ({
    id: `lineup-${index + 1}`, vessel: String(lineupCell(row, 0)).trim(), geport: geportColumn >= 0 ? String(row[geportColumn] ?? "").trim() : "",
    operation: label(lineupCell(row, 2)), cargo: label(lineupCell(row, 3)),
    plannedBerthTons: maybeNum(lineupCell(row, 4)), plannedOffshoreTons: hasOffshoreWeight ? maybeNum(lineupCell(row, 5)) : null,
    client: label(lineupCell(row, 5 + offset)), berth: label(lineupCell(row, 6 + offset)), agent: label(lineupCell(row, 7 + offset)),
    progress: maybeNum(lineupCell(row, 8 + offset)), plannedBerthStart: iso(lineupCell(row, 9 + offset)), plannedBerthEnd: iso(lineupCell(row, 10 + offset))
  }));
  if (!records.length) throw new Error("Nenhuma operação concluída foi encontrada nas abas anuais.");
  return { source, generatedAt: new Date().toISOString(), records, activeRecords,
    gusaSource: "BASE_GUSA_2026", gusaRecords, gusaActiveRecords, lineupRecords, lineupSchemaVersion: 2 };
}
