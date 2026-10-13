import assert from "node:assert/strict";
import { test } from "node:test";
import { diffOperations, diffDischarge, withChangeLog, MAX_ENTRIES, MAX_ITEMS } from "../netlify/lib/changes.mjs";

const concluded = (vessel, extra = {}) => ({ vessel, berthStart: "2026-10-01T10:00:00.000Z", berthEnd: "2026-10-03T08:00:00.000Z", operationStart: "2026-10-01T12:00:00.000Z", operationEnd: "2026-10-03T06:00:00.000Z", berth: "BERÇO 1", operation: "DESCARGA", cargo: "FERTILIZANTE", client: "CLIENTE", tons: 10000, productivity: 5000, ...extra });
const active = (vessel, extra = {}) => ({ vessel, berthStart: "2026-10-10T10:00:00.000Z", operationStart: "2026-10-10T12:00:00.000Z", berth: "BERÇO 2", operation: "DESCARGA", cargo: "SAL", client: "CLIENTE", partialTons: 1000, ...extra });
const titles = sections => Object.fromEntries(sections.map(section => [section.title, section.items]));

test("navios: atracação nova, operação encerrada, volume parcial e correção", () => {
  const previous = { records: [concluded("ALFA")], activeRecords: [active("BETA"), active("GAMA")] };
  const next = {
    records: [concluded("ALFA", { tons: 10500 }), concluded("BETA", { berthStart: "2026-10-10T10:00:00.000Z", berthEnd: "2026-10-12T09:00:00.000Z", tons: 8000 })],
    activeRecords: [active("GAMA", { partialTons: 2500 }), active("DELTA", { berthStart: "2026-10-12T15:00:00.000Z" })]
  };
  const result = titles(diffOperations(previous, next));
  assert.deepEqual(result["Navios concluídos corrigidos"], ["ALFA (atracação 01/10 07:00): volume 10.000 t → 10.500 t"]);
  assert.match(result["Operações encerradas"][0], /^BETA: desatracou em 12\/10 06:00 · 8\.000 t/);
  assert.deepEqual(result["Navios em operação"], ["GAMA: volume parcial 1.000 t → 2.500 t"]);
  assert.match(result["Novas atracações"][0], /^DELTA: atracou em 12\/10 12:00 no berço BERÇO 2/);
  assert.equal(result["Registros removidos ou com atracação alterada"], undefined, "BETA foi encerrado, não removido");
});

test("navios: lineup com navio incluído, alterado e removido", () => {
  const row = (vessel, extra = {}) => ({ vessel, geport: "", plannedBerthStart: "2026-10-20T10:00:00.000Z", berth: "BERÇO 1", operation: "DESCARGA", cargo: "SAL", ...extra });
  const result = titles(diffOperations({ lineupRecords: [row("ALFA"), row("BETA")] }, { lineupRecords: [row("ALFA", { plannedBerthStart: "2026-10-21T10:00:00.000Z" }), row("GAMA")] }));
  assert.deepEqual(result.Lineup, [
    "ALFA: atracação prevista 20/10 07:00 → 21/10 07:00",
    "GAMA: incluído, atracação prevista 20/10 07:00 no berço BERÇO 1",
    "BETA: saiu do lineup"
  ]);
});

test("indicadores: dia novo, dia corrigido, plano e pesagem", () => {
  const previous = {
    dischargeDays: [{ date: "2026-10-06", tons: 12000, wagons: 40 }],
    plans: [{ year: 2026, month: 10, plan: 300000, challenge: null, actual: 100000 }],
    weighings: [{ vessel: "ALFA", year: 2026, month: 10, unloadedTons: 5000, status: "ABERTO" }],
    inProgress: { records: 2 }
  };
  const next = {
    dischargeDays: [{ date: "2026-10-06", tons: 12345.4, wagons: 40 }, { date: "2026-10-07", tons: 9000, wagons: 30 }],
    plans: [{ year: 2026, month: 10, plan: 320000, challenge: null, actual: 100000 }],
    weighings: [{ vessel: "ALFA", year: 2026, month: 10, unloadedTons: 5000, status: "FECHADO" }],
    inProgress: { records: 2 }
  };
  const result = titles(diffDischarge(previous, next));
  assert.deepEqual(result["Descarga por dia"], ["06/10/2026: volume 12.000 t → 12.345 t", "07/10/2026: dia incluído com 9.000 t · 30 vagões"]);
  assert.deepEqual(result["Plano mensal"], ["out/2026: plano 300.000 t → 320.000 t"]);
  assert.deepEqual(result.Pesagem, ["ALFA (out/2026): situação ABERTO → FECHADO"]);
  assert.equal(result["Em descarga agora"], undefined);
});

test("histórico: só leituras com diferença entram, mais recente primeiro, com limite", () => {
  const day = (date, tons) => ({ date, tons, wagons: 1 });
  const first = withChangeLog("discharge", null, { generatedAt: "t0", dischargeDays: [day("2026-10-01", 1)] });
  assert.deepEqual(first.changeLog, [], "sem cópia anterior não há comparação");
  const same = withChangeLog("discharge", first, { generatedAt: "t1", dischargeDays: [day("2026-10-01", 1)] });
  assert.deepEqual(same.changeLog, []);
  const changed = withChangeLog("discharge", same, { generatedAt: "t2", dischargeDays: [day("2026-10-01", 1), day("2026-10-02", 5)] });
  assert.equal(changed.changeLog.length, 1);
  assert.deepEqual([changed.changeLog[0].at, changed.changeLog[0].since, changed.changeLog[0].total], ["t2", "t1", 1]);
  const unchanged = withChangeLog("discharge", changed, { generatedAt: "t3", dischargeDays: [day("2026-10-01", 1), day("2026-10-02", 5)] });
  assert.equal(unchanged.changeLog[0].at, "t2", "leitura sem diferença mantém o último registro");

  let snapshot = unchanged;
  for (let i = 0; i < MAX_ENTRIES + 3; i++) snapshot = withChangeLog("discharge", snapshot, { generatedAt: `n${i}`, dischargeDays: [day("2026-10-01", i + 10)] });
  assert.equal(snapshot.changeLog.length, MAX_ENTRIES);
  assert.equal(snapshot.changeLog[0].at, `n${MAX_ENTRIES + 2}`);
});

test("histórico: seção longa guarda só as primeiras linhas, mas conta todas", () => {
  const days = n => Array.from({ length: n }, (_, i) => ({ date: `2026-01-${String(i + 1).padStart(2, "0")}`, tons: 1, wagons: 1 }));
  const [section] = diffDischarge({ dischargeDays: [] }, { dischargeDays: days(MAX_ITEMS + 1) });
  assert.equal(section.count, MAX_ITEMS + 1);
  assert.equal(section.items.length, MAX_ITEMS);
});

test("histórico: cópia de reserva não serve de base de comparação", () => {
  const result = withChangeLog("discharge", { origin: "fallback", dischargeDays: [], changeLog: [{ at: "x" }] }, { generatedAt: "t", dischargeDays: [{ date: "2026-10-01", tons: 1, wagons: 1 }] });
  assert.deepEqual(result.changeLog, [{ at: "x" }]);
});
