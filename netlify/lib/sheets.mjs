/* Leitura direta das planilhas no Google Drive.
   Cada planilha precisa estar compartilhada como "Qualquer pessoa com o link – Leitor".
   Os IDs podem ser trocados no Netlify sem novo código, pelas variáveis
   TPS_SHEET_OPERATIONS e TPS_SHEET_DISCHARGE. */
import { XLSX, parseOperationsWorkbook, parseDischargeWorkbook } from "./parsers.mjs";
import { readColumns } from "./fast-xlsx.mjs";

const MAX_BYTES = 40 * 1024 * 1024;
const CACHE_MS = 2 * 60 * 1000;

export const SHEETS = {
  operations: {
    env: "TPS_SHEET_OPERATIONS",
    defaultId: "1nPBFECVbRr7cYxxmGRXdT3F9f0zT_wWm", // dados_navios_dinamico_triunfo.xlsm
    label: "dados_navios_dinamico_triunfo",
    tabs: ["2024", "2025", "2026", "BASE_GUSA_2026", "LINEUP"],
    readOptions: { cellDates: false }
  },
  discharge: {
    env: "TPS_SHEET_DISCHARGE",
    defaultId: "12ionZt6pJ7yeX59EUX-rppOCugcvp9F7", // Base - Indicadores Operacionais TPS.xlsx
    label: "Base - Indicadores Operacionais TPS",
    tabs: ["Base Descarga", "Base Pesagens"],
    // Colunas lidas pelo parseDischargeWorkbook (0 = A). Se o leitor passar a usar outra coluna, inclua aqui.
    columns: {
      "Base Descarga": [10, 15, 18, 22, 23, 33, 36, 37, 38, 39, 60, 61, 63, 64, 65],
      "Base Pesagens": [0, 1, 4, 5, 6, 7, 9, 10, 11]
    },
    readOptions: { dense: true, cellDates: true }
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

export function sheetUrl(kind, env = process.env) {
  const id = sourceId(kind, env);
  return id ? `https://drive.google.com/file/d/${id}/view` : null;
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

export function parseSheet(kind, bytes, fetchedAt = new Date()) {
  const config = SHEETS[kind];
  // Só os valores interessam: pular texto formatado, HTML e fórmulas deixa a leitura bem mais rápida.
  const workbook = config.columns
    ? readColumns(bytes, config.columns, { cellDates: false })
    : XLSX.read(bytes, { type: "array", sheets: config.tabs, cellText: false, cellHTML: false, cellFormula: false, ...config.readOptions });
  const source = `${config.label} (Google Planilhas)`;
  const data = kind === "operations"
    ? parseOperationsWorkbook(workbook, source)
    : parseDischargeWorkbook(workbook, source, fetchedAt.getTime());
  if (kind === "discharge" && !data.dischargeDays.length) throw new Error("Nenhuma descarga concluída foi encontrada na planilha.");
  data.generatedAt = fetchedAt.toISOString();
  data.origin = "google-sheets";
  data.sheetUrl = sheetUrl(kind);
  return data;
}

const cache = new Map();

/** Lê e interpreta a planilha, com cache curto na memória da função. */
export async function loadSheet(kind, { fetcher = fetch, now = Date.now } = {}) {
  const id = sourceId(kind);
  if (!id) throw new Error(`Link da planilha não configurado (${SHEETS[kind].env}).`);
  const cached = cache.get(kind);
  if (cached && cached.id === id && now() - cached.at < CACHE_MS) return cached.data;
  const bytes = await downloadWorkbook(id, fetcher);
  const parseStarted = Date.now();
  const data = parseSheet(kind, bytes, new Date(now()));
  console.log(`Planilha ${kind} interpretada em ${Date.now() - parseStarted} ms.`);
  cache.set(kind, { id, at: now(), data });
  return data;
}

export function clearSheetCache() { cache.clear(); }
