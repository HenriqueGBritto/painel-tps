import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryStore } from "../netlify/lib/activities-store.mjs";
import { parseVesselName } from "../netlify/lib/requisition-pdf.mjs";
import { checkRequisition } from "../netlify/lib/requisition-rules.mjs";
import * as R from "../netlify/lib/requisitions.mjs";
import * as O from "../netlify/lib/ogmo-sync.mjs";
import { isAllowed, parseGrid, pdfMatches, datesAround } from "../robot/ogmo-lib.mjs";

const at = text => new Date(`${text}-03:00`);
const terno = (equipe, observation, fns) => ({ equipe, generalNote: "É OBRIGATÓRIO O USO DE EPI.", fainas: [{ code: "3.8.4", text: "" }], observation, functions: Object.entries(fns).map(([code, vagas]) => ({ code, name: code, vagas })) });
const req = (number, vessel, period, ternos, extra = {}) => ({ number, vessel: parseVesselName(vessel), local: "PATIO 8/9", berthing: "Atracado", port: "Rio de Janeiro", date: "2026-10-21", period, travelType: "Longo Curso", printedAt: null, ternos, ...extra });
const cct = (period) => req(`9${period.slice(0, 2)}-1`, "CCT CAPATAZIA", period, [{ equipe: 1, generalNote: "", fainas: [{ code: "1.3", text: "DIVERSOS" }], observation: "CCT PREPOSTO CAPATAZIA", functions: [{ code: "PPC", name: "PREPOSTO CAPATAZIA", vagas: 1 }] }]);

test("nomes do OGMO ao largo: NAVIO (AL.) e BALSA X (AL. NAVIO)", () => {
  assert.deepEqual([parseVesselName("SKOMER ISLAND (AL.)").offshore, parseVesselName("SKOMER ISLAND (AL.)").name], [true, "SKOMER ISLAND"]);
  const balsa = parseVesselName("BALSA RIO PORT II (AL. SKOMER ISLAND)");
  assert.deepEqual([balsa.kind, balsa.name, balsa.attachedTo, balsa.offshore], ["balsa", "RIO PORT II", "SKOMER ISLAND", true]);
  assert.deepEqual([parseVesselName("BALSA BS5 (AT.BBC PHILIPPINES)").attachedTo, parseVesselName("BALSA BS5 (AT.BBC PHILIPPINES)").offshore], ["BBC PHILIPPINES", false]);
});

test("CCT CAPATAZIA: certa enquanto houver frente nossa com capatazia no período; sem nenhuma, deve ser cancelada", () => {
  const balsa = req("1-1", "BALSA RIO PORT II (AT. SKOMER ISLAND)", "07-13", [terno(1, "EMBARQUE DE FERRO GUSA", { CMP: 1, ETR: 1, CFC: 1, CFP: 1, PE: 2 })]);
  assert.equal(checkRequisition(cct("07-13"), { related: [balsa] }).result, "aprovado");
  const alone = checkRequisition(cct("07-13"), { related: [{ ...balsa, cancelled: true }] });
  assert.equal(alone.result, "reprovado");
  assert.match(alone.items[0].text, /deve ser cancelada/);
  assert.equal(checkRequisition(cct("07-13"), { related: [{ ...balsa, period: "13-19" }] }).result, "reprovado", "capatazia de outro período não conta");
});

test("o que falta: navio do período anterior sem a requisição do próximo, perto do limite; e navio em operação sem nenhuma", () => {
  const rows = [
    { date: "2026-10-23", number: "1-1", vessel: "SKOMER ISLAND (AL.)", period: "07-13", cancelled: false },
    { date: "2026-10-23", number: "2-1", vessel: "BALSA RIO PORT II (AL. SKOMER ISLAND)", period: "07-13", cancelled: false },
    { date: "2026-10-23", number: "3-1", vessel: "ASALET", period: "07-13", cancelled: false },
    { date: "2026-10-23", number: "4-1", vessel: "CCT CAPATAZIA", period: "07-13", cancelled: false },
    { date: "2026-10-23", number: "5-1", vessel: "SKOMER ISLAND (AL.)", period: "13-19", cancelled: false },
    { date: "2026-10-23", number: "6-1", vessel: "ASALET", period: "13-19", cancelled: true }
  ];
  // 08:50: o limite do 13x19 (09:45) está a menos de 80 minutos.
  const missing = O.missingRequisitions(rows, { now: at("2026-10-23T08:50:00"), operating: ["Asalet", "Thor Courage"] });
  assert.deepEqual(missing.map(item => `${item.vessel}|${item.period}`).sort(), ["ASALET|13-19", "BALSA RIO PORT II (AL. SKOMER ISLAND)|13-19", "THOR COURAGE|13-19"]);
  assert.match(O.missingText(missing.find(item => item.vessel === "ASALET")), /ASALET: falta a requisição do 13x19 de 23\/10 \(limite 09:45\)/);
  assert.deepEqual(O.missingRequisitions(rows, { now: at("2026-10-23T07:00:00") }), [], "longe do limite: sem aviso ainda");
  // 02:50: o 07x13 de hoje olha o 01x07 de ontem.
  const night = O.missingRequisitions([{ date: "2026-10-22", number: "9-1", vessel: "ASALET", period: "01-07", cancelled: false }], { now: at("2026-10-23T02:50:00") });
  assert.deepEqual(night.map(item => `${item.vessel}|${item.date}|${item.period}`), ["ASALET|2026-10-23|07-13"]);
});

test("rodada do robô: PDF conferido, cancelada vinda do OGMO reconfere a CCT CAPATAZIA e o resumo guarda o que falta", async () => {
  const store = memoryStore();
  const balsa = req("25053242-1", "BALSA RIO PORT II (AT. SKOMER ISLAND)", "07-13", [terno(1, "EMBARQUE DE FERRO GUSA", { CMP: 1, ETR: 1, CFC: 1, CFP: 1, PE: 2 })]);
  // As duas requisições já conferidas, como se os PDFs tivessem vindo do robô (o envio de PDF é testado em requisitions.test.mjs).
  for (const r of [balsa, cct("07-13")]) {
    const id = `${r.date}_${r.number}`;
    await store.set(R.COLLECTION, id, { id, ...r, check: checkRequisition(r, { related: [balsa, cct("07-13")].filter(o => o.number !== r.number) }), source: "ogmo", cancelled: false });
  }
  assert.equal((await store.get(R.COLLECTION, "2026-10-21_907-1")).check.result, "aprovado");
  const status = await O.receiveList(store, {
    dates: ["2026-10-21"],
    rows: [
      { date: "2026-10-21", number: "25053242-1", vessel: "BALSA RIO PORT II (AT. SKOMER ISLAND)", period: "07-13", local: "PATIO 8/9", cancelled: true, scaled: false },
      { date: "2026-10-21", number: "907-1", vessel: "CCT CAPATAZIA", period: "07-13", local: "ARMAZEM 10", cancelled: false, scaled: false },
      { date: "2026-10-21", number: "777-1", vessel: "ASALET", period: "07-13", local: "ARMAZEM 10", cancelled: false, scaled: true }
    ]
  }, { now: at("2026-10-21T05:00:00"), lineup: null });
  assert.deepEqual([status.ok, status.active, status.cancelled, status.notDownloaded], [true, 2, 1, 1]);
  assert.equal((await store.get(R.COLLECTION, "2026-10-21_25053242-1")).cancelled, true);
  assert.equal((await store.get(R.COLLECTION, "2026-10-21_907-1")).check.result, "reprovado", "sem a balsa, a CCT CAPATAZIA deve ser cancelada");
  const list = await R.list(store, { from: "2026-10-21", to: "2026-10-21" });
  assert.equal(list.find(row => row.number === "25053242-1").status, "cancelada");
  assert.deepEqual(await O.known(store, ["2026-10-21"]), { "25053242-1": { date: "2026-10-21", scaled: false, cancelled: true }, "907-1": { date: "2026-10-21", scaled: false, cancelled: false } });
  await O.receiveError(store, { message: "Não entrou no OGMO." }, { now: at("2026-10-21T06:00:00") });
  assert.deepEqual([(await O.syncStatus(store)).ok, (await O.syncStatus(store)).error, (await O.syncStatus(store)).active], [false, "Não entrou no OGMO.", 2]);
});

test("token do robô: exige o valor configurado no Netlify", () => {
  const request = token => new Request("https://x.test", { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const env = { OGMO_SYNC_TOKEN: "x".repeat(32) };
  assert.equal(O.tokenOk(request("x".repeat(32)), env), true);
  assert.equal(O.tokenOk(request("y".repeat(32)), env), false);
  assert.equal(O.tokenOk(request(""), env), false);
  assert.equal(O.tokenOk(request("curto"), { OGMO_SYNC_TOKEN: "curto" }), false, "token curto demais não vale");
});

test("robô: só ações de consulta passam; grade e PDF reconhecidos", () => {
  for (const action of ["IWBUSCAR", "DBLPORTO", "IWDBGRID1", "IWIMAGE5", "BTENTRAR"]) assert.equal(isAllowed(`IW_Action=${action}&IW_ActionParam=`), true, action);
  for (const action of ["BTNINCLUIR", "BTNEXCLUIR", "BTNALTERART", "BTNDUPLICAREQ", "IWBUTTON9", "IWBUTTON10", "IWBUTTON11", "IWIMAGE4", "IWBCOMPOSICAO", ""]) assert.equal(isAllowed(`IW_Action=${action}`), false, action || "vazio");
  const rows = parseGrid([
    { cells: ["Cancelada?", "Requisição", "Navio"], onclick: "" },
    { cells: ["NAO", "25053308-1", "SKOMER ISLAND (AL.)", "13-19", "RIO AO LARGO", "SIM", "Longo Curso", ""], onclick: "SubmitClickConfirm('IWDBGRID1','0_365019', true, '')" },
    { cells: ["SIM", "25053297-1", "SKOMER ISLAND (AL.)", "13-19", "RIO AO LARGO", "", "Longo Curso", ""], onclick: "SubmitClickConfirm('IWDBGRID1','2_365008', true, '')" }
  ], "2026-10-23");
  assert.deepEqual(rows.map(r => [r.number, r.cancelled, r.scaled, r.param]), [["25053308-1", false, true, "0_365019"], ["25053297-1", true, false, "2_365008"]]);
  assert.equal(pdfMatches("Pág.: 1 Operador: TRIUNFO Requisição: 25053301-1 Navio: CCT", "25053301-1"), true);
  assert.equal(pdfMatches("Requisição: 25053301-1", "25053302-1"), false);
  assert.deepEqual(datesAround(at("2026-10-23T00:30:00")), ["2026-10-22", "2026-10-23", "2026-10-24"]);
});

test("largada pelo Netlify: de hora em hora e 1 hora antes de cada limite; erro do GitHub vira mensagem clara", async () => {
  const { shouldRun, dispatch } = await import("../netlify/functions/ogmo-scheduled.mjs");
  assert.equal(shouldRun(new Date("2026-10-26T13:07:00Z")), true, "minuto 7: rodada de hora em hora");
  assert.equal(shouldRun(new Date("2026-10-26T11:45:00Z")), true, "08:45 em Brasília: 1 hora antes do limite do 13x19");
  assert.equal(shouldRun(new Date("2026-10-26T13:45:00Z")), false, "10:45 em Brasília: sem limite perto");
  const calls = [];
  await dispatch({ token: "t", fetcher: async (url, options) => { calls.push([url, JSON.parse(options.body)]); return new Response(null, { status: 204 }); } });
  assert.deepEqual(calls, [["https://api.github.com/repos/HenriqueGBritto/painel-tps/actions/workflows/ogmo.yml/dispatches", { ref: "main", inputs: { modo: "normal" } }]]);
  await assert.rejects(dispatch({ token: "t", fetcher: async () => new Response("Bad credentials", { status: 401 }) }), /token inválido, vencido ou sem permissão/);
  await assert.rejects(dispatch({ token: "" }), /GITHUB_DISPATCH_TOKEN/);
});
