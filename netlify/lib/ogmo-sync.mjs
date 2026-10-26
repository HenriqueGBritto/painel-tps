/* Verificação automática no OGMO. O robô (robot/ogmo.mjs, no GitHub Actions) entra no sistema do OGMO,
   lê a lista de requisições de ontem, hoje e amanhã, baixa o "Visualiza" (PDF) das ativas e manda tudo para cá:
   - POST /api/requisicoes/ogmo/pdf    cada PDF → mesma conferência da aba (requisitions.mjs)
   - POST /api/requisicoes/ogmo/lista  a lista completa → canceladas, o que falta antes do limite e o resumo da rodada
   - POST /api/requisicoes/ogmo/erro   a rodada falhou (aparece na aba e no sino)
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
  for (const date of dates.filter(isDate).slice(0, 4)) {
    for (const row of await store.list(R.COLLECTION, { from: `${date}_`, to: `${date}_~` })) result[row.number] = { date, scaled: Boolean(row.ogmo?.scaled), cancelled: Boolean(row.cancelled) };
  }
  return result;
}

/** Lista completa da rodada: marca canceladas, reconfere os períodos afetados e calcula o que falta. */
export async function receiveList(store, input, context) {
  const now = context.now || new Date();
  const dates = (Array.isArray(input?.dates) ? input.dates : []).filter(isDate).slice(0, 4);
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
  for (const { date, period } of affected.values()) await R.recheckShift(store, date, period, context);
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
  await store.set(SYNC, "status", { ok: false, error: message, errorAt: now.toISOString() }, { merge: true });
  return { ok: true };
}

export async function syncStatus(store) {
  return (await store.get(SYNC, "status")) || null;
}

/** Texto curto para alertas e para a aba. */
export const missingText = item => `${item.vessel}: falta a requisição do ${item.period.replace("-", "x")} de ${brDay(item.date)} (limite ${DEADLINES[item.period]})`;
