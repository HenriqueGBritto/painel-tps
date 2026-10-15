import assert from "node:assert/strict";
import { test } from "node:test";
import "../public/shifts.js";
import "../public/team-schedule.js";

const T = globalThis.TpsTeam;
const br = text => new Date(`${text}:00-03:00`);
const turn = date => { const r = T.rotation(date); return r ? `${r.day}+${r.night}:${r.dayOfBlock}` : null; };

test("2x2: 15–16/10/2026 = A + C, 17–18/10/2026 = B + D, e o ciclo segue", () => {
  assert.deepEqual(["2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20"].map(turn),
    ["A+C:1", "A+C:2", "B+D:1", "B+D:2", "A+C:1", "A+C:2"]);
});

test("2x2: virada de mês e de ano sem quebrar o ciclo", () => {
  assert.deepEqual(["2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"].map(turn), ["B+D:1", "B+D:2", "A+C:1", "A+C:2", "B+D:1"]);
  assert.deepEqual(["2026-12-31", "2027-01-01"].map(turn), ["A+C:2", "B+D:1"], "77 e 78 dias depois de 15/10");
});

test("2x2: começa em 01/06/2026; antes disso a escala era outra", () => {
  assert.equal(turn("2026-06-01"), "A+C:1");
  assert.equal(T.rotation("2026-05-31"), null);
  assert.deepEqual(T.groupWorks("A", "2026-05-31"), { works: null, reason: "escala anterior ao 2x2 (antes de 01/06/2026)" });
});

test("noturno pela meia-noite: 02:00 do dia 16 ainda é o plantão C que começou no dia 15", () => {
  assert.deepEqual(T.currentShift(br("2026-10-16T02:00")), { id: "2026-10-15_N", date: "2026-10-15", kind: "N" });
  assert.equal(T.rotation(T.currentShift(br("2026-10-16T02:00")).date).night, "C");
  assert.deepEqual(T.currentShift(br("2026-10-17T06:59")), { id: "2026-10-16_N", date: "2026-10-16", kind: "N" });
  assert.equal(T.rotation("2026-10-16").night, "C", "a noite de 16→17 ainda é da C (2º dia)");
  assert.deepEqual(T.currentShift(br("2026-10-17T07:00")), { id: "2026-10-17_D", date: "2026-10-17", kind: "D" });
  assert.equal(T.rotation("2026-10-17").day, "B");
});

test("intermediária: 2º dia de uma equipe e 1º da seguinte (16/10 = 1º dia, 17/10 = 2º)", () => {
  const works = date => { const r = T.groupWorks("Intermediária", date); return r.works ? r.dayOfBlock : 0; };
  assert.deepEqual(["2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21"].map(works), [0, 1, 2, 0, 0, 1, 2]);
});

test("5x2: capatazia e administrativo de segunda a sexta; a noite de sexta conta como sexta", () => {
  assert.equal(T.groupWorks("Capatazia Dia", "2026-10-16").works, true, "sexta");
  assert.equal(T.groupWorks("Capatazia Dia", "2026-10-17").works, false, "sábado");
  assert.equal(T.groupWorks("Capatazia Noite", "2026-10-16").works, true, "noite de sexta (termina no sábado 06:48)");
  assert.equal(T.groupWorks("Capatazia Noite", "2026-10-18").works, false, "noite de domingo");
  assert.equal(T.groupWorks("Administrativo", "2026-10-19").works, true);
  assert.deepEqual(T.groupWorks("Gestão", "2026-10-19"), { works: null, reason: "sem escala" });
  assert.equal(T.GROUPS["Capatazia Dia"].hours, "09:00–18:48");
});

const people = [
  { id: "1", name: "Ana A", role: "Conferente", category: "Operação", team: "A", status: "Ativo" },
  { id: "2", name: "Beto A", role: "Conferente", category: "Operação", team: "A", status: "Ativo (em transferência)" },
  { id: "3", name: "Caio A", role: "Estivador", category: "Operação", team: "A", status: "Afastado (INSS)" },
  { id: "4", name: "Duda C", role: "Conferente", category: "Operação", team: "C", status: "Ativo" },
  { id: "5", name: "Edu B", role: "Conferente", category: "Operação", team: "B", status: "Ativo" },
  { id: "6", name: "Gil", role: "Gerente", category: "Gestão", team: "Gestão", status: "Ativo" },
  { id: "7", name: "Hugo", role: "Trabalhador de Capatazia", category: "Operação", team: "Capatazia Dia", status: "Ativo" }
];
const absences = [
  { person: { id: "1", name: "Ana A" }, motive: "Férias", start: "2026-10-10", end: "2026-10-20", cover: { id: "5", name: "Edu B" }, coverStatus: "com cobertura" },
  { person: { id: "2", name: "Beto A" }, motive: "Férias", start: "2026-10-18", end: "2026-10-30", cover: null, coverStatus: "sem cobertura" },
  { person: { id: "5", name: "Edu B" }, motive: "Férias", start: "2026-10-19", end: "2026-10-25", cover: null, coverStatus: "não informada" }
];

test("de serviço: equipes do dia, ausentes com cobertura e quem está cobrindo", () => {
  const day = T.roster("2026-10-15", people, absences, { kind: "D" });
  assert.deepEqual(day.groups.map(group => group.group), ["A", "Capatazia Dia"]);
  const a = day.groups[0];
  assert.deepEqual(a.present.map(person => person.id), ["2"]);
  assert.deepEqual(a.absent.map(item => [item.person.id, item.absence.motive]), [["1", "Férias"], ["3", "Afastado (INSS)"]]);
  assert.deepEqual(day.covering.map(item => item.person.id), ["5"], "Edu (equipe B) cobre a Ana");
  const night = T.roster("2026-10-15", people, absences, { kind: "N" });
  assert.deepEqual(night.groups.map(group => [group.group, group.present.length]), [["C", 1]]);
});

test("quadro igual à aba Resumo: totais, função × equipe e números por equipe", () => {
  const summary = T.summary(people, { roles: [{ role: "Gerente", category: "Gestão" }, { role: "Conferente", category: "Operação" }, { role: "Estivador", category: "Operação" }] });
  assert.deepEqual(summary.totals, { total: 7, active: 6, inss: 1, transfer: 1 });
  const conferente = summary.categories.find(item => item.category === "Operação").roles.find(item => item.role === "Conferente");
  assert.deepEqual([conferente.columns.A, conferente.columns.B, conferente.columns.C, conferente.total], [2, 1, 1, 4]);
  assert.deepEqual(summary.teams.find(item => item.team === "A"), { team: "A", ...T.GROUPS.A, total: 3, active: 2, inss: 1, transfer: 1 });
  assert.equal(summary.grandTotal.columns["Capatazia Dia"], 1);
});

test("alertas: mesma função e equipe fora junto, sem cobertura e cobertura que também está fora", () => {
  const alerts = T.conflicts(absences, people, { from: "2026-10-01" });
  const types = alerts.map(alert => alert.type);
  assert.ok(types.includes("mesma função e equipe"), "Ana e Beto, conferentes da A, de 18 a 20/10");
  assert.ok(types.includes("cobertura também fora"), "Edu cobre a Ana mas sai de férias em 19/10");
  assert.equal(alerts.filter(alert => alert.type === "sem cobertura").length, 2);
  assert.deepEqual(alerts.find(alert => alert.type === "mesma função e equipe").period, { start: "2026-10-18", end: "2026-10-20" });
  assert.equal(T.conflicts(absences, people, { from: "2026-11-01" }).length, 0, "ausências já encerradas não geram alerta");
});

test("calendário do mês: equipe do dia e da noite e quantos estão fora", () => {
  const days = T.month(2026, 10, people, absences);
  assert.equal(days.length, 31);
  const day15 = days.find(day => day.date === "2026-10-15");
  assert.deepEqual([day15.day, day15.night, day15.dayOfBlock, day15.out], ["A", "C", 1, 1]);
  assert.equal(days.find(day => day.date === "2026-10-19").out, 3);
});
