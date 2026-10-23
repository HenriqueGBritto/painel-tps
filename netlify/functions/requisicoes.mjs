/* API da aba Requisições (conferência das requisições de estiva do OGMO).
   GET  /api/requisicoes?de=&ate=     lista do período, feriados e permissões
   POST /api/requisicoes/enviar       corpo = PDF; nome do arquivo no cabeçalho X-Arquivo
   GET  /api/requisicoes/pdf?id=      PDF enviado (versao= para um envio anterior)
   POST /api/requisicoes/hora         { id, at: "AAAA-MM-DDTHH:MM" } hora em que o pedido foi feito
   POST /api/requisicoes/aprovar      { id, reason } aprovar com justificativa
   POST /api/requisicoes/feriados     { holidays: [{ date, name }] }
   Toda rota passa por authorize(); regras em netlify/lib/requisitions.mjs e requisition-rules.mjs. */
import { authorize, actorOf, denied, can, ACTIONS } from "../lib/access.mjs";
import { activitiesStore } from "../lib/activities-store.mjs";
import { attachmentsStore } from "../lib/attachments-store.mjs";
import { loadForServing } from "../lib/snapshots.mjs";
import * as requisitions from "../lib/requisitions.mjs";

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

async function readJson(request) {
  const raw = await request.text();
  if (raw.length > 20_000) throw new requisitions.RequisitionError(413, "Pedido grande demais.");
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new requisitions.RequisitionError(400, "Pedido inválido."); }
}

const routes = {
  "GET /": { action: ACTIONS.readRequisitions, run: async ({ store, url, access }) => ({
    requisitions: await requisitions.list(store, { from: url.searchParams.get("de"), to: url.searchParams.get("ate") }),
    ...(await requisitions.getHolidays(store)),
    canEditHolidays: can(access.user, ACTIONS.configureRequisitions)
  }) },
  "POST /enviar": { action: ACTIONS.sendRequisitions, raw: true, run: async ({ store, request, access }) => {
    const length = Number(request.headers.get("content-length") || 0);
    if (length > requisitions.MAX_PDF_BYTES) throw new requisitions.RequisitionError(413, "Arquivo grande demais: o limite é 5 MB.");
    let name = ""; try { name = decodeURIComponent(request.headers.get("x-arquivo") || ""); } catch { /* nome inválido: usa o número */ }
    const bytes = new Uint8Array(await request.arrayBuffer());
    return requisitions.submit(store, { bytes, name }, actorOf(access), { lineup: await lineup(), files: attachmentsStore() });
  } },
  "GET /pdf": { action: ACTIONS.readRequisitions, run: async ({ store, url }) => {
    const { data, name } = await requisitions.readPdf(store, attachmentsStore(), { id: url.searchParams.get("id"), versao: url.searchParams.get("versao") });
    return new Response(data, { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(name)}`, "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" } });
  } },
  "POST /hora": { action: ACTIONS.sendRequisitions, run: async ({ store, request, access }) => requisitions.informRequestTime(store, await readJson(request), actorOf(access), { lineup: await lineup(), files: attachmentsStore() }) },
  "POST /aprovar": { action: ACTIONS.sendRequisitions, run: async ({ store, request, access }) => requisitions.approveWithReason(store, await readJson(request), actorOf(access), { files: attachmentsStore() }) },
  "POST /feriados": { action: ACTIONS.configureRequisitions, run: async ({ store, request, access }) => requisitions.saveHolidays(store, await readJson(request), actorOf(access)) }
};

export default async function handler(request) {
  const url = new URL(request.url);
  const route = routes[`${request.method} ${url.pathname.replace(/^\/api\/requisicoes/, "").replace(/\/$/, "") || "/"}`];
  if (!route) return json({ error: "Rota não encontrada." }, 404);
  if (request.method === "POST") {
    const origin = request.headers.get("origin");
    const allowedHosts = [url.host, request.headers.get("host"), request.headers.get("x-forwarded-host")].filter(Boolean);
    if (origin && !allowedHosts.includes(new URL(origin).host)) return json({ error: "Origem não permitida." }, 403);
  }
  const access = await authorize(request, route.action);
  if (!access.allowed) return denied(access);
  const store = activitiesStore();
  if (!store) return json({ error: "A aba Requisições precisa do Firestore: configure FIREBASE_SERVICE_ACCOUNT_JSON no Netlify." }, 503);
  try {
    const result = await route.run({ store, url, request, access });
    return result instanceof Response ? result : json(result);
  } catch (error) {
    if (error instanceof requisitions.RequisitionError) return json({ error: error.message }, error.status);
    console.error("Falha na aba Requisições:", error);
    return json({ error: "Não foi possível concluir agora. Tente novamente." }, 500);
  }
}

export const config = { path: ["/api/requisicoes", "/api/requisicoes/*"] };
