// As planilhas registram horários de Brasília sem fuso; a leitura precisa usar o mesmo fuso do navegador.
process.env.TZ = "America/Sao_Paulo";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { firestore } from "../lib/firebase.mjs";
import { loadDataset } from "../lib/dataset.mjs";
import { downloadWorkbook } from "../lib/sheets.mjs";
import { loadForServing, requestRefresh } from "../lib/snapshots.mjs";

const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const json = (value, status = 200, extra = {}) => new Response(JSON.stringify(value), { status, headers: { ...headers, ...extra, "Content-Type": "application/json; charset=utf-8" } });
// As bases vêm da cópia guardada no Netlify Blobs (leitura rápida); sem cache no CDN,
// para o botão "Atualizar dados" aparecer para todos logo em seguida.
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

export function normalizeOperations(data) {
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

/* Data do último registro de cada base: mostra se a planilha está sendo alimentada.
   Navios: atracação ou início de operação mais recente (datas futuras, provável digitação, são ignoradas).
   Descarga: último dia com descarga FINALIZADO. */
export function operationsLastRecord(data, now = Date.now()) {
  let latest = null;
  for (const row of [...(data.records || []), ...(data.activeRecords || [])]) {
    for (const value of [row.berthStart, row.operationStart]) {
      const time = Date.parse(value || "");
      if (Number.isFinite(time) && time <= now + 86400000 && (latest === null || time > latest)) latest = time;
    }
  }
  return latest === null ? null : new Date(latest).toISOString();
}

export function dischargeLastRecord(data) {
  return (data.dischargeDays || []).reduce((max, row) => typeof row.date === "string" && row.date > (max || "") ? row.date : max, null);
}

const withLastRecord = (kind, data) => ({ ...data, lastRecordAt: kind === "operations" ? operationsLastRecord(data) : dischargeLastRecord(data) });

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
    const finish = data => withLastRecord(kind, kind === "operations" ? normalizeOperations(data) : data);
    try {
      return json(finish(await loadForServing(kind)));
    } catch (error) {
      console.error(`Falha ao ler a planilha (${kind}) no Google:`, error);
      return json(finish(await fallbackDataset(kind, error)));
    }
  }
  if (request.method === "POST" && path === "/api/refresh") {
    // O site é público: aceita só pedidos vindos da própria página.
    const origin = request.headers.get("origin");
    const allowedHosts = [url.host, request.headers.get("host"), request.headers.get("x-forwarded-host")].filter(Boolean);
    if (origin && !allowedHosts.includes(new URL(origin).host)) return json({ error: "Origem não permitida." }, 403);
    try {
      const result = await requestRefresh();
      const status = result.status === "refreshed" || result.status === "recent" ? 200 : result.status === "running" ? 409 : 502;
      return json(result, status);
    } catch (error) {
      console.error("Falha ao atualizar as bases:", error);
      return json({ status: "error", error: "Não foi possível atualizar as bases agora." }, 502);
    }
  }
  return json({ error: "Rota não encontrada." }, 404);
}

export const config = { path: ["/api/data", "/api/discharge", "/api/production-workbook", "/api/refresh"] };
