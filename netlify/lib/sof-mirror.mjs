/* Espelho da Base SOF no Google Planilhas (só para consulta).
   Cada gravação na Base SOF marca o espelho como desatualizado (sofConfig/mirror); a função agendada
   sof-mirror-scheduled reescreve a planilha quando há mudança (ou uma vez por dia, para a desatracação da planilha de navios).
   Acesso: a mesma conta de serviço do Firebase (FIREBASE_SERVICE_ACCOUNT_JSON), com a planilha compartilhada
   com o e-mail dela como Editor e a Google Sheets API ativada no projeto. ID trocável por TPS_SOF_MIRROR_SHEET. */
import { createSign } from "node:crypto";
import { loadForServing } from "./snapshots.mjs";
import { sheetId } from "./sheets.mjs";
import * as sof from "./sof.mjs";

const S = sof.Sof;
export const MIRROR_DEFAULT_ID = "1DruBQd_txJOhWfLY51O1mEQnyqcV29tLS4CuUyYou1w";
const DOC = "mirror";
const DAY = 86400000;
const API = "https://sheets.googleapis.com/v4/spreadsheets";

export const mirrorId = (env = process.env) => sheetId(env.TPS_SOF_MIRROR_SHEET) || MIRROR_DEFAULT_ID;

/** Marca o espelho como desatualizado; a função agendada reescreve na próxima rodada. */
export async function markMirrorDirty(store) {
  const saved = (await store.get(sof.CONFIG, DOC)) || {};
  await store.set(sof.CONFIG, DOC, { ...saved, dirtyAt: new Date().toISOString() });
}

/** Precisa reescrever: houve gravação depois da última cópia, ou a última tem mais de um dia. */
export function mirrorDue(saved, now = Date.now()) {
  if (!saved?.syncedAt) return true;
  const synced = Date.parse(saved.syncedAt);
  return Date.parse(saved.dirtyAt || "") > synced || now - synced > DAY;
}

/* ---------- Conteúdo das abas ---------- */

/** Data do Excel/Planilhas na hora de Brasília (número), para a planilha poder filtrar e somar. */
const serial = iso => { const t = Date.parse(iso || ""); return Number.isFinite(t) ? (t - 3 * 3600000) / DAY + 25569 : ""; };
const round = (value, digits = 2) => value === null || value === undefined || !Number.isFinite(value) ? "" : Math.round(value * 10 ** digits) / 10 ** digits;
const origin = v => v.source !== "sof" ? "Histórico" : v.origin === "base" ? "Histórico (editado)" : "SOF enviado";

/** Abas do espelho a partir dos navios já completados pela planilha de navios. dates = colunas com data e hora. */
export function mirrorTabs(vessels, reasons, now = new Date()) {
  const label = name => S.RESPONSIBLE_LABELS[name] || name || "";
  const navios = [["ID", "Origem", "Navio", "Operação", "Carga", "Cliente", "Berço", "Atracação", "Início", "Fim", "Desatracação", "Toneladas",
    "Espera (h)", "Tempo atracado (h)", "Tempo de operação (h)", ...S.RESPONSIBLES.map(n => `Horas: ${label(n)}`),
    "Prancha bruta (t/dia)", "Prancha líquida (t/dia)", "Prancha Triunfo (t/dia)", "Ocorrências", "Na planilha de navios", "Editado em"]];
  const ocorrencias = [["ID do navio", "Navio", "Início", "Fim", "Duração (min)", "Período", "Terno", "Porão", "Descrição", "Código do motivo", "Motivo padrão", "Responsável", "Peso (t)"]];
  const byReason = new Map();
  for (const v of vessels) {
    const s = S.vesselSummary(v);
    navios.push([v.id, origin(v), v.vessel, v.operation, v.cargo, v.client || "", v.berth || "", serial(v.berthStart), serial(v.operationStart), serial(v.operationEnd), serial(v.berthEnd), round(v.tons, 3),
      round(s.waitDays * 24), round(s.berthDays * 24), round(s.operationDays * 24), ...S.RESPONSIBLES.map(n => round(s.byResponsible[n] * 24)),
      round(s.grossRate, 1), round(s.netRate, 1), round(s.triunfoRate, 1), v.events.length, v.matched ? "Sim" : "Não", serial(v.editedAt)]);
    for (const e of v.events) {
      ocorrencias.push([v.id, v.vessel, serial(e.start), serial(e.end), e.minutes, e.period || "", e.gang || "", e.hold || "", e.description, e.reason || "", e.reasonText || "", label(e.responsible), e.weight ?? ""]);
      if (e.reason) { const r = byReason.get(e.reason) || { count: 0, minutes: 0 }; r.count++; r.minutes += e.minutes || 0; byReason.set(e.reason, r); }
    }
  }
  const motivos = [["Código", "Responsável", "Motivo padrão", "Ocorrências", "Horas"],
    ...reasons.map(r => { const t = byReason.get(r.code) || { count: 0, minutes: 0 }; return [r.code, label(r.responsible), r.text, t.count, round(t.minutes / 60, 1)]; })];
  const when = new Date(now.getTime() - 3 * 3600000).toISOString();
  const sobre = [["Espelho da Base SOF"], [`Atualizado em ${when.slice(8, 10)}/${when.slice(5, 7)}/${when.slice(0, 4)} às ${when.slice(11, 16)} (Brasília).`],
    ["Esta planilha é reescrita pelo Painel de Operações sempre que a Base SOF muda (em até 10 minutos). Não edite aqui: as mudanças se perdem na próxima cópia."],
    ["Para corrigir algo, use o painel: Padronizar (motivos) ou a página do navio (Editar)."],
    ["Horas por responsável: proporcionais ao tempo de operação, como no painel. Ocorrências: tempos como no SOF."]];
  return [
    { title: "Sobre", rows: sobre, dates: [] },
    { title: "Navios", rows: navios, dates: [7, 8, 9, 10, navios[0].length - 1] },
    { title: "Ocorrências", rows: ocorrencias, dates: [2, 3] },
    { title: "Motivos", rows: motivos, dates: [] }
  ];
}

/* ---------- Google ---------- */

const base64url = value => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

/** Token de acesso da conta de serviço só para planilhas (JWT assinado aqui, sem biblioteca do Google). */
export async function googleToken(account, fetchImpl = fetch, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const unsigned = `${base64url({ alg: "RS256", typ: "JWT" })}.${base64url({ iss: account.client_email, scope: "https://www.googleapis.com/auth/spreadsheets", aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(account.private_key, "base64url");
  const response = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) throw new Error(`Google recusou a conta de serviço: ${body.error_description || body.error || response.status}`);
  return body.access_token;
}

async function call(fetchImpl, token, url, method = "GET", payload) {
  const response = await fetchImpl(url, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: payload ? JSON.stringify(payload) : undefined });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = response.status === 403 ? "a planilha não está compartilhada com a conta de serviço (como Editor) ou a Google Sheets API está desativada no projeto"
      : response.status === 404 ? "planilha não encontrada (confira o ID)" : body.error?.message || response.status;
    throw new Error(`Google Planilhas: ${reason}.`);
  }
  return body;
}

/** Reescreve as abas: cria as que faltam, ajusta o tamanho, limpa, grava os valores e formata as datas. */
export async function writeMirror(spreadsheetId, tabs, token, fetchImpl = fetch) {
  const url = `${API}/${spreadsheetId}`;
  const info = await call(fetchImpl, token, `${url}?fields=sheets.properties(sheetId,title)`);
  const existing = new Map((info.sheets || []).map(s => [s.properties.title, s.properties.sheetId]));
  const missing = tabs.filter(t => !existing.has(t.title));
  if (missing.length) {
    const added = await call(fetchImpl, token, `${url}:batchUpdate`, "POST", { requests: missing.map(t => ({ addSheet: { properties: { title: t.title } } })) });
    added.replies.forEach((reply, i) => existing.set(missing[i].title, reply.addSheet.properties.sheetId));
  }
  const requests = [];
  for (const tab of tabs) {
    const id = existing.get(tab.title), columns = Math.max(...tab.rows.map(r => r.length));
    requests.push({ updateSheetProperties: { properties: { sheetId: id, gridProperties: { rowCount: tab.rows.length + 1, columnCount: Math.max(columns, 1), frozenRowCount: tab.title === "Sobre" ? 0 : 1 } }, fields: "gridProperties(rowCount,columnCount,frozenRowCount)" } });
    for (const column of tab.dates) requests.push({ repeatCell: { range: { sheetId: id, startRowIndex: 1, startColumnIndex: column, endColumnIndex: column + 1 }, cell: { userEnteredFormat: { numberFormat: { type: "DATE_TIME", pattern: "dd/mm/yyyy hh:mm" } } }, fields: "userEnteredFormat.numberFormat" } });
    if (tab.title !== "Sobre") requests.push({ repeatCell: { range: { sheetId: id, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat.bold" } });
  }
  await call(fetchImpl, token, `${url}:batchUpdate`, "POST", { requests });
  const range = title => `'${title.replace(/'/g, "''")}'`;
  await call(fetchImpl, token, `${url}/values:batchClear`, "POST", { ranges: tabs.map(t => range(t.title)) });
  await call(fetchImpl, token, `${url}/values:batchUpdate`, "POST", { valueInputOption: "RAW", data: tabs.map(t => ({ range: `${range(t.title)}!A1`, values: t.rows })) });
}

/** Navios da planilha de navios (para desatracação, berço e cliente), como na API da Base SOF. */
async function operationRecords() {
  try {
    const data = await loadForServing("operations");
    return [...(data.records || []), ...(data.activeRecords || [])];
  } catch (error) {
    console.error("Espelho SOF: planilha de navios indisponível:", error);
    return [];
  }
}

/** Reescreve o espelho se estiver desatualizado (force: sempre). Devolve o que fez. */
export async function syncMirror(store, { force = false, env = process.env, fetchImpl = fetch } = {}) {
  const saved = (await store.get(sof.CONFIG, DOC)) || {};
  if (!force && !mirrorDue(saved)) return { skipped: true };
  const raw = env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) return { skipped: true, reason: "sem conta de serviço" };
  const started = new Date();
  try {
    const std = await sof.standardsOf(store);
    const [vessels, records] = await Promise.all([sof.allVessels(store, std), operationRecords()]);
    const tabs = mirrorTabs(vessels.map(v => sof.enrich(v, records)), std.reasons, started);
    await writeMirror(mirrorId(env), tabs, await googleToken(JSON.parse(raw), fetchImpl), fetchImpl);
    await store.set(sof.CONFIG, DOC, { ...saved, syncedAt: started.toISOString(), error: "", vessels: vessels.length });
    return { ok: true, vessels: vessels.length };
  } catch (error) {
    await store.set(sof.CONFIG, DOC, { ...saved, error: error.message, failedAt: started.toISOString() });
    return { ok: false, error: error.message };
  }
}
