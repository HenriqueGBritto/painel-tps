import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { useStore, readSnapshot, refreshKinds, requestRefresh, loadForServing, MIN_REFRESH_MS, MAX_AGE_MS } from "../netlify/lib/snapshots.mjs";

let saved;
beforeEach(() => {
  saved = new Map();
  useStore({ get: async key => saved.has(key) ? structuredClone(saved.get(key)) : null, setJSON: async (key, value) => { saved.set(key, structuredClone(value)); } });
});

const loaderAt = (iso, calls = []) => async kind => { calls.push(kind); return { kind, generatedAt: iso }; };

test("primeiro acesso sem cópia lê a planilha e guarda", async () => {
  const calls = [];
  const data = await loadForServing("discharge", { loader: loaderAt("2026-10-13T12:00:00Z", calls), now: () => Date.parse("2026-10-13T12:00:00Z") });
  assert.equal(data.kind, "discharge");
  assert.deepEqual(calls, ["discharge"]);
  assert.equal((await readSnapshot("discharge")).generatedAt, "2026-10-13T12:00:00Z");
});

test("com cópia recente, o acesso não lê o Google", async () => {
  saved.set("snapshot-operations", { generatedAt: "2026-10-13T06:00:00Z", records: [1] });
  const calls = [];
  const data = await loadForServing("operations", { loader: loaderAt("x", calls), now: () => Date.parse("2026-10-13T11:59:00Z") });
  assert.deepEqual(data.records, [1]);
  assert.equal(calls.length, 0);
});

test("cópia antiga demais é relida; se a leitura falhar, a antiga continua valendo", async () => {
  saved.set("snapshot-operations", { generatedAt: "2026-10-12T00:00:00Z", records: [1] });
  const now = () => Date.parse("2026-10-12T00:00:00Z") + MAX_AGE_MS + 1;
  const failing = async () => { throw new Error("Google fora"); };
  assert.deepEqual((await loadForServing("operations", { loader: failing, now })).records, [1]);
  await assert.rejects(loadForServing("discharge", { loader: failing, now }), /Google fora/, "sem cópia nenhuma, o erro sobe para a reserva da API");
});

test("botão: com as duas cópias lidas há menos de 5 minutos, devolve a cópia existente", async () => {
  const base = Date.parse("2026-10-13T12:00:00Z");
  saved.set("snapshot-operations", { generatedAt: "2026-10-13T12:00:00Z" });
  saved.set("snapshot-discharge", { generatedAt: "2026-10-13T11:59:00Z" });
  const calls = [];
  const result = await requestRefresh({ loader: loaderAt("novo", calls), now: () => base + 2 * 60000 });
  assert.equal(result.status, "recent");
  assert.equal(result.retryInMs, MIN_REFRESH_MS - 3 * 60000, "conta a partir da cópia mais antiga");
  assert.equal(calls.length, 0);
});

test("botão: base sem cópia (leitura anterior falhou) não fica bloqueada pela outra", async () => {
  const now = Date.parse("2026-10-13T12:02:00Z");
  saved.set("snapshot-discharge", { generatedAt: "2026-10-13T12:00:00Z" });
  const calls = [];
  const result = await requestRefresh({ loader: loaderAt("2026-10-13T12:02:00Z", calls), now: () => now });
  assert.equal(result.status, "refreshed");
  assert.ok(calls.includes("operations"));
});

test("botão: depois do intervalo relê as duas planilhas e guarda", async () => {
  saved.set("snapshot-operations", { generatedAt: "2026-10-13T06:00:00Z" });
  const calls = [];
  const result = await requestRefresh({ loader: loaderAt("2026-10-13T12:10:00Z", calls), now: () => Date.parse("2026-10-13T12:10:00Z") });
  assert.equal(result.status, "refreshed");
  assert.deepEqual(calls.sort(), ["discharge", "operations"]);
  assert.equal((await readSnapshot("operations")).generatedAt, "2026-10-13T12:10:00Z");
});

test("botão: leitura em andamento bloqueia uma segunda", async () => {
  const now = Date.parse("2026-10-13T12:00:00Z");
  saved.set("refresh-lock", { at: new Date(now - 10000).toISOString() });
  assert.equal((await requestRefresh({ loader: loaderAt("x"), now: () => now })).status, "running");
  saved.set("refresh-lock", { at: new Date(now - 120000).toISOString() });
  assert.equal((await requestRefresh({ loader: loaderAt("x"), now: () => now })).status, "refreshed", "trava velha (função caiu) é ignorada");
  assert.equal(saved.get("refresh-lock").at, new Date(0).toISOString(), "trava liberada no fim");
});

test("leitura nova guarda o que mudou desde a cópia anterior", async () => {
  saved.set("snapshot-discharge", { generatedAt: "2026-10-13T06:00:00Z", dischargeDays: [{ date: "2026-10-12", tons: 100, wagons: 1 }] });
  const loader = async kind => ({ generatedAt: "2026-10-13T12:00:00Z", dischargeDays: kind === "discharge" ? [{ date: "2026-10-12", tons: 100, wagons: 1 }, { date: "2026-10-13", tons: 50, wagons: 1 }] : [] });
  await refreshKinds(["discharge"], { loader });
  const [entry] = (await readSnapshot("discharge")).changeLog;
  assert.deepEqual([entry.at, entry.since, entry.sections[0].title], ["2026-10-13T12:00:00Z", "2026-10-13T06:00:00Z", "Descarga por dia"]);
});

test("falha numa planilha não apaga a cópia anterior dela", async () => {
  saved.set("snapshot-discharge", { generatedAt: "2026-10-12T00:00:00Z", dischargeDays: [1] });
  const loader = async kind => { if (kind === "discharge") throw new Error("timeout"); return { generatedAt: "novo" }; };
  const results = await refreshKinds(undefined, { loader });
  assert.deepEqual(results.discharge, { ok: false, error: "timeout" });
  assert.equal(results.operations.ok, true);
  assert.deepEqual((await readSnapshot("discharge")).dischargeDays, [1]);
});
