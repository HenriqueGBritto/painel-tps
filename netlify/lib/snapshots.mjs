/* Última leitura das planilhas, guardada no Netlify Blobs.
   - Quem abre o painel recebe essa cópia na hora, sem esperar o download do Drive.
   - A função agendada (refresh-scheduled.mjs) relê as duas planilhas a cada 6 horas.
   - O botão "Atualizar dados" relê na hora, com intervalo mínimo entre leituras.
   Fora do Netlify (testes e servidor local) usa um armazenamento em memória. */
import { getStore } from "@netlify/blobs";
import { loadSheet } from "./sheets.mjs";
import { withChangeLog } from "./changes.mjs";

/* Sempre uma leitura nova do Drive (sem o cache curto em memória de sheets.mjs). */
const freshSheet = kind => loadSheet(kind, { force: true });

export const KINDS = ["operations", "discharge"];
/** Cliques no botão dentro deste intervalo devolvem a cópia existente. */
export const MIN_REFRESH_MS = 5 * 60 * 1000;
/** Se a rotina agendada falhar por muito tempo, o próprio acesso relê a planilha. */
export const MAX_AGE_MS = 12 * 60 * 60 * 1000;
/** Uma leitura em andamento bloqueia outra por até este tempo. */
const LOCK_MS = 60 * 1000;

const memory = new Map();
const memoryStore = {
  async get(key) { return memory.has(key) ? structuredClone(memory.get(key)) : null; },
  async setJSON(key, value) { memory.set(key, structuredClone(value)); }
};

let override = null;
/** Só para testes: troca o armazenamento. */
export function useStore(store) { override = store; }
export function clearMemoryStore() { memory.clear(); }

function store() {
  if (override) return override;
  try {
    const blobs = getStore({ name: "painel-tps", consistency: "strong" });
    return { get: key => blobs.get(key, { type: "json" }), setJSON: (key, value) => blobs.setJSON(key, value) };
  } catch {
    return memoryStore; // sem ambiente do Netlify Blobs (local/testes)
  }
}

const ageOf = (snapshot, now) => now - Date.parse(snapshot?.generatedAt || 0);

export async function readSnapshot(kind) {
  return store().get(`snapshot-${kind}`);
}

/** Guarda a leitura nova com o histórico do que mudou desde a cópia anterior (changes.mjs). */
async function saveSnapshot(kind, data, previous) {
  const snapshot = withChangeLog(kind, previous, data);
  await store().setJSON(`snapshot-${kind}`, snapshot);
  return snapshot;
}

/** Lê as planilhas pedidas no Google e guarda o resultado. Uma falha não apaga a cópia anterior. */
export async function refreshKinds(kinds = KINDS, { loader = freshSheet, now = Date.now } = {}) {
  const results = await Promise.allSettled(kinds.map(async kind => {
    const [data, previous] = await Promise.all([loader(kind), readSnapshot(kind)]);
    return saveSnapshot(kind, data, previous);
  }));
  return Object.fromEntries(kinds.map((kind, index) => [kind, results[index].status === "fulfilled"
    ? { ok: true, generatedAt: results[index].value.generatedAt }
    : { ok: false, error: results[index].reason?.message || "Falha na leitura." }]));
}

/**
 * Pedido do botão "Atualizar dados". Respeita o intervalo mínimo e uma trava contra
 * leituras simultâneas; devolve o que aconteceu para a página informar a pessoa.
 */
export async function requestRefresh({ loader = freshSheet, now = Date.now } = {}) {
  const current = now();
  const snapshots = await Promise.all(KINDS.map(readSnapshot));
  // Vale a cópia mais antiga: se uma base não tem cópia (ou a leitura dela falhou), o botão pode tentar de novo.
  const oldest = Math.max(...snapshots.map(snapshot => snapshot ? ageOf(snapshot, current) : Infinity));
  if (oldest < MIN_REFRESH_MS) {
    return { status: "recent", retryInMs: MIN_REFRESH_MS - oldest, generatedAt: snapshots.map(s => s?.generatedAt).filter(Boolean).sort().at(-1) };
  }
  const lock = await store().get("refresh-lock");
  if (lock && current - Date.parse(lock.at) < LOCK_MS) return { status: "running" };
  await store().setJSON("refresh-lock", { at: new Date(current).toISOString() });
  try {
    const results = await refreshKinds(KINDS, { loader });
    const failed = Object.values(results).some(result => !result.ok);
    return { status: failed ? "partial" : "refreshed", results };
  } finally {
    await store().setJSON("refresh-lock", { at: new Date(0).toISOString() });
  }
}

/**
 * Dados para servir ao painel: a cópia guardada; sem cópia (primeiro uso) ou com cópia
 * muito antiga, lê a planilha na hora e guarda. Se a leitura falhar, a cópia antiga vale.
 */
export async function loadForServing(kind, { loader = freshSheet, now = Date.now } = {}) {
  const snapshot = await readSnapshot(kind);
  if (snapshot && ageOf(snapshot, now()) < MAX_AGE_MS) return snapshot;
  try {
    return await saveSnapshot(kind, await loader(kind), snapshot);
  } catch (error) {
    if (snapshot) return snapshot;
    throw error;
  }
}
