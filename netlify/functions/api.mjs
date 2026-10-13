// As planilhas registram horários de Brasília sem fuso; a leitura precisa usar o mesmo fuso do navegador.
process.env.TZ = "America/Sao_Paulo";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { firestore } from "../lib/firebase.mjs";
import { loadDataset } from "../lib/dataset.mjs";
import { downloadWorkbook, loadSheet } from "../lib/sheets.mjs";

const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const json = (value, status = 200, extra = {}) => new Response(JSON.stringify(value), { status, headers: { ...headers, ...extra, "Content-Type": "application/json; charset=utf-8" } });
// O CDN do Netlify guarda a resposta por 2 min e entrega a anterior enquanto busca a nova no Google.
const sheetCache = { "Netlify-CDN-Cache-Control": "public, durable, s-maxage=120, stale-while-revalidate=600" };
const fallbackCache = { "Netlify-CDN-Cache-Control": "public, s-maxage=30" };
const productionWorkbooks = {
  outras: "1KDStqZVY5vBG4LwByytYa2QSyNcjg9KQJXlV1rN43PU",
  potassio: "12itSxDBxOiB9c-IsgN9lA0Xcyls0DgsLQ6cFeGugJ30"
};
const seed = kind => JSON.parse(readFileSync(fileURLToPath(new URL(`../lib/initial-${kind}.json`, import.meta.url)), "utf8"));

function operationMonth(value) {
  if (typeof value !== "string") return null;
  const match = /^(20\d\d)-(0[1-9]|1[0-2])/.exec(value);
  if (!match) return null;
  if (!/[zZ]$/.test(value)) return { year: Number(match[1]), month: Number(match[2]) };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit" }).formatToParts(date);
  return { year: Number(parts.find(part => part.type === "year")?.value), month: Number(parts.find(part => part.type === "month")?.value) };
}

function normalizeOperations(data) {
  const activeIds = new Set((data.activeRecords || []).map(row => row.id));
  const stillBerthed = (data.records || []).filter(row => !row.berthEnd && row.berthStart);
  data.activeRecords ||= [];
  data.activeRecords.push(...stillBerthed.filter(row => !activeIds.has(row.id)).map(row => ({
    id: row.id, vessel: row.vessel, year: new Date(row.berthStart).getFullYear(), month: new Date(row.berthStart).getMonth() + 1,
    berthStart: row.berthStart, operationStart: row.operationStart, berth: row.berth, operation: row.operation,
    cargo: row.cargo, partialTons: row.tons
  })));
  data.records = (data.records || []).filter(row => row.berthEnd || !row.berthStart);
  for (const row of [...data.records, ...data.activeRecords]) {
    const period = operationMonth(row.operationStart || row.berthStart);
    if (period) Object.assign(row, period);
  }
  const byVessel = new Map();
  for (const row of data.records) {
    const key = String(row.vessel || "").trim().toUpperCase();
    if (!byVessel.has(key)) byVessel.set(key, []);
    byVessel.get(key).push(row);
  }
  for (const row of [...(data.gusaRecords || []), ...(data.gusaActiveRecords || [])]) {
    if (!row.operationStart) {
      const candidates = byVessel.get(String(row.vessel || "").trim().toUpperCase()) || [];
      const departure = Date.parse(row.departure || "");
      const matched = candidates.filter(item => item.operationStart).sort((a, b) =>
        Math.abs(Date.parse(a.berthEnd || a.operationEnd) - departure) - Math.abs(Date.parse(b.berthEnd || b.operationEnd) - departure))[0];
      if (matched) row.operationStart = matched.operationStart;
    }
    const period = operationMonth(row.operationStart || row.berthStart);
    if (period) Object.assign(row, period);
  }
  return data;
}

async function productionWorkbook(url) {
  const id = productionWorkbooks[url.searchParams.get("source")];
  if (!id) return json({ error: "Fonte de produção inválida." }, 400);
  try {
    const bytes = await downloadWorkbook(id, fetch, ["sheets", "drive"]);
    return new Response(bytes, { headers: { ...headers, "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } });
  } catch {
    return json({ error: "Não foi possível consultar esta planilha agora." }, 502);
  }
}

/* Se o Google estiver fora do ar ou o link mudar de permissão, o painel continua
   abrindo com a última base salva (Firestore ou cópia inicial) e mostra um aviso. */
async function fallbackDataset(kind, error) {
  let data = null;
  try { data = await loadDataset(firestore(), kind); } catch { /* Firestore opcional */ }
  data ||= seed(kind);
  return { ...data, origin: "fallback", fallbackReason: error.message };
}

export default async function handler(request) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === "GET" && path === "/api/production-workbook") return productionWorkbook(url);
  if (request.method === "GET" && (path === "/api/data" || path === "/api/discharge")) {
    const kind = path === "/api/data" ? "operations" : "discharge";
    const finish = data => kind === "operations" ? normalizeOperations(data) : data;
    try {
      return json(finish(structuredClone(await loadSheet(kind))), 200, sheetCache);
    } catch (error) {
      console.error(`Falha ao ler a planilha (${kind}) no Google:`, error);
      return json(finish(await fallbackDataset(kind, error)), 200, fallbackCache);
    }
  }
  return json({ error: "Rota não encontrada." }, 404);
}

export const config = { path: ["/api/data", "/api/discharge", "/api/production-workbook"] };
