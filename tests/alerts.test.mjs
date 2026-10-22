import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryStore } from "../netlify/lib/activities-store.mjs";
import * as A from "../netlify/lib/activities.mjs";
import { operationsAlerts, dischargeAlerts, activityAlerts, alertsFor } from "../netlify/lib/alerts.mjs";

const br = text => new Date(`${text}:00-03:00`);
const ids = list => list.map(alert => alert.id);

test("planilha de navios: reserva é crítico; sem alteração há mais de 24 h é atenção", () => {
  const now = br("2026-10-22T12:00");
  assert.equal(operationsAlerts({ origin: "fallback" }, now)[0].level, "critical");
  assert.deepEqual(operationsAlerts({ changeLog: [{ at: br("2026-10-22T06:00").toISOString() }] }, now), [], "mudou há 6 h");
  const quiet = operationsAlerts({ changeLog: [{ at: br("2026-10-20T06:00").toISOString() }] }, now);
  assert.deepEqual([quiet[0].id, quiet[0].title], ["navios-parada", "Planilha de navios sem alteração há 2 dias"]);
  assert.match(quiet[0].detail, /20\/10 às 06:00/);
  assert.deepEqual(operationsAlerts({ changeLog: [] }, now), [], "sem histórico ainda, não acusa");
});

test("descarga: parada há mais de 2 dias e previsão do mês abaixo do plano", () => {
  const days = Array.from({ length: 18 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, "0")}`, tons: 6000 }));
  const data = { dischargeDays: days, plans: [{ year: 2026, month: 10, plan: 230000 }] };
  const alerts = dischargeAlerts(data, br("2026-10-22T10:00"));
  assert.deepEqual(ids(alerts), ["descarga-parada", "descarga-ritmo-2026-10"]);
  assert.equal(alerts[0].title, "Sem descarga registrada desde 18/10");
  // 108.000 t em 18 dias = 6.000 t/dia → 186.000 t no mês = 81% do plano.
  assert.match(alerts[1].detail, /6\.000 t\/dia.*186\.000 t, 81% do plano de 230\.000 t/);
  assert.equal(alerts[1].level, "warning");
  assert.deepEqual(ids(dischargeAlerts({ ...data, plans: [{ year: 2026, month: 10, plan: 150000 }] }, br("2026-10-19T10:00"))), [], "no ritmo e descarga em dia");
  assert.equal(dischargeAlerts({ origin: "fallback" })[0].level, "critical");
});

test("atividades: atrasadas no turno atual e passagem não recebida depois de 30 minutos", async () => {
  const store = memoryStore();
  A.useTeamProvider(async () => null);
  await A.ensureShift(store, "2026-10-22_D", { now: br("2026-10-22T07:05") });
  assert.deepEqual(await activityAlerts(store, br("2026-10-22T07:20")), [], "começou há 20 minutos, nada atrasado ainda");
  const late = await activityAlerts(store, br("2026-10-22T12:00"));
  assert.ok(late.some(alert => alert.title === "3 atividades atrasadas no Diurno · 22/10/2026"), JSON.stringify(late));
  assert.ok(late.some(alert => alert.id === "turno-nao-recebido-2026-10-22_D"));
  await A.receiveShift(store, { shiftId: "2026-10-22_D" }, { id: "helio", name: "Hélio" }, { now: br("2026-10-22T12:01") });
  assert.ok(!(await activityAlerts(store, br("2026-10-22T12:02"))).some(alert => alert.id.startsWith("turno-nao-recebido")));
  assert.deepEqual(await activityAlerts(store, br("2026-10-23T12:00")), [], "turno que ninguém abriu não gera alerta (nem é criado)");
  assert.equal(await store.get(A.COLLECTIONS.shifts, "2026-10-23_D"), null);
});

test("cada pessoa recebe só os alertas das telas dela; uma fonte com erro não derruba as outras", async () => {
  const now = br("2026-10-22T12:00");
  const sources = {
    now, store: null,
    readOperations: async () => ({ origin: "fallback" }),
    readDischarge: async () => { throw new Error("Blobs fora do ar"); }
  };
  const quiet = console.error; console.error = () => {};
  try {
    assert.deepEqual(ids(await alertsFor({ permissions: ["lineup"] }, sources)), ["navios-reserva"]);
    assert.deepEqual(ids(await alertsFor({ permissions: ["indicadores"] }, sources)), ["navios-reserva"]);
    assert.deepEqual(await alertsFor({ permissions: ["producao", "equipe"] }, sources), []);
  } finally { console.error = quiet; }
});
