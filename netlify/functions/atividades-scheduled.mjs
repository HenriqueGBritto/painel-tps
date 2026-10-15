/* Virada de turno da aba Atividades: logo depois das 07:00 e das 19:00 de Brasília (10:02 e 22:02 UTC)
   cria o turno que começou e traz as pendências do anterior, mesmo que ninguém tenha encerrado o turno
   nem aberto o painel. Se os horários dos turnos mudarem na Configuração, ajuste o agendamento aqui.
   Funções agendadas só rodam no site publicado; numa prévia, use "Run now" no painel do Netlify. */
import "../../public/shifts.js";
import { activitiesStore } from "../lib/activities-store.mjs";
import { ensureShift, getConfig } from "../lib/activities.mjs";

export default async function handler() {
  const store = activitiesStore();
  if (!store) { console.log("Atividades: Firestore não configurado, virada de turno ignorada."); return new Response(null, { status: 204 }); }
  const now = new Date();
  const config = await getConfig(store);
  const shiftId = globalThis.TpsShifts.shiftIdAt(now, config.hours);
  await ensureShift(store, shiftId, { now });
  console.log(`Atividades: turno ${shiftId} aberto pela virada agendada.`);
  return new Response(null, { status: 204 });
}

export const config = { schedule: "2 10,22 * * *" };
