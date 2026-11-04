process.env.TZ = "America/Sao_Paulo";
import assert from "node:assert/strict";
import { test } from "node:test";
import { XLSX } from "../netlify/lib/parsers.mjs";
import { memoryStore } from "../netlify/lib/activities-store.mjs";
import * as sof from "../netlify/lib/sof.mjs";
import "../public/sof-core.js";

const S = globalThis.TpsSof;
const t = (h, m = 0) => (h * 60 + m) / 1440;
const day = iso => { const [y, m, d] = iso.split("-").map(Number); return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000; };
const book = (rows, name = "GERAL") => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name); return wb; };

/* SOF no modelo novo (Rev04): quadro de eventos em cima, tabela de ocorrências embaixo. */
function rev04() {
  return book([
    [null, "STATEMENT OF FACTS"], [null, "PL_TPS_ 006_Rev04"],
    [null, "Vessel", "Navio Teste", null, null, null, null, "Agents", "Agência"],
    [null, "Berth | Bollard", "Yard 10"], [null, "Type of operation", "Export"],
    [null, "Events", null, null, null, "Date", "Hour"],
    [null, "Made all fast", null, null, null, day("2026-10-21"), "23:25"],
    [null, "Commenced Loading", null, null, null, day("2026-10-22"), "01:50"],
    [null, "Completed Loading", null, null, null, day("2026-10-22"), "23:50"],
    [null, "Vessel unberthed", null, null, null, day("2026-10-23")],
    [null, "DATE", "DAY", "FROM", "TO", "GANG", "HOLD", "STOPPAGES", null, null, null, null, "VOLUMES", "WEIGHT"],
    [null, day("2026-10-22"), day("2026-10-22"), t(1), t(1, 50), "-", "-", "Not worked due to preparations alongside.", null, null, null, null, "-", "-"],
    [null, null, null, t(1, 50), t(7), "1st", "1", "Loading steel billets.", null, null, null, null, 90, 190.5],
    [null, null, null, null, null, null, null, "PERIOD TOTAL", null, null, null, null, 90, 190.5],
    [null, null, null, t(7), t(7, 30), "-", "-", "Not worked due to awaiting trucks.", null, null, null, null, "-", "-"],
    [null, null, null, t(19), t(1), "1st", "1", "Loading steel billets.", null, null, null, null, 100, 209.5],
    [null, null, null, t(1), t(2), "-", "-", "Not worked due to rain.", null, null, null, null, "-", "-"],
    [null, "Remarks: assinatura"]
  ]);
}

test("descrição normalizada ignora números, pontuação, caixa e palavras de enchimento", () => {
  assert.equal(S.normalizeDescription("Not worked due to awaiting TRUCKS (2x)."), "awaiting trucks");
  assert.equal(S.normalizeDescription("Crew using vessel's crane nr. 3"), S.normalizeDescription("crew using vessel crane nr 4"));
  assert.equal(S.canonicalResponsible("others"), "Others");
  assert.equal(S.canonicalResponsible("-"), "");
  assert.deepEqual([t(7), t(13), t(19), t(0, 30), t(1), t(6, 59)].map(v => S.periodOf(Math.round(v * 1440))), ["07x13", "13x19", "19x01", "19x01", "01x07", "01x07"]);
});

test("lê o SOF Rev04: navio, eventos principais, data repetida, total do período ignorado e madrugada no dia seguinte", () => {
  const p = S.parseSofWorkbook(XLSX, rev04(), "Statement of facts - NAVIO TESTE.xlsx");
  assert.equal(p.vessel, "NAVIO TESTE");
  assert.equal(p.model, "Rev04");
  assert.equal(p.operation, "EXPORTAÇÃO");
  assert.equal(p.berth, "Yard 10");
  assert.equal(p.berthStart, "2026-10-22T02:25:00.000Z");
  assert.equal(p.operationStart, "2026-10-22T04:50:00.000Z");
  assert.equal(p.operationEnd, "2026-10-23T02:50:00.000Z");
  assert.equal(p.berthEnd, null, "desatracação sem hora fica para a planilha de navios");
  assert.equal(p.events.length, 5);
  assert.deepEqual(p.events.map(e => [e.date, e.period, e.minutes]), [["2026-10-22", "01x07", 50], ["2026-10-22", "01x07", 310], ["2026-10-22", "07x13", 30], ["2026-10-22", "19x01", 360], ["2026-10-23", "01x07", 60]]);
  assert.equal(p.tons, 400);
});

test("lê o SOF Revisão 03 com a coluna Responsibility e o nome no título MV", () => {
  const wb = book([
    [null, "STATEMENT OF FACTS"], [null, "PL_TPS_ 006_Revisão 03"],
    [null, "09) Made all fast", null, null, null, day("2026-10-01"), "at", "00:36"],
    [null, "13) Commenced Discharging", null, null, null, day("2026-10-01"), "at", "04:10"],
    [null, "14) Completed Discharging", null, null, null, day("2026-10-02"), "at", "23:45"],
    [null, "MV OUTRO NAVIO"],
    [null, "Date", "Day", "From", "To", "Gang", "Hold", "Crane", "Stoppages", null, null, null, "Responsibility", "Vol's", "Weight"],
    [null, day("2026-10-01"), null, t(4, 10), t(6), "1st", "2", "Ship's", "Discharging pig iron.", null, null, null, "Cargo", 10, 20.5],
    [null, null, null, t(6), t(6, 20), "-", "-", "-", "Not worked due to daily safety dialogue.", null, null, null, "-", "-", "-"],
    [null, null, null, null, null, null, null, null, "Period Total", null, null, null, null, 10, 20.5]
  ], "OUTRO NAVIO");
  const p = S.parseSofWorkbook(XLSX, wb, "x.xlsx");
  assert.equal(p.vessel, "OUTRO NAVIO");
  assert.equal(p.model, "Rev03");
  assert.equal(p.operation, "IMPORTAÇÃO");
  assert.deepEqual(p.events.map(e => e.responsible), ["Cargo", ""]);
  assert.equal(S.suggest(p.events[0], {}).status, "sof");
});

test("nome do arquivo quando o SOF não traz o navio", () => {
  const wb = book([[null, "DATE", "DAY", "FROM", "TO", "STOPPAGES"], [null, day("2026-09-01"), null, t(8), t(9), "Loading cargo."]], "GERAL");
  assert.equal(S.parseSofWorkbook(XLSX, wb, "Statement of facts 01 - BBC RAISE.xlsx").vessel, "BBC RAISE");
  assert.equal(S.parseSofWorkbook(XLSX, wb, "HEEMSKERKGRACHT - Statement of facts.xlsx").vessel, "HEEMSKERKGRACHT");
});

test("sugestão de responsável: automática, confirmar, nova, regra e fixa", () => {
  const dict = S.learn([
    ...Array(19).fill({ description: "Not worked due to daily safety dialogue.", responsible: "Terminal" }), { description: "daily safety dialogue", responsible: "Vessel" },
    ...Array(3).fill({ description: "awaiting trucks", responsible: "Others" }), ...Array(2).fill({ description: "awaiting trucks", responsible: "Client" })
  ]);
  assert.deepEqual(S.suggest({ description: "Not worked due to daily safety dialogue" }, dict), { status: "auto", responsible: "Terminal", options: [{ name: "Terminal", count: 19 }, { name: "Vessel", count: 1 }] });
  assert.equal(S.suggest({ description: "Not worked due to awaiting trucks." }, dict).status, "confirmar");
  assert.equal(S.suggest({ description: "Not worked due to awaiting trucks." }, dict).responsible, "Others");
  assert.equal(S.suggest({ description: "awaiting TechnipFMC team" }, dict).status, "nova");
  assert.deepEqual([S.suggest({ description: "Discharging bundled steel pipes." }, dict).responsible, S.suggest({ description: "Rain." }, dict).responsible], ["Cargo", "Rain"]);
  dict["awaiting trucks"].fixed = "Client";
  assert.deepEqual([S.suggest({ description: "awaiting trucks" }, dict).status, S.suggest({ description: "awaiting trucks" }, dict).responsible], ["auto", "Client"]);
});

test("tempo por responsável proporcional ao tempo de operação, pranchas e paralisações", () => {
  const vessel = { tons: 1000, operationStart: "2026-01-01T03:00:00.000Z", operationEnd: "2026-01-03T03:00:00.000Z", events: [
    { description: "Loading", key: "loading", minutes: 300, responsible: "Cargo" },
    { description: "awaiting trucks", key: "awaiting trucks", minutes: 100, responsible: "Others" },
    { description: "Shifting gang", key: "shifting gang", minutes: 100, responsible: "Terminal" }
  ] };
  const s = S.vesselSummary(vessel);
  assert.equal(s.operationDays, 2);
  assert.deepEqual([s.byResponsible.Cargo, s.byResponsible.Others, s.byResponsible.Terminal].map(v => Math.round(v * 1000) / 1000), [1.2, 0.4, 0.4]);
  assert.equal(s.grossRate, 500);
  assert.equal(Math.round(s.netRate), 833);
  assert.equal(Math.round(s.triunfoRate), 625);
  assert.deepEqual(s.stoppages.map(x => x.responsible), ["Others", "Terminal"]);
});

test("ocupação por berço não conta duas vezes navios ao mesmo tempo", () => {
  const vessels = [
    { berth: "B1", berthStart: "2026-04-01T03:00:00.000Z", berthEnd: "2026-04-16T03:00:00.000Z" },
    { berth: "B1", berthStart: "2026-04-10T03:00:00.000Z", berthEnd: "2026-04-16T03:00:00.000Z" },
    { berth: "B2", berthStart: "2026-03-25T03:00:00.000Z", berthEnd: "2026-04-04T03:00:00.000Z" }
  ];
  const occ = S.occupancyFor(vessels, [2026], new Set([4]), Date.UTC(2027, 0));
  assert.deepEqual(occ.byBerth.map(r => [r.berth, Math.round(r.pct)]), [["B1", 50], ["B2", 10]]);
  assert.equal(Math.round(occ.overall), 30);
});

test("validação do SOF enviado: exige responsável em todas as ocorrências", () => {
  const base = { vessel: "Navio", cargo: "Tarugo", operation: "EXPORTAÇÃO", tons: 100, operationStart: "2026-10-22T04:50:00.000Z", operationEnd: "2026-10-23T02:50:00.000Z",
    events: [{ date: "2026-10-22", start: "2026-10-22T04:00:00.000Z", minutes: 50, description: "Not worked due to rain.", responsible: "Rain" }] };
  assert.equal(sof.validateVessel(base).vessel.vessel, "NAVIO");
  assert.match(sof.validateVessel({ ...base, events: [{ ...base.events[0], responsible: "" }] }).error, /motivo/);
  assert.match(sof.validateVessel({ ...base, operationEnd: base.operationStart }).error, /término/);
  assert.match(sof.validateVessel({ ...base, operation: "OUTRA" }).error, /operação/);
});

test("SOF enviado substitui o do histórico, aprende o responsável e é completado pela planilha de navios", async () => {
  sof.useSeed({ source: "teste", vessels: [{ id: "base-001", source: "base", vessel: "NAVIO", operationStart: "2026-10-22T05:00:00.000Z", operationEnd: "2026-10-23T02:00:00.000Z", tons: 1, events: [] },
    { id: "base-002", source: "base", vessel: "OUTRO", operationStart: "2026-09-01T05:00:00.000Z", operationEnd: "2026-09-02T02:00:00.000Z", tons: 1, events: [] }], dictionary: {} });
  const store = memoryStore();
  const { vessel } = sof.validateVessel({ vessel: "Navio", cargo: "Tarugo", operation: "EXPORTAÇÃO", tons: 100, operationStart: "2026-10-22T04:50:00.000Z", operationEnd: "2026-10-23T02:50:00.000Z",
    events: [{ date: "2026-10-22", start: "2026-10-22T04:00:00.000Z", minutes: 50, description: "awaiting harbour master visit", responsible: "Client" }] });
  await store.set(sof.VESSELS, sof.vesselId(vessel), { ...vessel, id: sof.vesselId(vessel) });
  await sof.learnFrom(store, vessel.events);
  const all = await sof.allVessels(store);
  assert.deepEqual(all.map(v => [v.vessel, v.source]), [["OUTRO", "base"], ["NAVIO", "sof"]]);
  assert.equal(S.suggest({ description: "Not worked due to awaiting harbour master visit." }, await sof.dictionary(store)).responsible, "Client");
  await sof.fixResponsible(store, "awaiting harbour master visit", "Others", { name: "Teste" });
  assert.equal((await sof.dictionary(store))["awaiting harbour master visit"].fixed, "Others");
  const enriched = sof.enrich(all[1], [{ vessel: "MV NAVIO", berthStart: "2026-10-22T02:00:00.000Z", berthEnd: "2026-10-23T09:00:00.000Z", berth: "PÁTIO 9", client: "Cliente" }]);
  assert.deepEqual([enriched.matched, enriched.berthEnd, enriched.berth], [true, "2026-10-23T09:00:00.000Z", "PÁTIO 9"]);
  sof.useSeed(null);
});

test("histórico embutido: 2025 e 2026, ocorrências com responsável e dicionário", () => {
  const data = sof.seed();
  const years = new Set(data.vessels.map(v => S.vesselMonth(v).year));
  assert.deepEqual([...years].sort(), [2025, 2026]);
  assert.ok(data.vessels.length > 150);
  assert.ok(data.vessels.every(v => v.events.every(e => S.RESPONSIBLES.includes(e.responsible))));
  assert.ok(Object.keys(data.dictionary).length > 500);
});

test("exportação: navio com resumo calculado e ocorrências sem campos internos", () => {
  const vessel = sof.seed().vessels[0];
  const row = sof.exportOf({ ...vessel, savedBy: { name: "Equipe", uid: "x" } });
  assert.equal(row.events.length, vessel.events.length);
  assert.equal(row.savedBy, "Equipe");
  assert.ok(row.summary.operationDays > 0 && row.summary.grossRate > 0);
  assert.deepEqual(Object.keys(row.events[0]).sort(), ["date", "description", "end", "gang", "hold", "minutes", "period", "reason", "reasonText", "responsible", "start", "volume", "weight"].sort());
});

test("padrões: a descrição conhecida recebe o motivo, e o motivo define o responsável", async () => {
  const event = sof.expandEvent({ date: "2026-10-22", start: "2026-10-22T04:00:00.000Z", minutes: 30, description: "Awaiting Cargo in transit.", responsible: "Others" });
  assert.deepEqual([event.reason, event.responsible, event.reasonText], ["C01", "Client", "Not worked due to awaiting cargo."]);
  assert.equal(sof.expandEvent({ start: "2026-10-22T04:00:00.000Z", minutes: 5, description: "Something never seen", responsible: "Port" }).responsible, "Port");
  const store = memoryStore();
  assert.match((await sof.fixResponsible(store, "awaiting cargo transit", "Others", { name: "Teste" })).error, /motivo padrão/);
  assert.equal((await sof.dictionary(store))["awaiting cargo transit"].fixed, "Client");
  const s = S.vesselSummary({ operationStart: "2026-01-01T03:00:00.000Z", operationEnd: "2026-01-02T03:00:00.000Z", events: [
    sof.expandEvent({ start: "2026-01-01T03:00:00.000Z", minutes: 60, description: "Not worked due to rain." }),
    sof.expandEvent({ start: "2026-01-01T04:00:00.000Z", minutes: 60, description: "Not work due to rain." })] });
  assert.deepEqual(s.stoppages.map(x => [x.key, x.count]), [["R01", 2]]);
});

test("descrição: conserta o localizar/substituir antigo da Base SOF", () => {
  assert.equal(S.cleanDescription("Not worked due to Not worked due to awaiting stevedores.."), "Not worked due to awaiting stevedores.");
  assert.equal(S.cleanDescription("Discharging..general Cargo"), "Discharging general Cargo");
  assert.equal(S.cleanDescription("Discharging. potash in bulk."), "Discharging potash in bulk.");
  assert.equal(S.cleanDescription("Discharging.."), "Discharging.");
  assert.equal(S.cleanDescription("Not worked due to Not worked due to shifting gang.ing from hold 2 to hold 3."), "Not worked due to shifting gang from hold 2 to hold 3.");
  assert.equal(S.cleanDescription("Shifting gang from Hold No. 1. to Hold No. 6."), "Shifting gang from Hold No. 1. to Hold No. 6.");
  assert.ok(!sof.seed().vessels.some(v => v.events.some(e => /[^.]\.\.$|due to not worked due/i.test(e.description))));
});

test("padrões: nome do navio, duplicados, berço, cliente e carga", () => {
  const vessels = sof.seed().vessels;
  assert.ok(!vessels.some(v => ["base-073", "base-122"].includes(v.id)));
  const hobart = vessels.find(v => v.originalName === "INDUSTRIAL HOBART EXPORTAÇÃO");
  assert.equal(hobart.vessel, "INDUSTRIAL HOBART");
  const enriched = sof.enrich({ ...hobart, cargo: "CARRETEL / CAIXA" }, [{ vessel: "INDUSTRIAL HOBART EXPORTACAO", berthStart: hobart.berthStart || hobart.operationStart, berth: "Terminal 30 - 209 - 215", client: "SUBSEA7" }]);
  assert.deepEqual([enriched.matched, enriched.berth, enriched.client, enriched.cargo], [true, "ARMAZÉM 30", "SUBSEA 7", "CARRETEL"]);
});

test("motivos parecidos: erro de digitação e palavras em comum; paralisação não sugere Carga", () => {
  const std = sof.buildStandards();
  const known = Object.entries(std.descriptions);
  const top = text => S.similarReasons(text, known, std.reasons).map(x => x.code);
  assert.equal(top("Waiting for trucks from client")[0], "C04");
  assert.equal(top("Crane no. 2 breakdown")[0], "N01");
  assert.ok(top("Not worked due to stevedors shortage").includes("T01"));
  assert.ok(!top("Not worked due to discharging delay").some(code => std.byCode.get(code).responsible === "Cargo"));
  assert.ok(S.similarity("awaiting stevedores", "awaiting stevedeores") > S.similarity("awaiting stevedores", "awaiting trucks"));
});

test("importação: descrição nova recebe o motivo escolhido e passa a valer nos próximos SOFs", async () => {
  sof.useSeed({ source: "teste", vessels: [], dictionary: {} });
  const store = memoryStore();
  const base = { vessel: "Navio", cargo: "Tarugo", operation: "EXPORTAÇÃO", tons: 100, operationStart: "2026-10-22T04:50:00.000Z", operationEnd: "2026-10-23T02:50:00.000Z" };
  const event = { date: "2026-10-22", start: "2026-10-22T04:00:00.000Z", minutes: 50, description: "Not worked due to tug unavailability." };
  assert.match(sof.validateVessel({ ...base, events: [{ ...event, reason: "ZZ9" }] }).error, /Motivo desconhecido/);
  const { vessel } = sof.validateVessel({ ...base, events: [{ ...event, reason: "O03", responsible: "Terminal" }] }, await sof.standardsOf(store));
  assert.deepEqual([vessel.events[0].reason, vessel.events[0].responsible], ["O03", "Others"]);
  await store.set(sof.VESSELS, sof.vesselId(vessel), { ...vessel, id: sof.vesselId(vessel) });
  await sof.learnStandards(store, vessel.events);
  const std = await sof.standardsOf(store);
  assert.equal(sof.reasonOf("tug unavailability", std).code, "O03");
  assert.equal((await sof.dictionary(store)).stevedores, undefined);
  const [saved] = await sof.allVessels(store);
  assert.deepEqual([saved.events[0].reason, saved.events[0].responsible], ["O03", "Others"]);
  // Descrição que já tinha motivo não muda pela importação.
  await sof.learnStandards(store, [{ description: "Not worked due to rain.", reason: "T01" }]);
  assert.equal(sof.reasonOf("rain", await sof.standardsOf(store)).code, "R01");
  sof.useSeed(null);
});

test("padronizar: criar motivo, mover descrições e conferir", async () => {
  sof.useSeed({ source: "teste", vessels: [{ id: "base-001", source: "base", vessel: "NAVIO", operationStart: "2026-10-22T05:00:00.000Z", operationEnd: "2026-10-23T05:00:00.000Z", tons: 1,
    events: [{ date: "2026-10-22", from: 120, minutes: 60, description: "Awaiting barges." }, { date: "2026-10-22", from: 180, minutes: 30, description: "Not worked due to awaiting tug." }].map(e => sof.expandEvent(e)) }], dictionary: {} });
  const store = memoryStore();
  const actor = { name: "Henrique" };
  assert.match((await sof.createReason(store, { responsible: "Others", text: "awaiting berth" }, actor)).error, /já existe/);
  const { reason } = await sof.createReason(store, { responsible: "Others", text: "not worked due to awaiting tug." }, actor);
  assert.deepEqual([reason.code, reason.text, reason.responsible], ["O11", "Not worked due to awaiting tug.", "Others"]);
  assert.equal((await sof.createReason(store, { responsible: "Cargo", text: "loading containers" }, actor)).reason.text, "Loading containers.");
  let std = await sof.standardsOf(store);
  let list = sof.descriptionList(await sof.allVessels(store, std), std);
  assert.deepEqual(list.map(x => [x.key, x.status]), [["awaiting barges", "conferida"], ["awaiting tug", "sem-motivo"]]);
  assert.match((await sof.setDescriptions(store, ["awaiting tug"], "", actor)).error, /Escolha um motivo/);
  assert.ok((await sof.setDescriptions(store, ["awaiting tug", "awaiting barges"], "O11", actor)).ok);
  std = await sof.standardsOf(store);
  const [vessel] = await sof.allVessels(store, std);
  assert.deepEqual(vessel.events.map(e => [e.reason, e.responsible]), [["O11", "Others"], ["O11", "Others"]]);
  list = sof.descriptionList([vessel], std);
  assert.ok(list.every(x => x.status === "conferida" && x.reason === "O11"));
  sof.useSeed(null);
});
