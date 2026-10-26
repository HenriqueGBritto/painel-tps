/* Dá a largada no robô do OGMO (GitHub Actions, .github/workflows/ogmo.yml) nos horários combinados.
   O agendamento do próprio GitHub pulava e atrasava rodadas (8 a 10 por dia em vez de 28); o do Netlify é pontual.
   Roda nos minutos 7 e 45 de toda hora (UTC) e decide:
   - minuto 7: rodada de hora em hora;
   - minuto 45: só 1 hora antes de cada limite do OGMO (02:45, 08:45, 14:45 e 17:45 em Brasília = 05, 11, 17 e 20 UTC).
   Precisa de GITHUB_DISPATCH_TOKEN no Netlify (token do GitHub só com permissão de Actions neste repositório).
   Se não conseguir acionar, registra o erro na verificação do OGMO (aparece na aba Requisições e no sino).
   Funções agendadas só rodam no site publicado. */
import { activitiesStore } from "../lib/activities-store.mjs";
import { receiveError } from "../lib/ogmo-sync.mjs";
import { dispatch } from "../lib/github-dispatch.mjs";
export { dispatch };

export const PRE_DEADLINE_HOURS_UTC = [5, 11, 17, 20];
/** Nesta hora/minuto (UTC) o robô deve rodar? */
export function shouldRun(date = new Date()) {
  const minute = date.getUTCMinutes();
  if (minute < 30) return true; // rodada de hora em hora
  return PRE_DEADLINE_HOURS_UTC.includes(date.getUTCHours()); // 1 hora antes de um limite
}

export default async function handler() {
  const now = new Date();
  if (!shouldRun(now)) return new Response(null, { status: 204 });
  try {
    await dispatch({ modo: "normal" });
    console.log("Robô do OGMO acionado no GitHub.");
  } catch (error) {
    console.error(error.message);
    const store = activitiesStore();
    if (store) await receiveError(store, { message: error.message }, { now }).catch(() => {});
  }
  return new Response(null, { status: 204 });
}

export const config = { schedule: "7,45 * * * *" };
