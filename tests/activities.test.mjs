import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { memoryStore, useActivitiesStore } from "../netlify/lib/activities-store.mjs";
import { memoryAttachmentsStore, useAttachmentsStore } from "../netlify/lib/attachments-store.mjs";
import * as A from "../netlify/lib/activities.mjs";
import handler from "../netlify/functions/atividades.mjs";
import { sessionCookie } from "./auth-helper.mjs";

const br = text => new Date(`${text}:00-03:00`);
const helio = { id: "helio", name: "Hélio" };
const andres = { id: "andres", name: "Andrés" };
const roger = { id: "roger", name: "Roger" };
const tasks = (store, shiftId) => store.list(`shifts/${shiftId}/tasks`);
let store;

/* A maioria dos testes parte sem as atividades fixas iniciais, para conferir só o que cada um cria. */
const withoutDefaultTemplates = async () => { await A.getConfig(store); await Promise.all(A.DEFAULT_TEMPLATES.map(t => store.remove("taskTemplates", t.id))); };
beforeEach(async () => { store = memoryStore(); useActivitiesStore(store); A.useTeamProvider(async () => null); await withoutDefaultTemplates(); });

test("primeiro uso grava os 4 assistentes e a escala combinada", async () => {
  const settings = await A.getSettings(store, { now: br("2026-10-14T10:00") });
  assert.deepEqual(settings.assistants.map(a => a.name), ["Roger", "Hélio", "Matheus", "Andrés"]);
  assert.equal(settings.currentShiftId, "2026-10-14_D");
  const view = await A.getShiftView(store, "2026-10-14_D", { now: br("2026-10-14T10:00") });
  assert.deepEqual([view.shift.scheduled.name, view.shift.scheduled.dayOfBlock], ["Hélio", 2]);
});

test("lista do turno sai dos modelos, sem duplicar quando duas abas abrem juntas", async () => {
  const now = br("2026-10-14T20:00");
  await A.saveTemplate(store, { title: "Conferir pedidos de estiva", shift: "N", time: "23:00", remindBefore: 30 }, andres, { now });
  await A.saveTemplate(store, { title: "Relatório diurno", shift: "D" }, andres, { now });
  await Promise.all([A.ensureShift(store, "2026-10-14_N", { now }), A.ensureShift(store, "2026-10-14_N", { now })]);
  const list = await tasks(store, "2026-10-14_N");
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].title, list[0].time, list[0].dueAt, list[0].remindBefore], ["Conferir pedidos de estiva", "23:00", "2026-10-15T02:00:00.000Z", 30]);
});

test("modelo incluído com o turno já aberto entra no turno atual", async () => {
  const now = br("2026-10-14T20:00");
  await A.ensureShift(store, "2026-10-14_N", { now });
  await A.saveTemplate(store, { title: "Ronda", shift: "both", time: "02:00" }, andres, { now });
  const [task] = await tasks(store, "2026-10-14_N");
  assert.deepEqual([task.title, task.dueAt], ["Ronda", "2026-10-15T05:00:00.000Z"]);
  await A.saveTemplate(store, { id: task.templateId, title: "Ronda", shift: "D" }, andres, { now });
  assert.equal((await tasks(store, "2026-10-14_N")).length, 0, "deixou de valer para o Noturno: a pendente sai");
});

test("virada da meia-noite: sem encerramento, as pendências do Noturno passam sozinhas para o Diurno", async () => {
  const night = br("2026-10-14T23:00");
  await A.addTask(store, { shiftId: "2026-10-14_N", title: "Ligar para o agente", time: "02:00" }, andres, { now: night });
  await A.addTask(store, { shiftId: "2026-10-14_N", title: "Conferir lacres" }, andres, { now: night });
  const [first] = await tasks(store, "2026-10-14_N");
  await A.setTaskStatus(store, { shiftId: "2026-10-14_N", taskId: first.id, status: "done" }, andres, { now: br("2026-10-15T02:05") });

  const morning = br("2026-10-15T07:05");
  const view = await A.getShiftView(store, "2026-10-15_D", { now: morning });
  const carried = view.tasks.filter(task => task.origin === "carried");
  assert.equal(carried.length, 1);
  assert.deepEqual([carried[0].fromShift, carried[0].withoutHandover], ["2026-10-14_N", true]);
  assert.equal(view.previous.handover, null);
  const original = (await tasks(store, "2026-10-14_N")).find(task => task.id === carried[0].fromTaskId);
  assert.deepEqual([original.status, original.transferredTo], ["transferred", "2026-10-15_D"]);

  await A.getShiftView(store, "2026-10-15_D", { now: br("2026-10-15T08:00") });
  assert.equal((await tasks(store, "2026-10-15_D")).length, 1, "repetir não duplica");
});

test("passagem de serviço: encerrar grava observações, leva pendências e quem assume confirma", async () => {
  const night = br("2026-10-15T05:00");
  await A.addTask(store, { shiftId: "2026-10-14_N", title: "Aguardar prático", time: "06:30" }, andres, { now: night });
  const closed = await A.closeShift(store, { shiftId: "2026-10-14_N", notes: "Navio X atrasou." }, andres, { now: br("2026-10-15T06:50") });
  assert.deepEqual([closed.nextId, closed.transferred], ["2026-10-15_D", 1]);
  await assert.rejects(A.addTask(store, { shiftId: "2026-10-14_N", title: "Depois" }, andres, { now: br("2026-10-15T06:55") }), /encerrado/);

  const view = await A.getShiftView(store, "2026-10-15_D", { now: br("2026-10-15T07:02") });
  assert.equal(view.previous.handover.notes, "Navio X atrasou.");
  assert.deepEqual(view.tasks.map(task => [task.title, task.withoutHandover]), [["Aguardar prático", false]]);
  await assert.rejects(A.receiveShift(store, { shiftId: "2026-10-15_D" }, roger, { now: br("2026-10-15T06:58") }), /não começou/);
  const { received } = await A.receiveShift(store, { shiftId: "2026-10-15_D" }, roger, { now: br("2026-10-15T07:03") });
  assert.deepEqual(received, { by: roger, at: "2026-10-15T10:03:00.000Z" });
});

test("pendência atravessa vários turnos sem duplicar e mantém a origem", async () => {
  await A.addTask(store, { shiftId: "2026-10-14_D", title: "Pedir orçamento" }, helio, { now: br("2026-10-14T08:00") });
  await A.ensureShift(store, "2026-10-14_N", { now: br("2026-10-14T19:01") });
  await A.ensureShift(store, "2026-10-15_D", { now: br("2026-10-15T07:01") });
  const [task] = await tasks(store, "2026-10-15_D");
  assert.equal(task.fromShift, "2026-10-14_N");
  assert.match(task.rootId, /^2026-10-14_D~/, "a origem é o Diurno do dia 14");
});

test("situação registra quem e quando; 'não feito' exige motivo; turno futuro não pode ser marcado", async () => {
  const now = br("2026-10-14T09:00");
  const { id } = await A.addTask(store, { shiftId: "2026-10-14_D", title: "Enviar boletim", time: "10:00" }, helio, { now });
  await assert.rejects(A.setTaskStatus(store, { shiftId: "2026-10-14_D", taskId: id, status: "not_done" }, helio, { now }), /motivo/);
  await assert.rejects(A.setTaskStatus(store, { shiftId: "2026-10-14_D", taskId: id, status: "done" }, null, { now }), /Identifique-se/);
  const done = await A.setTaskStatus(store, { shiftId: "2026-10-14_D", taskId: id, status: "done" }, helio, { now: br("2026-10-14T10:02") });
  assert.deepEqual([done.doneBy, done.doneAt], [helio, "2026-10-14T13:02:00.000Z"]);
  const future = await A.addTask(store, { shiftId: "2026-10-15_D", title: "Amanhã" }, helio, { now });
  await assert.rejects(A.setTaskStatus(store, { shiftId: "2026-10-15_D", taskId: future.id, status: "done" }, helio, { now }), /não começou/);
  await assert.rejects(A.addTask(store, { shiftId: "2026-10-13_N", title: "Ontem" }, helio, { now }), /turno atual ou em turnos futuros/);
});

test("ajuste pontual muda o escalado do turno já aberto", async () => {
  const now = br("2026-10-15T07:30");
  await A.ensureShift(store, "2026-10-15_D", { now });
  await A.saveOverride(store, { shiftId: "2026-10-15_D", assistantId: "helio", reason: "Troca com Roger" }, roger, { now });
  const view = await A.getShiftView(store, "2026-10-15_D", { now });
  assert.deepEqual([view.shift.scheduled.name, view.shift.scheduled.source], ["Hélio", "ajuste"]);
});

test("acompanhamento por período e por assistente", async () => {
  await A.addTask(store, { shiftId: "2026-10-14_D", title: "A" }, helio, { now: br("2026-10-14T08:00") });
  await A.addTask(store, { shiftId: "2026-10-14_N", title: "B" }, andres, { now: br("2026-10-14T20:00") });
  const all = await A.history(store, { from: "2026-10-14", to: "2026-10-14" });
  assert.deepEqual(all.map(shift => shift.id), ["2026-10-14_D", "2026-10-14_N"]);
  const onlyAndres = await A.history(store, { from: "2026-10-14", to: "2026-10-14", assistantId: "andres" });
  assert.deepEqual(onlyAndres.map(shift => shift.id), ["2026-10-14_N"]);
  await assert.rejects(A.history(store, { from: "2026-09-01", to: "2026-10-14" }), /até 31 dias/);
});

test("API: login obrigatório, autor pelo login e versão que evita reler a lista", async () => {
  const now = () => br("2026-10-14T20:00");
  const { cookie } = await sessionCookie({ name: "Andrés", assistantId: "andres" });
  const request = (path, body, extra = {}) => new Request(`https://painel.test/api/atividades${path}`, body ? { method: "POST", body: JSON.stringify(body), headers: { origin: "https://painel.test", ...extra } } : { headers: extra });
  const call = (path, body) => handler(request(path, body, { cookie }), {}, { now });
  assert.equal((await handler(request("/status"), {}, { now })).status, 401, "sem login");
  assert.equal((await handler(request("/tarefa", { shiftId: "2026-10-14_N", title: "X" }), {}, { now })).status, 401, "sem login não grava");
  assert.deepEqual(await (await call("/status")).json(), { ok: true, storage: "memory", persistent: false });
  assert.equal((await call("/tarefa", { shiftId: "2026-10-14_N", title: "X", actor: { id: "helio", name: "Outro nome" } })).status, 200);
  const view = await (await call("/turno?id=atual")).json();
  assert.equal(view.shift.id, "2026-10-14_N");
  assert.deepEqual([view.tasks[0].createdBy.id, view.tasks[0].createdBy.name], ["andres", "Andrés"], "o autor é quem está logado, não o que veio no pedido");
  assert.deepEqual(await (await call(`/turno?id=atual&versao=${encodeURIComponent(view.shift.version)}`)).json(), { unchanged: true, version: view.shift.version });
  assert.equal((await call("/nada")).status, 404);
  const foreign = await handler(new Request("https://painel.test/api/atividades/tarefa", { method: "POST", body: "{}", headers: { origin: "https://outro.site" } }), {}, { now });
  assert.equal(foreign.status, 403);
});

test("API: sem Firestore em produção, responde 503 em vez de gravar em memória", async () => {
  const { cookie } = await sessionCookie();
  useActivitiesStore(null);
  const saved = { FIREBASE: process.env.FIREBASE_SERVICE_ACCOUNT_JSON, DEV: process.env.NETLIFY_DEV, MEM: process.env.TPS_ACTIVITIES_MEMORY };
  delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON; delete process.env.NETLIFY_DEV; delete process.env.TPS_ACTIVITIES_MEMORY;
  try {
    const response = await handler(new Request("https://painel.test/api/atividades/status", { headers: { cookie } }), {});
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /FIREBASE_SERVICE_ACCOUNT_JSON/);
  } finally {
    for (const [key, name] of [["FIREBASE", "FIREBASE_SERVICE_ACCOUNT_JSON"], ["DEV", "NETLIFY_DEV"], ["MEM", "TPS_ACTIVITIES_MEMORY"]]) if (saved[key] !== undefined) process.env[name] = saved[key];
  }
});

test("atividades fixas iniciais: cada prazo cai no turno certo", async () => {
  const fresh = memoryStore();
  useActivitiesStore(fresh);
  await A.getConfig(fresh);
  const titles = async shiftId => (await fresh.list(`shifts/${shiftId}/tasks`)).filter(task => task.origin === "template").map(task => `${task.time || "--:--"} ${task.title}`).sort();
  await A.ensureShift(fresh, "2026-10-14_N", { now: br("2026-10-14T19:05") });
  await A.ensureShift(fresh, "2026-10-15_D", { now: br("2026-10-15T07:05") });
  assert.deepEqual(await titles("2026-10-14_N"), [
    "--:-- Atualizar GEPORT", "--:-- Atualizar SOF", "--:-- Atualizar e enviar produção do navio (até 19h)", "--:-- Atualizar lineup", "--:-- Dobra de TPA",
    "03:30 Requisição de estiva · período 07x13", "05:15 Enviar DA9 · período 07x13", "20:15 Enviar DA9 · período 01x07"
  ]);
  assert.deepEqual(await titles("2026-10-15_D"), [
    "--:-- Atualizar GEPORT", "--:-- Atualizar SOF", "--:-- Atualizar e enviar produção do navio (até 07h)", "--:-- Atualizar lineup", "--:-- Dobra de TPA",
    "08:30 Pagamento de estiva para o Rogério", "09:00 Requisição de estiva · período 13x19", "11:15 Enviar DA9 · período 13x19",
    "15:30 Requisição de estiva · período 19x01", "16:00 Pedido de operadores (plano B)", "17:15 Enviar DA9 · período 19x01", "18:30 Requisição de estiva · período 01x07"
  ]);
  // Nada foi feito no Noturno: as que só existem no Noturno passam como herdadas; as que se repetem no Diurno são juntadas.
  const day = await fresh.list("shifts/2026-10-15_D/tasks");
  assert.deepEqual(day.filter(task => task.origin === "carried").map(task => task.templateId).sort(), ["da9-01x07", "da9-07x13", "estiva-07x13", "producao-noite"]);
  assert.equal(day.find(task => task.templateId === "sof").pendingFromPrevious, "2026-10-14_N");
  assert.equal(day.filter(task => task.templateId === "sof").length, 1, "sem SOF duplicado");
  const estiva = (await fresh.list("shifts/2026-10-14_N/tasks")).find(task => task.templateId === "estiva-07x13");
  assert.deepEqual([estiva.dueAt, estiva.remindBefore], ["2026-10-15T06:30:00.000Z", 30], "03:30 do Noturno do dia 14 = madrugada do dia 15, lembrete 30 min antes");
});

test("observação por atividade: grava quem e quando, pode ser apagada e acompanha a pendência", async () => {
  const now = br("2026-10-14T20:00");
  const { id } = await A.addTask(store, { shiftId: "2026-10-14_N", title: "Conferir calado" }, andres, { now });
  const saved = await A.setTaskNote(store, { shiftId: "2026-10-14_N", taskId: id, note: "Aguardando o prático" }, andres, { now });
  assert.deepEqual([saved.note, saved.noteBy, saved.noteAt], ["Aguardando o prático", andres, "2026-10-14T23:00:00.000Z"]);
  await A.ensureShift(store, "2026-10-15_D", { now: br("2026-10-15T07:01") });
  const [carried] = await tasks(store, "2026-10-15_D");
  assert.equal(carried.note, "Aguardando o prático", "a observação vai junto para o turno seguinte");
  const cleared = await A.setTaskNote(store, { shiftId: "2026-10-15_D", taskId: carried.id, note: "  " }, roger, { now: br("2026-10-15T08:00") });
  assert.deepEqual([cleared.note, cleared.noteBy], ["", null]);
  await assert.rejects(A.setTaskNote(store, { shiftId: "2026-10-14_N", taskId: id, note: "x" }, andres, { now: br("2026-10-15T08:00") }), /já passou para o turno seguinte|encerrado/);
});

test("responsável: modelo com pessoa fixa, atribuição manual e volta ao escalado", async () => {
  const now = br("2026-10-14T08:00");
  await A.saveTemplate(store, { title: "Pagamento de estiva", shift: "D", time: "08:30", assigneeId: "roger" }, helio, { now });
  await A.ensureShift(store, "2026-10-14_D", { now });
  const [task] = await tasks(store, "2026-10-14_D");
  assert.deepEqual(task.assignee, { id: "roger", name: "Roger" }, "Roger é o responsável fixo, mesmo de folga hoje");
  const assigned = await A.assignTask(store, { shiftId: "2026-10-14_D", taskId: task.id, assigneeId: "helio" }, roger, { now });
  assert.deepEqual([assigned.assignee, assigned.assignedBy], [{ id: "helio", name: "Hélio" }, roger]);
  await A.saveTemplate(store, { id: task.templateId, title: "Pagamento de estiva (grupo)", shift: "D", time: "08:30", assigneeId: "roger" }, helio, { now });
  const [edited] = await tasks(store, "2026-10-14_D");
  assert.deepEqual([edited.title, edited.assignee.id], ["Pagamento de estiva (grupo)", "helio"], "editar o modelo não desfaz a atribuição manual");
  const back = await A.assignTask(store, { shiftId: "2026-10-14_D", taskId: task.id, assigneeId: "" }, helio, { now });
  assert.equal(back.assignee, null, "vazio = escalado do turno");
  await assert.rejects(A.assignTask(store, { shiftId: "2026-10-14_D", taskId: task.id, assigneeId: "ninguem" }, helio, { now }), /Responsável inválido/);
  const future = await A.addTask(store, { shiftId: "2026-10-15_D", title: "Amanhã", assigneeId: "matheus" }, helio, { now });
  const [planned] = (await tasks(store, "2026-10-15_D")).filter(item => item.id === future.id);
  assert.equal(planned.assignee.name, "Matheus", "atribuição já na inclusão, em turno futuro");
});

test("API: observação e responsável passam pelas rotas novas", async () => {
  const now = () => br("2026-10-14T20:00");
  const { cookie } = await sessionCookie({ name: "Andrés", assistantId: "andres" });
  const call = (path, body) => handler(new Request(`https://painel.test/api/atividades${path}`, { method: "POST", body: JSON.stringify(body), headers: { origin: "https://painel.test", cookie } }), {}, { now });
  const { id } = await (await call("/tarefa", { shiftId: "2026-10-14_N", title: "X", actor: andres })).json();
  assert.equal((await call("/tarefa/observacao", { shiftId: "2026-10-14_N", taskId: id, note: "ok", actor: andres })).status, 200);
  assert.equal((await call("/tarefa/responsavel", { shiftId: "2026-10-14_N", taskId: id, assigneeId: "matheus", actor: andres })).status, 200);
  const [task] = await tasks(store, "2026-10-14_N");
  assert.deepEqual([task.note, task.assignee.id], ["ok", "matheus"]);
});

test("anexos na observação: envio, leitura, atividade herdada leva o anexo e recusas", async () => {
  const files = memoryAttachmentsStore();
  const now = br("2026-10-14T18:30");
  const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  const photo = await A.uploadAttachment(store, files, { shiftId: "2026-10-14_D", name: "lacre/vagão.png", type: "image/png", bytes: png }, helio, { now });
  assert.deepEqual([photo.name, photo.kind, photo.size, photo.by], ["lacre_vagão.png", "imagem", 7, helio], "barra no nome vira _");
  const read = await A.readAttachment(files, { shiftId: "2026-10-14_D", id: photo.id });
  assert.deepEqual(new Uint8Array(read.data), png);
  await assert.rejects(A.uploadAttachment(store, files, { shiftId: "2026-10-14_D", name: "x.exe", type: "application/x-msdownload", bytes: png }, helio, { now }), /Tipo de arquivo não aceito/);
  await assert.rejects(A.uploadAttachment(store, files, { shiftId: "2026-10-14_D", name: "grande.pdf", type: "application/pdf", bytes: new Uint8Array(6 * 1024 * 1024) }, helio, { now }), /grande demais/);
  const { id: taskId } = await A.addTask(store, { shiftId: "2026-10-14_D", title: "Conferir lacres" }, helio, { now });
  await assert.rejects(A.setTaskNote(store, { shiftId: "2026-10-14_D", taskId, note: "x", attachments: [{ id: "0123456789abcdef", shift: "2026-10-14_D" }] }, helio, { now, files }), /não foi encontrado/);
  const saved = await A.setTaskNote(store, { shiftId: "2026-10-14_D", taskId, note: "", attachments: [{ id: photo.id }] }, helio, { now, files });
  assert.deepEqual(saved.attachments, [{ id: photo.id, shift: "2026-10-14_D", name: "lacre_vagão.png", type: "image/png", kind: "imagem", size: 7 }]);
  assert.deepEqual(saved.noteBy, helio, "só anexo, sem texto, também conta como observação");
  await A.closeShift(store, { shiftId: "2026-10-14_D", notes: "Lacres pendentes." }, helio, { now });
  const view = await A.getShiftView(store, "2026-10-14_N", { now: br("2026-10-14T19:05") });
  const carried = view.tasks.find(task => task.origin === "carried");
  assert.equal(carried.attachments[0].shift, "2026-10-14_D", "o anexo vai junto e continua apontando para o turno onde foi enviado");
  const later = await A.uploadAttachment(store, files, { shiftId: "2026-10-14_N", name: "nova.png", type: "image/png", bytes: png }, andres, { now: br("2026-10-14T20:00") });
  const both = await A.setTaskNote(store, { shiftId: "2026-10-14_N", taskId: carried.id, note: "Mais uma foto", attachments: [...carried.attachments, { id: later.id }] }, andres, { now: br("2026-10-14T20:01"), files });
  assert.deepEqual(both.attachments.map(file => file.shift), ["2026-10-14_D", "2026-10-14_N"]);
  await assert.rejects(A.uploadAttachment(store, files, { shiftId: "2026-10-14_D", name: "depois.png", type: "image/png", bytes: png }, helio, { now }), /encerrado/);
  await assert.rejects(A.readAttachment(files, { shiftId: "2026-10-14_D", id: "../../x" }), /Anexo inválido/);
});

test("ordem arrastada vale para o turno e ensina a ordem das fixas aos turnos seguintes", async () => {
  const now = br("2026-10-14T08:00");
  for (const [title, time] of [["SOF", null], ["Estiva", "09:00"], ["DA9", "11:15"]]) await A.saveTemplate(store, { title, shift: "both", time }, helio, { now });
  const { id: extra } = await A.addTask(store, { shiftId: "2026-10-14_D", title: "Ligar agente", time: "10:00" }, helio, { now });
  const before = (await A.getShiftView(store, "2026-10-14_D", { now })).tasks.map(task => task.title);
  assert.deepEqual(before, ["Estiva", "Ligar agente", "DA9", "SOF"], "sem ordem própria: por horário");
  const ids = Object.fromEntries((await tasks(store, "2026-10-14_D")).map(task => [task.title, task.id]));
  await A.reorderTasks(store, { shiftId: "2026-10-14_D", order: [ids.DA9, ids.SOF, extra, ids.Estiva, "inexistente"] }, helio, { now });
  assert.deepEqual((await A.getShiftView(store, "2026-10-14_D", { now })).tasks.map(task => task.title), ["DA9", "SOF", "Ligar agente", "Estiva"]);
  const night = await A.getShiftView(store, "2026-10-14_N", { now: br("2026-10-14T19:05") });
  assert.deepEqual(night.tasks.filter(task => task.origin === "template").map(task => task.title), ["DA9", "SOF", "Estiva"], "o Noturno já nasce na ordem aprendida");
  await assert.rejects(A.reorderTasks(store, { shiftId: "2026-10-14_N", order: ["nada"] }, helio, { now }), /Ordem inválida/);
});

test("ordem: atividade nova entra no fim da ordem arrastada", () => {
  const list = [{ id: "a", title: "A", dueAt: "2026-10-14T12:00:00Z" }, { id: "b", title: "B" }, { id: "c", title: "C", dueAt: "2026-10-14T11:00:00Z" }];
  assert.deepEqual(A.arrangeTasks(list, ["b", "a"]).map(task => task.id), ["b", "a", "c"]);
  assert.deepEqual(A.arrangeTasks(list).map(task => task.id), ["c", "a", "b"]);
});

test("API: anexo enviado como arquivo e lido de volta", async () => {
  useAttachmentsStore(memoryAttachmentsStore());
  try {
    const now = () => br("2026-10-14T10:00");
    const { cookie } = await sessionCookie({ name: "Hélio", assistantId: "helio" });
    const upload = await handler(new Request("https://painel.test/api/atividades/anexo?turno=2026-10-14_D", {
      method: "POST", body: new Uint8Array([37, 80, 68, 70]),
      headers: { origin: "https://painel.test", "content-type": "application/pdf", "x-arquivo": encodeURIComponent("Relatório.pdf"), cookie }
    }), {}, { now });
    const meta = await upload.json();
    assert.equal(upload.status, 200, JSON.stringify(meta));
    assert.deepEqual([meta.name, meta.by.id, meta.by.name], ["Relatório.pdf", "helio", "Hélio"]);
    const file = await handler(new Request(`https://painel.test/api/atividades/anexo?turno=2026-10-14_D&id=${meta.id}&baixar=1`, { headers: { cookie } }), {}, { now });
    assert.equal(file.headers.get("content-type"), "application/pdf");
    assert.match(file.headers.get("content-disposition"), /^attachment; filename\*=UTF-8''Relat%C3%B3rio\.pdf$/);
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), new Uint8Array([37, 80, 68, 70]));
  } finally {
    useAttachmentsStore(null);
  }
});

test("escala noturna invertida da primeira versão é corrigida uma vez (Andrés = C em 15–16/10)", async () => {
  const fresh = memoryStore();
  await fresh.set("shiftConfig", "main", { hours: { dayStart: "07:00", nightStart: "19:00" }, rotations: { D: A.DEFAULT_CONFIG.rotations.D, N: { members: ["andres", "matheus"], blockDays: 2, referenceDate: "2026-10-13" } } });
  const fixed = await A.getConfig(fresh);
  assert.deepEqual(fixed.rotations.N, { members: ["andres", "matheus"], blockDays: 2, referenceDate: "2026-10-15" });
  assert.ok(fixed.fixedNightRotationAt);
  const edited = memoryStore();
  await edited.set("shiftConfig", "main", { hours: { dayStart: "07:00", nightStart: "19:00" }, rotations: { D: A.DEFAULT_CONFIG.rotations.D, N: { members: ["andres", "matheus"], blockDays: 2, referenceDate: "2026-10-13" } }, updatedBy: { name: "Gestão" } });
  assert.equal((await A.getConfig(edited)).rotations.N.referenceDate, "2026-10-13", "escala alterada pela tela não é mexida");
});

/* Planilha da equipe de exemplo: um assistente por equipe (matrículas dos assistentes iniciais). */
const teamSheet = (absences = []) => ({
  people: [
    { id: "9019", name: "Roger da Silva", team: "A", role: "Assistente de Operações", status: "Ativo" },
    { id: "7343", name: "Hélio Marques", team: "B", role: "Assistente de Operações", status: "Ativo" },
    { id: "7144", name: "Andrés Esteves", team: "C", role: "Assistente de Operações", status: "Ativo" },
    { id: "8940", name: "Matheus Silva", team: "D", role: "Assistente de Operações", status: "Ativo" }
  ],
  absences
});

test("escala pela aba Equipe: assistente da equipe de plantão no dia e na noite", async () => {
  A.useTeamProvider(async () => teamSheet());
  const now = br("2026-10-19T08:00");
  const day = await A.getShiftView(store, "2026-10-19_D", { now });
  assert.deepEqual([day.shift.scheduled.name, day.shift.scheduled.team, day.shift.scheduled.dayOfBlock, day.shift.scheduled.source], ["Roger", "A", 1, "equipe"], "19/10 = A + C (1º dia)");
  const night = await A.getShiftView(store, "2026-10-21_N", { now });
  assert.deepEqual([night.shift.scheduled.name, night.shift.scheduled.team], ["Matheus", "D"], "21/10 = B + D");
  const settings = await A.getSettings(store, { now });
  assert.deepEqual(settings.preview[0].N.name, "Andrés");
  assert.deepEqual(settings.assistants.find(item => item.id === "helio").linked, { name: "Hélio Marques", team: "B", role: "Assistente de Operações", status: "Ativo" });
});

test("escala pela aba Equipe: de férias entra quem cobre; sem cobertura, fica marcado como fora", async () => {
  const absences = [
    { person: { id: "9019", name: "Roger" }, motive: "Férias", start: "2026-10-19", end: "2026-10-28", cover: { id: "7343", name: "Hélio" }, coverStatus: "com cobertura" },
    { person: { id: "7144", name: "Andrés" }, motive: "Férias", start: "2026-10-19", end: "2026-10-28", cover: null, coverStatus: "sem cobertura" }
  ];
  A.useTeamProvider(async () => teamSheet(absences));
  const now = br("2026-10-19T08:00");
  const day = (await A.getShiftView(store, "2026-10-19_D", { now })).shift.scheduled;
  assert.deepEqual([day.name, day.source, day.reason], ["Hélio", "cobertura", "cobre Roger (férias até 28/10)"]);
  const night = (await A.getShiftView(store, "2026-10-19_N", { now })).shift.scheduled;
  assert.deepEqual([night.name, night.absent, night.reason], ["Andrés", true, "Andrés está fora (férias até 28/10); sem cobertura registrada"]);
});

test("escala pela aba Equipe: ajuste pontual vale mais; antes do 2x2 ou sem planilha, vale o rodízio", async () => {
  A.useTeamProvider(async () => teamSheet());
  const now = br("2026-10-19T08:00");
  await A.saveOverride(store, { shiftId: "2026-10-19_D", assistantId: "matheus", reason: "Troca" }, roger, { now });
  assert.deepEqual([(await A.getShiftView(store, "2026-10-19_D", { now })).shift.scheduled.name, (await A.getShiftView(store, "2026-10-19_D", { now })).shift.scheduled.source], ["Matheus", "ajuste"]);
  const settings = await A.getSettings(store, { now: br("2026-05-20T08:00") });
  assert.equal(settings.preview[0].D.source, "escala", "maio/2026: antes do 2x2, rodízio de reserva");
  A.useTeamProvider(async () => { throw new Error("planilha fora"); });
  assert.equal((await A.getSettings(store, { now })).preview[1].D.source, "escala", "planilha indisponível: rodízio de reserva");
});

test("escala pela aba Equipe: a virada agendada atualiza turnos já criados quando a planilha muda", async () => {
  A.useTeamProvider(async () => teamSheet());
  const now = br("2026-10-19T08:00");
  await A.ensureShift(store, "2026-10-19_D", { now });
  A.useTeamProvider(async () => teamSheet([{ person: { id: "9019", name: "Roger" }, motive: "Férias", start: "2026-10-19", end: "2026-10-20", cover: { id: "7343", name: "Hélio" }, coverStatus: "com cobertura" }]));
  await A.refreshScheduled(store, "2026-10-19_D", now);
  assert.equal((await A.getShiftView(store, "2026-10-19_D", { now })).shift.scheduled.name, "Hélio");
});

test("assistente: matrícula do Cadastro é gravada e validada", async () => {
  const now = br("2026-10-19T08:00");
  await A.saveAssistant(store, { id: "roger", name: "Roger", matricula: "9019" }, roger, { now });
  assert.equal((await store.get("shiftAssistants", "roger")).matricula, "9019");
  await assert.rejects(A.saveAssistant(store, { id: "roger", name: "Roger", matricula: "90-19" }, roger, { now }), /Matrícula inválida/);
});
