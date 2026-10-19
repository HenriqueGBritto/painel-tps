/* Visão do painel na URL (?aba=…&ano=…&mes=…&de=…&ate=…), para links compartilháveis.
   Funções puras, testadas em tests/url-state.test.mjs. Expõe window.TpsUrlState. */
(function (root) {
  const VIEWS = ["operacional", "ocupacao", "descarga", "pesagem", "lineup", "mares", "producao", "atividades", "acompanhamento", "configuracao",
    "equipe", "equipe-servico", "equipe-calendario", "equipe-pessoas", "equipe-ferias", "equipe-treinamentos", "equipe-importacao", "acessos"];
  const DEFAULT_VIEW = "operacional";
  const isDate = value => /^20\d\d-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value || "");
  const list = (value, check) => [...new Set(String(value || "").split(",").map(Number).filter(check))].sort((a, b) => a - b);

  /** Lê a query string. Valores inválidos são ignorados, nunca quebram o painel. */
  function parse(search) {
    const params = new URLSearchParams(search || "");
    const view = VIEWS.includes(params.get("aba")) ? params.get("aba") : DEFAULT_VIEW;
    const result = {
      view,
      years: list(params.get("ano"), y => Number.isInteger(y) && y >= 2000 && y <= 2100),
      months: list(params.get("mes"), m => Number.isInteger(m) && m >= 1 && m <= 12),
      start: null, end: null
    };
    if (isDate(params.get("de")) && isDate(params.get("ate")) && params.get("de") <= params.get("ate")) {
      result.start = params.get("de"); result.end = params.get("ate");
    }
    return result;
  }

  /** Monta a query string; omite o que é padrão. Filtros só entram nas abas que os usam. */
  function serialize({ view = DEFAULT_VIEW, years = [], months = [], start = null, end = null } = {}) {
    const params = new URLSearchParams();
    if (view !== DEFAULT_VIEW) params.set("aba", view);
    const usesYearMonth = ["operacional", "ocupacao", "pesagem"].includes(view);
    if (usesYearMonth && years.length) params.set("ano", [...years].sort((a, b) => a - b).join(","));
    if (usesYearMonth && months.length) params.set("mes", [...months].sort((a, b) => a - b).join(","));
    if (view === "descarga" && isDate(start) && isDate(end)) { params.set("de", start); params.set("ate", end); }
    const text = params.toString().replace(/%2C/g, ",");
    return text ? `?${text}` : "";
  }

  root.TpsUrlState = { VIEWS, DEFAULT_VIEW, parse, serialize };
})(typeof window !== "undefined" ? window : globalThis);
