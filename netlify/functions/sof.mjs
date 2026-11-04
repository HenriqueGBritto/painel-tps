/* API da Base SOF (indicadores Operacional e Ocupação).
   GET    /api/sof                 navios (histórico + enviados) com o resumo de cada um, para os indicadores
   GET    /api/sof/navio?id=       um navio com todas as ocorrências
   GET    /api/sof/exportar        todos os navios com as ocorrências, o dicionário e os motivos padrão (exportação para Excel)
   GET    /api/sof/planilha?navio=&inicio=   navio correspondente na planilha de navios
   GET    /api/sof/dicionario      dicionário de responsáveis (descrição → contagens e responsável fixo)
   POST   /api/sof/dicionario      { key, responsible } fixa o responsável de uma descrição (vazio solta)
   POST   /api/sof/navios          salva um SOF lido no navegador (public/sof-core.js) com os responsáveis escolhidos
   DELETE /api/sof/navios?id=      apaga um SOF enviado
   Regras em netlify/lib/sof.mjs. */
import { authorize, actorOf, denied, ACTIONS } from "../lib/access.mjs";
import { activitiesStore } from "../lib/activities-store.mjs";
import { loadForServing } from "../lib/snapshots.mjs";
import * as sof from "../lib/sof.mjs";

const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Type": "application/json; charset=utf-8" };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers });
const unavailable = () => json({ error: "Armazenamento indisponível: confira o Firestore no Netlify." }, 503);

/** Navios da planilha de navios (concluídos e em andamento), para desatracação, berço e cliente. */
async function operations() {
  try {
    const data = await loadForServing("operations");
    return [...(data.records || []), ...(data.activeRecords || [])];
  } catch (error) {
    console.error("SOF: planilha de navios indisponível:", error);
    return [];
  }
}

async function readBody(request) {
  try { return await request.json(); } catch { return null; }
}

export default async function handler(request) {
  const url = new URL(request.url);
  const route = url.pathname.replace(/^\/api\/sof\/?/, "");
  const reading = request.method === "GET";
  const access = await authorize(request, reading ? ACTIONS.readSof : ACTIONS.sendSof);
  if (!access.allowed) return denied(access, headers);
  const store = activitiesStore();

  if (reading && route === "") {
    const [vessels, records] = await Promise.all([sof.allVessels(store), operations()]);
    return json({ vessels: vessels.map(v => sof.summaryOf(sof.enrich(v, records))), source: sof.seed().source, operationsAvailable: records.length > 0 });
  }
  if (reading && route === "navio") {
    const id = url.searchParams.get("id");
    const [vessels, records] = await Promise.all([sof.allVessels(store), operations()]);
    const vessel = vessels.find(v => v.id === id);
    return vessel ? json({ vessel: sof.enrich(vessel, records) }) : json({ error: "Navio não encontrado." }, 404);
  }
  if (reading && route === "exportar") {
    const [vessels, records, dictionary] = await Promise.all([sof.allVessels(store), operations(), sof.dictionary(store)]);
    return json({ vessels: vessels.map(v => sof.exportOf(sof.enrich(v, records))), dictionary, reasons: sof.REASONS });
  }
  if (reading && route === "dicionario") return json({ dictionary: await sof.dictionary(store), autoShare: sof.Sof.AUTO_SHARE });
  if (reading && route === "planilha") {
    // Navio na planilha de navios, para completar o SOF antes de salvar (carga, berço, cliente, desatracação).
    const match = sof.matchOperation({ vessel: url.searchParams.get("navio") || "", berthStart: url.searchParams.get("inicio") || "" }, await operations());
    return json({ match: match ? { vessel: match.vessel, cargo: match.cargo, operation: match.operation, berth: match.berth, client: match.client, berthStart: match.berthStart, berthEnd: match.berthEnd || null } : null });
  }
  if (!store) return unavailable();

  if (request.method === "POST" && route === "dicionario") {
    const body = await readBody(request);
    const result = await sof.fixResponsible(store, String(body?.key || ""), String(body?.responsible || ""), actorOf(access));
    return result.error ? json(result, 400) : json(result);
  }
  if (request.method === "POST" && route === "navios") {
    const body = await readBody(request);
    const { vessel, error } = sof.validateVessel(body);
    if (error) return json({ error }, 400);
    const id = sof.vesselId(vessel);
    const previous = await store.get(sof.VESSELS, id);
    await store.set(sof.VESSELS, id, { ...vessel, id, savedAt: new Date().toISOString(), savedBy: actorOf(access) });
    // Reenvio do mesmo SOF não conta as escolhas duas vezes no dicionário.
    if (!previous) await sof.learnFrom(store, vessel.events);
    return json({ ok: true, id, replaced: Boolean(previous) });
  }
  if (request.method === "DELETE" && route === "navios") {
    const id = url.searchParams.get("id") || "";
    const current = await store.get(sof.VESSELS, id);
    if (!current || current.deleted) return json({ error: "SOF enviado não encontrado." }, 404);
    await store.remove(sof.VESSELS, id);
    return json({ ok: true });
  }
  return json({ error: "Rota não encontrada." }, 404);
}

export const config = { path: ["/api/sof", "/api/sof/*"] };
