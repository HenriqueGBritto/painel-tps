/* Leitura direta das planilhas no Google Drive.
   Cada planilha precisa estar compartilhada como "Qualquer pessoa com o link – Leitor".
   Os IDs podem ser trocados no Netlify sem novo código, pelas variáveis
   TPS_SHEET_OPERATIONS, TPS_SHEET_LINEUP, TPS_SHEET_DISCHARGE e TPS_SHEET_PURCHASES. */
import { XLSX, parseOperationsWorkbook, parseDischargeWorkbook } from "./parsers.mjs";
import { parseTeamWorkbook, TEAM_TABS } from "./team-parsers.mjs";
import { readColumns } from "./fast-xlsx.mjs";
import { parsePurchasesWorkbook } from "./purchases.mjs";

const MAX_BYTES = 40 * 1024 * 1024;
const CACHE_MS = 2 * 60 * 1000;

export const SHEETS = {
  operations: {
    env: "TPS_SHEET_OPERATIONS",
    defaultId: "1nPBFECVbRr7cYxxmGRXdT3F9f0zT_wWm", // dados_navios_dinamico_triunfo.xlsm
    label: "dados_navios_dinamico_triunfo",
    fileName: "dados_navios_dinamico_triunfo.xlsm",
    tabs: ["2024", "2025", "2026", "BASE_GUSA_2026"],
    readOptions: { cellDates: false },
    // A aba LINEUP fica na planilha de produção "outras" (Google Planilhas nativo), com a mesma estrutura de antes.
    lineup: { env: "TPS_SHEET_LINEUP", defaultId: "1KDStqZVY5vBG4LwByytYa2QSyNcjg9KQJXlV1rN43PU", fileName: "Planilha de produção \"outras\" (aba LINEUP)", tab: "LINEUP", order: ["sheets", "drive"] }
  },
  discharge: {
    env: "TPS_SHEET_DISCHARGE",
    defaultId: "12ionZt6pJ7yeX59EUX-rppOCugcvp9F7", // Base - Indicadores Operacionais TPS.xlsx
    label: "Base - Indicadores Operacionais TPS",
    fileName: "Base - Indicadores Operacionais TPS.xlsx",
    tabs: ["Base Descarga", "Base Pesagens"],
    // Colunas lidas pelo parseDischargeWorkbook (0 = A). Se o leitor passar a usar outra coluna, inclua aqui.
    columns: {
      "Base Descarga": [10, 15, 18, 22, 23, 33, 36, 37, 38, 39, 60, 61, 63, 64, 65],
      "Base Pesagens": [0, 1, 4, 5, 6, 7, 9, 10, 11]
    },
    readOptions: { dense: true, cellDates: true }
  },
  // Equipe TPS (aba Equipe): .xlsx no Drive aberto pelo Google Planilhas. Lida 1 vez por dia ou pelo botão.
  team: {
    env: "TPS_SHEET_TEAM",
    defaultId: "1qeQgIOmbg9jW1l0id6Sgt39y657PTzbM",
    label: "Equipe TPS",
    fileName: "Planilha da equipe TPS",
    tabs: Object.values(TEAM_TABS),
    readOptions: { cellDates: false },
    order: ["sheets", "drive"],
    editUrl: true
  },
  // Compras: Controle de RMS (.xlsx no Drive). Lê todas as abas: a base e o orçamento são achados pelo cabeçalho.
  purchases: {
    env: "TPS_SHEET_PURCHASES",
    defaultId: "1SoWGctzB4l3DmtY2H7sOdHnUgG1iogjA",
    label: "Controle de RMS",
    fileName: "Controle_RMS_2025_2026_classificado.xlsx",
    readOptions: { cellDates: false },
    editUrl: true
  }
};

/** Aceita o ID puro ou qualquer link do Google Planilhas/Drive. */
export function sheetId(value) {
  const text = String(value || "").trim();
  const match = /\/d\/([A-Za-z0-9_-]{20,})/.exec(text) || /[?&]id=([A-Za-z0-9_-]{20,})/.exec(text) || /^([A-Za-z0-9_-]{20,})$/.exec(text);
  return match ? match[1] : null;
}

export function sourceId(kind, env = process.env) {
  const config = SHEETS[kind];
  if (!config) throw new Error("Base desconhecida.");
  return sheetId(env[config.env]) || sheetId(config.defaultId);
}

/** Planilha de onde vem a aba LINEUP. */
export function lineupId(env = process.env) {
  const config = SHEETS.operations.lineup;
  return sheetId(env[config.env]) || sheetId(config.defaultId);
}

export function sheetUrl(kind, env = process.env) {
  const id = sourceId(kind, env);
  if (!id) return null;
  return SHEETS[kind].editUrl ? `https://docs.google.com/spreadsheets/d/${id}/edit` : `https://drive.google.com/file/d/${id}/view`;
}

/**
 * Arquivos lidos para cada base, com nome e link, para a página mostrar de onde vêm os dados.
 * Se a variável do Netlify apontar para outro arquivo, o nome padrão deixa de valer.
 */
export function sourceFiles(kind, env = process.env) {
  const describe = (config, id, url) => ({
    name: id === sheetId(config.defaultId) ? config.fileName : `Arquivo definido em ${config.env}`,
    url
  });
  const id = sourceId(kind, env);
  const files = [describe(SHEETS[kind], id, sheetUrl(kind, env))];
  if (kind === "operations") {
    const extra = lineupId(env);
    files.push(describe(SHEETS.operations.lineup, extra, extra ? `https://docs.google.com/spreadsheets/d/${extra}/edit` : null));
  }
  return files;
}

const isZip = bytes => bytes.byteLength > 100 && bytes[0] === 0x50 && bytes[1] === 0x4b;

/* Duas formas de baixar:
   - "drive": arquivo .xlsx/.xlsm guardado no Drive como está. Baixa o original, sem conversão (rápido).
   - "sheets": planilha nativa do Google Planilhas, exportada em .xlsx.
   A ordem padrão começa pelo Drive, porque as duas bases são arquivos do Excel.
   A exportação do Google Planilhas num arquivo do Excel obriga o Google a converter tudo
   e foi a causa da lentidão (cerca de 16 s). As planilhas de produção são nativas e usam ["sheets", "drive"]. */
export async function downloadWorkbook(id, fetcher = fetch, order = ["drive", "sheets"]) {
  const bucket = Math.floor(Date.now() / 60000);
  const sources = {
    drive: `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`,
    sheets: `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx&_=${bucket}`
  };
  const urls = order.map(kind => sources[kind]);
  let lastError = "Planilha indisponível.";
  for (const url of urls) {
    try {
      const started = Date.now();
      const response = await fetcher(url, { redirect: "follow", signal: AbortSignal.timeout(8000) });
      if (!response.ok) { lastError = `Google respondeu ${response.status}.`; continue; }
      if (Number(response.headers.get("content-length")) > MAX_BYTES) { lastError = "Planilha grande demais."; continue; }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_BYTES) { lastError = "Planilha grande demais."; continue; }
      if (isZip(bytes)) {
        console.log(`Planilha ${id} baixada de ${new URL(url).hostname} em ${Date.now() - started} ms (${(bytes.byteLength / 1048576).toFixed(1)} MB).`);
        return bytes;
      }
      lastError = "O Google não devolveu uma planilha. Confira se o compartilhamento está como “Qualquer pessoa com o link”.";
    } catch (error) {
      lastError = `Falha de rede ao consultar o Google: ${error.message}`;
    }
  }
  throw new Error(lastError);
}

/* Junta a aba LINEUP de outra planilha à de navios. Sem lineupBytes, vale a LINEUP da própria planilha. */
function attachLineup(workbook, lineupBytes) {
  if (!lineupBytes) return workbook;
  const { tab } = SHEETS.operations.lineup;
  const source = XLSX.read(lineupBytes, { type: "array", sheets: [tab], cellText: false, cellHTML: false, cellFormula: false, cellDates: false });
  if (!source.Sheets[tab]) throw new Error(`Aba ${tab} ausente na planilha de produção.`);
  workbook.Sheets[tab] = source.Sheets[tab];
  return workbook;
}

export function parseSheet(kind, bytes, fetchedAt = new Date(), { lineupBytes = null } = {}) {
  const config = SHEETS[kind];
  // Só os valores interessam: pular texto formatado, HTML e fórmulas deixa a leitura bem mais rápida.
  const workbook = config.columns
    ? readColumns(bytes, config.columns, { cellDates: false })
    : XLSX.read(bytes, { type: "array", sheets: lineupBytes || !config.lineup ? config.tabs : [...config.tabs, config.lineup.tab], cellText: false, cellHTML: false, cellFormula: false, ...config.readOptions });
  const source = `${config.label} (Google Planilhas)`;
  const data = kind === "purchases" ? parsePurchasesWorkbook(workbook, source) : kind === "team" ? parseTeamWorkbook(workbook, source) : kind === "operations"
    ? parseOperationsWorkbook(attachLineup(workbook, lineupBytes), source)
    : parseDischargeWorkbook(workbook, source, fetchedAt.getTime());
  if (kind === "discharge" && !data.dischargeDays.length) throw new Error("Nenhuma descarga concluída foi encontrada na planilha.");
  data.generatedAt = fetchedAt.toISOString();
  data.origin = "google-sheets";
  data.sheetUrl = sheetUrl(kind);
  return data;
}

const cache = new Map();

/** Lê e interpreta a planilha, com cache curto na memória da função. */
export async function loadSheet(kind, { fetcher = fetch, now = Date.now, force = false } = {}) {
  const id = sourceId(kind);
  if (!id) throw new Error(`Link da planilha não configurado (${SHEETS[kind].env}).`);
  const extraId = kind === "operations" ? lineupId() : null;
  const key = `${id}|${extraId || ""}`;
  const cached = cache.get(kind);
  if (!force && cached && cached.id === key && now() - cached.at < CACHE_MS) return cached.data;
  const [bytes, lineupBytes] = await Promise.all([
    downloadWorkbook(id, fetcher, SHEETS[kind].order),
    extraId ? downloadWorkbook(extraId, fetcher, SHEETS.operations.lineup.order) : null
  ]);
  const parseStarted = Date.now();
  const data = parseSheet(kind, bytes, new Date(now()), { lineupBytes });
  console.log(`Planilha ${kind} interpretada em ${Date.now() - parseStarted} ms.`);
  cache.set(kind, { id: key, at: now(), data });
  return data;
}

export function clearSheetCache() { cache.clear(); }
