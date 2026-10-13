import { randomUUID } from "node:crypto";

const CHUNK_BYTES = 450_000;
const KINDS = new Set(["operations", "discharge"]);

export function splitText(text, maxBytes = CHUNK_BYTES) {
  if (typeof text !== "string" || maxBytes < 4) throw new Error("Dados inválidos para divisão.");
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + Math.floor(maxBytes / 4), text.length);
    while (end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end--;
    const chunk = text.slice(start, end);
    if (!chunk || Buffer.byteLength(chunk, "utf8") > maxBytes) throw new Error("Falha ao dividir os dados.");
    chunks.push(chunk);
    start = end;
  }
  return chunks;
}

export async function saveDataset(db, kind, data) {
  if (!KINDS.has(kind)) throw new Error("Base desconhecida.");
  const serialized = JSON.stringify(data);
  const chunks = splitText(serialized);
  if (!chunks.length || chunks.length > 100) throw new Error("Base fora do tamanho permitido.");
  const version = randomUUID();
  const collection = db.collection("dashboardVersions").doc(version).collection("chunks");
  await Promise.all(chunks.map((value, index) => collection.doc(String(index).padStart(4, "0")).set({ value })));
  await db.collection("dashboardDatasets").doc(kind).set({ version, chunkCount: chunks.length, updatedAt: new Date().toISOString(), source: data.source || "" });
  return { version, chunkCount: chunks.length };
}

export async function loadDataset(db, kind) {
  if (!KINDS.has(kind)) throw new Error("Base desconhecida.");
  const pointer = await db.collection("dashboardDatasets").doc(kind).get();
  if (!pointer.exists) return null;
  const { version, chunkCount } = pointer.data();
  if (typeof version !== "string" || !Number.isInteger(chunkCount) || chunkCount < 1 || chunkCount > 100) throw new Error("Referência da base inválida.");
  const collection = db.collection("dashboardVersions").doc(version).collection("chunks");
  const docs = await Promise.all(Array.from({ length: chunkCount }, (_, index) => collection.doc(String(index).padStart(4, "0")).get()));
  if (docs.some(doc => !doc.exists || typeof doc.data()?.value !== "string")) throw new Error("Base incompleta no Firestore.");
  return JSON.parse(docs.map(doc => doc.data().value).join(""));
}

export function validateOperations(data) {
  return data && typeof data.source === "string" && /\.(xlsm|xlsx)$/i.test(data.source) &&
    Array.isArray(data.records) && data.records.length > 0 && data.records.length <= 10000 &&
    Array.isArray(data.activeRecords) && data.activeRecords.length <= 1000 &&
    Array.isArray(data.gusaRecords) && data.gusaRecords.length <= 10000 &&
    Array.isArray(data.gusaActiveRecords) && data.gusaActiveRecords.length <= 1000 &&
    Array.isArray(data.lineupRecords) && data.lineupRecords.length <= 10000 &&
    data.gusaSource === "BASE_GUSA_2026" &&
    data.records.every(row => typeof row.vessel === "string" && Number.isInteger(row.year) && Number.isFinite(row.tons));
}

export function validateDischarge(data) {
  const validDate = value => typeof value === "string" && /^20\d\d-\d\d-\d\d$/.test(value);
  const validRows = (rows, max, check) => Array.isArray(rows) && rows.length <= max && rows.every(check);
  return data && typeof data.source === "string" && /\.xlsx$/i.test(data.source) &&
    validRows(data.dischargeDays, 2000, row => validDate(row.date) && Number.isFinite(row.tons) && row.tons >= 0 && Number.isFinite(row.wagons)) &&
    validRows(data.dischargeVessels, 6000, row => validDate(row.date) && typeof row.vessel === "string" && Number.isFinite(row.tons)) &&
    validRows(data.occurrences, 30000, row => validDate(row.date) && typeof row.reason === "string" && Number.isFinite(row.minutes) && row.minutes >= 0) &&
    validRows(data.plans, 120, row => Number.isInteger(row.year) && Number.isInteger(row.month) && row.month >= 1 && row.month <= 12) &&
    validRows(data.weighings, 1000, row => typeof row.vessel === "string" && Number.isInteger(row.year) && Number.isInteger(row.month)) &&
    data.dischargeDays.length > 0;
}
