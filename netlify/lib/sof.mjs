/* Base SOF do painel: histórico fixo (initial-sof.json, gerado por scripts/import-base-sof.mjs a partir da
   aba "Base SOF", 2025 e 2026) + SOFs enviados pela equipe (Firestore, coleção sofVessels).
   O dicionário de responsáveis começa com o histórico e aprende com cada SOF salvo (documento sofConfig/dictionary).
   A desatracação, o berço e o cliente vêm da planilha de navios sempre que o navio for encontrado nela. */
// O JSON entra no pacote da função: ler o arquivo pelo caminho falhava no Netlify, onde import.meta.url aponta para a função.
import initialSof from "./initial-sof.json" with { type: "json" };
import "../../public/sof-core.js";

export const Sof = globalThis.TpsSof;
export const VESSELS = "sofVessels";
export const CONFIG = "sofConfig";
const MAX_EVENTS = 4000;
const MAX_TEXT = 400;

let seedCache = null;
/** Histórico da Base SOF, com a chave de cada descrição já calculada. */
export function seed() {
  if (seedCache) return seedCache;
  const raw = initialSof;
  return seedCache = { ...raw, vessels: raw.vessels.map(vessel => ({ ...vessel, events: vessel.events.map(expandEvent) })) };
}
export function useSeed(value) { seedCache = value; }

/** Ocorrência guardada (data + minuto de início + duração) → com início, fim, período e chave da descrição. */
export function expandEvent(event) {
  const start = event.start || Sof.localIso(event.date, event.from || 0);
  const from = event.from ?? Math.round(((Date.parse(start) / 60000 - 180) % 1440 + 1440) % 1440);
  return {
    ...event, from, start, end: new Date(Date.parse(start) + (event.minutes || 0) * 60000).toISOString(),
    period: event.period || Sof.periodOf(from), key: Sof.normalizeDescription(event.description)
  };
}

/* ---------- Validação do que chega do navegador ---------- */

const str = (value, max = 120) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const iso = value => { const t = Date.parse(value || ""); return Number.isFinite(t) && t > Date.UTC(2020, 0) && t < Date.UTC(2040, 0) ? new Date(t).toISOString() : null; };
const num = value => typeof value === "number" && Number.isFinite(value) ? value : null;

/** Confere e limpa um SOF pronto para salvar. Devolve { vessel } ou { error }. */
export function validateVessel(input) {
  if (!input || typeof input !== "object") return { error: "Dados do SOF ausentes." };
  const vessel = str(input.vessel, 80).toUpperCase();
  if (!vessel) return { error: "Informe o nome do navio." };
  const operationStart = iso(input.operationStart), operationEnd = iso(input.operationEnd);
  if (!operationStart || !operationEnd || Date.parse(operationEnd) <= Date.parse(operationStart)) return { error: "Confira o início e o término da operação." };
  const operation = str(input.operation, 20).toUpperCase();
  if (!Sof.OPERATIONS.includes(operation)) return { error: "Escolha o tipo de operação." };
  const cargo = str(input.cargo, 60).toUpperCase();
  if (!cargo) return { error: "Informe a carga." };
  const tons = num(input.tons);
  if (tons === null || tons < 0 || tons > 300000) return { error: "Confira o volume (toneladas)." };
  if (!Array.isArray(input.events) || !input.events.length || input.events.length > MAX_EVENTS) return { error: "O SOF precisa ter ocorrências." };
  const events = [];
  for (const [index, e] of input.events.entries()) {
    const start = iso(e?.start);
    const minutes = num(e?.minutes);
    const description = str(e?.description, MAX_TEXT);
    const responsible = Sof.canonicalResponsible(e?.responsible);
    if (!start || minutes === null || minutes < 0 || minutes > 2880 || !description) return { error: `Ocorrência ${index + 1} inválida.` };
    if (!responsible) return { error: `Escolha o responsável da ocorrência ${index + 1} ("${description.slice(0, 50)}").` };
    events.push({ date: str(e.date, 10), start, minutes, gang: str(e.gang, 12), hold: str(e.hold, 12), description, volume: num(e.volume), weight: num(e.weight), responsible });
  }
  return {
    vessel: {
      vessel, cargo, operation, operationStart, operationEnd, tons,
      berthStart: iso(input.berthStart), berthEnd: iso(input.berthEnd), arrival: iso(input.arrival),
      berth: str(input.berth, 60), client: str(input.client, 80), invoiceTons: num(input.invoiceTons),
      cargoDescription: str(input.cargoDescription, 200), fileName: str(input.fileName, 160), model: str(input.model, 20), events
    }
  };
}

/** Id estável: data de início + nome. Reenviar o SOF do mesmo navio substitui o anterior. */
export function vesselId(vessel) {
  return `${vessel.operationStart.slice(0, 10)}_${Sof.vesselKey(vessel.vessel).slice(0, 40)}`;
}

/* ---------- Leitura ---------- */

/** Histórico + enviados. Um enviado com o mesmo navio e início (±2 dias) de um do histórico o substitui. */
export async function allVessels(store) {
  const sent = store ? await store.list(VESSELS) : [];
  const removed = new Set(sent.filter(v => v.deleted && v.replaces).map(v => v.replaces));
  const uploaded = sent.filter(v => !v.deleted).map(v => ({ ...v, source: "sof", events: (v.events || []).map(expandEvent) }));
  const replaced = vessel => uploaded.some(u => Sof.vesselKey(u.vessel) === Sof.vesselKey(vessel.vessel) && Math.abs(Date.parse(u.operationStart) - Date.parse(vessel.operationStart)) < 2 * 86400000);
  const history = seed().vessels.filter(v => !removed.has(v.id) && !replaced(v));
  return [...history, ...uploaded].sort((a, b) => a.operationStart.localeCompare(b.operationStart));
}

/** Navio da planilha de navios com o mesmo nome e atracação/início mais próximos (até 5 dias). */
export function matchOperation(vessel, records) {
  const key = Sof.vesselKey(vessel.vessel);
  if (!key) return null;
  const when = Date.parse(vessel.berthStart || vessel.operationStart);
  const near = records.filter(r => {
    const k = Sof.vesselKey(r.vessel);
    return k && (k === key || (Math.min(k.length, key.length) >= 5 && (k.startsWith(key) || key.startsWith(k))));
  }).map(r => ({ r, gap: Math.abs(Date.parse(r.berthStart || r.operationStart || "") - when) }))
    .filter(x => Number.isFinite(x.gap) && x.gap < 5 * 86400000).sort((a, b) => a.gap - b.gap);
  return near[0]?.r || null;
}

/** Completa com a planilha de navios: desatracação (sempre preferida), berço, cliente e atracação. */
export function enrich(vessel, records) {
  const match = matchOperation(vessel, records);
  if (!match) return { ...vessel, matched: false };
  return {
    ...vessel, matched: true,
    berthEnd: match.berthEnd || vessel.berthEnd || null,
    berthStart: vessel.berthStart || match.berthStart || null,
    berth: match.berth && match.berth !== "Não informado" ? match.berth : vessel.berth || "",
    client: match.client && match.client !== "Não informado" ? match.client : vessel.client || ""
  };
}

/** Resumo para os indicadores (sem a lista de ocorrências, que vem só no detalhe). */
export function summaryOf(vessel) {
  const { events, ...rest } = vessel;
  const summary = Sof.vesselSummary(vessel);
  return { ...rest, events: events.length, summary: { ...summary, stoppages: summary.stoppages.slice(0, 25) } };
}

/** Navio completo para a exportação: resumo calculado + ocorrências sem os campos internos. */
export function exportOf(vessel) {
  const { operationDays, berthDays, waitDays, byResponsible, grossRate, netRate, triunfoRate } = Sof.vesselSummary(vessel);
  const events = vessel.events.map(({ date, start, end, minutes, period, gang, hold, description, volume, weight, responsible }) =>
    ({ date, start, end, minutes, period, gang, hold, description, volume, weight, responsible }));
  return { ...vessel, savedBy: vessel.savedBy?.name || "", events, summary: { operationDays, berthDays, waitDays, byResponsible, grossRate, netRate, triunfoRate } };
}

/* ---------- Dicionário ---------- */

/** Histórico + o que foi aprendido/fixado no painel. */
export async function dictionary(store) {
  const saved = store ? await store.get(CONFIG, "dictionary") : null;
  const merged = JSON.parse(JSON.stringify(seed().dictionary));
  for (const [key, entry] of Object.entries(saved?.entries || {})) {
    const target = merged[key] ||= { counts: {}, text: entry.text || key };
    for (const [name, count] of Object.entries(entry.counts || {})) target.counts[name] = (target.counts[name] || 0) + count;
    if (entry.fixed) { target.fixed = entry.fixed; target.fixedBy = entry.fixedBy; target.fixedAt = entry.fixedAt; }
  }
  return merged;
}

/** Soma as escolhas de um SOF salvo ao dicionário (só o que foi aprendido no painel fica no Firestore). */
export async function learnFrom(store, events) {
  const saved = (await store.get(CONFIG, "dictionary")) || { entries: {} };
  const entries = saved.entries || {};
  for (const event of events) {
    const key = Sof.normalizeDescription(event.description);
    if (!key) continue;
    const entry = entries[key] ||= { counts: {}, text: event.description };
    entry.counts[event.responsible] = (entry.counts[event.responsible] || 0) + 1;
  }
  await store.set(CONFIG, "dictionary", { entries, updatedAt: new Date().toISOString() });
}

/** Fixa (ou solta, com responsible vazio) o responsável de uma descrição. */
export async function fixResponsible(store, key, responsible, actor) {
  const name = responsible ? Sof.canonicalResponsible(responsible) : "";
  if (responsible && !name) return { error: "Responsável inválido." };
  const clean = Sof.normalizeDescription(key) === key ? key : null;
  if (!clean) return { error: "Descrição inválida." };
  const saved = (await store.get(CONFIG, "dictionary")) || { entries: {} };
  const entries = saved.entries || {};
  const entry = entries[clean] ||= { counts: {}, text: seed().dictionary[clean]?.text || clean };
  if (name) Object.assign(entry, { fixed: name, fixedBy: actor?.name || "", fixedAt: new Date().toISOString() });
  else { delete entry.fixed; delete entry.fixedBy; delete entry.fixedAt; }
  await store.set(CONFIG, "dictionary", { entries, updatedAt: new Date().toISOString() });
  return { ok: true };
}
