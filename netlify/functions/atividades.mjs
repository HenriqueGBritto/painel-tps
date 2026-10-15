/* API da aba Atividades (turnos, passagem de serviço, escala e modelos).
   Toda rota passa por authorize() (netlify/lib/access.mjs), hoje liberado; o login entra lá depois.
   As regras ficam em netlify/lib/activities.mjs; os dados no Firestore (activities-store.mjs). */
import { authorize, actorOf, ACTIONS } from "../lib/access.mjs";
import { activitiesStore } from "../lib/activities-store.mjs";
import * as activities from "../lib/activities.mjs";
import { attachmentsStore, MAX_BYTES } from "../lib/attachments-store.mjs";

const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Type": "application/json; charset=utf-8" };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers });
const MAX_BODY = 20_000;

/* Rotas: método + caminho depois de /api/atividades → ação de permissão e função. */
const routes = {
  "GET /status": { action: ACTIONS.readShift, run: async ({ store }) => ({ ok: true, storage: store.kind, persistent: store.kind === "firestore" }) },
  "GET /turno": { action: ACTIONS.readShift, run: ({ store, url, now }) => {
    const id = url.searchParams.get("id");
    return activities.getConfig(store).then(config => activities.getShiftView(store, !id || id === "atual" ? globalThis.TpsShifts.shiftIdAt(now, config.hours) : id, { now, since: url.searchParams.get("versao") }));
  } },
  "GET /historico": { action: ACTIONS.readHistory, run: ({ store, url }) => activities.history(store, { from: url.searchParams.get("de"), to: url.searchParams.get("ate"), assistantId: url.searchParams.get("assistente") || null }).then(shifts => ({ shifts })) },
  "GET /configuracao": { action: ACTIONS.readShift, run: ({ store, now }) => activities.getSettings(store, { now }) },
  "POST /tarefa": { action: ACTIONS.editShift, run: ({ store, body, actor, now }) => activities.addTask(store, body, actor, { now }) },
  "POST /tarefa/excluir": { action: ACTIONS.editShift, run: ({ store, body, actor, now }) => activities.removeTask(store, body, actor, { now }) },
  "POST /tarefa/situacao": { action: ACTIONS.editShift, run: ({ store, body, actor, now }) => activities.setTaskStatus(store, body, actor, { now }) },
  "POST /tarefa/observacao": { action: ACTIONS.editShift, run: ({ store, body, actor, now }) => activities.setTaskNote(store, body, actor, { now, files: attachmentsStore() }) },
  "POST /tarefa/responsavel": { action: ACTIONS.editShift, run: ({ store, body, actor, now }) => activities.assignTask(store, body, actor, { now }) },
  "POST /encerrar": { action: ACTIONS.editShift, run: ({ store, body, actor, now }) => activities.closeShift(store, body, actor, { now }) },
  "POST /turno/ordem": { action: ACTIONS.editShift, run: ({ store, body, actor, now }) => activities.reorderTasks(store, body, actor, { now }) },
  // Anexo: o corpo é o próprio arquivo; turno na URL, nome e autor nos cabeçalhos.
  "POST /anexo": { action: ACTIONS.editShift, raw: true, run: async ({ store, url, request, access, now }) => {
    const length = Number(request.headers.get("content-length") || 0);
    if (length > MAX_BYTES) throw new activities.ActivityError(413, `Arquivo grande demais: o limite é ${MAX_BYTES / 1048576} MB.`);
    const header = name => { try { return decodeURIComponent(request.headers.get(name) || ""); } catch { return ""; } };
    const actor = actorOf(access, { actor: { id: header("x-autor-id"), name: header("x-autor-nome") } });
    const type = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    return activities.uploadAttachment(store, attachmentsStore(), { shiftId: url.searchParams.get("turno"), name: header("x-arquivo"), type, bytes: new Uint8Array(await request.arrayBuffer()) }, actor, { now });
  } },
  "GET /anexo": { action: ACTIONS.readShift, run: async ({ url }) => {
    const { data, metadata } = await activities.readAttachment(attachmentsStore(), { shiftId: url.searchParams.get("turno"), id: url.searchParams.get("id") });
    const disposition = url.searchParams.get("baixar") ? "attachment" : "inline";
    return new Response(data, { headers: { "Content-Type": metadata.type, "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(metadata.name)}`, "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" } });
  } },
  "POST /receber": { action: ACTIONS.editShift, run: ({ store, body, actor, now }) => activities.receiveShift(store, body, actor, { now }) },
  "POST /assistentes": { action: ACTIONS.configure, run: ({ store, body, actor, now }) => activities.saveAssistant(store, body, actor, { now }) },
  "POST /escala": { action: ACTIONS.configure, run: ({ store, body, actor, now }) => activities.saveSchedule(store, body, actor, { now }) },
  "POST /ajustes": { action: ACTIONS.configure, run: ({ store, body, actor, now }) => activities.saveOverride(store, body, actor, { now }) },
  "POST /ajustes/remover": { action: ACTIONS.configure, run: ({ store, body, actor, now }) => activities.removeOverride(store, body, actor, { now }) },
  "POST /modelos": { action: ACTIONS.configure, run: ({ store, body, actor, now }) => activities.saveTemplate(store, body, actor, { now }) },
  "POST /modelos/remover": { action: ACTIONS.configure, run: ({ store, body, actor, now }) => activities.removeTemplate(store, body, actor, { now }) }
};

async function readBody(request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY) throw new activities.ActivityError(413, "Pedido grande demais.");
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new activities.ActivityError(400, "Pedido inválido."); }
}

export default async function handler(request, _context, { now = () => new Date() } = {}) {
  const url = new URL(request.url);
  const route = routes[`${request.method} ${url.pathname.replace(/^\/api\/atividades/, "").replace(/\/$/, "") || "/"}`];
  if (!route) return json({ error: "Rota não encontrada." }, 404);
  if (request.method === "POST") {
    // O site é público: aceita gravações só da própria página.
    const origin = request.headers.get("origin");
    const allowedHosts = [url.host, request.headers.get("host"), request.headers.get("x-forwarded-host")].filter(Boolean);
    if (origin && !allowedHosts.includes(new URL(origin).host)) return json({ error: "Origem não permitida." }, 403);
  }
  const access = await authorize(request, route.action);
  if (!access.allowed) return json({ error: access.error || "Acesso negado." }, access.status || 403);
  const store = activitiesStore();
  if (!store) return json({ error: "A aba Atividades precisa do Firestore: configure FIREBASE_SERVICE_ACCOUNT_JSON no Netlify.", storage: null }, 503);
  try {
    const body = request.method === "POST" && !route.raw ? await readBody(request) : {};
    const result = await route.run({ store, url, body, request, access, actor: actorOf(access, body), now: now() });
    return result instanceof Response ? result : json(result);
  } catch (error) {
    if (error instanceof activities.ActivityError) return json({ error: error.message }, error.status);
    console.error("Falha na aba Atividades:", error);
    return json({ error: "Não foi possível concluir agora. Tente novamente." }, 500);
  }
}

export const config = { path: ["/api/atividades/*"] };
