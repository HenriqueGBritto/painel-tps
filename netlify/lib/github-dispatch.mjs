/* Aciona o robô do OGMO no GitHub Actions (workflow ogmo.yml) pela API do GitHub.
   Usado pela largada agendada (functions/ogmo-scheduled.mjs) e pela busca sob demanda da aba Requisições.
   Precisa de GITHUB_DISPATCH_TOKEN no Netlify (token só com permissão de Actions neste repositório). */
const REPO = process.env.GITHUB_REPO || "HenriqueGBritto/painel-tps";
const WORKFLOW = "ogmo.yml";

/** inputs: { modo: "normal" | "diagnostico", datas?: "AAAA-MM-DD:AAAA-MM-DD", pedido?: id da busca }. */
export async function dispatch(inputs = { modo: "normal" }, { token = process.env.GITHUB_DISPATCH_TOKEN, fetcher = fetch } = {}) {
  if (!token) throw new Error("Falta GITHUB_DISPATCH_TOKEN no Netlify para acionar o robô do OGMO.");
  const response = await fetcher(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json", "User-Agent": "painel-tps" },
    body: JSON.stringify({ ref: "main", inputs }),
    signal: AbortSignal.timeout(15000)
  });
  if (response.status !== 204) {
    const detail = await response.text().catch(() => "");
    throw new Error(`O GitHub recusou acionar o robô do OGMO (${response.status}${response.status === 401 || response.status === 403 ? ": token inválido, vencido ou sem permissão de Actions" : ""}). ${detail.slice(0, 160)}`);
  }
}
