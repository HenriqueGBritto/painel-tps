/* Compras: leitura do Controle de RMS (planilha no Drive, aba "Base RMS 25-26" e aba "Orçamento por Categoria").
   As colunas são achadas pelo nome do cabeçalho, não pela posição, para a planilha poder ganhar colunas.
   Na leitura o texto é padronizado: status, fornecedor e aplicação sem espaços sobrando e em maiúsculas,
   "FINALIZDO" → "FINALIZADO", aplicação sem o "MV" na frente. Testado em tests/purchases.test.mjs. */
import { XLSX } from "./parsers.mjs";

const DAY = 86400000;
const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const text = value => String(value ?? "").replace(/\s+/g, " ").trim();
const plain = value => text(value).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const upper = value => text(value).toUpperCase();
const number = value => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const t = text(value).replace(/[R$\s]/g, "");
  if (!t) return null;
  const parsed = Number(t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Data do dia (aaaa-mm-dd) a partir de data do Excel, objeto Date ou texto dd/mm/aaaa. */
export function dayOf(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return new Date(value.getTime() - 3 * 3600000 + 12 * 3600000).toISOString().slice(0, 10);
  if (typeof value === "number" && value > 20000 && value < 80000) return new Date((Math.floor(value) - 25569) * DAY).toISOString().slice(0, 10);
  const t = text(value);
  const br = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(t);
  if (br) return `${br[3]}-${br[2].padStart(2, "0")}-${br[1].padStart(2, "0")}`;
  return /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : null;
}

const STATUS = { "finalizado": "FINALIZADO", "finalizdo": "FINALIZADO", "finalizada": "FINALIZADO", "em aberto": "EM ABERTO", "aberto": "EM ABERTO", "cancelado": "CANCELADO", "cancelada": "CANCELADO" };
export const statusOf = value => STATUS[plain(value)] || (text(value) ? upper(value) : "SEM STATUS");
export const supplierOf = value => upper(value) || "NÃO INFORMADO";
export const applicationOf = value => upper(value).replace(/^M\s*\/?\s*V\.?\s+/, "") || "NÃO INFORMADA";
/** Compra cotada (prazo de 30 dias) ou direta (15 dias); vazio quando a coluna existe mas não foi preenchida. */
export const purchaseTypeOf = value => { const t = plain(value); return !t ? "" : t.includes("cot") ? "COTADA" : t.includes("dir") ? "DIRETA" : upper(value); };

/* Cabeçalhos aceitos para cada campo (sem acento e em minúsculas). O primeiro que existir vale. */
const FIELDS = {
  rms: ["rms"], nf: ["nf"], product: ["produto/servico", "produto"], opened: ["data de abertura"], closed: ["data de termino"],
  quantity: ["quantidade"], unitPrice: ["preco unitario"], total: ["preco final"], nfTotal: ["preco baixado nf"],
  supplier: ["fornecedor"], application: ["aplicacao"], buyer: ["responsavel"], status: ["status"],
  type: ["tipo de despesa (sugerido)", "tipo de despesa"], typeCode: ["cod. tipo"], costCenter: ["c.c (sugerido)", "c.c", "centro de custo"],
  approver: ["aprovador"], budgeted: ["orcado no tps?"], confidence: ["confianca"], purchaseType: ["tipo de compra", "modalidade de compra", "modalidade"], detail: ["descricao col. a (original)", "descricao detalhada", "observacoes"], alerts: ["alertas de preenchimento"]
};

/** Aba e linha do cabeçalho da base: a primeira aba que tem as colunas RMS e Produto. */
function findBase(workbook) {
  for (const name of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: true, defval: null });
    const index = rows.slice(0, 15).findIndex(row => row.some(c => plain(c) === "rms") && row.some(c => plain(c).startsWith("produto")));
    if (index >= 0) return { name, rows, index };
  }
  return null;
}

/** Orçamento mensal por tipo de despesa: { tipo: [jan … dez] }. */
function readBudget(workbook) {
  for (const name of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: true, defval: null });
    const index = rows.slice(0, 15).findIndex(row => plain(row[0]) === "tipo de despesa" && row.some(c => plain(c) === "janeiro"));
    if (index < 0) continue;
    const columns = MONTHS.map(m => rows[index].findIndex(c => plain(c) === plain(m)));
    const budget = {};
    for (const row of rows.slice(index + 1)) {
      const type = upper(row[0]);
      if (!type || type === "TOTAL") continue;
      budget[type] = columns.map(c => (c >= 0 ? number(row[c]) : null) ?? 0);
    }
    return { sheet: name, byType: budget };
  }
  return { sheet: null, byType: {} };
}

/** Lê o Controle de RMS: { records, budget, source }. */
export function parsePurchasesWorkbook(workbook, source = "Controle de RMS") {
  const base = findBase(workbook);
  if (!base) throw new Error("Aba da base de RMS não encontrada (precisa ter as colunas RMS e Produto).");
  const header = base.rows[base.index].map(plain);
  const column = Object.fromEntries(Object.entries(FIELDS).map(([field, names]) => [field, names.map(n => header.indexOf(n)).find(i => i >= 0) ?? -1]));
  const get = (row, field) => column[field] >= 0 ? row[column[field]] : null;
  const records = [];
  for (const [offset, row] of base.rows.slice(base.index + 1).entries()) {
    const rms = text(get(row, "rms")), product = text(get(row, "product"));
    const total = number(get(row, "total"));
    if (!rms && !product && total === null) continue;
    const opened = dayOf(get(row, "opened")), closed = dayOf(get(row, "closed"));
    const supplier = supplierOf(get(row, "supplier")), application = applicationOf(get(row, "application")), status = statusOf(get(row, "status"));
    // Campos que só batem com a lista depois de padronizados (espaço sobrando, minúscula, erro de digitação, "MV").
    const raw = field => String(get(row, field) ?? "");
    const fixes = [["status", status], ["supplier", supplier], ["application", application]].filter(([field, value]) => raw(field) && raw(field) !== value).map(([field]) => field);
    records.push({
      line: base.index + offset + 2, rms: rms === "-" ? "" : rms, nf: text(get(row, "nf")).replace(/^-$/, ""), product: upper(product),
      opened, closed, days: opened && closed ? Math.round((Date.parse(closed) - Date.parse(opened)) / DAY) : null,
      quantity: number(get(row, "quantity")), unitPrice: number(get(row, "unitPrice")), total: total ?? 0, nfTotal: number(get(row, "nfTotal")),
      supplier, application, buyer: upper(get(row, "buyer")) || "NÃO INFORMADO",
      status, type: upper(get(row, "type")) || "A DEFINIR", typeCode: text(get(row, "typeCode")).replace(/^—$/, ""), confidence: text(get(row, "confidence")), fixes,
      // Sem a coluna na planilha, null (o prazo fica em 30 dias para todas).
      purchaseType: column.purchaseType >= 0 ? purchaseTypeOf(get(row, "purchaseType")) : null,
      costCenter: text(get(row, "costCenter")), approver: upper(get(row, "approver")),
      budgeted: column.budgeted >= 0 ? plain(get(row, "budgeted")) === "orcado" : null,
      detail: text(get(row, "detail")), alerts: text(get(row, "alerts"))
    });
  }
  return { records, budget: readBudget(workbook), source, sheet: base.name, hasPurchaseType: column.purchaseType >= 0 };
}
