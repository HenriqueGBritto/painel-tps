process.env.TZ = "America/Sao_Paulo";
import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { readWorkbookViaApi, clearTokenCache } from "../netlify/lib/sheets-api.mjs";
import { loadSheet, clearSheetCache, SHEETS } from "../netlify/lib/sheets.mjs";
import { serviceAccount } from "../netlify/lib/google-auth.mjs";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const account = { client_email: "painel@teste.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) };

/** Google de mentira: token + values:batchGet devolvendo o que `answer` montar a partir dos intervalos pedidos. */
function fakeGoogle(answer, calls = []) {
  return async (url, options = {}) => {
    calls.push(url);
    if (url.startsWith("https://oauth2.googleapis.com/")) return new Response(JSON.stringify({ access_token: "tk" }));
    if (url.includes("/values:batchGet")) {
      assert.equal(options.headers.Authorization, "Bearer tk");
      const params = new URL(url).searchParams;
      return new Response(JSON.stringify({ valueRanges: answer(params.getAll("ranges"), params) }));
    }
    return new Response("", { status: 404 });
  };
}

test("API: só as colunas pedidas viram uma planilha densa, com datas como número de série", async () => {
  clearTokenCache();
  let seen;
  const fetchImpl = fakeGoogle((ranges, params) => {
    seen = { ranges, dim: params.get("majorDimension"), render: params.get("valueRenderOption"), dates: params.get("dateTimeRenderOption") };
    return [{ values: [["DATA", "", 45970.5]] }, { values: [["STATUS", "x", "FINALIZADO", true]] }, {}];
  });
  const wb = await readWorkbookViaApi("abc", { "Base D'X": [10, 23], Outra: [0] }, { account, fetchImpl });
  assert.deepEqual(seen, { ranges: ["'Base D''X'!K:K", "'Base D''X'!X:X", "'Outra'!A:A"], dim: "COLUMNS", render: "UNFORMATTED_VALUE", dates: "SERIAL_NUMBER" });
  const sheet = wb.Sheets["Base D'X"];
  assert.equal(sheet["!ref"], "A1:X4");
  assert.deepEqual(sheet["!data"][2][10], { t: "n", v: 45970.5 });
  assert.equal(sheet["!data"][1][10], undefined, "célula vazia não vira célula");
  assert.deepEqual(sheet["!data"][3][23], { t: "b", v: true });
  assert.equal(wb.Sheets.Outra["!ref"], "A1", "aba sem valores");
});

test("API: abas inteiras por linha; erro de compartilhamento vira mensagem clara; token reaproveitado", async () => {
  clearTokenCache();
  const calls = [];
  const fetchImpl = fakeGoogle(ranges => ranges.map(() => ({ values: [["NAVIO", "TONS"], ["SEA BRAVE", 24781.705, ""]] })), calls);
  const wb = await readWorkbookViaApi("abc", { "2026": null }, { account, fetchImpl });
  assert.equal(wb.Sheets["2026"].B2.v, 24781.705);
  assert.equal(wb.Sheets["2026"].C2, undefined);
  await readWorkbookViaApi("abc", { "2026": null }, { account, fetchImpl });
  assert.equal(calls.filter(u => u.includes("oauth2")).length, 1, "um token por hora, não um por leitura");
  const denied = async url => url.includes("oauth2") ? new Response(JSON.stringify({ access_token: "tk" })) : new Response("{}", { status: 403 });
  await assert.rejects(readWorkbookViaApi("abc", { "2026": null }, { account, fetchImpl: denied }), /não está compartilhada com a conta de serviço/);
});

test("loadSheet: planilha nativa pela API quando há conta de serviço; sem ela ou com falha, pela exportação", async () => {
  const saved = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  try {
    assert.equal(SHEETS.discharge.api, true);
    assert.equal(serviceAccount({}), null);
    assert.equal(serviceAccount({ FIREBASE_SERVICE_ACCOUNT_JSON: "{quebrado" }), null);
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify(account);
    clearSheetCache(); clearTokenCache();
    const calls = [];
    const descarga = ranges => ranges.map(range => {
      const col = range.split("!")[1].split(":")[0];
      const values = { K: ["TONS", "", 120], S: ["DATA", "", 45970.5], W: ["VAGÕES", "", 2], X: ["STATUS", "", "FINALIZADO"] }[col];
      return values ? { values: [values] } : {};
    });
    const data = await loadSheet("discharge", { fetcher: fakeGoogle(descarga, calls), force: true });
    assert.equal(data.dischargeDays.length, 1);
    assert.equal(data.dischargeDays[0].tons, 120);
    assert.ok(calls.every(u => !u.includes("/export")), "não exporta o .xlsx");

    // API fora do ar: cai para a exportação (aqui também falha, e o erro é o da exportação).
    clearSheetCache(); clearTokenCache();
    const broken = async url => url.includes("oauth2") ? new Response(JSON.stringify({ access_token: "tk" })) : new Response("", { status: 500 });
    await assert.rejects(loadSheet("discharge", { fetcher: broken, force: true }), /Google respondeu 500/);
  } finally {
    if (saved === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON; else process.env.FIREBASE_SERVICE_ACCOUNT_JSON = saved;
    clearSheetCache(); clearTokenCache();
  }
});
