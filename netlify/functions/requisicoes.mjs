/* API da aba Requisições (conferência das requisições de estiva do OGMO).
   GET  /api/requisicoes?de=&ate=     lista do período, feriados e permissões
   POST /api/requisicoes/enviar       corpo = PDF; nome do arquivo no cabeçalho X-Arquivo
   GET  /api/requisicoes/pdf?id=      PDF enviado (versao= para um envio anterior)
   POST /api/requisicoes/aprovar      { id, reason } aprovar com justificativa
   POST /api/requisicoes/feriados     { holidays: [{ date, name }] }
   GET  /api/requisicoes/da9?id=      DA9 (trabalhadores escalados) baixado pelo robô
   POST /api/requisicoes/buscar       { de, ate } aciona o robô para ler esses dias no OGMO; GET /buscar?id= acompanha
   Robô do OGMO (robot/ogmo.mjs), com o token OGMO_SYNC_TOKEN em vez de login:
   GET  /api/requisicoes/ogmo/conhecidas?datas=   POST /api/requisicoes/ogmo/pdf   POST /api/requisicoes/ogmo/lista   POST /api/requisicoes/ogmo/erro
   POST /api/requisicoes/ogmo/da9 (cabeçalhos X-Requisicao e X-Data)
   As rotas da equipe passam por authorize(); regras em netlify/lib/requisitions.mjs, requisition-rules.mjs e ogmo-sync.mjs. */
import { authorize, actorOf, denied, can, ACTIONS } from "../lib/access.mjs";
import { activitiesStore } from "../lib/activities-store.mjs";
import { attachmentsStore } from "../lib/attachments-store.mjs";
import { loadForServing } from "../lib/snapshots.mjs";
import * as requisitions from "../lib/requisitions.mjs";
import * as ogmo from "../lib/ogmo-sync.mjs";
import { dispatch } from "../lib/github-dispatch.mjs";

const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Type": "application/json; charset=utf-8" };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers });

/** Navios do lineup e das operações recentes, para conferir nome e local. Sem a planilha, a conferência segue sem cruzar. */
async function lineup() {
  try {
    const data = await loadForServing("operations");
    const recent = Date.now() - 60 * 86400000;
    return [
      ...(data.lineupRecords || []).map(row => ({ vessel: row.vessel, berth: row.berth, plannedBerthStart: row.plannedBerthStart })),
      ...(data.activeRecords || []).map(row => ({ vessel: row.vessel, berth: row.berth, berthStart: row.berthStart })),
      ...(data.records || []).filter(row => Date.parse(row.berthStart || 0) >= recent).map(row => ({ vessel: row.vessel, berth: row.berth, berthStart: row.berthStart }))
    ].filter(row => row.vessel);
  } catch (error) {
    console.error("Requisições: lineup indisponível:", error);
    return null;
  }
}

/** Navios em operação agora (Lineup/operações ativas): sem requisição no dia, aparecem como faltando. */
async function operating() {
  try {
    const data = await loadForServing("operations");
    return (data.activeRecords || []).filter(row => row.vessel && row.operationStart).map(row => row.vessel);
  } catch { return []; }
}

async function readPdfBody(request) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > requisitions.MAX_PDF_BYTES) throw new requisitions.RequisitionError(413, "Arquivo grande demais: o limite é 5 MB.");
  let name = ""; try { name = decodeURIComponent(request.headers.get("x-arquivo") || ""); } catch { /* nome inválido: usa o número */ }
  return { bytes: new Uint8Array(await request.arrayBuffer()), name };
}

async function readJson(request, max = 20_000) {
  const raw = await request.text();
  if (raw.length > max) throw new requisitions.RequisitionError(413, "Pedido grande demais.");
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new requisitions.RequisitionError(400, "Pedido inválido."); }
}

const routes = {
  "GET /": { action: ACTIONS.readRequisitions, run: async ({ store, url, access }) => ({
    requisitions: await requisitions.list(store, { from: url.searchParams.get("de"), to: url.searchParams.get("ate") }),
    ...(await requisitions.getHolidays(store)),
    canEditHolidays: can(access.user, ACTIONS.configureRequisitions),
    sync: await ogmo.syncStatus(store),
    search: await ogmo.currentSearch(store)
  }) },
  "POST /enviar": { action: ACTIONS.sendRequisitions, raw: true, run: async ({ store, request, access }) => requisitions.submit(store, await readPdfBody(request), actorOf(access), { lineup: await lineup(), files: attachmentsStore() }) },
  "GET /pdf": { action: ACTIONS.readRequisitions, run: async ({ store, url }) => {
    const { data, name } = await requisitions.readPdf(store, attachmentsStore(), { id: url.searchParams.get("id"), versao: url.searchParams.get("versao") });
    return new Response(data, { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(name)}`, "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" } });
  } },
  "POST /aprovar": { action: ACTIONS.sendRequisitions, run: async ({ store, request, access }) => requisitions.approveWithReason(store, await readJson(request), actorOf(access), { files: attachmentsStore() }) },
  "POST /feriados": { action: ACTIONS.configureRequisitions, run: async ({ store, request, access }) => requisitions.saveHolidays(store, await readJson(request), actorOf(access)) },
  "GET /da9": { action: ACTIONS.readRequisitions, run: async ({ store, url }) => {
    const { data, name } = await ogmo.readDa9(store, attachmentsStore(), url.searchParams.get("id"));
    return new Response(data, { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(name)}`, "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" } });
  } },
  "POST /buscar": { action: ACTIONS.sendRequisitions, run: async ({ store, request, access }) => ogmo.requestSearch(store, await readJson(request), actorOf(access), { dispatcher: dispatch }) },
  "GET /buscar": { action: ACTIONS.readRequisitions, run: async ({ store, url }) => ogmo.searchStatus(store, url.searchParams.get("id")) },
  // Robô do OGMO.
  "GET /ogmo/conhecidas": { robot: true, run: async ({ store, url }) => ({ known: await ogmo.known(store, String(url.searchParams.get("datas") || "").split(",")) }) },
  "POST /ogmo/pdf": { robot: true, raw: true, run: async ({ store, request }) => {
    const body = await readPdfBody(request);
    return ogmo.receivePdf(store, { ...body, scaled: request.headers.get("x-escalada") === "1" }, { lineup: await lineup(), files: attachmentsStore() });
  } },
  "POST /ogmo/lista": { robot: true, run: async ({ store, request }) => ogmo.receiveList(store, await readJson(request, 200_000), { lineup: await lineup(), operating: await operating() }) },
  "POST /ogmo/erro": { robot: true, run: async ({ store, request }) => ogmo.receiveError(store, await readJson(request)) },
  "POST /ogmo/da9": { robot: true, raw: true, run: async ({ store, request }) => {
    const { bytes } = await readPdfBody(request);
    return ogmo.receiveDa9(store, attachmentsStore(), { bytes, number: request.headers.get("x-requisicao"), date: request.headers.get("x-data") });
  } }
};

export default async function handler(request) {
  const url = new URL(request.url);
  const route = routes[`${request.method} ${url.pathname.replace(/^\/api\/requisicoes/, "").replace(/\/$/, "") || "/"}`];
  if (!route) return json({ error: "Rota não encontrada." }, 404);
  if (route.robot) {
    if (!process.env.OGMO_SYNC_TOKEN) return json({ error: "Verificação do OGMO não configurada: falta OGMO_SYNC_TOKEN no Netlify." }, 503);
    if (!ogmo.tokenOk(request)) return json({ error: "Token inválido." }, 401);
  } else if (request.method === "POST") {
    const origin = request.headers.get("origin");
    const allowedHosts = [url.host, request.headers.get("host"), request.headers.get("x-forwarded-host")].filter(Boolean);
    if (origin && !allowedHosts.includes(new URL(origin).host)) return json({ error: "Origem não permitida." }, 403);
  }
  const access = route.robot ? { allowed: true, user: null } : await authorize(request, route.action);
  if (!access.allowed) return denied(access);
  const store = activitiesStore();
  if (!store) return json({ error: "A aba Requisições precisa do Firestore: configure FIREBASE_SERVICE_ACCOUNT_JSON no Netlify." }, 503);
  try {
    const result = await route.run({ store, url, request, access });
    return result instanceof Response ? result : json(result);
  } catch (error) {
    if (error instanceof requisitions.RequisitionError || error instanceof ogmo.SyncError) return json({ error: error.message }, error.status);
    console.error("Falha na aba Requisições:", error);
    return json({ error: "Não foi possível concluir agora. Tente novamente." }, 500);
  }
}

export const config = { path: ["/api/requisicoes", "/api/requisicoes/*"] };
