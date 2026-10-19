import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { XLSX } from "../netlify/lib/parsers.mjs";
import { sheetId, sourceId, lineupId, sourceFiles, downloadWorkbook, parseSheet, loadSheet, clearSheetCache } from "../netlify/lib/sheets.mjs";
import handler from "../netlify/functions/api.mjs";

const ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const toBytes = workbook => new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }));
const fakeResponse = (body, status = 200) => ({ ok: status < 400, status, headers: new Map([["content-length", String(body.byteLength ?? body.length)]]), arrayBuffer: async () => body });

function operationsWorkbook() {
  const wb = XLSX.utils.book_new();
  const d = (y, m, day, h = 0) => new Date(y, m - 1, day, h);
  const yearSheet = rows => XLSX.utils.aoa_to_sheet([["NAVIO"], ...rows], { cellDates: true });
  XLSX.utils.book_append_sheet(wb, yearSheet([["NAVIO 2024", null, d(2024, 3, 1, 8), d(2024, 3, 4, 10), d(2024, 3, 1, 9), d(2024, 3, 4, 9), "B1", "DESCARGA", "CLIENTE", "GUSA", null, null, null, 30000000, 30000, 9500]]), "2024");
  XLSX.utils.book_append_sheet(wb, yearSheet([["NAVIO 2025", null, null, d(2025, 1, 1, 0), d(2025, 1, 3, 12), d(2025, 1, 1, 1), d(2025, 1, 3, 11), "B2", "EMBARQUE", "CLIENTE 2", null, "POTÁSSIO", null, null, null, 40000000, 40000, 0]]), "2025");
  XLSX.utils.book_append_sheet(wb, yearSheet([
    ["NAVIO 2026", null, null, d(2026, 9, 30, 23), d(2026, 10, 2, 6), d(2026, 9, 30, 23), d(2026, 10, 2, 5), "B1", "DESCARGA", "CLIENTE", null, "GUSA", null, null, null, 0, 25000, 0],
    ["ATRACADO", null, null, d(2026, 10, 10, 7), null, d(2026, 10, 10, 8), null, "B2", "DESCARGA", "CLIENTE", null, "GUSA", null, null, null, 0, 1200, 0]
  ]), "2026");
  XLSX.utils.book_append_sheet(wb, yearSheet([["NAVIO 2026", null, null, d(2026, 9, 30, 23), d(2026, 10, 2, 6), d(2026, 9, 30, 23), null, null, null, null, null, null, null, null, null, 24000, 1000, 25000, 24900, 24800]]), "BASE_GUSA_2026");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["NAVIO", "X", "OPERAÇÃO", "CARGA", "PESO", "CLIENTE", "BERÇO", "AGENTE", "%", "INÍCIO", "FIM"], ["FUTURO", null, "DESCARGA", "GUSA", 30000, "CLIENTE", "B1", "AG", 0, d(2026, 11, 1, 6), d(2026, 11, 4, 18)]], { cellDates: true }), "LINEUP");
  return wb;
}

function dischargeWorkbook() {
  const wb = XLSX.utils.book_new();
  const row = new Array(66).fill(null);
  const r1 = [...row]; r1[18] = new Date(2026, 9, 5); r1[10] = 812.4; r1[23] = "FINALIZADO"; r1[22] = 12; r1[15] = "NAVIO 2026";
  r1[33] = new Date(2026, 9, 5); r1[37] = "P01"; r1[38] = "CHUVA"; r1[39] = "TRIUNFO"; r1[36] = 0.0625; r1[60] = 2026; r1[61] = 10; r1[63] = 90000; r1[64] = 85000; r1[65] = 40000;
  const r2 = [...row]; r2[10] = 300; r2[23] = "EM DESCARGA";
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["T"], ["H"], r1, r2], { cellDates: true }), "Base Descarga");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["T"], ["H"], ["NAVIO 2026", new Date(2026, 9, 1), null, null, "3", 25000, 24900, 24800, null, "CLIENTE", "TRADER", "OK"]], { cellDates: true }), "Base Pesagens");
  return wb;
}

/* Executa os leitores que antes rodavam no navegador, para provar que o servidor gera os mesmos dados. */
function legacyParsers() {
  const context = { XLSX, document: { getElementById: () => null }, window: {}, Intl, Date, Math, Number, String, Map, Set, Array, Object, Error };
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL("./fixtures/legacy-import.js", import.meta.url), "utf8"), context);
  vm.runInContext(readFileSync(new URL("./fixtures/legacy-discharge.js", import.meta.url), "utf8"), context);
  return { operations: context.parseOperationsWorkbook, discharge: context.window.dischargePanel.parseWorkbook };
}

const strip = ({ source, generatedAt, sourceModifiedAt, origin, sheetUrl, ...rest }) => rest;

test("aceita link de planilha, de arquivo do Drive ou ID puro", () => {
  assert.equal(sheetId(`https://docs.google.com/spreadsheets/d/${ID}/edit?usp=sharing`), ID);
  assert.equal(sheetId(`https://drive.google.com/file/d/${ID}/view?usp=drive_link`), ID);
  assert.equal(sheetId(`https://drive.google.com/open?id=${ID}`), ID);
  assert.equal(sheetId(ID), ID);
  assert.equal(sheetId("https://drive.google.com/drive/folders/curto"), null);
  assert.equal(sourceId("operations", { TPS_SHEET_OPERATIONS: `https://docs.google.com/spreadsheets/d/${ID}/edit` }), ID);
});

test("servidor lê a planilha de navios exatamente como a importação manual", () => {
  const wb = operationsWorkbook();
  const server = parseSheet("operations", toBytes(wb));
  const legacy = legacyParsers().operations(XLSX.read(toBytes(wb), { type: "array", cellDates: false }), "x.xlsm");
  assert.deepEqual(strip(server), strip(JSON.parse(JSON.stringify(legacy))));
  assert.equal(server.records.length, 3);
  assert.equal(server.activeRecords.length, 1);
  assert.equal(server.records.find(r => r.vessel === "NAVIO 2026").operationStart, "2026-10-01T02:00:00.000Z", "23h de Brasília");
});

test("LINEUP vem da planilha de produção, com a coluna LOA e o mesmo resultado", async () => {
  const d = (y, m, day, h = 0) => new Date(y, m - 1, day, h);
  const navios = operationsWorkbook();
  const reference = parseSheet("operations", toBytes(navios));
  delete navios.Sheets.LINEUP; navios.SheetNames = navios.SheetNames.filter(name => name !== "LINEUP");
  const producao = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(producao, XLSX.utils.aoa_to_sheet([["X"]]), "MV QUALQUER");
  XLSX.utils.book_append_sheet(producao, XLSX.utils.aoa_to_sheet([
    ["NAVIO", "LOA (m)", "GEPORT", "OPERAÇÃO", "TIPO DE CARGA", "PESO PREVISTO ATRACADO(t)", "PESO PREVISTO AO LARGO(t)", "CLIENTE", "LOCAL ATRACAÇÃO / BERÇO", "AGENTE", "PROGRESSO", "ATRACAÇÃO PREVISTA", "DESATRACAÇÃO PREVISTA"],
    ["FUTURO", 180, 54417, "DESCARGA", "GUSA", 30000, 5000, "CLIENTE", "B1", "AG", 0, d(2026, 11, 1, 6), d(2026, 11, 4, 18)]
  ], { cellDates: true }), "LINEUP");
  const data = parseSheet("operations", toBytes(navios), new Date(), { lineupBytes: toBytes(producao) });
  assert.deepEqual(data.records, reference.records);
  assert.deepEqual(data.lineupRecords, [{ id: "lineup-1", vessel: "FUTURO", geport: "54417", operation: "DESCARGA", cargo: "GUSA",
    plannedBerthTons: 30000, plannedOffshoreTons: 5000, client: "CLIENTE", berth: "B1", agent: "AG", progress: 0,
    plannedBerthStart: reference.lineupRecords[0].plannedBerthStart, plannedBerthEnd: reference.lineupRecords[0].plannedBerthEnd }]);
  assert.throws(() => parseSheet("operations", toBytes(navios), new Date(), { lineupBytes: toBytes(navios) }), /LINEUP ausente na planilha de produção/);
  assert.throws(() => parseSheet("operations", toBytes(navios)), /Abas obrigatórias ausentes: LINEUP/);

  clearSheetCache();
  const urls = [];
  const fetcher = async url => { urls.push(url); return fakeResponse(toBytes(url.includes(lineupId()) ? producao : navios)); };
  const loaded = await loadSheet("operations", { fetcher, force: true });
  assert.equal(loaded.lineupRecords[0].vessel, "FUTURO");
  assert.ok(urls.some(url => url.includes(`spreadsheets/d/${lineupId()}/export`)), "planilha nativa: exportação primeiro");
  assert.equal(lineupId({ TPS_SHEET_LINEUP: `https://docs.google.com/spreadsheets/d/${ID}/edit` }), ID);
  clearSheetCache();
});

test("servidor lê a base de descarga exatamente como a importação manual", () => {
  const wb = dischargeWorkbook();
  const server = parseSheet("discharge", toBytes(wb));
  const legacy = legacyParsers().discharge(XLSX.read(toBytes(wb), { type: "array", dense: true, cellDates: true }), "x.xlsx", Date.now());
  assert.deepEqual(strip(server), strip(JSON.parse(JSON.stringify(legacy))));
  assert.deepEqual(server.dischargeDays, [{ date: "2026-10-05", tons: 812.4, wagons: 12, records: 1 }]);
  assert.equal(server.occurrences[0].minutes, 90);
});

test("tenta primeiro o arquivo original do Drive e só depois a exportação do Google Planilhas", async () => {
  const bytes = toBytes(dischargeWorkbook());
  const calls = [];
  const result = await downloadWorkbook(ID, async url => { calls.push(url); return calls.length === 1 ? fakeResponse(new TextEncoder().encode("<html>login</html>")) : fakeResponse(bytes); });
  assert.equal(calls.length, 2);
  assert.match(calls[0], /drive\.usercontent\.google\.com/);
  assert.match(calls[1], /docs\.google\.com\/spreadsheets/);
  assert.equal(result.byteLength, bytes.byteLength);
});

test("explica quando a planilha não está compartilhada", async () => {
  await assert.rejects(downloadWorkbook(ID, async () => fakeResponse(new TextEncoder().encode("<html>login</html>"))), /Qualquer pessoa com o link/);
});

test("guarda a leitura por alguns minutos para não consultar o Google a cada acesso", async () => {
  clearSheetCache();
  process.env.TPS_SHEET_DISCHARGE = ID;
  let calls = 0, clock = 1_000_000;
  const options = { fetcher: async () => { calls++; return fakeResponse(toBytes(dischargeWorkbook())); }, now: () => clock };
  await loadSheet("discharge", options);
  await loadSheet("discharge", options);
  assert.equal(calls, 1);
  clock += 3 * 60 * 1000;
  await loadSheet("discharge", options);
  assert.equal(calls, 2);
  delete process.env.TPS_SHEET_DISCHARGE;
  clearSheetCache();
});

test("sem acesso à planilha, a API devolve a última base salva com aviso", async () => {
  const saved = { ...process.env };
  const realFetch = globalThis.fetch;
  delete process.env.TPS_SHEET_OPERATIONS; delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  // Google fora do ar: o teste não depende da internet (com rede, a leitura real funcionaria e o teste falharia).
  globalThis.fetch = async () => { throw new Error("rede indisponível no teste"); };
  clearSheetCache();
  try {
    const response = await handler(new Request("https://painel.test/api/data"));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.origin, "fallback");
    assert.match(body.fallbackReason, /rede indisponível no teste/);
    assert.ok(body.records.length > 0);
    assert.equal((await handler(new Request("https://painel.test/api/import", { method: "POST" }))).status, 404, "importação manual removida");
  } finally {
    globalThis.fetch = realFetch;
    Object.assign(process.env, saved);
  }
});

test("cada base informa o nome e o link dos arquivos lidos", () => {
  assert.deepEqual(sourceFiles("discharge", {}).map(file => file.name), ["Base - Indicadores Operacionais TPS.xlsx"]);
  const operations = sourceFiles("operations", {});
  assert.deepEqual(operations.map(file => file.name), ["dados_navios_dinamico_triunfo.xlsm", "Planilha de produção \"outras\" (aba LINEUP)"]);
  assert.match(operations[1].url, /^https:\/\/docs\.google\.com\/spreadsheets\/d\/1KDStq/);
  const custom = sourceFiles("discharge", { TPS_SHEET_DISCHARGE: "https://drive.google.com/file/d/abcdefghijklmnopqrstuvwxyz/view" });
  assert.deepEqual(custom, [{ name: "Arquivo definido em TPS_SHEET_DISCHARGE", url: "https://drive.google.com/file/d/abcdefghijklmnopqrstuvwxyz/view" }]);
});
