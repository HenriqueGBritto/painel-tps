/* Compras (Controle de RMS): filtros e indicadores. Roda no navegador (window.TpsPurchases) e nos testes (globalThis.TpsPurchases).
   Regras combinadas com o setor de Compras (06/11/2026):
   - Gasto = valor da NF baixada quando houver; sem NF, o valor final da RMS. Sem as canceladas.
   - Mês e ano = data de término (material entregue e pago); sem término, a data de abertura.
   - Prazo: compra cotada 30 dias, compra direta 15 dias (coluna "Tipo de compra"; sem ela, 30 dias).
   Chame prepare() nos registros lidos antes de usar o resto. Testado em tests/purchases.test.mjs. */
(function (root) {
  const DAY = 86400000;
  const DEADLINES = { COTADA: 30, DIRETA: 15 };
  const DEFAULT_DEADLINE = DEADLINES.COTADA;
  const isSpend = r => r.status !== "CANCELADO";
  const plain = value => String(value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const amountOf = r => r.amount ?? r.total ?? 0;
  const sum = (rows, f = amountOf) => rows.reduce((s, r) => s + f(r), 0);
  /** Data que conta para o mês do gasto: término; sem término, abertura. */
  const dateOf = r => r.closed || r.opened || null;
  const monthOf = r => { const d = dateOf(r); return d ? { year: Number(d.slice(0, 4)), month: Number(d.slice(5, 7)) } : null; };
  /** Prazo da RMS pelo tipo de compra. */
  const deadlineOf = r => DEADLINES[r.purchaseType] || DEFAULT_DEADLINE;

  function median(values) {
    const list = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b);
    if (!list.length) return null;
    const mid = list.length >> 1;
    return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
  }
  const percentile = (values, p) => { const list = values.filter(Number.isFinite).sort((a, b) => a - b); return list.length ? list[Math.min(list.length - 1, Math.floor(list.length * p))] : null; };

  /* Itens da mesma RMS e NF. Quando todos trazem o mesmo valor de NF, é o total da nota repetido em cada linha
     (jeito antigo da planilha); valores diferentes são o valor de cada item (jeito combinado daqui em diante). */
  function invoiceGroups(rows) {
    const map = new Map();
    for (const r of rows.filter(isSpend)) {
      if (r.nfTotal === null || r.nfTotal === undefined) continue;
      const key = r.rms ? `${r.rms}|${r.nf}` : `linha-${r.line}`;
      map.set(key, [...(map.get(key) || []), r]);
    }
    return [...map.values()].map(items => {
      const values = items.map(r => r.nfTotal);
      const repeated = items.length > 1 && values.every(v => v === values[0]);
      return { items, repeated, nfTotal: repeated ? values[0] : values.reduce((s, v) => s + v, 0), total: items.reduce((s, r) => s + (r.total || 0), 0) };
    });
  }

  /**
   * Valor de cada linha (amount): o da NF quando houver. Nota repetida em vários itens é dividida entre eles
   * na proporção do valor da RMS de cada um. nfRepeated marca essas linhas (pendência de preenchimento).
   */
  function prepare(records) {
    const extra = new Map();
    for (const group of invoiceGroups(records)) {
      for (const r of group.items) {
        const amount = group.repeated ? (group.total > 0 ? group.nfTotal * (r.total || 0) / group.total : group.nfTotal / group.items.length) : r.nfTotal;
        extra.set(r, { amount, nfRepeated: group.repeated });
      }
    }
    return records.map(r => ({ ...r, amount: extra.get(r)?.amount ?? (r.total || 0), nfRepeated: extra.get(r)?.nfRepeated || false }));
  }

  /** Filtro: { year, months (Set), type, buyer, status, supplier, search }. */
  function filterRecords(records, f = {}) {
    const search = plain(f.search).trim();
    return records.filter(r => {
      const when = monthOf(r);
      if (f.year && when?.year !== f.year) return false;
      if (f.months?.size && !f.months.has(when?.month)) return false;
      if (f.type && r.type !== f.type) return false;
      if (f.buyer && r.buyer !== f.buyer) return false;
      if (f.status && r.status !== f.status) return false;
      if (f.supplier && !plain(r.supplier).includes(plain(f.supplier))) return false;
      return !search || [r.rms, r.nf, r.product, r.supplier, r.application, r.detail].some(v => plain(v).includes(search));
    });
  }

  /** Dias em aberto até hoje (RMS em aberto) ou null. */
  const daysOpen = (r, today) => r.status === "EM ABERTO" && r.opened ? Math.max(0, Math.floor((Date.parse(today) - Date.parse(r.opened)) / DAY)) : null;
  const isLate = (r, today) => daysOpen(r, today) > deadlineOf(r);

  /** RMS com NF baixada, uma por RMS, comparando a soma dos itens com a NF. */
  function invoices(rows) {
    return invoiceGroups(rows).filter(g => g.total > 0).map(g => {
      const first = g.items[0];
      const product = g.items.length > 1 ? `${first.product} e mais ${g.items.length - 1} ${g.items.length === 2 ? "item" : "itens"}` : first.product;
      return { ...first, product, items: g.items, total: g.total, nfTotal: g.nfTotal };
    });
  }

  /** Cartões do topo para um conjunto de RMS. today = aaaa-mm-dd. */
  function totals(rows, today) {
    const spend = rows.filter(isSpend);
    const open = rows.filter(r => r.status === "EM ABERTO");
    const done = rows.filter(r => r.status === "FINALIZADO" && Number.isFinite(r.days));
    const withNf = invoices(rows);
    const unbudgeted = spend.filter(r => r.budgeted === false);
    return {
      count: spend.length, value: sum(spend),
      open: { count: open.length, value: sum(open), late: open.filter(r => isLate(r, today)).length },
      medianDays: median(done.map(r => r.days)), p90Days: percentile(done.map(r => r.days), 0.9), measured: done.length,
      onTime: done.length ? done.filter(r => r.days <= deadlineOf(r)).length / done.length : null,
      nf: { count: withNf.length, diff: withNf.reduce((s, r) => s + r.nfTotal - r.total, 0), over10: withNf.filter(r => Math.abs(r.nfTotal / r.total - 1) > 0.1).length },
      unbudgeted: { count: unbudgeted.length, value: sum(unbudgeted) }
    };
  }

  /** Gasto (ou quantidade) mês a mês de cada ano, para o gráfico. metric: "value" | "count". */
  function monthly(records, years, f = {}, metric = "value") {
    const rows = filterRecords(records, { ...f, year: null, months: null }).filter(isSpend);
    return years.map(year => Array.from({ length: 12 }, (_, i) => {
      const inMonth = rows.filter(r => { const w = monthOf(r); return w?.year === year && w.month === i + 1; });
      return inMonth.length ? (metric === "count" ? inMonth.length : sum(inMonth)) : null;
    }));
  }

  /** Soma por um campo (tipo, fornecedor, aplicação, responsável), do maior para o menor valor. */
  function groupBy(rows, key) {
    const map = new Map();
    for (const r of rows.filter(isSpend)) {
      const k = key(r);
      const item = map.get(k) || { key: k, count: 0, value: 0, days: [], budgeted: r.budgeted };
      item.count++; item.value += amountOf(r);
      if (r.status === "FINALIZADO" && Number.isFinite(r.days)) item.days.push(r.days);
      map.set(k, item);
    }
    return [...map.values()].map(({ days, ...item }) => ({ ...item, medianDays: median(days) })).sort((a, b) => b.value - a.value);
  }

  /**
   * Meses que entram na comparação com o orçamento: o mês escolhido ou, sem mês, de janeiro
   * até o último mês com gasto no ano (o ano em andamento não é comparado com o orçamento inteiro).
   */
  function budgetMonths(records, year, months) {
    if (months?.size) return [...months].sort((a, b) => a - b);
    const last = Math.max(0, ...records.map(monthOf).filter(w => w?.year === year).map(w => w.month));
    return Array.from({ length: last }, (_, i) => i + 1);
  }

  /** Orçado × realizado nos tipos que têm orçamento. rows = RMS já filtradas pelo período. */
  function budgetCompare(rows, budget, months) {
    const spent = new Map(groupBy(rows, r => r.type).map(g => [g.key, g.value]));
    return Object.entries(budget || {}).map(([type, values]) => {
      const limit = months.reduce((s, m) => s + (values[m - 1] || 0), 0);
      const value = spent.get(type) || 0;
      return { type, value, budget: limit, share: limit ? value / limit : null };
    }).sort((a, b) => b.budget - a.budget);
  }

  /** RMS em aberto, da mais antiga para a mais nova, com o prazo de cada uma. */
  function openList(rows, today) {
    return rows.filter(r => r.status === "EM ABERTO").map(r => ({ ...r, daysOpen: daysOpen(r, today), deadline: deadlineOf(r), late: isLate(r, today) }))
      .sort((a, b) => (b.daysOpen ?? -1) - (a.daysOpen ?? -1));
  }

  /** RMS cuja NF veio mais de 10% diferente do valor da RMS, da maior diferença (em R$) para a menor. */
  function nfDifferences(rows) {
    return invoices(rows).filter(r => Math.abs(r.nfTotal / r.total - 1) > 0.1)
      .map(r => ({ ...r, diff: r.nfTotal - r.total, diffShare: r.nfTotal / r.total - 1 })).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  }

  /**
   * Gasto de cada escala de navio: a aplicação da RMS com o mesmo nome de um navio da Base SOF (vesselKey) e a escala
   * com início de operação mais perto da abertura da RMS (até 60 dias). Com as toneladas da escala, dá o custo por tonelada.
   */
  function vesselCosts(rows, vessels, vesselKey) {
    const calls = vessels.map(v => ({ ...v, key: vesselKey(v.vessel), start: Date.parse(v.operationStart || "") })).filter(v => v.key && Number.isFinite(v.start));
    const byKey = new Map();
    for (const call of calls) byKey.set(call.key, [...(byKey.get(call.key) || []), call]);
    const map = new Map();
    for (const r of rows.filter(isSpend)) {
      const options = byKey.get(vesselKey(r.application));
      if (!options || !r.opened) continue;
      const when = Date.parse(r.opened);
      const best = options.map(c => ({ c, gap: Math.abs(c.start - when) })).filter(x => x.gap <= 60 * DAY).sort((a, b) => a.gap - b.gap)[0];
      if (!best) continue;
      const c = best.c;
      const item = map.get(c.id) || { id: c.id, vessel: c.vessel, cargo: c.cargo, operation: c.operation, operationStart: c.operationStart, tons: c.tons || 0, count: 0, value: 0 };
      item.count++; item.value += amountOf(r);
      map.set(c.id, item);
    }
    return [...map.values()].map(item => ({ ...item, perTon: item.tons > 0 ? item.value / item.tons : null })).sort((a, b) => b.value - a.value);
  }

  /**
   * Preço unitário dos itens comprados várias vezes (mesmo nome de produto, sem acento e caixa).
   * Preço até R$ 1 é simbólico (estoque, serviço lançado à parte) e fica de fora.
   */
  function priceHistory(rows, minTimes = 3) {
    const map = new Map();
    for (const r of rows.filter(isSpend)) {
      if (!(r.unitPrice > 1) || !r.product) continue;
      const key = plain(r.product).replace(/[^a-z0-9]+/g, " ").trim();
      const item = map.get(key) || { product: r.product, prices: [] };
      item.prices.push({ date: r.opened, price: r.unitPrice, supplier: r.supplier, rms: r.rms });
      map.set(key, item);
    }
    return [...map.values()].filter(item => item.prices.length >= minTimes).map(item => {
      const prices = [...item.prices].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
      const values = prices.map(p => p.price), mid = median(values), last = prices.at(-1);
      return { product: item.product, times: values.length, suppliers: new Set(prices.map(p => p.supplier)).size, min: Math.min(...values), max: Math.max(...values), median: mid, last, change: mid ? last.price / mid - 1 : null, prices };
    }).sort((a, b) => b.times - a.times);
  }

  /** Pendências de preenchimento da planilha: cada regra com as linhas que caem nela. */
  const ISSUES = [
    ["a-definir", "Tipo de despesa a definir (ajustar depois)", r => r.type === "A DEFINIR"],
    ["aberta-atrasada", "Em aberto fora do prazo (30 dias cotada · 15 dias direta)", (r, today) => isLate(r, today)],
    ["aberta-com-termino", "Em aberto, mas com data de término (provavelmente já finalizada)", r => r.status === "EM ABERTO" && r.closed],
    ["sem-nf", "Finalizada sem número de NF", r => r.status === "FINALIZADO" && !r.nf],
    ["sem-termino", "Finalizada sem data de término (não mede prazo)", r => r.status === "FINALIZADO" && !r.closed],
    ["valor-zerado", "Valor zerado ou simbólico, até R$ 1 (item de estoque ou valor ainda não lançado)", r => isSpend(r) && (r.total || 0) <= 1],
    ["nf-repetida", "Valor da NF repetido em todos os itens da RMS (registrar o valor de cada item)", r => r.nfRepeated],
    ["produto-generico", "Produto genérico \"mão de obra terceirizada\" (registrar o serviço: apeação, estiva, descarga…)", r => /mao de obra terceirizada/.test(plain(r.product))],
    ["sem-tipo-compra", "Sem tipo de compra (cotada ou direta)", r => r.purchaseType === ""],
    ["confianca-baixa", "Tipo de despesa sugerido com confiança baixa (conferir)", r => r.type !== "A DEFINIR" && plain(r.confidence) === "baixa"],
    ["sem-status", "Sem status", r => r.status === "SEM STATUS"],
    ["sem-rms", "Sem número de RMS", r => !r.rms],
    ["sem-fornecedor", "Sem fornecedor", r => r.supplier === "NÃO INFORMADO"],
    ["escrita", "Status, fornecedor ou aplicação escritos fora do padrão (o painel corrige na leitura)", r => r.fixes?.length > 0]
  ];
  function issues(rows, today) {
    return ISSUES.map(([key, label, test]) => ({ key, label, rows: rows.filter(r => test(r, today)) })).filter(issue => issue.rows.length);
  }

  root.TpsPurchases = { DEADLINES, DEFAULT_DEADLINE, deadlineOf, dateOf, monthOf, median, prepare, filterRecords, daysOpen, totals, monthly, groupBy, budgetMonths, budgetCompare, openList, invoices, nfDifferences, vesselCosts, priceHistory, issues };
})(typeof window !== "undefined" ? window : globalThis);
