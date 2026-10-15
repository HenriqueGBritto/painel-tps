/* Regras da aba Atividades: turnos, listas geradas dos modelos, passagem de serviço e escala.
   Usado pela função netlify/functions/atividades.mjs; testado em tests/activities.test.mjs.

   Coleções:
   - shiftAssistants/{id}           assistentes { name, active, order }
   - shiftConfig/main               { hours, rotations: { D, N }, updatedBy, updatedAt }
   - shiftOverrides/{turno}         ajuste pontual { assistantId, reason, by, at }
   - taskTemplates/{id}             atividade fixa { title, description, shift, time, remindBefore, weekdays, active }
   - shifts/{turno}                 { scheduled, handover, received, version, templatesGenerated, carryDone }
   - shifts/{turno}/tasks/{id}      { title, time, dueAt, status, doneBy, doneAt, origin, rootId, ... }
   Turno = "AAAA-MM-DD_D" ou "AAAA-MM-DD_N" (public/shifts.js). */
import { randomUUID } from "node:crypto";
import "../../public/shifts.js";
import { ALLOWED_TYPES, MAX_BYTES, MAX_FILES } from "./attachments-store.mjs";

const S = globalThis.TpsShifts;

export const COLLECTIONS = { assistants: "shiftAssistants", config: "shiftConfig", overrides: "shiftOverrides", templates: "taskTemplates", shifts: "shifts" };
const tasksOf = shiftId => `${COLLECTIONS.shifts}/${shiftId}/tasks`;
const SYSTEM = { id: null, name: "Sistema" };
const STATUSES = ["pending", "done", "not_done"];
/** Maior intervalo do acompanhamento, em dias. */
export const MAX_HISTORY_DAYS = 31;

/* Escala inicial, alinhada às equipes do 2x2 (aba Equipe): Diurno Hélio (B) / Roger (A) e Noturno Andrés (C) / Matheus (D).
   13–14/10/2026 = B + D (Hélio e Matheus) e 15–16/10/2026 = A + C (Roger e Andrés). */
export const DEFAULT_ASSISTANTS = [
  { id: "roger", name: "Roger", active: true, order: 1 },
  { id: "helio", name: "Hélio", active: true, order: 2 },
  { id: "matheus", name: "Matheus", active: true, order: 3 },
  { id: "andres", name: "Andrés", active: true, order: 4 }
];
export const DEFAULT_CONFIG = {
  hours: { ...S.DEFAULT_HOURS },
  rotations: {
    D: { members: ["helio", "roger"], blockDays: 2, referenceDate: "2026-10-13" },
    N: { members: ["andres", "matheus"], blockDays: 2, referenceDate: "2026-10-15" }
  }
};

/* Atividades fixas iniciais (lista da operação). Horário = prazo ("até"); cada prazo cai no turno em que acontece.
   Requisições de estiva e DA9 são por período de trabalho (07x13, 13x19, 19x01, 01x07). */
const fixed = (id, title, shift, time = null, extra = {}) => ({ id, title, shift, time, description: "", remindBefore: 0, weekdays: [], assigneeId: null, active: true, ...extra });
export const DEFAULT_TEMPLATES = [
  fixed("sof", "Atualizar SOF", "both"),
  fixed("geport", "Atualizar GEPORT", "both"),
  fixed("dobra-tpa", "Dobra de TPA", "both"),
  fixed("lineup", "Atualizar lineup", "both"),
  fixed("producao-dia", "Atualizar e enviar produção do navio (até 07h)", "D", null, { description: "Após o término do período: produção até as 07h." }),
  fixed("producao-noite", "Atualizar e enviar produção do navio (até 19h)", "N", null, { description: "Após o término do período: produção até as 19h." }),
  fixed("pagamento-estiva", "Pagamento de estiva para o Rogério", "D", "08:30", { description: "Enviar no grupo da estiva." }),
  fixed("plano-b", "Pedido de operadores (plano B)", "D", "16:00"),
  fixed("estiva-07x13", "Requisição de estiva · período 07x13", "N", "03:30", { remindBefore: 30 }),
  fixed("estiva-13x19", "Requisição de estiva · período 13x19", "D", "09:00", { remindBefore: 30 }),
  fixed("estiva-19x01", "Requisição de estiva · período 19x01", "D", "15:30", { remindBefore: 30 }),
  fixed("estiva-01x07", "Requisição de estiva · período 01x07", "D", "18:30", { remindBefore: 30 }),
  fixed("da9-07x13", "Enviar DA9 · período 07x13", "N", "05:15"),
  fixed("da9-13x19", "Enviar DA9 · período 13x19", "D", "11:15"),
  fixed("da9-19x01", "Enviar DA9 · período 19x01", "D", "17:15"),
  fixed("da9-01x07", "Enviar DA9 · período 01x07", "N", "20:15")
];

export class ActivityError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new ActivityError(status, message); };

const text = (value, max, field, { required = false } = {}) => {
  const result = String(value ?? "").trim();
  if (required && !result) fail(400, `Preencha ${field}.`);
  if (result.length > max) fail(400, `${field[0].toUpperCase()}${field.slice(1)} pode ter até ${max} caracteres.`);
  return result;
};
const minutes = value => {
  const number = Math.floor(Number(value) || 0);
  if (number < 0 || number > 240) fail(400, "O lembrete antecipado vai de 0 a 240 minutos.");
  return number;
};
const timeOrNull = value => {
  if (value === null || value === undefined || value === "") return null;
  if (!S.isTime(value)) fail(400, "Horário inválido. Use HH:MM.");
  return value;
};
const shiftIdOrFail = id => { if (!S.isShiftId(id)) fail(400, "Turno inválido."); return id; };
const requireActor = actor => { if (!actor?.name) fail(400, "Identifique-se antes de registrar (quem é você?)."); return actor; };
const newVersion = now => `${now.getTime()}-${randomUUID().slice(0, 6)}`;
const iso = date => date.toISOString();

/* ---------- Configuração e escala ---------- */

/** Configuração da escala; no primeiro uso grava os assistentes, a escala e as atividades fixas iniciais. */
/* A primeira versão gravou o Noturno invertido (Andrés em 13–14/10, quando a noite era da equipe D, de Matheus).
   Se a escala salva ainda for exatamente essa e ninguém a alterou pela tela, ela é corrigida uma vez. */
const WRONG_NIGHT = { members: ["andres", "matheus"], blockDays: 2, referenceDate: "2026-10-13" };
const isWrongNight = rotation => JSON.stringify({ members: rotation?.members, blockDays: rotation?.blockDays, referenceDate: rotation?.referenceDate }) === JSON.stringify(WRONG_NIGHT);

export async function getConfig(store) {
  const config = await store.get(COLLECTIONS.config, "main");
  if (config && !config.updatedBy && isWrongNight(config.rotations?.N)) {
    const fixed = { ...config, rotations: { ...config.rotations, N: structuredClone(DEFAULT_CONFIG.rotations.N) }, fixedNightRotationAt: new Date().toISOString() };
    await store.set(COLLECTIONS.config, "main", fixed);
    await refreshScheduled(store, S.shiftIdAt(new Date(), fixed.hours), new Date());
    return fixed;
  }
  if (config) return config;
  await Promise.all(DEFAULT_ASSISTANTS.map(({ id, ...data }) => store.create(COLLECTIONS.assistants, id, data)));
  await Promise.all(DEFAULT_TEMPLATES.map(({ id, ...data }) => store.create(COLLECTIONS.templates, id, data)));
  await store.create(COLLECTIONS.config, "main", structuredClone(DEFAULT_CONFIG));
  return store.get(COLLECTIONS.config, "main");
}

export async function listAssistants(store) {
  return (await store.list(COLLECTIONS.assistants)).sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || a.name.localeCompare(b.name));
}

async function overridesBetween(store, fromId, toId) {
  const rows = await store.list(COLLECTIONS.overrides, { from: fromId, to: toId });
  return Object.fromEntries(rows.map(({ id, ...row }) => [id, row]));
}

/** Escalado no turno, com nome (para o histórico guardar quem estava escalado na época). */
function scheduledSnapshot(shiftId, config, assistants, overrides) {
  const slot = S.scheduledFor(shiftId, config, overrides);
  const person = assistants.find(item => item.id === slot.assistantId);
  return { ...slot, name: person?.name || null };
}

/** Atualiza o escalado gravado nos turnos já criados a partir de `fromId` (depois de mudar escala ou ajuste). */
async function refreshScheduled(store, fromId, now) {
  const [config, assistants, shifts] = await Promise.all([getConfig(store), listAssistants(store), store.list(COLLECTIONS.shifts, { from: fromId })]);
  const overrides = await overridesBetween(store, fromId, shifts.at(-1)?.id || fromId);
  await Promise.all(shifts.map(shift => {
    const scheduled = scheduledSnapshot(shift.id, config, assistants, overrides);
    if (JSON.stringify(scheduled) === JSON.stringify(shift.scheduled)) return null;
    return store.set(COLLECTIONS.shifts, shift.id, { scheduled, version: newVersion(now) }, { merge: true });
  }));
}

export async function getSettings(store, { now = new Date() } = {}) {
  const config = await getConfig(store);
  const current = S.shiftIdAt(now, config.hours);
  const today = current.slice(0, 10);
  const [assistants, templates, overrides] = await Promise.all([
    listAssistants(store),
    store.list(COLLECTIONS.templates),
    store.list(COLLECTIONS.overrides, { from: S.makeId(S.addDays(today, -14), "D"), to: S.makeId(S.addDays(today, 90), "N") })
  ]);
  return { config, assistants, templates: templates.sort((a, b) => (a.time || "99:99").localeCompare(b.time || "99:99") || a.title.localeCompare(b.title)), overrides, currentShiftId: current };
}

const slug = name => name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "assistente";

export async function saveAssistant(store, input, actor, { now = new Date() } = {}) {
  requireActor(actor);
  await getConfig(store);
  const name = text(input.name, 60, "o nome", { required: true });
  const assistants = await listAssistants(store);
  let id = input.id ? String(input.id) : null;
  if (id && !assistants.some(item => item.id === id)) fail(404, "Assistente não encontrado.");
  if (!id) {
    const base = slug(name);
    id = base;
    for (let n = 2; assistants.some(item => item.id === id); n++) id = `${base}-${n}`;
  }
  const current = assistants.find(item => item.id === id);
  await store.set(COLLECTIONS.assistants, id, { name, active: input.active !== false, order: current?.order ?? assistants.length + 1, updatedBy: actor, updatedAt: iso(now) }, { merge: true });
  await refreshScheduled(store, S.shiftIdAt(now, (await getConfig(store)).hours), now);
  return { id };
}

export async function saveSchedule(store, input, actor, { now = new Date() } = {}) {
  requireActor(actor);
  await getConfig(store);
  const assistants = await listAssistants(store);
  const known = new Set(assistants.map(item => item.id));
  const hours = { dayStart: input?.hours?.dayStart, nightStart: input?.hours?.nightStart };
  if (!S.isTime(hours.dayStart) || !S.isTime(hours.nightStart) || S.minutesOf(hours.dayStart) >= S.minutesOf(hours.nightStart)) fail(400, "Horários dos turnos inválidos: o Diurno precisa começar antes do Noturno.");
  const rotation = kind => {
    const value = input?.rotations?.[kind] || {};
    const members = (Array.isArray(value.members) ? value.members : []).map(String).filter(Boolean);
    if (!members.length || members.some(id => !known.has(id))) fail(400, `Escolha os assistentes do ${S.KINDS[kind]}.`);
    const blockDays = Math.floor(Number(value.blockDays));
    if (!(blockDays >= 1 && blockDays <= 7)) fail(400, "Dias seguidos por assistente: de 1 a 7.");
    if (!S.isDate(value.referenceDate)) fail(400, `Data de referência do ${S.KINDS[kind]} inválida.`);
    return { members, blockDays, referenceDate: value.referenceDate };
  };
  const config = { hours, rotations: { D: rotation("D"), N: rotation("N") }, updatedBy: actor, updatedAt: iso(now) };
  await store.set(COLLECTIONS.config, "main", config);
  await refreshScheduled(store, S.shiftIdAt(now, hours), now);
  return config;
}

export async function saveOverride(store, input, actor, { now = new Date() } = {}) {
  requireActor(actor);
  const shiftId = shiftIdOrFail(input.shiftId);
  const assistants = await listAssistants(store);
  if (!assistants.some(item => item.id === input.assistantId)) fail(400, "Escolha quem cobre o turno.");
  const reason = text(input.reason, 200, "o motivo", { required: true });
  await store.set(COLLECTIONS.overrides, shiftId, { assistantId: input.assistantId, reason, by: actor, at: iso(now) });
  await refreshScheduled(store, shiftId, now);
  return { shiftId };
}

export async function removeOverride(store, input, actor, { now = new Date() } = {}) {
  requireActor(actor);
  const shiftId = shiftIdOrFail(input.shiftId);
  await store.remove(COLLECTIONS.overrides, shiftId);
  await refreshScheduled(store, shiftId, now);
  return { shiftId };
}

/* ---------- Modelos (atividades fixas) ---------- */

/** Atividade gerada pelo modelo. Responsável fixo do modelo, se houver; sem ele, vale o escalado do turno. */
function templateTask(template, shiftId, hours, now, assistants = []) {
  const person = template.assigneeId ? assistants.find(item => item.id === template.assigneeId) : null;
  const due = S.dueAt(shiftId, template.time, hours);
  return {
    title: template.title, description: template.description || "", time: template.time || null, dueAt: due ? iso(due) : null,
    remindBefore: template.remindBefore || 0, origin: "template", templateId: template.id, rootId: `${shiftId}~m_${template.id}`,
    assignee: person ? { id: person.id, name: person.name } : null, note: "",
    status: "pending", createdBy: SYSTEM, createdAt: iso(now)
  };
}

/**
 * Salva o modelo e aplica a partir do turno atual nos turnos já gerados e não encerrados:
 * cria a atividade onde passou a valer, atualiza as pendentes e tira as pendentes de onde deixou de valer.
 */
export async function saveTemplate(store, input, actor, { now = new Date() } = {}) {
  requireActor(actor);
  const config = await getConfig(store);
  const shift = ["D", "N", "both"].includes(input.shift) ? input.shift : fail(400, "Escolha o turno do modelo.");
  const weekdays = [...new Set((Array.isArray(input.weekdays) ? input.weekdays : []).map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6))].sort();
  if (Array.isArray(input.weekdays) && input.weekdays.length && !weekdays.length) fail(400, "Dias da semana inválidos.");
  const id = input.id ? String(input.id) : `t${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  if (input.id && !(await store.get(COLLECTIONS.templates, id))) fail(404, "Modelo não encontrado.");
  const assistants = await listAssistants(store);
  const assigneeId = input.assigneeId ? String(input.assigneeId) : null;
  if (assigneeId && !assistants.some(item => item.id === assigneeId)) fail(400, "Responsável fixo inválido.");
  const template = {
    title: text(input.title, 120, "o título", { required: true }), description: text(input.description, 1000, "a descrição"),
    shift, time: timeOrNull(input.time), remindBefore: minutes(input.remindBefore), weekdays: weekdays.length === 7 ? [] : weekdays,
    assigneeId, active: input.active !== false, updatedBy: actor, updatedAt: iso(now)
  };
  await store.set(COLLECTIONS.templates, id, template);
  await applyTemplate(store, { id, ...template }, config, now, assistants);
  return { id };
}

export async function removeTemplate(store, input, actor, { now = new Date() } = {}) {
  requireActor(actor);
  const id = String(input.id || "");
  const existing = await store.get(COLLECTIONS.templates, id);
  if (!existing) fail(404, "Modelo não encontrado.");
  await store.remove(COLLECTIONS.templates, id);
  await applyTemplate(store, { id, ...existing, active: false }, await getConfig(store), now, await listAssistants(store));
  return { id };
}

async function applyTemplate(store, template, config, now, assistants) {
  const shifts = await store.list(COLLECTIONS.shifts, { from: S.shiftIdAt(now, config.hours) });
  for (const shift of shifts.filter(item => item.templatesGenerated && !item.handover)) {
    const taskId = `m_${template.id}`;
    const existing = await store.get(tasksOf(shift.id), taskId);
    const applies = S.templateApplies(template, shift.id);
    let changed = false;
    if (applies && !existing) changed = await store.create(tasksOf(shift.id), taskId, templateTask(template, shift.id, config.hours, now, assistants));
    else if (applies && existing?.status === "pending") {
      const fresh = templateTask(template, shift.id, config.hours, now, assistants);
      // Responsável atribuído à mão na atividade não é sobrescrito pelo modelo.
      await store.set(tasksOf(shift.id), taskId, { title: fresh.title, description: fresh.description, time: fresh.time, dueAt: fresh.dueAt, remindBefore: fresh.remindBefore, ...(existing.assignedBy ? {} : { assignee: fresh.assignee }), updatedAt: iso(now) }, { merge: true });
      changed = true;
    } else if (!applies && existing?.status === "pending") { await store.remove(tasksOf(shift.id), taskId); changed = true; }
    if (changed) await bump(store, shift.id, now);
  }
}

/* ---------- Turnos ---------- */

const bump = (store, shiftId, now) => store.set(COLLECTIONS.shifts, shiftId, { version: newVersion(now) }, { merge: true });

/**
 * Pendências do turno anterior passam para `shiftId`. A original fica "transferida" (o histórico
 * do turno anterior continua mostrando o que ficou pendente lá). Seguro para repetir: a cópia usa
 * id fixo pelo `rootId` da atividade original, e pendências já transferidas são ignoradas.
 */
export async function carryInto(store, shiftId, { now = new Date() } = {}) {
  const previousId = S.previous(shiftId);
  const previous = await store.get(COLLECTIONS.shifts, previousId);
  if (!previous) return 0;
  const pending = (await store.list(tasksOf(previousId))).filter(task => task.status === "pending");
  for (const { id, ...task } of pending) {
    // Atividade fixa que se repete no turno seguinte (ex.: "Atualizar SOF"): junta com a de lá em vez de duplicar.
    const sameTemplate = task.templateId ? await store.get(tasksOf(shiftId), `m_${task.templateId}`) : null;
    if (sameTemplate) {
      const hasNote = item => Boolean(item.note || item.attachments?.length);
      await store.set(tasksOf(shiftId), `m_${task.templateId}`, { pendingFromPrevious: previousId, ...(hasNote(task) && !hasNote(sameTemplate) ? { note: task.note || "", attachments: task.attachments || [], noteBy: task.noteBy, noteAt: task.noteAt } : {}) }, { merge: true });
      await store.set(tasksOf(previousId), id, { status: "transferred", transferredTo: shiftId, mergedInto: `m_${task.templateId}`, updatedAt: iso(now) }, { merge: true });
      continue;
    }
    await store.create(tasksOf(shiftId), `c_${task.rootId}`, {
      ...task, origin: "carried", fromShift: previousId, fromTaskId: id, withoutHandover: !previous.handover,
      status: "pending", carriedAt: iso(now), createdBy: SYSTEM, createdAt: iso(now)
    });
    await store.set(tasksOf(previousId), id, { status: "transferred", transferredTo: shiftId, updatedAt: iso(now) }, { merge: true });
  }
  if (pending.length) await Promise.all([bump(store, previousId, now), bump(store, shiftId, now)]);
  return pending.length;
}

/**
 * Garante que o turno exista: cria o registro, gera a lista a partir dos modelos e, quando o turno
 * já começou, traz as pendências do anterior. Turnos passados que nunca foram abertos não são criados.
 */
export async function ensureShift(store, shiftId, { now = new Date() } = {}) {
  shiftIdOrFail(shiftId);
  let shift = await store.get(COLLECTIONS.shifts, shiftId);
  if (shift?.templatesGenerated && (shift.carryDone || now < new Date(shift.start))) return shift;
  const config = await getConfig(store);
  const { start, end } = S.bounds(shiftId, config.hours);
  if (!shift) {
    if (end <= now) return null;
    const [assistants, overrides] = await Promise.all([listAssistants(store), overridesBetween(store, shiftId, shiftId)]);
    const { date, kind } = S.parseId(shiftId);
    await store.create(COLLECTIONS.shifts, shiftId, {
      date, kind, start: iso(start), end: iso(end), scheduled: scheduledSnapshot(shiftId, config, assistants, overrides),
      handover: null, received: null, templatesGenerated: false, carryDone: false, version: newVersion(now), createdAt: iso(now)
    });
    shift = await store.get(COLLECTIONS.shifts, shiftId);
  }
  if (!shift.templatesGenerated) {
    const [templates, assistants] = await Promise.all([store.list(COLLECTIONS.templates), listAssistants(store)]);
    await Promise.all(templates.filter(template => S.templateApplies(template, shiftId)).map(template => store.create(tasksOf(shiftId), `m_${template.id}`, templateTask(template, shiftId, config.hours, now, assistants))));
    await store.set(COLLECTIONS.shifts, shiftId, { templatesGenerated: true, version: newVersion(now) }, { merge: true });
  }
  if (!shift.carryDone && now >= start) {
    await carryInto(store, shiftId, { now });
    await store.set(COLLECTIONS.shifts, shiftId, { carryDone: true }, { merge: true });
  }
  return store.get(COLLECTIONS.shifts, shiftId);
}

const byTime = (a, b) => (a.dueAt || "9999").localeCompare(b.dueAt || "9999") || (a.createdAt || "").localeCompare(b.createdAt || "") || a.title.localeCompare(b.title);

/**
 * Ordem da lista. Se a lista do turno foi arrastada, vale essa ordem (atividades novas vão para o fim, por horário).
 * Sem ordem própria: herdadas primeiro, depois as fixas na ordem aprendida dos últimos arrastes
 * (templateOrder) e por fim as incluídas, por horário. Sem ordem aprendida, tudo por horário.
 */
export function arrangeTasks(tasks, shiftOrder = null, templateOrder = null) {
  const list = [...tasks].sort(byTime);
  if (Array.isArray(shiftOrder) && shiftOrder.length) {
    const position = new Map(shiftOrder.map((id, index) => [id, index]));
    return list.sort((a, b) => (position.get(a.id) ?? Infinity) - (position.get(b.id) ?? Infinity));
  }
  if (!Array.isArray(templateOrder) || !templateOrder.length) return list;
  const learned = new Map(templateOrder.map((id, index) => [id, index]));
  const group = task => task.origin === "carried" ? 0 : task.origin === "template" ? 1 : 2;
  return list.sort((a, b) => group(a) - group(b) || (group(a) === 1 ? (learned.get(a.templateId) ?? Infinity) - (learned.get(b.templateId) ?? Infinity) : 0));
}
const publicShift = (id, shift) => shift && ({
  id, label: S.label(id), date: shift.date, kind: shift.kind, start: shift.start, end: shift.end,
  scheduled: shift.scheduled, handover: shift.handover || null, received: shift.received || null, version: shift.version
});

/**
 * Turno com as atividades, para a tela. `since` = versão que a página já tem: se nada mudou,
 * devolve só { unchanged: true } (a página consulta a cada 30 s; assim cada consulta lê um documento só).
 */
export async function getShiftView(store, shiftId, { now = new Date(), since = null } = {}) {
  const shift = await ensureShift(store, shiftId, { now });
  if (shift && since && since === shift.version) return { unchanged: true, version: shift.version };
  const config = await getConfig(store);
  const previousId = S.previous(shiftId);
  const nextId = S.next(shiftId);
  const [tasks, previous, next] = await Promise.all([shift ? store.list(tasksOf(shiftId)) : [], store.get(COLLECTIONS.shifts, previousId), shift?.handover ? store.get(COLLECTIONS.shifts, nextId) : null]);
  let view = publicShift(shiftId, shift);
  if (!view) {
    // Turno passado sem registro: mostra só quem estava escalado.
    const { start, end } = S.bounds(shiftId, config.hours);
    const [assistants, overrides] = await Promise.all([listAssistants(store), overridesBetween(store, shiftId, shiftId)]);
    view = { id: shiftId, label: S.label(shiftId), ...S.parseId(shiftId), start: iso(start), end: iso(end), scheduled: scheduledSnapshot(shiftId, config, assistants, overrides), handover: null, received: null, version: null, missing: true };
  }
  return {
    shift: view, tasks: arrangeTasks(tasks, shift?.taskOrder, config.templateOrder), previous: publicShift(previousId, previous), next: publicShift(nextId, next),
    currentShiftId: S.shiftIdAt(now, config.hours), hours: config.hours, serverTime: iso(now)
  };
}

async function openShift(store, shiftId, now, { mustHaveStarted = true } = {}) {
  shiftIdOrFail(shiftId);
  const shift = await ensureShift(store, shiftId, { now });
  if (!shift) fail(409, "Esse turno já terminou e não tem registro.");
  if (shift.handover) fail(409, "Esse turno já foi encerrado.");
  if (mustHaveStarted && now < new Date(shift.start)) fail(409, "Esse turno ainda não começou.");
  return shift;
}

export async function addTask(store, input, actor, { now = new Date() } = {}) {
  requireActor(actor);
  const shiftId = shiftIdOrFail(input.shiftId);
  const config = await getConfig(store);
  if (shiftId < S.shiftIdAt(now, config.hours)) fail(409, "Só dá para incluir atividades no turno atual ou em turnos futuros.");
  await openShift(store, shiftId, now, { mustHaveStarted: false });
  const time = timeOrNull(input.time);
  const due = S.dueAt(shiftId, time, config.hours);
  const assignee = await assigneeOf(store, input.assigneeId);
  const id = `a_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await store.create(tasksOf(shiftId), id, {
    title: text(input.title, 120, "o título", { required: true }), description: text(input.description, 1000, "a descrição"),
    time, dueAt: due ? iso(due) : null, remindBefore: minutes(input.remindBefore), origin: "adhoc", rootId: `${shiftId}~${id}`,
    assignee, ...(assignee ? { assignedBy: actor, assignedAt: iso(now) } : {}), note: "",
    status: "pending", createdBy: actor, createdAt: iso(now)
  });
  await bump(store, shiftId, now);
  return { id };
}

/** Responsável escolhido: { id, name } de um assistente cadastrado, ou null (= escalado do turno). */
async function assigneeOf(store, assigneeId) {
  if (!assigneeId) return null;
  const person = (await listAssistants(store)).find(item => item.id === String(assigneeId));
  if (!person) fail(400, "Responsável inválido.");
  return { id: person.id, name: person.name };
}

async function openTask(store, input, now, { mustHaveStarted }) {
  const shiftId = shiftIdOrFail(input.shiftId);
  await openShift(store, shiftId, now, { mustHaveStarted });
  const taskId = String(input.taskId || "");
  const task = await store.get(tasksOf(shiftId), taskId);
  if (!task) fail(404, "Atividade não encontrada.");
  if (task.status === "transferred") fail(409, "Essa atividade já passou para o turno seguinte.");
  return { shiftId, taskId, task };
}

/** Observação da atividade (texto livre, a última versão vale). Vale também para turnos futuros. */

/**
 * Atribui a atividade a outra pessoa (ex.: o responsável fixo está de folga) ou volta para o escalado (assigneeId vazio).
 * Pode ser feito antes do turno começar.
 */
export async function assignTask(store, input, actor, { now = new Date() } = {}) {
  requireActor(actor);
  const { shiftId, taskId } = await openTask(store, input, now, { mustHaveStarted: false });
  const assignee = await assigneeOf(store, input.assigneeId);
  const change = { assignee, assignedBy: actor, assignedAt: iso(now) };
  await store.set(tasksOf(shiftId), taskId, { ...change, updatedBy: actor, updatedAt: iso(now) }, { merge: true });
  await bump(store, shiftId, now);
  return { id: taskId, ...change };
}

export async function removeTask(store, input, actor, { now = new Date() } = {}) {
  requireActor(actor);
  const shiftId = shiftIdOrFail(input.shiftId);
  await openShift(store, shiftId, now, { mustHaveStarted: false });
  const task = await store.get(tasksOf(shiftId), String(input.taskId || ""));
  if (!task) fail(404, "Atividade não encontrada.");
  if (task.origin !== "adhoc" || task.status !== "pending") fail(409, "Só atividades avulsas ainda pendentes podem ser excluídas.");
  await store.remove(tasksOf(shiftId), String(input.taskId));
  await bump(store, shiftId, now);
  return { id: input.taskId };
}

/** Feito, não feito (com motivo) ou de volta a pendente. Registra quem e quando. */
export async function setTaskStatus(store, input, actor, { now = new Date() } = {}) {
  requireActor(actor);
  const shiftId = shiftIdOrFail(input.shiftId);
  await openShift(store, shiftId, now);
  const taskId = String(input.taskId || "");
  const task = await store.get(tasksOf(shiftId), taskId);
  if (!task) fail(404, "Atividade não encontrada.");
  if (task.status === "transferred") fail(409, "Essa atividade já passou para o turno seguinte.");
  if (!STATUSES.includes(input.status)) fail(400, "Situação inválida.");
  const reason = input.status === "not_done" ? text(input.reason, 500, "o motivo", { required: true }) : "";
  const change = input.status === "pending"
    ? { status: "pending", reason: "", doneBy: null, doneAt: null }
    : { status: input.status, reason, doneBy: actor, doneAt: iso(now) };
  await store.set(tasksOf(shiftId), taskId, { ...change, updatedBy: actor, updatedAt: iso(now) }, { merge: true });
  await bump(store, shiftId, now);
  return { id: taskId, ...change };
}

/* ---------- Anexos das observações ---------- */

const attachmentKey = (shiftId, id) => `${shiftId}/${id}`;
const ATTACHMENT_ID = /^[a-f0-9]{16}$/;

/**
 * Guarda um arquivo para anexar à observação de uma atividade do turno. `files` = attachmentsStore().
 * O arquivo fica sob o turno em que foi enviado; se a atividade passar para o turno seguinte, o anexo vai junto
 * (a lista da atividade guarda o turno de cada arquivo).
 */
export async function uploadAttachment(store, files, input, actor, { now = new Date() } = {}) {
  requireActor(actor);
  const shiftId = shiftIdOrFail(input.shiftId);
  await openShift(store, shiftId, now, { mustHaveStarted: false });
  const kind = ALLOWED_TYPES[input.type];
  if (!kind) fail(415, "Tipo de arquivo não aceito. Envie imagem (JPG, PNG, WebP), PDF, Word, Excel ou texto.");
  const size = input.bytes?.byteLength || 0;
  if (!size) fail(400, "Arquivo vazio.");
  if (size > MAX_BYTES) fail(413, `Arquivo grande demais: o limite é ${MAX_BYTES / 1048576} MB.`);
  const name = text(input.name, 120, "o nome do arquivo", { required: true }).replace(/[\\/:*?"<>|]+/g, "_");
  const id = randomUUID().replace(/-/g, "").slice(0, 16);
  const metadata = { id, name, type: input.type, kind, size, by: actor, at: iso(now) };
  await files.put(attachmentKey(shiftId, id), input.bytes, metadata);
  return metadata;
}

export async function readAttachment(files, input) {
  const shiftId = shiftIdOrFail(input.shiftId);
  if (!ATTACHMENT_ID.test(String(input.id || ""))) fail(400, "Anexo inválido.");
  const file = await files.get(attachmentKey(shiftId, input.id));
  if (!file) fail(404, "Anexo não encontrado.");
  return file;
}

/**
 * Anexos escolhidos para a observação: [{ id, shift }] de arquivos já enviados. Só valem arquivos que existem;
 * nome, tipo e tamanho vêm do que foi guardado no envio, não do pedido.
 */
async function resolveAttachments(files, entries, defaultShift) {
  const wanted = (Array.isArray(entries) ? entries : []).map(entry => typeof entry === "string" ? { id: entry, shift: defaultShift } : { id: String(entry?.id || ""), shift: String(entry?.shift || defaultShift) });
  const unique = [...new Map(wanted.map(entry => [`${entry.shift}/${entry.id}`, entry])).values()];
  if (unique.length > MAX_FILES) fail(400, `Anexe até ${MAX_FILES} arquivos por atividade.`);
  if (unique.length && !files) fail(500, "Armazenamento de anexos indisponível.");
  const found = await Promise.all(unique.map(entry => ATTACHMENT_ID.test(entry.id) && S.isShiftId(entry.shift) ? files.meta(attachmentKey(entry.shift, entry.id)) : null));
  if (found.some(item => !item)) fail(400, "Um dos anexos não foi encontrado. Envie o arquivo de novo.");
  return found.map(({ id, name, type, kind, size }, index) => ({ id, shift: unique[index].shift, name, type, kind, size }));
}

/** Observação da atividade (texto livre e anexos; a última versão vale). Vale também para turnos futuros. */
export async function setTaskNote(store, input, actor, { now = new Date(), files = null } = {}) {
  requireActor(actor);
  const { shiftId, taskId } = await openTask(store, input, now, { mustHaveStarted: false });
  const note = text(input.note, 2000, "a observação");
  const attachments = await resolveAttachments(files, input.attachments, shiftId);
  const filled = Boolean(note || attachments.length);
  const change = { note, attachments, noteBy: filled ? actor : null, noteAt: filled ? iso(now) : null };
  await store.set(tasksOf(shiftId), taskId, { ...change, updatedBy: actor, updatedAt: iso(now) }, { merge: true });
  await bump(store, shiftId, now);
  return { id: taskId, ...change };
}

/* ---------- Ordem da lista ---------- */

/**
 * Ordem arrastada na tela. Vale para o turno e ensina a ordem das atividades fixas aos turnos seguintes.
 */
export async function reorderTasks(store, input, actor, { now = new Date() } = {}) {
  requireActor(actor);
  const shiftId = shiftIdOrFail(input.shiftId);
  await openShift(store, shiftId, now, { mustHaveStarted: false });
  const tasks = await store.list(tasksOf(shiftId));
  const known = new Map(tasks.map(task => [task.id, task]));
  const order = [...new Set(Array.isArray(input.order) ? input.order.map(String) : [])].filter(id => known.has(id));
  if (!order.length) fail(400, "Ordem inválida.");
  const config = await getConfig(store);
  const templates = order.map(id => known.get(id).templateId).filter(Boolean);
  const templateOrder = [...new Set([...templates, ...(config.templateOrder || [])])];
  await store.set(COLLECTIONS.config, "main", { templateOrder }, { merge: true });
  await store.set(COLLECTIONS.shifts, shiftId, { taskOrder: order, version: newVersion(now) }, { merge: true });
  return { shiftId, order };
}

/** Passagem de serviço: grava as observações e já passa as pendências para o turno seguinte. */
export async function closeShift(store, input, actor, { now = new Date() } = {}) {
  requireActor(actor);
  const shiftId = shiftIdOrFail(input.shiftId);
  await openShift(store, shiftId, now);
  const notes = text(input.notes, 4000, "as observações");

  await store.set(COLLECTIONS.shifts, shiftId, { handover: { by: actor, at: iso(now), notes }, version: newVersion(now) }, { merge: true });
  const nextId = S.next(shiftId);
  await ensureShift(store, nextId, { now });
  const transferred = await carryInto(store, nextId, { now });
  return { shiftId, nextId, transferred };
}

/** Quem assume confirma que recebeu a passagem do turno anterior. */
export async function receiveShift(store, input, actor, { now = new Date() } = {}) {
  requireActor(actor);
  const shiftId = shiftIdOrFail(input.shiftId);
  const shift = await openShift(store, shiftId, now);
  if (shift.received) return { shiftId, received: shift.received };
  const received = { by: actor, at: iso(now) };
  await store.set(COLLECTIONS.shifts, shiftId, { received, version: newVersion(now) }, { merge: true });
  return { shiftId, received };
}

/** Acompanhamento: turnos registrados entre duas datas, com as atividades; filtro opcional por assistente. */
export async function history(store, { from, to, assistantId = null } = {}) {
  if (!S.isDate(from) || !S.isDate(to) || from > to) fail(400, "Período inválido.");
  if (S.daysBetween(from, to) >= MAX_HISTORY_DAYS) fail(400, `Escolha um período de até ${MAX_HISTORY_DAYS} dias.`);
  const shifts = await store.list(COLLECTIONS.shifts, { from: S.makeId(from, "D"), to: S.makeId(to, "N") });
  const rows = await Promise.all(shifts.map(async shift => ({ ...publicShift(shift.id, shift), tasks: arrangeTasks(await store.list(tasksOf(shift.id)), shift.taskOrder) })));
  if (!assistantId) return rows;
  const involved = row => row.scheduled?.assistantId === assistantId || row.handover?.by?.id === assistantId || row.received?.by?.id === assistantId ||
    row.tasks.some(task => task.doneBy?.id === assistantId || task.createdBy?.id === assistantId || task.assignee?.id === assistantId);
  return rows.filter(involved);
}
