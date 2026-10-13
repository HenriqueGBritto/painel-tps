/* Releitura automática das duas planilhas a cada 6 horas (horário UTC: 00h, 06h, 12h e 18h,
   ou seja, 21h, 03h, 09h e 15h em Brasília). Guarda o resultado no Netlify Blobs.
   Funções agendadas só rodam no site publicado; numa prévia, use "Run now" no painel do Netlify. */
process.env.TZ = "America/Sao_Paulo";
import { refreshKinds } from "../lib/snapshots.mjs";

export default async function handler() {
  const results = await refreshKinds();
  console.log("Atualização agendada das planilhas:", JSON.stringify(results));
  return new Response(null, { status: 204 });
}

export const config = { schedule: "0 */6 * * *" };
