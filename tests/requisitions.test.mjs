import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { parseRequisition, parseVesselName } from "../netlify/lib/requisition-pdf.mjs";
import { checkRequisition, expectedCapatazia, defaultHolidays, retroactiveCheck } from "../netlify/lib/requisition-rules.mjs";
import * as R from "../netlify/lib/requisitions.mjs";
import * as A from "../netlify/lib/activities.mjs";
import { memoryStore } from "../netlify/lib/activities-store.mjs";
import { memoryAttachmentsStore } from "../netlify/lib/attachments-store.mjs";
import { upgradeProfile } from "../netlify/lib/auth.mjs";

// Texto (com posições) de dois PDFs reais do OGMO, de 17/10/2026 (sábado): balsa RIO PORT II atrelada ao SKOMER ISLAND.
const pages = name => JSON.parse(readFileSync(new URL(`./fixtures/requisicoes/${name}.json`, import.meta.url), "utf8"));
const CMG = "rio-port-07x13-cmg";       // 07x13: CMG no lugar do CMP nos dois ternos
const OBS = "rio-port-01x07-obs";       // 01x07: observação do 2º terno errada e nome SMOKER (o certo é SKOMER)
const lineup = [{ vessel: "Skomer Island", berth: "PÁTIO 8/9", plannedBerthStart: "2026-10-15T10:00:00" }];
const holidays = defaultHolidays(2026);
const errors = check => check.items.filter(item => item.level === "erro").map(item => item.text);
const confirms = check => check.items.filter(item => item.level === "confirmar").map(item => item.text);
const helio = { id: "helio", name: "Hélio" };

test("PDF: cabeçalho, ternos e cada função com as vagas da mesma linha", () => {
  const r = parseRequisition(pages(CMG));
  assert.deepEqual([r.number, r.date, r.period, r.local, r.berthing, r.travelType, r.printedAt], ["25053242-1", "2026-10-17", "07-13", "PATIO 8/9", "Atracado", "Longo Curso", "2026-10-23T10:29:40"]);
  assert.deepEqual([r.vessel.kind, r.vessel.name, r.vessel.attachedTo], ["balsa", "RIO PORT II", "SKOMER ISLAND"]);
  assert.equal(r.ternos.length, 2);
  assert.deepEqual(r.ternos[0].functions.map(f => `${f.section}:${f.code}=${f.vagas}`).sort(), ["CAPATAZIA:PE=4", "CONFERENTE:CFC=1", "CONFERENTE:CFP=1", "ESTIVA:CMG=1", "ESTIVA:ETR=1"]);
  assert.deepEqual(r.ternos[1].functions.map(f => f.code).sort(), ["CFP", "CMG", "ETR", "PE"], "CFC só no 1º terno");
  assert.deepEqual([r.ternos[0].fainas, r.ternos[0].observation, r.ternos[0].generalNote], [[{ code: "3.8.4", text: "OP. FERRO GUSA" }], "EMBARQUE DE FERRO GUSA.", "USO OBRIGATÓRIO DO EPI."]);
  assert.equal(parseRequisition(pages(OBS)).ternos[1].observation, "USO OBRIGATÓRIO DO EPI.");
});

test("nome do navio: balsa atrelada, ao largo, retroativo e enlonamento", () => {
  assert.deepEqual(parseVesselName("NAVIO XX (AL)"), { raw: "NAVIO XX (AL)", kind: "navio", name: "NAVIO XX", attachedTo: null, offshore: true, retroactive: null, tarp: false, extras: ["AL"] });
  assert.equal(parseVesselName("SKOMER ISLAND (REF.15/10/2026)").retroactive, "2026-10-15");
  assert.equal(parseVesselName("THOR (ENLONAMENTO)").tarp, true);
});

test("CMG no lugar do CMP reprova; o resto da requisição está conforme a IT", () => {
  const check = checkRequisition(parseRequisition(pages(CMG)), { lineup, holidays });
  assert.equal(check.result, "reprovado");
  assert.equal(check.operation.key, "gusa-balsa-atracada-embarque");
  assert.deepEqual(errors(check), [
    "Terno 1 (balsa atracada, embarque de ferro gusa): CMG (Contra Mestre Geral) no lugar do CMP (Contra Mestre Porão).",
    "Terno 2 (balsa atracada, embarque de ferro gusa): CMG (Contra Mestre Geral) no lugar do CMP (Contra Mestre Porão)."
  ]);
  assert.ok(check.items.some(item => item.level === "ok" && /combina com o berço do Lineup/.test(item.text)));
});

test("observação do 2º terno sem a operação reprova; nome diferente do Lineup fica para confirmar", () => {
  const check = checkRequisition(parseRequisition(pages(OBS)), { lineup, holidays });
  assert.equal(check.result, "reprovado");
  assert.deepEqual(errors(check), ['Terno 2: a observação deve dizer a operação e o produto (ex.: EMBARQUE DE FERRO GUSA); está "USO OBRIGATÓRIO DO EPI.".']);
  assert.ok(confirms(check).some(text => /"SMOKER ISLAND" não está no Lineup; o mais parecido é "SKOMER ISLAND"/.test(text)));
  assert.ok(check.items.some(item => item.level === "ok" && /PE 4 \(sábado\)/.test(item.text)), "sábado: 4 capatazia");
});

test("capatazia: 2 em dia útil, 4 em sábado, domingo e feriado", () => {
  assert.equal(expectedCapatazia("2026-10-16", holidays).count, 2, "sexta");
  assert.equal(expectedCapatazia("2026-10-18", holidays).count, 4, "domingo");
  assert.deepEqual(expectedCapatazia("2026-10-12", holidays), { count: 4, why: "feriado (Nossa Senhora Aparecida)" });
  const friday = { ...parseRequisition(pages(OBS)), date: "2026-10-16" };
  assert.ok(errors(checkRequisition(friday, { lineup, holidays })).some(text => /capatazia \(PE\) 4 — o esperado é 2 por ser dia útil \(sexta\)/.test(text)));
});

test("a hora da impressão não é conferida", () => {
  const items = checkRequisition(parseRequisition(pages(CMG)), { lineup, holidays }).items;
  assert.ok(!items.some(item => /impress|limite|prazo/i.test(item.text)), "o PDF impresso dias depois não gera aviso");
});

test("CMA no lugar do CMP é aceito (pedido do especialista); ao largo exige (AL) e a balsa com o mesmo número de ternos", () => {
  const base = parseRequisition(pages(CMG));
  const cma = { ...base, ternos: base.ternos.map(t => ({ ...t, functions: t.functions.map(f => f.code === "CMG" ? { ...f, code: "CMA", name: "CONTRA MESTRE AUXILIAR" } : f) })) };
  assert.deepEqual(errors(checkRequisition(cma, { lineup, holidays })), []);

  const shipTerno = n => ({ equipe: n, generalNote: "É OBRIGATÓRIO O USO DE EPI.", fainas: [{ code: "3.8.4", text: "OP. FERRO GUSA" }], observation: "EMBARQUE DE FERRO GUSA AO LARGO", functions: [["CMP", 1], ["GC", 1], ["ESI", 1], ["CFP", 1]].map(([code, vagas]) => ({ code, name: code, vagas })) });
  const ship = { number: "1-1", vessel: parseVesselName("SKOMER ISLAND"), local: "RIO AO LARGO", berthing: "Ao Largo", port: "Rio de Janeiro", date: "2026-10-17", period: "07-13", travelType: "Longo Curso", printedAt: "2026-10-17T02:00:00", ternos: [shipTerno(1), shipTerno(2)] };
  assert.ok(errors(checkRequisition(ship, { lineup, holidays })).some(text => /NAVIO XX \(AL\)/.test(text)));
  const shipAL = { ...ship, vessel: parseVesselName("SKOMER ISLAND (AL)") };
  const bargeTerno = (n, cfc) => ({ equipe: n, generalNote: "É OBRIGATÓRIO O USO DE EPI.", fainas: [{ code: "3.8.4", text: "" }], observation: "DESCARGA DE FERRO GUSA - LANCHA SAI DO ARM.18 ÀS 00H", functions: [["CMP", 1], ["ETR", 1], ["EE", 3], ...(cfc ? [["CFC", 1]] : [])].map(([code, vagas]) => ({ code, name: code, vagas })) });
  const barge = { ...ship, number: "2-1", vessel: parseVesselName("BALSA RIO PORT II (AT. SKOMER ISLAND)"), observation: "", ternos: [bargeTerno(1, true)] };
  assert.equal(checkRequisition(barge, { lineup, holidays }).result, "confirmar", "sem a requisição do navio ainda");
  assert.ok(errors(checkRequisition(barge, { lineup, holidays, related: [shipAL] })).some(text => /Navio ao largo com 2 terno\(s\) e balsa\(s\) com 1/.test(text)));
  const barge2 = { ...barge, ternos: [bargeTerno(1, true), bargeTerno(2, false)] };
  assert.deepEqual(errors(checkRequisition(barge2, { lineup, holidays, related: [shipAL] })), []);
});

/* Requisições montadas a partir dos exemplos da IT (seções 6 a 10). */
function mk({ vessel, local = "ARMAZEM 07", berthing = "Atracado", date = "2026-10-21", period = "07-13", faina, ternos, printedAt = "2026-10-21T02:00:00", epi = "É OBRIGATÓRIO O USO DE EPI." }) {
  return {
    number: `${Math.random()}`.slice(2, 10), vessel: parseVesselName(vessel), local, berthing, port: "Rio de Janeiro", date, period, travelType: "Longo Curso", printedAt,
    ternos: ternos.map(([observation, fns], index) => ({ equipe: index + 1, generalNote: epi, fainas: [{ code: faina, text: "" }], observation, functions: Object.entries(fns).map(([code, vagas]) => ({ code, name: code, vagas })) }))
  };
}
const check = (requisition, extra = {}) => checkRequisition(requisition, { lineup: null, holidays, ...extra });

test("tubos (6.1 a 6.3): soltos sem consertador, amarrados com consertador, desembarque com ENB/BLM/BLC", () => {
  const soltos = { CMA: 1, GC: 1, ESI: 1, EE: 4, CFC: 1, CFP: 1, BLE: 4, PE: 4 };
  const ok = check(mk({ vessel: "BBC ELISABETH", faina: "5.9.3", ternos: [["EMBARQUE DE TUBO SOLTO.", soltos]] }));
  assert.deepEqual([ok.result, ok.operation.key, errors(ok)], ["aprovado", "tubos-embarque-soltos", []]);
  assert.match(errors(check(mk({ vessel: "BBC ELISABETH", faina: "5.9.3", ternos: [["EMBARQUE DE TUBO SOLTO.", { ...soltos, CSC: 1, CBD: 1 }]] })))[0], /tubos soltos não levam consertador/);
  const alavanca = check(mk({ vessel: "BBC ELISABETH", faina: "5.9.3", ternos: [["EMBARQUE DE TUBO SOLTO.", { ...soltos, EE: 6, EGU: 2 }]] }));
  assert.deepEqual(errors(alavanca), [], "EE 6 com alavanca e guia 2 são aceitos");
  const amarrados = check(mk({ vessel: "BBC DANUBE", faina: "5.9.3", ternos: [["EMBARQUE DE AMARRADOS DE TUBOS", { ...soltos, CSC: 1, CBD: 1 }], ["EMBARQUE DE AMARRADOS DE TUBOS", { CMA: 1, GC: 1, ESI: 1, EE: 4, CFP: 1, CBD: 1, BLE: 4, PE: 4 }]] }));
  assert.deepEqual([amarrados.operation.key, errors(amarrados)], ["tubos-embarque-amarrados", []]);
  assert.match(errors(check(mk({ vessel: "BBC DANUBE", faina: "5.9.3", ternos: [["EMBARQUE DE AMARRADOS DE TUBOS", soltos]] })))[0], /falta CSC \(1\); falta CBD \(1\)/);
  const desembarque = check(mk({ vessel: "BBC DANUBE", faina: "5.9.3", ternos: [["DESEMBARQUE DE TUBOS", { CMA: 1, GC: 1, ESI: 1, EE: 4, CFC: 1, CFP: 1, BLE: 4, PE: 4 }]] }));
  assert.match(errors(desembarque)[0], /falta ENB.*falta BLM.*falta BLC.*BLE 4: bloquista de equipe \(BLE 4\) é só para EMBARQUE/);
  const soBloco = check(mk({ vessel: "BBC ELISABETH", faina: "5.9.3", ternos: [["EMBARQUE DE TUBO SOLTO.", soltos], ["EMBARQUE DE TUBO SOLTO.", { BLE: 4 }]] }));
  assert.deepEqual(errors(soBloco), [], "terno só de bloco (6.1 Nota 3)");
});

test("carga geral (7.1 a 7.4): navio padrão, carretel vazio sem consertador, navio com balsa sem capatazia", () => {
  const navio = { CMA: 1, GC: 1, ESI: 1, EE: 4, EEM: 0, CFC: 1, CFP: 1, CSC: 1, CBD: 1, ENB: 1, BLP: 2, PE: 4 };
  const echo = check(mk({ vessel: "BBC ECHO", faina: "7.0", ternos: [["DESEMBARQUE DE CARGA GERAL - 1 EMPILHADOR SOLICITADO", navio]] }));
  assert.deepEqual([echo.result, echo.operation.key], ["aprovado", "carga-geral-navio"], "EEM com 0 vagas (reoferta) não conta");
  const vazio = mk({ vessel: "BBC PHILIPPINES", local: "ARMAZEM 08", faina: "7.0", ternos: [["EMBARQUE DE CARRETEL VAZIO", { CMA: 1, GC: 1, EGU: 2, ESI: 1, EE: 4, CFC: 1, CFP: 1, ENB: 1, BLP: 2 }]] });
  const balsa = mk({ vessel: "BALSA BS5 (AT.BBC PHILIPPINES)", local: "ARMAZEM 08", faina: "7.0", ternos: [["DESCARGA DE CARRETEL VAZIO", { CMA: 1, EE: 4 }]] });
  assert.equal(check(vazio).result, "confirmar", "sem capatazia e sem a requisição da balsa ainda");
  assert.deepEqual([check(vazio, { related: [balsa] }).result, errors(check(vazio, { related: [balsa] }))], ["aprovado", []]);
  const balsaCheck = check(balsa);
  assert.deepEqual([balsaCheck.operation.key, errors(balsaCheck)], ["cargaGeral-balsa", []]);
  assert.match(errors(check({ ...balsa, ternos: [{ ...balsa.ternos[0], functions: [...balsa.ternos[0].functions, { code: "CFP", name: "CFP", vagas: 1 }] }] }))[0], /CFP-CFP \(1\) não faz parte/);
  assert.ok(confirms(check({ ...vazio, ternos: [{ ...vazio.ternos[0], functions: [...vazio.ternos[0].functions, { code: "CSC", name: "CSC", vagas: 1 }, { code: "CBD", name: "CBD", vagas: 1 }] }] }, { related: [balsa] })).some(text => /carretel vazio não precisa de consertador/.test(text)));
});

test("granel (8.1): EE 1, varredura com EE 4 na observação, tratorista aceito e enlonamento em requisição separada", () => {
  const potassio = { CMP: 1, GC: 1, ESI: 1, EE: 1, CFC: 1, CFP: 1 };
  assert.deepEqual(errors(check(mk({ vessel: "PORT OSAKA", local: "PATIO 9", faina: "4.2.4", ternos: [["DESCARGA DE POTÁSSIO", potassio]] }))), []);
  assert.match(errors(check(mk({ vessel: "PORT OSAKA", local: "PATIO 9", faina: "4.2.4", ternos: [["DESCARGA DE POTÁSSIO", { ...potassio, EE: 4 }]] })))[0], /EE com 4 .*EE 4 só com varredura/);
  assert.deepEqual(errors(check(mk({ vessel: "PORT OSAKA", local: "PATIO 9", faina: "4.2.4", ternos: [["DESCARGA DE POTÁSSIO. ESTIVADOR DE EQUIPE 4. SENDO 3 HOMENS DE VARRICÃO", { ...potassio, ETR: 1, EE: 4 }]] }))), []);
  assert.ok(confirms(check(mk({ vessel: "PORT OSAKA", local: "PATIO 9", faina: "4.2.4", ternos: [["DESCARGA DE POTÁSSIO", { ...potassio, PE: 2 }]] }))).some(text => /ENLONAMENTO/.test(text)));
  const lona = check(mk({ vessel: "PORT OSAKA (ENLONAMENTO)", local: "PATIO 9", faina: "4.2.4", ternos: [["DECARGA DE POTÁSSIO - HOMENS DE ENLOMANTO", { PE: 2 }]] }));
  assert.deepEqual([lona.operation.key, errors(lona)], ["enlonamento", []]);
});

test("big bag, amarras, dormentes (Tyvek) e containers (9.1 a 9.4)", () => {
  const completo = { CMP: 1, GC: 1, ESI: 1, EE: 4, CFC: 1, CFP: 1, CSC: 1, CBD: 1, ENB: 1, BLP: 2, PE: 4 };
  assert.deepEqual(errors(check(mk({ vessel: "BBC GDANSK", faina: "15.0", ternos: [["DESCARGA DE MAGNESITA EM BIG BAGS.", completo]] }))), []);
  const amarras = mk({ vessel: "QI LIN SONG", local: "PATIO 8/9", faina: "5.0", ternos: [["DESEMBARQUE DE AMARRAS.", { ...completo, CMP: 0, CMA: 1, PE: 0 }]] });
  const balsaAmarras = mk({ vessel: "BALSA LOCAR I (AT.QI LIN SONG)", local: "PATIO 8/9", faina: "5.0", ternos: [["EMBARQUE DE AMARRAS.", { CMA: 1, EE: 4 }]] });
  assert.equal(check(amarras, { related: [balsaAmarras] }).result, "aprovado");
  assert.deepEqual(errors(check(balsaAmarras)), []);
  const dormentes = { CMA: 1, GC: 1, EEM: 1, ESI: 1, EE: 4, CFC: 1, CFP: 1, CSC: 1, CBD: 1, ENB: 1, BLP: 2, PE: 4 };
  assert.deepEqual(errors(check(mk({ vessel: "BBC DANUBE", local: "ARMAZEM 09", faina: "9.4", ternos: [["DECARGA DE AMARRADOS DE DORMENTES DE MADEIRA - TPA'S DEVERÃO ESTAR DE MACACÃO TYVEK E MÁSCARA", dormentes]] }))), []);
  assert.match(errors(check(mk({ vessel: "BBC DANUBE", local: "ARMAZEM 09", faina: "9.4", ternos: [["DESCARGA DE DORMENTES DE MADEIRA", dormentes]] })))[0], /macacão Tyvek/);
  const dormenteReq = mk({ vessel: "BBC DANUBE", local: "ARMAZEM 09", faina: "9.4", ternos: [["DESCARGA DE DORMENTES - MACACÃO TYVEK", dormentes]] });
  const outraCarga = mk({ vessel: "BBC DANUBE", local: "ARMAZEM 09", faina: "7.0", ternos: [["DESCARGA DE CARGA GERAL", { CMA: 1, GC: 1, ESI: 1, EE: 4, CFC: 1, CFP: 1, CSC: 1, CBD: 1, ENB: 1, BLP: 2, PE: 4 }]] });
  assert.ok(errors(check(outraCarga, { related: [dormenteReq] })).some(text => /macacão Tyvek e máscara/.test(text)), "9.3 Nota 2");
  assert.deepEqual(errors(check(mk({ vessel: "LEOPOLD STAFF", faina: "6.1", ternos: [["DESCARGA DE CONTAINER CHEIO", { CMA: 1, GC: 1, ESI: 1, EE: 4, CFC: 1, CFP: 1, ENB: 1, BLP: 2, PE: 4 }]] }))), []);
});

test("retroativo (10): mostra o dia do trabalho original e o do pedido", () => {
  const retro = mk({ vessel: "07 VEGA S (REF.31/07/2024)", local: "ARMAZEM 08", date: "2024-08-03", period: "13-19", faina: "5.9.3", ternos: [["EMBARQUE DE TUBOS SOLTOS - TERNO RETROATIVO", { CMA: 1, GC: 1, ESI: 1, EE: 4, CFC: 1, CFP: 1, BLE: 4, PE: 4 }]] });
  assert.match(retroactiveCheck(retro)[0].text, /trabalho de quarta 31\/07\/2024, lançado com data de sábado 03\/08\/2024, período 13x19/);
  assert.deepEqual(retroactiveCheck(mk({ vessel: "BBC ELISABETH", faina: "5.9.3", ternos: [["EMBARQUE DE TUBO SOLTO.", {}]] })), []);
});

test("envio, reenvio corrigido e aprovação com justificativa marcando a atividade do turno", async () => {
  const store = memoryStore(), files = memoryAttachmentsStore();
  A.useTeamProvider(async () => null);
  const bytes = new TextEncoder().encode("%PDF-1.4 teste");
  const context = (name, now) => ({ lineup, files, now, read: async () => pages(name) });
  // O 07x13 de 17/10 é pedido no Noturno de 16/10 (atividade fixa às 03:30).
  await A.ensureShift(store, "2026-10-16_N", { now: new Date("2026-10-16T22:05:00-03:00") });
  const first = await R.submit(store, { bytes, name: "07x13.pdf" }, helio, context(CMG, new Date("2026-10-17T03:20:00-03:00")));
  assert.deepEqual([first.id, first.status, first.replaced], ["2026-10-17_25053242-1", "reprovado", false]);
  assert.equal(first.activity, null, "reprovada não marca a atividade");
  await assert.rejects(R.approveWithReason(store, { id: first.id, reason: "ok" }, helio, { files }), /motivo/);
  const approved = await R.approveWithReason(store, { id: first.id, reason: "CMG pedido pelo especialista nesta operação." }, helio, { files, now: new Date("2026-10-17T03:25:00-03:00") });
  assert.equal(approved.status, "aprovado-justificado");
  assert.deepEqual([approved.activity.done, approved.activity.shiftId], [true, "2026-10-16_N"]);
  const task = await store.get("shifts/2026-10-16_N/tasks", "m_estiva-07x13");
  assert.equal(task.status, "done");
  assert.match(task.note, /Requisição 25053242-1 conferida na aba Requisições: aprovada com justificativa/);
  assert.equal(task.attachments[0].type, "application/pdf");

  // Reenvio da mesma requisição: nova conferência, anterior no histórico.
  const again = await R.submit(store, { bytes, name: "07x13-v2.pdf" }, helio, context(CMG, new Date("2026-10-17T03:30:00-03:00")));
  assert.deepEqual([again.replaced, again.history.length, again.history[0].status, again.override], [true, 1, "aprovado-justificado", null]);

  await R.submit(store, { bytes, name: "01x07.pdf" }, helio, context(OBS, new Date("2026-10-23T10:30:00-03:00")));
  const list = await R.list(store, { from: "2026-10-17", to: "2026-10-17" });
  assert.deepEqual(list.map(row => row.period), ["01-07", "07-13"], "mais tarde primeiro");
  await assert.rejects(R.submit(store, { bytes: new TextEncoder().encode("não é pdf"), name: "x.pdf" }, helio, context(CMG)), /PDF da requisição/);
});

test("feriados: lista inicial com Carnaval, Sexta-feira Santa e Corpus Christi, e lista salva vale", async () => {
  const dates = defaultHolidays(2026).map(item => item.date);
  for (const date of ["2026-02-16", "2026-02-17", "2026-04-03", "2026-06-04", "2026-01-20", "2026-04-23", "2026-11-20"]) assert.ok(dates.includes(date), date);
  const store = memoryStore();
  assert.equal((await R.getHolidays(store, new Date("2026-10-23T12:00:00Z"))).custom, false);
  await R.saveHolidays(store, { holidays: [{ date: "2026-12-24", name: "Véspera de Natal" }] }, helio);
  assert.deepEqual((await R.getHolidays(store)).holidays, [{ date: "2026-12-24", name: "Véspera de Natal" }]);
  await assert.rejects(R.saveHolidays(store, { holidays: [{ date: "24/12/2026" }] }, helio), /inválida/);
});

test("acessos antigos: quem tinha Atividades ganha Requisições uma vez só", () => {
  assert.deepEqual(upgradeProfile({ permissions: ["atividades"] }).permissions, ["atividades", "requisicoes"]);
  assert.deepEqual(upgradeProfile({ permissions: ["indicadores"] }).permissions, ["indicadores"]);
  assert.equal(upgradeProfile({ permissions: ["atividades"], profileVersion: 2 }), null, "já migrado: o administrador pode ter tirado");
});
