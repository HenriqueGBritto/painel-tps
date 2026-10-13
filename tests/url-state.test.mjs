import assert from "node:assert/strict";
import { test } from "node:test";
import "../public/url-state.js";

const U = globalThis.TpsUrlState;

test("URL: visão padrão fica sem parâmetros", () => {
  assert.equal(U.serialize({ view: "operacional", years: [], months: [] }), "");
  assert.deepEqual(U.parse(""), { view: "operacional", years: [], months: [], start: null, end: null });
});

test("URL: aba, anos e meses vão e voltam iguais", () => {
  const view = { view: "ocupacao", years: [2026, 2025], months: [9, 3] };
  const query = U.serialize(view);
  assert.equal(query, "?aba=ocupacao&ano=2025,2026&mes=3,9");
  assert.deepEqual(U.parse(query), { view: "ocupacao", years: [2025, 2026], months: [3, 9], start: null, end: null });
});

test("URL: descarga guarda o intervalo de datas; ano e mês não entram", () => {
  const query = U.serialize({ view: "descarga", years: [2026], months: [10], start: "2026-10-06", end: "2026-10-12" });
  assert.equal(query, "?aba=descarga&de=2026-10-06&ate=2026-10-12");
  assert.deepEqual(U.parse(query), { view: "descarga", years: [], months: [], start: "2026-10-06", end: "2026-10-12" });
});

test("URL: lineup, marés e produção só levam a aba", () => {
  for (const view of ["lineup", "mares", "producao"]) assert.equal(U.serialize({ view, years: [2026], start: "2026-01-01", end: "2026-01-02" }), `?aba=${view}`);
});

test("URL: valores inválidos são ignorados sem quebrar", () => {
  assert.deepEqual(U.parse("?aba=xyz&ano=abc,2026,1800&mes=0,13,5,5&de=2026-13-01&ate=2026-10-12"),
    { view: "operacional", years: [2026], months: [5], start: null, end: null });
  assert.deepEqual(U.parse("?aba=descarga&de=2026-10-12&ate=2026-10-01").start, null, "início depois do fim");
});
