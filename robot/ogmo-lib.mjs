/* Partes do robô do OGMO que não dependem do navegador (testadas em tests/ogmo-sync.test.mjs). */

/**
 * Ações do sistema do OGMO que o robô pode disparar: entrar, abrir o Registro de Requisições, escolher porto e
 * período, pesquisar, selecionar requisição/terno e visualizar (PDF). Qualquer outra (Nova Requisição, Inclusão,
 * Alteração, Exclusão, Modifica, Cancela, Duplica, Sair…) é bloqueada antes de sair do navegador.
 */
export const ALLOWED_ACTIONS = new Set(["BTENTRAR", "IWMENU1", "DBLPORTO", "DBLPESQPERIODO", "IWBUSCAR", "IWDBGRID1", "IWDBGRID2", "IWIMAGE5", "IWRELATORIO"]);
/** Botões que podem gerar o PDF ("Visualiza"/impressora). No diagnóstico de 26/10/2026 foi o IWRELATORIO; o robô confere o número no PDF. */
export const PDF_BUTTONS = ["IWRELATORIO", "IWIMAGE5"];
export const MENU_REGISTRO = ["IWMENU1", "IWMENU1_submenu5"];

/** Ação de um envio de formulário do IntraWeb (corpo application/x-www-form-urlencoded). */
export function actionOf(postData) {
  try { return new URLSearchParams(postData || "").get("IW_Action") || ""; } catch { return ""; }
}
export const isAllowed = postData => ALLOWED_ACTIONS.has(actionOf(postData));

/** Datas no horário de Brasília: ontem, hoje e amanhã (o 01x07 de ontem conta para o 07x13 de hoje). */
export function datesAround(now = new Date()) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(now);
  const shift = days => new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10) + days)).toISOString().slice(0, 10);
  return [shift(-1), today, shift(1)];
}
export const brDate = iso => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/** Linhas da grade de requisições (texto das células e o parâmetro do clique de cada linha). */
export function parseGrid(rows, date) {
  return rows.filter(row => row.cells.length >= 6 && /^\d+-\d+$/.test(row.cells[1] || "")).map(row => ({
    date, cancelled: /^SIM$/i.test(row.cells[0]), number: row.cells[1], vessel: row.cells[2], period: (row.cells[3] || "").replace(/\s+/g, ""),
    local: row.cells[4], scaled: /^SIM$/i.test(row.cells[5]), travel: row.cells[6] || "", param: (/'IWDBGRID1'\s*,\s*'([^']*)'/.exec(row.onclick || "") || [])[1] || null
  }));
}

/** O PDF é da requisição selecionada? (texto do "Visualiza": "Requisição: 25053301-1"). */
export const pdfMatches = (text, number) => new RegExp(`Requisi\\S*\\s*:?\\s*${number.replace(/[-]/g, "\\-")}\\b`).test(text || "");
