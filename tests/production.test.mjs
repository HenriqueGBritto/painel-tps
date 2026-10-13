import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const productionFile = readFileSync(new URL("../public/production.js", import.meta.url), "utf8");
const exportFile = readFileSync(new URL("../public/export.js", import.meta.url), "utf8");
const source = productionFile.split("function productionStopsByDay")[0];
const context = vm.createContext({ window: {} });
vm.runInContext(source, context);

function metrics(stops) {
  const start = new Date("2026-10-01T00:00:00Z");
  const end = new Date("2026-10-01T04:00:00Z");
  context.data = {
    start, asOfEnd: end, elapsedDays: 1 / 6, produced: 100, offshoreProduced: 0,
    periods: [{ end, crewCount: 2 }],
    stops: stops.map(([from, to, location]) => ({
      startAt: new Date(`2026-10-01T0${from}:00:00Z`),
      endAt: new Date(`2026-10-01T0${to}:00:00Z`),
      location
    }))
  };
  return vm.runInContext("productionEffectiveTime(data)", context);
}

test("desconta só a parada simultânea quando os ternos são registrados em linhas separadas", () => {
  const result = metrics([[1, 3, "1° / 2"], [2, 4, "2° / 4"]]);
  assert.equal(result.stoppedMinutes, 60);
  assert.ok(Math.abs(result.rate - 800) < 0.001);
});

test("não desconta a parada isolada de um terno", () => {
  const result = metrics([[1, 2, "1° / 2"], [2, 3, "2° / 4"]]);
  assert.equal(result.rate, undefined);
});

test("não pressupõe parada do navio se os ternos escalados não estão identificados", () => {
  const result = metrics([[1, 3, "1° / 2"]]);
  assert.equal(result.rate, undefined);
});

test("exclui sábado 19h até segunda 07h apenas das cargas autorizadas", () => {
  const from = new Date("2026-10-03T21:00:00Z").getTime(); // sábado 18h em São Paulo
  const to = new Date("2026-10-05T11:00:00Z").getTime(); // segunda 08h
  context.from = from; context.to = to;
  assert.equal(vm.runInContext("productionIntervalUnionMs(productionWeekendIntervals(from, to, 'TARUGO DE AÇO'))", context), 36 * 3600000);
  assert.equal(vm.runInContext("productionIntervalUnionMs(productionWeekendIntervals(from, to, 'CLORETO DE POTÁSSIO'))", context), 36 * 3600000);
  assert.equal(vm.runInContext("productionIntervalUnionMs(productionWeekendIntervals(from, to, 'FERRO GUSA'))", context), 36 * 3600000);
  assert.equal(vm.runInContext("productionIntervalUnionMs(productionWeekendIntervals(from, to, 'CARGA GERAL'))", context), 0);
});

test("não duplica parada que coincide com o fim de semana", () => {
  const start = new Date("2026-10-03T21:00:00Z");
  const end = new Date("2026-10-05T11:00:00Z");
  context.data = {
    cargo: "TARUGO DE AÇO", start, asOfEnd: end, elapsedDays: 38 / 24,
    produced: 100, offshoreProduced: 0,
    periods: [{ stage: "Atracado", from: start, end, crewCount: 1, tons: 100, byHold: { 2: 100 } }],
    stops: [
      { startAt: new Date("2026-10-03T21:30:00Z"), endAt: new Date("2026-10-03T22:30:00Z"), location: "1° / 2" },
      { startAt: new Date("2026-10-05T10:30:00Z"), endAt: end, location: "1° / 2" }
    ]
  };
  const vessel = vm.runInContext("productionEffectiveTime(data)", context);
  assert.equal(vessel.weekendMinutes, 36 * 60);
  assert.equal(vessel.stoppedMinutes, 60);
  assert.ok(Math.abs(vessel.rate - 2400) < 0.001);
  const crew = vm.runInContext("productionCrewMetrics(data)", context);
  assert.equal(crew.rows[0].weekendMinutes, 36 * 60);
  assert.ok(Math.abs(crew.rows[0].effective - 600) < 0.001);
});

test("usa somente a nomenclatura oficial das pranchas na Produção e na exportação", () => {
  assert.doesNotMatch(`${productionFile}\n${exportFile}`, /prancha\s+(?:bruta|efetiva)/i);
  assert.match(productionFile, /Prancha real/);
  assert.match(productionFile, /Prancha Triunfo/);
});

test("exportação lista cada parada com início, término e duração", () => {
  assert.match(exportFile, /stop\.description[^\n]+startTime[^\n]+às[^\n]+endTime[^\n]+duration\(stop\.minutes\)/);
  assert.doesNotMatch(exportFile, /shiftStops\.slice\(/);
});
