/* Espelho da Base SOF no Google Planilhas: a cada 10 minutos confere se a base mudou e, se sim, reescreve a planilha.
   Também reescreve uma vez por dia, para trazer a desatracação e o berço que chegam depois pela planilha de navios.
   Regras em netlify/lib/sof-mirror.mjs. Funções agendadas só rodam no site publicado. */
import { activitiesStore } from "../lib/activities-store.mjs";
import { syncMirror } from "../lib/sof-mirror.mjs";

export default async function handler() {
  const store = activitiesStore();
  if (!store) return new Response(null, { status: 204 });
  const result = await syncMirror(store);
  if (!result.skipped) console.log("Espelho da Base SOF:", JSON.stringify(result));
  return new Response(null, { status: 204 });
}

export const config = { schedule: "*/10 * * * *" };
