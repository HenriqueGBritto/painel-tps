/* Aba Requisições: guarda as requisições de estiva enviadas (PDF + leitura + conferência) e as ações sobre elas.
   - Firestore: requisitions/{data}_{número}  { número, navio, período, ternos, conferência, aprovação justificada, … }
                requisitionConfig/feriados     { holidays: [{ date, name }] }
   - PDF no Netlify Blobs (mesmo armazenamento dos anexos), chave "requisicoes/{número}/{id}.pdf".
   Reenviar a mesma requisição (corrigida no OGMO) substitui a conferência e guarda a anterior no histórico.
   Aprovada (direto ou com justificativa) → marca como feita a atividade "Requisição de estiva · período" do turno.
   Testado em tests/requisitions.test.mjs. */
import { randomUUID } from "node:crypto";
import { parseRequisition, extractPages, RequisitionParseError } from "./requisition-pdf.mjs";
import { checkRequisition, defaultHolidays, PERIODS } from "./requisition-rules.mjs";
import * as activities from "./activities.mjs";
import "../../public/shifts.js";

const S = globalThis.TpsShifts;
export const COLLECTION = "requisitions";
export const CONFIG = "requisitionConfig";
export const MAX_PDF_BYTES = 5 * 1024 * 1024;
const MAX_LIST_DAYS = 62;
const MAX_HISTORY = 20;

export class RequisitionError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new RequisitionError(status, message); };
const iso = date => date.toISOString();
const isDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
const idOf = (date, number) => `${date}_${number}`;
const ID = /^\d{4}-\d{2}-\d{2}_[\d-]+$/;

/* ---------- Feriados ---------- */

export async function getHolidays(store, now = new Date()) {
  const saved = await store.get(CONFIG, "feriados");
  if (saved?.holidays) return { holidays: saved.holidays, custom: true, updatedBy: saved.updatedBy || null, updatedAt: saved.updatedAt || null };
  const year = Number(S.zonedParts(now).date.slice(0, 4));
  return { holidays: [...defaultHolidays(year), ...defaultHolidays(year + 1)], custom: false };
}

export async function saveHolidays(store, input, actor, { now = new Date() } = {}) {
  const list = (Array.isArray(input?.holidays) ? input.holidays : []).map(item => ({ date: String(item?.date || ""), name: String(item?.name || "").trim().slice(0, 60) || "Feriado" }));
  if (list.some(item => !isDate(item.date))) fail(400, "Data de feriado inválida.");
  if (list.length > 200) fail(400, "Lista de feriados grande demais.");
  const holidays = [...new Map(list.map(item => [item.date, item])).values()].sort((a, b) => a.date.localeCompare(b.date));
  await store.set(CONFIG, "feriados", { holidays, updatedBy: actor, updatedAt: iso(now) });
  return { holidays };
}

/* ---------- Conferência ---------- */

const status = record => record.cancelled ? "cancelada" : record.override ? "aprovado-justificado" : record.check.result;
const publicRecord = record => ({ ...record, status: status(record) });

/** Outras requisições ativas (não canceladas no OGMO) do mesmo dia e período. */
async function sameShift(store, record) {
  return (await store.list(COLLECTION, { from: `${record.date}_`, to: `${record.date}_~` })).filter(other => other.period === record.period && other.id !== record.id && !other.cancelled);
}

function recheck(record, context, related) {
  return checkRequisition(record, { lineup: context.lineup, holidays: context.holidays, related });
}

/**
 * Requisições do mesmo período se conferem juntas (balsa e navio ao largo, navio sem capatazia e a balsa dele,
 * dormentes e os outros ternos, CCT CAPATAZIA): ao chegar ou cancelar uma, as outras são reconferidas.
 */
async function recheckPartners(store, record, context) {
  const others = await sameShift(store, record);
  for (const other of others) {
    const check = recheck(other, context, [record, ...others.filter(item => item.id !== other.id)]);
    if (JSON.stringify(check) !== JSON.stringify(other.check)) await store.set(COLLECTION, other.id, { check }, { merge: true });
  }
}

/**
 * Recebe o PDF, lê, confere e guarda. `context` = { lineup, files, now, read? (para testes: lê os trechos sem o PDF) }.
 */
export async function submit(store, input, actor, context) {
  const now = context.now || new Date();
  const bytes = input.bytes;
  if (!bytes?.byteLength) fail(400, "Arquivo vazio.");
  if (bytes.byteLength > MAX_PDF_BYTES) fail(413, `Arquivo grande demais: o limite é ${MAX_PDF_BYTES / 1048576} MB.`);
  if (String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") fail(415, "Envie o PDF da requisição impresso pelo sistema do OGMO.");
  let parsed;
  try { parsed = parseRequisition(context.read ? await context.read(bytes) : await extractPages(bytes)); }
  catch (error) {
    if (error instanceof RequisitionParseError) fail(422, error.message);
    console.error("Falha ao ler o PDF da requisição:", error);
    fail(422, "Não consegui ler esse PDF. Envie o PDF impresso pelo sistema do OGMO (não uma foto ou digitalização).");
  }
  if (!isDate(parsed.date) || !PERIODS.includes(parsed.period)) fail(422, "Não encontrei a data da operação e o período no PDF.");
  const id = idOf(parsed.date, parsed.number);
  const previous = await store.get(COLLECTION, id);
  // Mesma requisição sem nenhuma mudança (a verificação no OGMO baixa o PDF de novo a cada rodada): não vira um novo envio.
  const contentKey = JSON.stringify({ ...parsed, printedAt: null });
  if (previous && previous.contentKey === contentKey && !previous.cancelled) {
    // Mesmo PDF: não vira novo envio, mas é conferido de novo com as regras atuais (as regras podem ter mudado).
    const holidays = (await getHolidays(store, now)).holidays;
    const check = recheck({ id, ...previous }, { lineup: context.lineup, holidays }, await sameShift(store, { id, ...previous }));
    const seen = { lastSeenAt: iso(now), ...(context.ogmo ? { ogmo: context.ogmo } : {}), ...(JSON.stringify(check) !== JSON.stringify(previous.check) ? { check } : {}) };
    await store.set(COLLECTION, id, seen, { merge: true });
    return { ...publicRecord({ id, ...previous, ...seen }), unchanged: true };
  }
  const fileKey = `requisicoes/${parsed.number}/${randomUUID().replace(/-/g, "").slice(0, 16)}.pdf`;
  const fileName = String(input.name || `${parsed.number}.pdf`).replace(/[\\/:*?"<>|]+/g, "_").slice(0, 120);
  await context.files.put(fileKey, bytes, { name: fileName, type: "application/pdf", size: bytes.byteLength, by: actor, at: iso(now) });

  const holidays = (await getHolidays(store, now)).holidays;
  const ctx = { lineup: context.lineup, holidays };
  const record = { id, ...parsed, contentKey, fileKey, fileName, fileSize: bytes.byteLength, uploadedBy: actor, uploadedAt: iso(now), lastSeenAt: iso(now), source: context.source || "envio", ogmo: context.ogmo || null, cancelled: false, override: null, activity: null };
  const related = await sameShift(store, record);
  record.check = recheck(record, ctx, related);
  record.history = previous ? [{ at: previous.uploadedAt, by: previous.uploadedBy, status: status(previous), fileKey: previous.fileKey, fileName: previous.fileName, override: previous.override || null }, ...(previous.history || [])].slice(0, MAX_HISTORY) : [];
  await store.set(COLLECTION, id, record);
  await recheckPartners(store, record, ctx);
  if (record.check.result === "aprovado") record.activity = await markActivity(store, record, actor, { files: context.files, now, bytes });
  if (record.activity) await store.set(COLLECTION, id, { activity: record.activity }, { merge: true });
  return { ...publicRecord(record), replaced: Boolean(previous) };
}

/** Reconfere todas as requisições ativas de um dia e período (depois de cancelamentos vindos do OGMO). */
export async function recheckShift(store, date, period, context) {
  const rows = (await store.list(COLLECTION, { from: `${date}_`, to: `${date}_~` })).filter(row => row.period === period && !row.cancelled);
  const holidays = (await getHolidays(store, context.now)).holidays;
  for (const row of rows) {
    const check = recheck(row, { lineup: context.lineup, holidays }, rows.filter(other => other.id !== row.id));
    if (JSON.stringify(check) !== JSON.stringify(row.check)) await store.set(COLLECTION, row.id, { check }, { merge: true });
  }
}

async function load(store, id) {
  if (!ID.test(String(id || ""))) fail(400, "Requisição inválida.");
  const record = await store.get(COLLECTION, id);
  if (!record) fail(404, "Requisição não encontrada.");
  return { id, ...record };
}

/** Aprovar uma requisição reprovada (ou com pontos a confirmar) explicando o motivo. Fica registrado quem e quando. */
export async function approveWithReason(store, input, actor, context) {
  const now = context.now || new Date();
  const record = await load(store, input?.id);
  if (record.check.result === "aprovado") fail(409, "Essa requisição já está aprovada.");
  if (record.override) fail(409, "Essa requisição já foi aprovada com justificativa.");
  const reason = String(input?.reason || "").trim();
  if (reason.length < 5) fail(400, "Escreva o motivo da aprovação.");
  record.override = { by: actor, at: iso(now), reason: reason.slice(0, 1000), result: record.check.result };
  await store.set(COLLECTION, record.id, { override: record.override }, { merge: true });
  if (!record.activity?.done) {
    record.activity = await markActivity(store, record, actor, { files: context.files, now });
    await store.set(COLLECTION, record.id, { activity: record.activity }, { merge: true });
  }
  return publicRecord(record);
}

export async function list(store, { from, to } = {}) {
  if (!isDate(from) || !isDate(to) || from > to) fail(400, "Período inválido.");
  if (S.daysBetween(from, to) >= MAX_LIST_DAYS) fail(400, `Escolha um período de até ${MAX_LIST_DAYS} dias.`);
  const rows = await store.list(COLLECTION, { from: `${from}_`, to: `${to}_~` });
  const order = Object.fromEntries(PERIODS.map((period, index) => [period, index]));
  return rows.map(publicRecord).sort((a, b) => b.date.localeCompare(a.date) || order[b.period] - order[a.period] || a.number.localeCompare(b.number));
}

export async function readPdf(store, files, input) {
  const record = await load(store, input?.id);
  const key = input?.versao ? record.history?.find(item => item.fileKey.endsWith(`/${input.versao}.pdf`))?.fileKey : record.fileKey;
  if (!key) fail(404, "Arquivo não encontrado.");
  const file = await files.get(key);
  if (!file) fail(404, "Arquivo não encontrado.");
  return { data: file.data, name: file.metadata?.name || record.fileName };
}

/* ---------- Ligação com as Atividades ---------- */

/** Turnos onde costuma estar a atividade fixa do período (07x13 é pedida no Noturno do dia anterior). */
function candidateShifts(date, period) {
  return period === "07-13" ? [S.makeId(S.addDays(date, -1), "N"), S.makeId(date, "D")] : [S.makeId(date, "D"), S.makeId(S.addDays(date, -1), "N"), S.makeId(date, "N")];
}

/**
 * Marca como feita a atividade "Requisição de estiva · período" e anexa o PDF à observação dela.
 * Não impede nada se não der (turno encerrado, atividade inexistente): devolve o motivo.
 */
export async function markActivity(store, record, actor, { files, now = new Date(), bytes = null } = {}) {
  const taskId = `m_estiva-${record.period.replace("-", "x")}`;
  try {
    for (const shiftId of candidateShifts(record.date, record.period)) {
      const task = await store.get(`shifts/${shiftId}/tasks`, taskId);
      if (!task) continue;
      if (task.status === "done") return { done: true, shiftId, taskId, already: true };
      const shift = await store.get(activities.COLLECTIONS.shifts, shiftId);
      if (shift?.handover) return { done: false, shiftId, taskId, reason: "turno já encerrado" };
      let pdf = bytes;
      if (!pdf) { const file = await files.get(record.fileKey); pdf = file ? new Uint8Array(file.data) : null; }
      const keep = (task.attachments || []).map(item => ({ id: item.id, shift: item.shift || shiftId }));
      if (pdf) {
        const meta = await activities.uploadAttachment(store, files, { shiftId, name: record.fileName || `${record.number}.pdf`, type: "application/pdf", bytes: pdf }, actor, { now });
        keep.push({ id: meta.id, shift: shiftId });
      }
      const line = `Requisição ${record.number} conferida na aba Requisições: ${record.override ? "aprovada com justificativa" : "aprovada"}.`;
      await activities.setTaskNote(store, { shiftId, taskId, note: [task.note, line].filter(Boolean).join("\n").slice(0, 2000), attachments: keep.slice(-8) }, actor, { now, files });
      if (now >= new Date(shift?.start || 0)) await activities.setTaskStatus(store, { shiftId, taskId, status: "done" }, actor, { now });
      return { done: now >= new Date(shift?.start || 0), shiftId, taskId };
    }
    return { done: false, reason: "atividade do período não encontrada nos turnos" };
  } catch (error) {
    if (error instanceof activities.ActivityError) return { done: false, reason: error.message };
    throw error;
  }
}
