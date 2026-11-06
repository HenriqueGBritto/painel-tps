/* Releitura automática das planilhas (navios, indicadores e Controle de RMS) a cada 6 horas (horário UTC: 00h, 06h, 12h e 18h,
   ou seja, 21h, 03h, 09h e 15h em Brasília). Guarda o resultado no Netlify Blobs.
   A planilha da equipe é lida só 1 vez por dia, na rodada das 06h UTC (03h em Brasília);
   fora disso, só pelo botão "Atualizar dados" na aba Equipe.
   Funções agendadas só rodam no site publicado; numa prévia, use "Run now" no painel do Netlify. */
process.env.TZ = "America/Sao_Paulo";
import { refreshKinds, KINDS, SCHEDULED_KINDS } from "../lib/snapshots.mjs";

/** Rodada (hora UTC) em que a equipe também é relida. */
export const TEAM_REFRESH_HOUR_UTC = 6;
export const kindsForHour = hourUtc => hourUtc === TEAM_REFRESH_HOUR_UTC ? KINDS : SCHEDULED_KINDS;

export default async function handler() {
  const results = await refreshKinds(kindsForHour(new Date().getUTCHours()));
  console.log("Atualização agendada das planilhas:", JSON.stringify(results));
  return new Response(null, { status: 204 });
}

export const config = { schedule: "0 */6 * * *" };
