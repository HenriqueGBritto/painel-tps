/* Verificação automática no OGMO. O robô (robot/ogmo.mjs, no GitHub Actions) entra no sistema do OGMO,
   lê a lista de requisições de ontem, hoje e amanhã, baixa o "Visualiza" (PDF) das ativas e manda tudo para cá:
   - POST /api/requisicoes/ogmo/pdf    cada PDF → mesma conferência da aba (requisitions.mjs)
   - POST /api/requisicoes/ogmo/lista  a lista completa → canceladas, o que falta antes do limite e o resumo da rodada
   - POST /api/requisicoes/ogmo/erro   a rodada falhou (aparece na aba e no sino)
   - POST /api/requisicoes/ogmo/da9    DA9 (trabalhadores escalados) das requisições já escaladas
   A aba também pede buscas de um dia ou período (requestSearch): o robô roda só aqueles dias e manda a lista dia a dia.
   O robô se identifica com OGMO_SYNC_TOKEN (o mesmo valor no GitHub e no Netlify). Ele só consulta o OGMO.
   Testado em tests/ogmo-sync.test.mjs. */
import { createHash, timingSafeEqual } from "node:crypto";
import * as R from "./requisitions.mjs";
import { parseVesselName } from "./requisition-pdf.mjs";
import "../../public/shifts.js";

const S = globalThis.TpsShifts;
export const SYNC = "requisitionSync";
export const ROBOT = { id: "ogmo", name: "OGMO (verificação automática)" };
/** Horário-limite do OGMO para cada período (no dia da operação): usado só para avisar o que falta pedir. */
export const DEADLINES = { "07-13": "03:45", "13-19": "09:45", "19-01": "15:45", "01-07": "18:45" };
const ORDER = ["07-13", "13-19", "19-01", "01-07"];
/** Antecedência do aviso: o robô roda 1 hora antes de cada limite (o GitHub pode atrasar alguns minutos). */
export const WARN_MINUTES = 80;
const CCT = "CCT CAPATAZIA";

export class SyncError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new SyncError(status, message); };
const normalize = text => String(text || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
const isDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
const brDay = iso => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
/** "AAAA-MM-DDTHH:MM:SS" no horário de Brasília. */
export const localNow = (now = new Date()) => new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(now).replace(" ", "T");
const addMinutes = (local, minutes) => localNow(new Date(Date.parse(`${local}-03:00`) + minutes * 60000));

/** Confere o token do robô (comparação em tempo constante). */
export function tokenOk(request, env = process.env) {
  const expected = env.OGMO_SYNC_TOKEN || "";
  if (expected.length < 24) return false;
  const given = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const digest = value => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

export function previousPeriod(date, period) {
  const index = ORDER.indexOf(period);
  return index > 0 ? { date, period: ORDER[index - 1] } : { date: S.addDays(date, -1), period: "01-07" };
}
export const deadlineOf = (date, period) => `${date}T${DEADLINES[period]}:00`;
const shipOf = name => { const vessel = parseVesselName(name); return normalize(vessel.attachedTo || vessel.name); };

/**
 * O que falta pedir nos períodos cujo limite chega nos próximos WARN_MINUTES:
 * - navio (ou balsa) que teve requisição ativa no período anterior e ainda não tem a deste;
 * - navio em operação no Lineup sem nenhuma requisição no dia.
 */
export function missingRequisitions(rows, { now = new Date(), operating = [] } = {}) {
  // Vigia não é requisitada pela Triunfo: não entra no que falta.
  const active = rows.filter(row => !row.cancelled && !row.vigia && normalize(row.vessel) !== CCT);
  const current = localNow(now), limit = addMinutes(current, WARN_MINUTES);
  const today = current.slice(0, 10);
  const missing = [];
  // Compara sem acento e sem diferença de caixa, mas mostra o nome como está no OGMO.
  const original = new Map(active.map(row => [normalize(row.vessel), row.vessel]));
  for (const date of [S.addDays(today, -1), today, S.addDays(today, 1)]) {
    for (const period of ORDER) {
      const deadline = deadlineOf(date, period);
      if (!(deadline > current && deadline <= limit)) continue;
      const prev = previousPeriod(date, period);
      const here = new Set(active.filter(row => row.date === date && row.period === period).map(row => normalize(row.vessel)));
      const before = [...new Set(active.filter(row => row.date === prev.date && row.period === prev.period).map(row => normalize(row.vessel)))];
      for (const vessel of before.filter(name => !here.has(name))) {
        missing.push({ date, period, vessel: original.get(vessel) || vessel, deadline, reason: `teve requisição no ${prev.period.replace("-", "x")} e ainda não tem a do ${period.replace("-", "x")}` });
      }
      const shipsToday = new Set(active.filter(row => row.date === date).map(row => shipOf(row.vessel)));
      for (const ship of [...new Set(operating.map(normalize))].filter(name => name && !shipsToday.has(name))) {
        missing.push({ date, period, vessel: ship, deadline, reason: "navio em operação no Lineup sem nenhuma requisição no dia" });
      }
    }
  }
  return missing;
}

/** Cada PDF baixado do OGMO passa pela mesma conferência dos PDFs enviados pela equipe. */
export async function receivePdf(store, input, context) {
  return R.submit(store, { bytes: input.bytes, name: input.name }, ROBOT, { ...context, source: "ogmo", ogmo: { scaled: Boolean(input.scaled), seenAt: (context.now || new Date()).toISOString() } });
}

/** Requisições já guardadas dos dias pedidos: o robô pula o PDF das que já foram escaladas e não mudam mais. */
export async function known(store, dates) {
  const result = {};
  for (const date of dates.filter(isDate).slice(0, MAX_SEARCH_DAYS)) {
    for (const row of await store.list(R.COLLECTION, { from: `${date}_`, to: `${date}_~` })) result[row.number] = { date, scaled: Boolean(row.ogmo?.scaled), cancelled: Boolean(row.cancelled), da9: Boolean(row.da9) };
  }
  return result;
}

/** Lista completa da rodada: marca canceladas, reconfere os períodos afetados e calcula o que falta. */
export async function receiveList(store, input, context) {
  const now = context.now || new Date();
  const dates = (Array.isArray(input?.dates) ? input.dates : []).filter(isDate).slice(0, MAX_SEARCH_DAYS);
  const rows = (Array.isArray(input?.rows) ? input.rows : []).slice(0, 400).map(row => ({
    date: String(row.date || ""), number: String(row.number || "").trim(), vessel: String(row.vessel || "").trim().slice(0, 120),
    period: String(row.period || "").replace(/\s+/g, ""), local: String(row.local || "").trim().slice(0, 80), cancelled: Boolean(row.cancelled), scaled: Boolean(row.scaled)
  })).filter(row => isDate(row.date) && /^[\d-]+$/.test(row.number) && ORDER.includes(row.period));
  if (!dates.length) fail(400, "Rodada sem datas.");
  const affected = new Map();
  let notDownloaded = 0;
  for (const row of rows) {
    const id = `${row.date}_${row.number}`;
    const stored = await store.get(R.COLLECTION, id);
    if (!stored) { if (!row.cancelled) notDownloaded++; continue; }
    if (stored.check?.operation?.key === "vigia") row.vigia = true;
    const change = { ogmo: { ...(stored.ogmo || {}), scaled: row.scaled, seenAt: now.toISOString() } };
    if (row.cancelled !== Boolean(stored.cancelled)) {
      Object.assign(change, { cancelled: row.cancelled, cancelledAt: row.cancelled ? now.toISOString() : null });
      affected.set(`${row.date}|${row.period}`, { date: row.date, period: row.period });
    }
    await store.set(R.COLLECTION, id, change, { merge: true });
  }
  // Reconfere com as regras atuais todos os períodos da rodada (as já escaladas não têm o PDF baixado de novo).
  for (const row of rows) affected.set(`${row.date}|${row.period}`, { date: row.date, period: row.period });
  for (const { date, period } of affected.values()) await R.recheckShift(store, date, period, context);
  // Busca sob demanda: o robô manda dia a dia; soma o andamento sem mexer na rodada automática (que cuida do que falta).
  if (input.pedido) {
    const previous = (await store.get(SYNC, requestId(input.pedido))) || {};
    const restart = Number(input.dia) === 1 || previous.status !== "lendo"; // 1º dia (ou nova tentativa do robô): começa do zero
    const add = (key, value) => (restart ? 0 : previous[key] || 0) + value;
    const days = add("days", dates.length), total = Number(input.dias) || days;
    const summary = {
      status: days >= total ? "concluida" : "lendo", days, totalDays: total, updatedAt: now.toISOString(), ...(days >= total ? { finishedAt: now.toISOString() } : {}),
      total: add("total", rows.length), active: add("active", rows.filter(row => !row.cancelled).length), cancelled: add("cancelled", rows.filter(row => row.cancelled).length), notDownloaded: add("notDownloaded", notDownloaded)
    };
    await store.set(SYNC, requestId(input.pedido), summary, { merge: true });
    return summary;
  }
  const status = {
    ok: true, lastRunAt: now.toISOString(), runStartedAt: input.startedAt || null, dates,
    total: rows.length, active: rows.filter(row => !row.cancelled).length, cancelled: rows.filter(row => row.cancelled).length, notDownloaded,
    missing: missingRequisitions(rows, { now, operating: context.operating || [] }), error: null, errorAt: null
  };
  await store.set(SYNC, "status", status);
  return status;
}

export async function receiveError(store, input, { now = new Date() } = {}) {
  const message = String(input?.message || "Falha sem mensagem.").slice(0, 500);
  if (input?.pedido) {
    await store.set(SYNC, requestId(input.pedido), { status: "falhou", error: message, finishedAt: now.toISOString() }, { merge: true });
    return { ok: true };
  }
  await store.set(SYNC, "status", { ok: false, error: message, errorAt: now.toISOString() }, { merge: true });
  return { ok: true };
}

/* ---------- Busca sob demanda (aba Requisições: "Buscar no OGMO") ---------- */

/** Dias por busca: os mesmos 8 que a aba mostra ao abrir (6 dias atrás até amanhã). */
export const MAX_SEARCH_DAYS = 8;
const requestId = id => `busca-${String(id).replace(/[^a-z0-9]/gi, "").slice(0, 16)}`;

/** Pede ao robô a leitura de um dia ou período no OGMO (até 8 dias, no máximo até amanhã). */
export async function requestSearch(store, input, actor, { now = new Date(), dispatcher }) {
  const from = String(input?.de || ""), to = String(input?.ate || input?.de || "");
  if (!isDate(from) || !isDate(to) || from > to) fail(400, "Escolha um dia ou um período válido.");
  if (S.daysBetween(from, to) >= MAX_SEARCH_DAYS) fail(400, `Busque até ${MAX_SEARCH_DAYS} dias por vez no OGMO.`);
  const tomorrow = S.addDays(localNow(now).slice(0, 10), 1);
  if (to > tomorrow) fail(400, "O OGMO só tem requisições até amanhã.");
  // Uma busca por vez: na fila do GitHub, uma nova espera pela anterior e pode tomar o lugar de outra que esperava.
  const running = await currentSearch(store, { now });
  if (running && ["enviada", "lendo"].includes(running.status)) fail(409, `Já há uma busca no OGMO em andamento (pedida por ${running.by?.name || "alguém"}). Aguarde terminar.`);
  const id = createHash("sha256").update(`${now.toISOString()}${Math.random()}`).digest("hex").slice(0, 12);
  const record = { id, de: from, ate: to, status: "enviada", by: actor, at: now.toISOString() };
  await store.set(SYNC, requestId(id), record);
  await store.set(SYNC, "busca-atual", { id, at: record.at });
  try {
    await dispatcher({ modo: "normal", datas: `${from}:${to}`, pedido: id });
  } catch (error) {
    await store.set(SYNC, requestId(id), { status: "falhou", error: error.message, finishedAt: now.toISOString() }, { merge: true });
    fail(502, error.message);
  }
  return record;
}

/** Tempo máximo de uma busca: depois disso (robô parado, cancelado na fila do GitHub) ela conta como não concluída. */
export const SEARCH_TIMEOUT_MINUTES = 45;
const expired = (record, now) => ["enviada", "lendo"].includes(record.status) && now - Date.parse(record.at) > SEARCH_TIMEOUT_MINUTES * 60000;
const withTimeout = (record, now) => expired(record, now) ? { ...record, status: "falhou", error: "O robô não terminou a busca a tempo. Tente de novo." } : record;

export async function searchStatus(store, id, { now = new Date() } = {}) {
  const record = await store.get(SYNC, requestId(id));
  if (!record) fail(404, "Busca não encontrada.");
  return withTimeout(record, now);
}

/** Última busca pedida (a aba retoma o acompanhamento ao abrir); a que terminou some da tela depois de 30 minutos. */
export async function currentSearch(store, { now = new Date() } = {}) {
  const pointer = await store.get(SYNC, "busca-atual");
  if (!pointer?.id || now - Date.parse(pointer.at) > 2 * 3600000) return null;
  const record = await store.get(SYNC, requestId(pointer.id));
  if (!record || (record.finishedAt && now - Date.parse(record.finishedAt) > 30 * 60000)) return null;
  return withTimeout(record, now);
}

/* ---------- DA9 (relatório de trabalhadores escalados) ---------- */

/** Guarda o DA9 de uma requisição escalada, baixado pelo robô. */
export async function receiveDa9(store, files, input, { now = new Date() } = {}) {
  const number = String(input?.number || ""), date = String(input?.date || "");
  if (!/^[\d-]+$/.test(number) || !isDate(date)) fail(400, "Requisição do DA9 inválida.");
  const bytes = input.bytes;
  if (!bytes?.byteLength || String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") fail(415, "O DA9 precisa ser PDF.");
  const id = `${date}_${number}`;
  const record = await store.get(R.COLLECTION, id);
  if (!record) fail(404, "Requisição do DA9 ainda não foi recebida.");
  const fileKey = `requisicoes/${number}/da9-${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.pdf`;
  if (record.da9?.fileKey !== fileKey) {
    await files.put(fileKey, bytes, { name: `DA9 ${number}.pdf`, type: "application/pdf", size: bytes.byteLength, at: now.toISOString() });
    await store.set(R.COLLECTION, id, { da9: { fileKey, name: `DA9 ${number}.pdf`, size: bytes.byteLength, at: now.toISOString() } }, { merge: true });
  }
  return { ok: true };
}

export async function readDa9(store, files, id) {
  const record = await store.get(R.COLLECTION, String(id || ""));
  if (!record?.da9?.fileKey) fail(404, "DA9 ainda não baixado: ele só existe depois que o OGMO escala a requisição.");
  const file = await files.get(record.da9.fileKey);
  if (!file) fail(404, "Arquivo do DA9 não encontrado.");
  return { data: file.data, name: record.da9.name };
}

export async function syncStatus(store) {
  return (await store.get(SYNC, "status")) || null;
}

/** Texto curto para alertas e para a aba. */
export const missingText = item => `${item.vessel}: falta a requisição do ${item.period.replace("-", "x")} de ${brDay(item.date)} (limite ${DEADLINES[item.period]})`;
