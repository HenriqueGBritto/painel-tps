/* Leitura das planilhas nativas do Google Planilhas pela API, com a conta de serviço do painel.
   Exportar a planilha de indicadores em .xlsx leva cerca de 50 s (o Google converte o arquivo inteiro); pela API
   vêm só as abas e colunas usadas, já como valores (datas como número de série, como no .xlsx lido com cellDates: false).
   A planilha precisa estar compartilhada com o e-mail da conta de serviço. O resultado tem o mesmo formato das
   planilhas do SheetJS, então os leitores (parsers.mjs) não mudam. */
import { XLSX } from "./parsers.mjs";
import { googleToken } from "./google-auth.mjs";

const API = "https://sheets.googleapis.com/v4/spreadsheets";
let tokenCache = null;

async function token(account, fetchImpl, now) {
  if (tokenCache && tokenCache.email === account.client_email && tokenCache.until > now) return tokenCache.value;
  const value = await googleToken(account, fetchImpl, now);
  tokenCache = { email: account.client_email, value, until: now + 50 * 60000 };
  return value;
}
export function clearTokenCache() { tokenCache = null; }

const quoted = tab => `'${tab.replace(/'/g, "''")}'`;
const cellOf = value => value === "" || value === null || value === undefined ? null
  : typeof value === "number" ? { t: "n", v: value } : typeof value === "boolean" ? { t: "b", v: value } : { t: "s", v: String(value) };

/** Aba inteira (linhas) → planilha do SheetJS. */
function sheetFromRows(rows) {
  return XLSX.utils.aoa_to_sheet((rows || []).map(row => row.map(value => value === "" ? null : value)));
}

/** Só algumas colunas → planilha "densa" ({ "!ref", "!data" }), como a de fast-xlsx.mjs. */
function sheetFromColumns(columns) {
  const data = [];
  let maxRow = 0, maxCol = 0;
  for (const [col, values] of columns) {
    (values || []).forEach((value, row) => {
      const cell = cellOf(value);
      if (!cell) return;
      (data[row] ||= [])[col] = cell;
      maxRow = Math.max(maxRow, row); maxCol = Math.max(maxCol, col);
    });
  }
  return { "!ref": XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxRow, c: maxCol } }), "!data": data };
}

/** plan: { aba: null (inteira) | [colunas, 0 = A] }. Todas as abas do plano no mesmo formato (inteiras ou por coluna). */
export async function readWorkbookViaApi(id, plan, { account, fetchImpl = fetch, now = Date.now(), timeout = 25000 } = {}) {
  const tabs = Object.keys(plan);
  const byColumn = tabs.some(tab => plan[tab]);
  const ranges = byColumn
    ? tabs.flatMap(tab => plan[tab].map(col => ({ tab, col, range: `${quoted(tab)}!${XLSX.utils.encode_col(col)}:${XLSX.utils.encode_col(col)}` })))
    : tabs.map(tab => ({ tab, range: quoted(tab) }));
  const params = new URLSearchParams({ majorDimension: byColumn ? "COLUMNS" : "ROWS", valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "SERIAL_NUMBER" });
  ranges.forEach(r => params.append("ranges", r.range));
  const started = Date.now();
  const response = await fetchImpl(`${API}/${id}/values:batchGet?${params}`, {
    headers: { Authorization: `Bearer ${await token(account, fetchImpl, now)}` }, signal: AbortSignal.timeout(timeout)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = response.status === 403 ? "a planilha não está compartilhada com a conta de serviço do painel"
      : response.status === 404 ? "planilha não encontrada (confira o ID)" : body.error?.message || response.status;
    throw new Error(`Google Planilhas (API): ${reason}.`);
  }
  const values = body.valueRanges || [];
  if (values.length !== ranges.length) throw new Error("Google Planilhas (API): resposta incompleta.");
  const Sheets = {};
  for (const tab of tabs) {
    const mine = ranges.map((r, i) => ({ ...r, values: values[i].values || [] })).filter(r => r.tab === tab);
    Sheets[tab] = byColumn ? sheetFromColumns(mine.map(r => [r.col, r.values[0] || []])) : sheetFromRows(mine[0].values);
  }
  console.log(`Planilha ${id} lida pela API em ${Date.now() - started} ms (${ranges.length} intervalos).`);
  return { SheetNames: tabs, Sheets };
}
