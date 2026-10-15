import assert from "node:assert/strict";
import { test } from "node:test";
import "../public/shifts.js";
import { DEFAULT_CONFIG } from "../netlify/lib/activities.mjs";

const S = globalThis.TpsShifts;
/** Horário de Brasília (UTC-3) para instante. */
const br = text => new Date(`${text}:00-03:00`);

test("turno: o Noturno atravessa a meia-noite e pertence à data em que começou", () => {
  assert.equal(S.shiftIdAt(br("2026-10-14T19:00")), "2026-10-14_N");
  assert.equal(S.shiftIdAt(br("2026-10-14T23:59")), "2026-10-14_N");
  assert.equal(S.shiftIdAt(br("2026-10-15T00:00")), "2026-10-14_N", "meia-noite ainda é o Noturno do dia 14");
  assert.equal(S.shiftIdAt(br("2026-10-15T02:00")), "2026-10-14_N");
  assert.equal(S.shiftIdAt(br("2026-10-15T06:59")), "2026-10-14_N");
  assert.equal(S.shiftIdAt(br("2026-10-15T07:00")), "2026-10-15_D", "07:00 em ponto já é o Diurno");
  assert.equal(S.shiftIdAt(br("2026-10-15T18:59")), "2026-10-15_D");
  assert.equal(S.shiftIdAt(br("2026-12-31T23:30")), "2026-12-31_N", "virada de ano");
  assert.equal(S.shiftIdAt(br("2027-01-01T03:00")), "2026-12-31_N");
});

test("turno: o resultado não depende do fuso da máquina", () => {
  const original = process.env.TZ;
  try {
    process.env.TZ = "Asia/Tokyo";
    assert.equal(S.shiftIdAt(br("2026-10-15T02:00")), "2026-10-14_N");
    assert.equal(S.dueAt("2026-10-14_N", "02:00").toISOString(), "2026-10-15T05:00:00.000Z");
  } finally {
    process.env.TZ = original;
  }
});

test("turno: início, fim, anterior e seguinte", () => {
  const night = S.bounds("2026-10-14_N");
  assert.deepEqual([night.start.toISOString(), night.end.toISOString()], ["2026-10-14T22:00:00.000Z", "2026-10-15T10:00:00.000Z"]);
  const day = S.bounds("2026-10-15_D");
  assert.deepEqual([day.start.toISOString(), day.end.toISOString()], ["2026-10-15T10:00:00.000Z", "2026-10-15T22:00:00.000Z"]);
  assert.equal(S.next("2026-10-14_N"), "2026-10-15_D");
  assert.equal(S.next("2026-10-15_D"), "2026-10-15_N");
  assert.equal(S.previous("2026-10-15_D"), "2026-10-14_N");
  assert.equal(S.previous("2026-03-01_D"), "2026-02-28_N");
  assert.deepEqual(S.range("2026-10-14", "2026-10-15"), ["2026-10-14_D", "2026-10-14_N", "2026-10-15_D", "2026-10-15_N"]);
  assert.equal(S.label("2026-10-14_N"), "Noturno · 14/10 → 15/10/2026");
});

test("turno: horário da atividade no Noturno depois da meia-noite cai no dia seguinte", () => {
  assert.equal(S.dueAt("2026-10-14_N", "23:00").toISOString(), "2026-10-15T02:00:00.000Z");
  assert.equal(S.dueAt("2026-10-14_N", "02:00").toISOString(), "2026-10-15T05:00:00.000Z");
  assert.equal(S.dueAt("2026-10-14_D", "08:30").toISOString(), "2026-10-14T11:30:00.000Z");
  assert.equal(S.dueAt("2026-10-14_D", null), null);
  assert.equal(S.shiftIdAt(S.dueAt("2026-10-14_N", "02:00")), "2026-10-14_N", "o horário calculado cai dentro do próprio turno");
});

test("escala 2x2: rodízio do Diurno e do Noturno a partir da referência, para frente e para trás", () => {
  const who = (date, kind) => { const slot = S.scheduledFor(S.makeId(date, kind), DEFAULT_CONFIG); return `${slot.assistantId}:${slot.dayOfBlock}`; };
  // Referência combinada: em 14/10/2026 Hélio (Diurno) e Andrés (Noturno) fazem o 2º dia.
  assert.equal(who("2026-10-14", "D"), "helio:2");
  assert.equal(who("2026-10-14", "N"), "andres:2");
  assert.deepEqual(["2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19"].map(date => who(date, "D")), ["roger:1", "roger:2", "helio:1", "helio:2", "roger:1"]);
  assert.deepEqual(["2026-10-15", "2026-10-16", "2026-10-17"].map(date => who(date, "N")), ["matheus:1", "matheus:2", "andres:1"]);
  assert.deepEqual(["2026-10-12", "2026-10-11", "2026-10-10"].map(date => who(date, "D")), ["roger:2", "roger:1", "helio:2"], "datas antes da referência");
  assert.equal(who("2027-10-14", "D"), "roger:1", "um ano depois o ciclo continua (365 dias = 91 ciclos + 1)");
});

test("escala 2x2: quem trabalha às 02:00 é o escalado do Noturno que começou no dia anterior", () => {
  const shiftId = S.shiftIdAt(br("2026-10-15T02:00"));
  assert.equal(S.scheduledFor(shiftId, DEFAULT_CONFIG).assistantId, "andres");
});

test("escala 2x2: ajuste pontual tem prioridade sobre o rodízio", () => {
  const overrides = { "2026-10-15_D": { assistantId: "helio", reason: "Troca com Roger" } };
  assert.deepEqual(S.scheduledFor("2026-10-15_D", DEFAULT_CONFIG, overrides), { assistantId: "helio", source: "ajuste", reason: "Troca com Roger", dayOfBlock: null });
  assert.equal(S.scheduledFor("2026-10-15_N", DEFAULT_CONFIG, overrides).assistantId, "matheus", "o ajuste vale só para aquele turno");
  assert.equal(S.scheduledFor("2026-10-15_D", { rotations: {} }).source, "sem escala");
});

test("modelos: turno e dias da semana pela data de início do turno", () => {
  const weekdaysOnly = { shift: "N", weekdays: [1, 2, 3, 4, 5] };
  assert.equal(S.templateApplies(weekdaysOnly, "2026-10-16_N"), true, "sexta à noite vale, mesmo terminando no sábado");
  assert.equal(S.templateApplies(weekdaysOnly, "2026-10-17_N"), false, "sábado");
  assert.equal(S.templateApplies(weekdaysOnly, "2026-10-16_D"), false, "outro turno");
  assert.equal(S.templateApplies({ shift: "both", weekdays: [] }, "2026-10-18_D"), true);
  assert.equal(S.templateApplies({ shift: "both", weekdays: [], active: false }, "2026-10-18_D"), false);
});

test("alertas: no horário e, se pedido, minutos antes", () => {
  const task = { dueAt: "2026-10-15T02:00:00.000Z", remindBefore: 30 };
  assert.deepEqual(S.alertTimes(task).map(alert => [alert.kind, new Date(alert.at).toISOString()]), [["antes", "2026-10-15T01:30:00.000Z"], ["horario", "2026-10-15T02:00:00.000Z"]]);
  assert.equal(S.alertTimes({ ...task, remindBefore: 0 }).length, 1);
  assert.deepEqual(S.alertTimes({ dueAt: null }), []);
});
