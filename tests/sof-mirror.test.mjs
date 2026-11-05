process.env.TZ = "America/Sao_Paulo";
import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { memoryStore } from "../netlify/lib/activities-store.mjs";
import * as sof from "../netlify/lib/sof.mjs";
import { mirrorTabs, mirrorDue, googleToken, writeMirror, syncMirror, markMirrorDirty, mirrorId, MIRROR_DEFAULT_ID } from "../netlify/lib/sof-mirror.mjs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const account = { client_email: "painel@projeto.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) };

/** Google falso: guarda os pedidos e responde como a API (token, leitura das abas, batchUpdate, limpar e gravar). */
function fakeGoogle(tabs = ["Página1"]) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method || "GET", body: options.body });
    const ok = body => ({ ok: true, status: 200, json: async () => body });
    if (url.includes("oauth2")) return ok({ access_token: "token-teste" });
    if (options.method === undefined || options.method === "GET") return ok({ sheets: tabs.map((title, i) => ({ properties: { title, sheetId: i } })) });
    const body = JSON.parse(options.body);
    if (url.endsWith(":batchUpdate") && body.requests?.[0]?.addSheet) return ok({ replies: body.requests.map((r, i) => ({ addSheet: { properties: { title: r.addSheet.properties.title, sheetId: 100 + i } } })) });
    return ok({});
  };
  return { calls, fetchImpl };
}

const vessel = () => ({ id: "base-001", source: "base", vessel: "NAVIO", cargo: "TARUGO", operation: "EXPORTAÇÃO", tons: 1000, berth: "PÁTIO 9", client: "CLIENTE", matched: true,
  berthStart: "2026-10-22T03:00:00.000Z", berthEnd: "2026-10-23T09:00:00.000Z", operationStart: "2026-10-22T05:00:00.000Z", operationEnd: "2026-10-23T05:00:00.000Z",
  events: [{ date: "2026-10-22", from: 120, minutes: 60, description: "Not worked due to rain." }, { date: "2026-10-22", from: 180, minutes: 600, description: "Loading steel billets." }].map(e => sof.expandEvent(e)) });

test("espelho: abas com datas como número, horas por responsável e motivos somados", () => {
  const tabs = mirrorTabs([vessel()], sof.REASONS, new Date("2026-11-05T15:00:00.000Z"));
  assert.deepEqual(tabs.map(t => t.title), ["Sobre", "Navios", "Ocorrências", "Motivos"]);
  assert.match(tabs[0].rows[1][0], /05\/11\/2026 às 12:00/);
  const [head, row] = tabs[1].rows;
  assert.equal(row[head.indexOf("Origem")], "Histórico");
  assert.equal(row[head.indexOf("Início")], (Date.parse("2026-10-22T05:00:00.000Z") - 3 * 3600000) / 86400000 + 25569);
  assert.equal(row[head.indexOf("Tempo de operação (h)")], 24);
  assert.equal(row[head.indexOf("Horas: Chuva")] + row[head.indexOf("Horas: Carga")], 24);
  assert.deepEqual(tabs[1].dates.map(i => head[i]), ["Atracação", "Início", "Fim", "Desatracação", "Editado em"]);
  assert.deepEqual(tabs[2].rows[1].slice(9, 12), ["R01", "Not worked due to rain.", "Chuva"]);
  assert.deepEqual(tabs[3].rows.find(r => r[0] === "R01"), ["R01", "Chuva", "Not worked due to rain.", 1, 1]);
});

test("espelho: reescreve quando houve gravação depois da última cópia ou passou um dia", () => {
  const now = Date.parse("2026-11-05T12:00:00.000Z");
  assert.equal(mirrorDue({}, now), true);
  assert.equal(mirrorDue({ syncedAt: "2026-11-05T11:00:00.000Z" }, now), false);
  assert.equal(mirrorDue({ syncedAt: "2026-11-05T11:00:00.000Z", dirtyAt: "2026-11-05T11:30:00.000Z" }, now), true);
  assert.equal(mirrorDue({ syncedAt: "2026-11-04T11:00:00.000Z" }, now), true);
  assert.equal(mirrorId({}), MIRROR_DEFAULT_ID);
  assert.equal(mirrorId({ TPS_SOF_MIRROR_SHEET: "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit" }), "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789");
});

test("espelho: token da conta de serviço é um JWT assinado só com acesso a planilhas", async () => {
  const { calls, fetchImpl } = fakeGoogle();
  assert.equal(await googleToken(account, fetchImpl, Date.parse("2026-11-05T12:00:00.000Z")), "token-teste");
  const assertion = new URLSearchParams(calls[0].body.toString()).get("assertion");
  const [header, claims, signature] = assertion.split(".");
  const payload = JSON.parse(Buffer.from(claims, "base64url").toString());
  assert.deepEqual([payload.iss, payload.scope, payload.exp - payload.iat], [account.client_email, "https://www.googleapis.com/auth/spreadsheets", 3600]);
  assert.ok(createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, signature, "base64url"));
});

test("espelho: cria as abas que faltam, limpa e grava os valores; sem permissão, explica o motivo", async () => {
  const google = fakeGoogle(["Página1", "Navios"]);
  await writeMirror("ID", mirrorTabs([vessel()], sof.REASONS), "token", google.fetchImpl);
  const added = JSON.parse(google.calls[1].body).requests.map(r => r.addSheet.properties.title);
  assert.deepEqual(added, ["Sobre", "Ocorrências", "Motivos"]);
  assert.ok(google.calls.some(c => c.url.endsWith("/values:batchClear")));
  const values = JSON.parse(google.calls.at(-1).body);
  assert.equal(values.valueInputOption, "RAW");
  assert.deepEqual(values.data.map(d => d.range), ["'Sobre'!A1", "'Navios'!A1", "'Ocorrências'!A1", "'Motivos'!A1"]);
  const denied = async () => ({ ok: false, status: 403, json: async () => ({ error: { message: "The caller does not have permission" } }) });
  await assert.rejects(writeMirror("ID", [], "token", denied), /compartilhada com a conta de serviço/);
});

test("espelho: sincronia marca a hora da cópia, pula sem mudança e guarda o erro", async () => {
  sof.useSeed({ source: "teste", vessels: [vessel()], dictionary: {} });
  const store = memoryStore();
  const env = { FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify(account) };
  const google = fakeGoogle();
  assert.deepEqual(await syncMirror(store, { env, fetchImpl: google.fetchImpl }), { ok: true, vessels: 1 });
  assert.ok((await store.get(sof.CONFIG, "mirror")).syncedAt);
  assert.deepEqual(await syncMirror(store, { env, fetchImpl: google.fetchImpl }), { skipped: true });
  await new Promise(r => setTimeout(r, 5));
  await markMirrorDirty(store);
  const failing = async url => url.includes("oauth2") ? { ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) } : google.fetchImpl(url);
  const result = await syncMirror(store, { env, fetchImpl: failing });
  assert.equal(result.ok, false);
  assert.match((await store.get(sof.CONFIG, "mirror")).error, /invalid_grant/);
  assert.deepEqual(await syncMirror(store, { env: {}, fetchImpl: google.fetchImpl }), { skipped: true, reason: "sem conta de serviço" });
  sof.useSeed(null);
});
