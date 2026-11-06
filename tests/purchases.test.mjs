process.env.TZ = "America/Sao_Paulo";
import assert from "node:assert/strict";
import { test } from "node:test";
import { XLSX } from "../netlify/lib/parsers.mjs";
import { parsePurchasesWorkbook, dayOf, statusOf, applicationOf, purchaseTypeOf } from "../netlify/lib/purchases.mjs";
import "../public/purchases-core.js";

const P = globalThis.TpsPurchases;
const serial = iso => (Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000;
const HEAD = ["Linha original", "RMS", "NF", "Produto/Serviço", "Data de Abertura", "Data de Término", "Dias", "Quantidade", "Preço Unitário", "Preço Final", "Preço Baixado NF",
  "Fornecedor", "Aplicação", "Responsável", "Status", "Mês", "Ano", "Tipo de Despesa (sugerido)", "Cód. Tipo", "C.C (sugerido)", "Aprovador", "Confiança", "Motivo da sugestão", "Alertas de preenchimento", "Descrição col. A (original)", "Orçado no TPS?"];
const row = (rms, product, opened, closed, total, nf, supplier, application, status, type, budgeted) =>
  [1, rms, "123", product, serial(opened), closed ? serial(closed) : null, null, 1, total, total, nf, supplier, application, "MARCELLY", status, null, null, type, "1", "02.01 - TPS", "RODOLPHO", "Alta", null, null, "detalhe", budgeted ? "Orçado" : "Não orçado"];

function workbook() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Painel"]]), "Painel");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["CONTROLE DE RMS"], ["nota"], [], HEAD,
    row(100, "Inspeção de guindaste", "2025-01-10", "2025-02-09", 1000, 1200, " MSE ", "MV FORTUNAGRACHT", "FINALIZADO ", "LAUDO E CERTIFICADO", true),
    row(101, "Madeira", "2025-03-05", null, 500, null, "DONNA MADEIRA", "TPS ", "EM ABERTO", "MATERIAL DE PEAÇÃO", true),
    row(102, "Luva", "2026-01-20", "2026-01-25", 200, 200, "mse", "TPS", "FINALIZDO", "EPI E UNIFORMES", false),
    row(103, "Cancelada", "2026-02-02", null, 999, null, "X", "TPS", "CANCELADO", "EPI E UNIFORMES", false),
    [null, null, null, null, null, null, null, null, null, null]]), "Base RMS 25-26");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["ORÇAMENTO"], [], [], [],
    ["Tipo de Despesa", "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro", "Total ano"],
    ["LAUDO E CERTIFICADO", ...Array(12).fill(800), 9600], ["MATERIAL DE PEAÇÃO", ...Array(12).fill(1000), 12000], ["TOTAL", ...Array(12).fill(1800), 21600]]), "Orçamento por Categoria");
  return wb;
}

test("leitura: acha a base pelo cabeçalho, padroniza status, fornecedor e aplicação e lê o orçamento", () => {
  const data = parsePurchasesWorkbook(workbook());
  assert.equal(data.sheet, "Base RMS 25-26");
  assert.equal(data.records.length, 4, "linha vazia no fim é ignorada");
  const [first, second, third] = data.records;
  assert.deepEqual([first.rms, first.opened, first.closed, first.days, first.status, first.supplier, first.application, first.budgeted], ["100", "2025-01-10", "2025-02-09", 30, "FINALIZADO", "MSE", "FORTUNAGRACHT", true]);
  assert.deepEqual([second.status, second.application, second.closed, second.days], ["EM ABERTO", "TPS", null, null]);
  assert.deepEqual([third.status, third.supplier, third.budgeted], ["FINALIZADO", "MSE", false]);
  assert.deepEqual(Object.keys(data.budget.byType), ["LAUDO E CERTIFICADO", "MATERIAL DE PEAÇÃO"]);
  assert.equal(data.budget.byType["MATERIAL DE PEAÇÃO"][2], 1000, "março (com acento) também é lido");
  assert.equal(dayOf("05/03/2025"), "2025-03-05");
  assert.equal(statusOf(""), "SEM STATUS");
  assert.equal(applicationOf("M/V BBC EDGE"), "BBC EDGE");
  assert.deepEqual(["Compra cotada", "DIRETA", ""].map(purchaseTypeOf), ["COTADA", "DIRETA", ""]);
  assert.equal(data.hasPurchaseType, false);
  assert.equal(first.purchaseType, null, "sem a coluna Tipo de compra");
  assert.throws(() => parsePurchasesWorkbook({ SheetNames: ["X"], Sheets: { X: XLSX.utils.aoa_to_sheet([["nada"]]) } }), /base de RMS/);
});

test("indicadores: gasto pela NF sem canceladas, em aberto fora do prazo, prazo, NF e fora do orçamento", () => {
  const records = P.prepare(parsePurchasesWorkbook(workbook()).records);
  const t = P.totals(records, "2025-07-01");
  assert.deepEqual([t.count, t.value], [3, 1900], "RMS 100 vale a NF (1.200), não a RMS (1.000)");
  assert.deepEqual(t.open, { count: 1, value: 500, late: 1 }, "aberta desde março: fora dos 30 dias em julho");
  assert.deepEqual([t.medianDays, t.measured, t.onTime], [17.5, 2, 1], "30 e 5 dias: as duas dentro dos 30 dias");
  assert.deepEqual(t.nf, { count: 2, diff: 200, over10: 1 });
  assert.deepEqual(t.unbudgeted, { count: 1, value: 200 });
  assert.deepEqual(P.filterRecords(records, { year: 2025, months: new Set([3]) }).map(r => r.rms), ["101"]);
  assert.deepEqual(P.filterRecords(records, { search: "fortuna" }).map(r => r.rms), ["100"]);
  assert.deepEqual(P.filterRecords(records, { supplier: "mse" }).map(r => r.rms), ["100", "102"]);
});

test("gráficos: mês a mês, por grupo, orçado × realizado, abertas e diferença de NF", () => {
  const { records: raw, budget } = parsePurchasesWorkbook(workbook());
  const records = P.prepare(raw);
  const [y2025, y2026] = P.monthly(records, [2025, 2026]);
  assert.deepEqual([y2025[0], y2025[1], y2025[2], y2026[0], y2026[1]], [null, 1200, 500, 200, null], "pela data de término (aberta: abertura); cancelada não entra");
  assert.deepEqual(P.monthly(records, [2025], {}, "count")[0].slice(0, 3), [null, 1, 1]);
  assert.deepEqual(P.groupBy(records, r => r.supplier).map(g => [g.key, g.count, g.value]), [["MSE", 2, 1400], ["DONNA MADEIRA", 1, 500]]);
  assert.deepEqual(P.budgetMonths(records, 2025, null), [1, 2, 3], "até o último mês com RMS");
  assert.deepEqual(P.budgetMonths(records, 2025, new Set([2])), [2]);
  const compare = P.budgetCompare(P.filterRecords(records, { year: 2025 }), budget.byType, [1, 2, 3]);
  assert.deepEqual(compare.map(c => [c.type, c.value, c.budget]), [["MATERIAL DE PEAÇÃO", 500, 3000], ["LAUDO E CERTIFICADO", 1200, 2400]]);
  assert.deepEqual(P.openList(records, "2025-04-04").map(r => [r.rms, r.daysOpen, r.deadline, r.late]), [["101", 30, 30, false]]);
  assert.equal(P.openList(records, "2025-04-05")[0].late, true);
  assert.equal(P.openList([{ ...records[1], purchaseType: "DIRETA" }], "2025-03-21")[0].late, true, "compra direta: 15 dias");
  assert.deepEqual(P.nfDifferences(records).map(r => [r.rms, r.diff, Math.round(r.diffShare * 100)]), [["100", 200, 20]]);
});

test("navio, preço e pendências: escala mais próxima da Base SOF, histórico de preço e regras de preenchimento", async () => {
  await import("../public/sof-core.js");
  const records = P.prepare(parsePurchasesWorkbook(workbook()).records);
  const vessels = [{ id: "a", vessel: "FORTUNAGRACHT", operationStart: "2025-01-05T10:00:00.000Z", tons: 500, cargo: "TARUGO", operation: "EXPORTAÇÃO" },
    { id: "b", vessel: "FORTUNAGRACHT", operationStart: "2025-09-01T10:00:00.000Z", tons: 900 }];
  const costs = P.vesselCosts(records, vessels, globalThis.TpsSof.vesselKey);
  assert.deepEqual(costs.map(c => [c.id, c.count, c.value, c.perTon]), [["a", 1, 1200, 2.4]], "MV FORTUNAGRACHT → escala de janeiro");
  const item = (price, opened, supplier = "A") => ({ product: "Inspeção de guindaste", unitPrice: price, opened, supplier, status: "FINALIZADO" });
  const [history] = P.priceHistory([item(100, "2025-01-01"), item(120, "2025-06-01", "B"), item(150, "2026-01-01"), item(0.01, "2026-02-01"), { ...item(1, "2026-02-01"), product: "Outro" }]);
  assert.deepEqual([history.times, history.suppliers, history.min, history.median, history.max, history.last.price, Math.round(history.change * 100)], [3, 2, 100, 120, 150, 150, 25]);
  const found = Object.fromEntries(P.issues(records, "2025-07-01").map(i => [i.key, i.rows.map(r => r.rms)]));
  assert.deepEqual(found["aberta-atrasada"], ["101"]);
  assert.equal(found["sem-tipo-compra"], undefined, "sem a coluna Tipo de compra, não vira pendência");
  assert.deepEqual(found.escrita, ["100", "101", "102"], "\" MSE \", \"MV FORTUNAGRACHT\", \"TPS \", \"FINALIZDO\"");
  assert.deepEqual(records.find(r => r.rms === "100").fixes, ["status", "supplier", "application"]);
  assert.equal(found["sem-nf"], undefined);
});

test("NF: RMS com vários itens e o total da nota repetido em cada linha conta a nota uma vez", () => {
  const item = (product, total, nfTotal) => ({ rms: "193047", nf: "55", line: 1, product, total, nfTotal, status: "FINALIZADO" });
  const repeated = P.invoices([item("FITA 50MM", 9975, 21875), item("CATRACA 50MM", 11900, 21875)]);
  assert.deepEqual(repeated.map(r => [r.total, r.nfTotal, r.product]), [[21875, 21875, "FITA 50MM e mais 1 item"]]);
  assert.deepEqual(P.nfDifferences([item("FITA", 9975, 21875), item("CATRACA", 11900, 21875)]), []);
  const perItem = P.invoices([item("A", 100, 110), item("B", 200, 230)]);
  assert.deepEqual(perItem.map(r => [r.total, r.nfTotal]), [[300, 340]], "valores diferentes por item somam");
  const prepared = P.prepare([item("FITA", 9975, 21875), item("CATRACA", 11900, 21875), { ...item("SEM NF", 50, null), rms: "1" }]);
  assert.deepEqual(prepared.map(r => [Math.round(r.amount), r.nfRepeated]), [[9975, true], [11900, true], [50, false]], "nota repetida dividida pelos itens; sem NF vale a RMS");
  assert.deepEqual(P.issues(prepared, "2026-01-01").find(i => i.key === "nf-repetida").rows.length, 2);
});
