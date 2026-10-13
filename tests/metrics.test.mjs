process.env.TZ = "America/Sao_Paulo";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { normalizeOperations, operationsLastRecord, dischargeLastRecord } from "../netlify/functions/api.mjs";
import "../public/metrics.js";

const M = globalThis.TpsMetrics;
const seed = name => JSON.parse(readFileSync(new URL(`../netlify/lib/initial-${name}.json`, import.meta.url), "utf8"));
const operations = normalizeOperations(seed("operations"));
const records = operations.records;
const set = (...values) => new Set(values);

/* Roda a cópia literal dos cálculos antigos de app.js com o mesmo filtro. */
function legacy(years, months) {
  const context = { state: { records, years, months }, Date, Math, Set, Array, Number };
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL("./fixtures/legacy-app-kpis.js", import.meta.url), "utf8"), context);
  return { ...context.legacyKpis() };
}

const filters = [
  ["todos os anos", set(), set()],
  ["2025", set(2025), set()],
  ["2026", set(2026), set()],
  ["mar/2025", set(2025), set(3)],
  ["set/2026", set(2026), set(9)],
  ["jan+fev de 2026", set(2026), set(1, 2)],
  ["março de todos os anos", set(), set(3)],
  ["2024 e 2025", set(2024, 2025), set()]
];

test("KPIs extraídos para metrics.js dão exatamente o mesmo resultado de app.js", () => {
  for (const [label, years, months] of filters) {
    assert.deepEqual(M.kpis(records, years, months), legacy(years, months), label);
  }
});

test("KPIs da base embutida (valores de referência)", () => {
  const all = M.kpis(records, set(), set());
  assert.equal(all.vessels, records.length);
  assert.ok(all.vessels > 300);
  const y2025 = M.kpis(records, set(2025), set());
  const sum2025 = records.filter(r => r.year === 2025).reduce((s, r) => s + r.tons, 0);
  assert.equal(y2025.tons, sum2025);
  const withProd = records.filter(r => r.year === 2025 && r.productivity > 0);
  assert.equal(y2025.productivity, withProd.reduce((s, r) => s + r.productivity, 0) / withProd.length);
  assert.ok(y2025.occupancy > 0 && y2025.occupancy <= 100);
});

test("ocupação: um berço ocupado metade do mês dá 50%", () => {
  const rows = [{ year: 2025, month: 4, berth: "B1", berthStart: new Date(2025, 3, 1).toISOString(), berthEnd: new Date(2025, 3, 16).toISOString(), tons: 1, productivity: 1 }];
  assert.equal(M.occupancy(rows, set(2025), set(4)), 50);
  const overlapping = [...rows, { ...rows[0], berthStart: new Date(2025, 3, 10).toISOString() }];
  assert.equal(M.occupancy(overlapping, set(2025), set(4)), 50, "intervalos sobrepostos não contam duas vezes");
});

test("período anterior: mês → mês anterior, ano → ano anterior, todos os anos → sem comparação", () => {
  const done = new Date(2026, 11, 31, 12);
  assert.equal(M.previousPeriod(set(), set(), done), null);
  assert.equal(M.previousPeriod(set(2024, 2025), set(), done), null);
  assert.equal(M.previousPeriod(set(), set(3), done), null);
  const sep = M.previousPeriod(set(2026), set(10), done);
  assert.deepEqual([[...sep.years], [...sep.months], sep.label, sep.inProgress], [[2026], [9], "set/2026", false]);
  const dec = M.previousPeriod(set(2026), set(1), done);
  assert.deepEqual([[...dec.years], [...dec.months], dec.label], [[2025], [12], "dez/2025"]);
  const year = M.previousPeriod(set(2025), set(), done);
  assert.deepEqual([[...year.years], [...year.months], year.label], [[2024], [], "2024"]);
  const months = M.previousPeriod(set(2026), set(2, 1), done);
  assert.deepEqual([[...months.years], [...months.months], months.label], [[2025], [1, 2], "mesmos meses de 2025"]);
});

test("período em andamento é comparado até o mesmo ponto do anterior", () => {
  const now = new Date(2026, 9, 13, 15);
  const month = M.previousPeriod(set(2026), set(10), now);
  assert.equal(month.inProgress, true);
  assert.equal(month.label, "set/2026 até dia 13");
  assert.equal(M.isoDay(month.cutoff), "2026-09-13");
  const year = M.previousPeriod(set(2026), set(), now);
  assert.equal(year.label, "2025 até 13/out");
  assert.equal(M.isoDay(year.cutoff), "2025-10-13");
  const endOfMonth = M.previousPeriod(set(2026), set(3), new Date(2026, 2, 31, 10));
  assert.equal(M.isoDay(endOfMonth.cutoff), "2026-02-28", "31/mar vira 28/fev");
  const rows = [
    { year: 2026, month: 9, operationStart: new Date(2026, 8, 5).toISOString(), tons: 100, productivity: 10, berth: "B1" },
    { year: 2026, month: 9, operationStart: new Date(2026, 8, 20).toISOString(), tons: 300, productivity: 30, berth: "B1" }
  ];
  assert.equal(M.previousKpis(rows, month).tons, 100, "navio de 20/set fica fora do recorte até dia 13");
  assert.equal(M.previousKpis(rows, M.previousPeriod(set(2026), set(10), new Date(2026, 11, 1))).tons, 400);
});

test("variação percentual e sentido", () => {
  assert.deepEqual(M.variation(108.2, 100), { pct: 8.200000000000003, direction: "up" });
  assert.equal(M.variation(90, 100).direction, "down");
  assert.equal(M.variation(100.01, 100).direction, "flat");
  assert.equal(M.variation(10, 0), null);
  assert.equal(M.variation(NaN, 10), null);
  assert.equal(M.kpiVariation("productivity", { productivity: 0 }, { productivity: 3000 }), null, "mês sem navio não tem prancha");
  assert.equal(M.kpiVariation("vessels", { vessels: 0 }, { vessels: 3 }).direction, "down");
});

test("selo: em dia, em alerta depois de 7 dias e crítico na reserva", () => {
  const now = new Date("2026-10-13T17:32:00Z");
  const ok = M.freshness({ origin: "google-sheets", lastRecordAt: "2026-10-12", generatedAt: "2026-10-13T17:32:00Z" }, now);
  assert.deepEqual([ok.level, ok.text, ok.ageDays], ["ok", "Dados até 12/10/2026 · lidos às 14:32", 1]);
  assert.equal(M.freshness({ origin: "google-sheets", lastRecordAt: "2026-10-06" }, now).level, "ok", "7 dias ainda está em dia");
  const old = M.freshness({ origin: "google-sheets", lastRecordAt: "2026-10-05T02:00:00.000Z" }, now);
  assert.deepEqual([old.level, old.ageDays, old.text], ["warning", 9, "Dados até 04/10/2026"], "horário em UTC vira o dia de Brasília");
  const reserve = M.freshness({ origin: "fallback", lastRecordAt: "2026-10-12" }, now);
  assert.deepEqual([reserve.level, reserve.text], ["critical", "Exibindo base de reserva, dados podem estar desatualizados"]);
  assert.equal(M.STALE_DAYS, 7);
});

test("descarga: 7 dias que terminam na última descarga registrada", () => {
  const days = [{ date: "2026-09-28" }, { date: "2026-10-12" }, { date: "2026-10-01" }];
  assert.deepEqual(M.lastDischargeWindow(days), { start: "2026-10-06", end: "2026-10-12", hasData: true });
  assert.deepEqual(M.lastDischargeWindow([], 7, "2026-10-13"), { start: "2026-10-07", end: "2026-10-13", hasData: false });
  assert.deepEqual(M.lastDischargeWindow([{ date: "2026-03-02" }]), { start: "2026-02-24", end: "2026-03-02", hasData: true }, "atravessa o mês");
});

test("API informa a data do último registro de cada base", () => {
  const last = operationsLastRecord(operations, Date.parse("2026-12-31T00:00:00Z"));
  const expected = Math.max(...[...records, ...operations.activeRecords].flatMap(r => [r.berthStart, r.operationStart]).map(v => Date.parse(v || "")).filter(Number.isFinite));
  assert.equal(last, new Date(expected).toISOString());
  assert.equal(operationsLastRecord({ records: [{ berthStart: "2030-01-01T00:00:00Z" }, { berthStart: "2026-10-01T10:00:00Z" }] }, Date.parse("2026-10-13T00:00:00Z")), "2026-10-01T10:00:00.000Z", "data futura é ignorada");
  assert.equal(dischargeLastRecord(seed("discharge")), seed("discharge").dischargeDays.map(d => d.date).sort().at(-1));
  assert.equal(dischargeLastRecord({}), null);
});

test("ranking de cargas: ordem, participação e cargas sem volume fora", () => {
  const rows = [{ cargo: "GUSA", tons: 300 }, { cargo: "TRIGO", tons: 100 }, { cargo: "GUSA", tons: 100 }, { cargo: "SAL", tons: 0 }];
  const ranking = M.cargoRanking(rows);
  assert.equal(ranking.total, 500);
  assert.deepEqual(ranking.items.map(i => [i.label, i.tons, i.share]), [["GUSA", 400, .8], ["TRIGO", 100, .2]]);
  const real = M.cargoRanking(records);
  assert.ok(Math.abs(real.items.reduce((s, i) => s + i.share, 0) - 1) < 1e-9);
  assert.ok(real.items.every((item, i, all) => !i || all[i - 1].tons >= item.tons));
});

test("ritmo diário do plano: plano do mês ÷ dias do mês, sem linha em mês sem plano", () => {
  const plans = [{ year: 2026, month: 9, plan: 110000 }, { year: 2026, month: 10, plan: 230655 }, { year: 2026, month: 11, plan: null }];
  const { days, segments } = M.dailyTargets(plans, "2026-09-29", "2026-11-02");
  assert.equal(days.length, 35);
  assert.equal(days[0].rate, 110000 / 30);
  assert.equal(days.find(d => d.date === "2026-10-15").rate, 230655 / 31);
  assert.equal(days.at(-1).rate, null, "novembro sem plano");
  assert.deepEqual(segments.map(s => [s.start, s.end, s.month]), [["2026-09-29", "2026-09-30", 9], ["2026-10-01", "2026-10-31", 10]]);
  assert.equal(M.dailyTargets([], "2026-10-01", "2026-10-07").segments.length, 0);
  assert.equal(M.dailyTargets([{ year: 2028, month: 2, plan: 2900 }], "2028-02-01", "2028-02-01").days[0].rate, 100, "fevereiro bissexto");
});
