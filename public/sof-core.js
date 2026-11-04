/* Statement of Facts (SOF): leitura do Excel, responsáveis das ocorrências e indicadores.
   O mesmo arquivo roda no navegador (window.TpsSof) e nas funções do Netlify e nos testes (globalThis.TpsSof).
   Testado em tests/sof.test.mjs. */
(function (root) {
  const RESPONSIBLES = ["Terminal", "Cargo", "Vessel", "Client", "Rain", "Others", "Port"];
  const RESPONSIBLE_LABELS = { Terminal: "Terminal", Cargo: "Carga", Vessel: "Navio", Client: "Cliente", Rain: "Chuva", Others: "Outros", Port: "Porto" };
  const PERIODS = ["07x13", "13x19", "19x01", "01x07"];
  const OPERATIONS = ["IMPORTAÇÃO", "EXPORTAÇÃO", "CABOTAGEM"];
  const DAY = 86400000;
  /** Brasília sem horário de verão desde 2019: o SOF registra a hora local, sem fuso. */
  const OFFSET_HOURS = 3;
  /** Uma descrição vira automática quando o histórico dá o mesmo responsável em pelo menos 90% das vezes. */
  const AUTO_SHARE = 0.9;
  const STOPWORDS = /\b(the|of|a|an|to|on|in|at|for|and|by|from|due|not|worked|s)\b/g;

  const text = value => String(value ?? "").replace(/\s+/g, " ").trim();
  const isBlank = value => { const t = text(value); return !t || t === "-" || t === "–"; };

  /** Chave da descrição: minúsculas, sem acento, sem números/códigos, sem pontuação e sem palavras de enchimento. */
  function normalizeDescription(value) {
    return text(value).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
      .replace(/\b[a-z]*\d[\w-]*\b/g, " ").replace(/[^a-z ]+/g, " ").replace(STOPWORDS, " ").replace(/\s+/g, " ").trim();
  }

  /**
   * Conserta o texto deixado por um localizar/substituir antigo na Base SOF:
   * "Not worked due to Not worked due to …", "Discharging..general Cargo", "awaiting stevedores..", "shifting gang.ing".
   */
  function cleanDescription(value) {
    return text(value)
      .replace(/(not worked due to\s+){2,}/gi, match => match.match(/not worked due to\s+/i)[0])
      .replace(/\b(discharging|loading pig iron in bulk|unlashing cargo)\.{1,2}\s*(?=[a-zà-ÿ])/gi, "$1 ")
      .replace(/\bshifting gang\.ing\b/gi, "shifting gang")
      .replace(/([^.])\.\.$/, "$1.");
  }

  /** "others", "TERMINAL", "Ship" → nome padrão; vazio quando não reconhece. */
  function canonicalResponsible(value) {
    const t = text(value).toLowerCase();
    if (!t || t === "-") return "";
    const aliases = { ship: "Vessel", navio: "Vessel", carga: "Cargo", operation: "Cargo", cliente: "Client", chuva: "Rain", outros: "Others", other: "Others", porto: "Port" };
    return RESPONSIBLES.find(name => name.toLowerCase() === t) || aliases[t] || "";
  }

  /** Nome do navio para comparar entre planilhas: sem acento, espaço ou pontuação, e sem "MV" na frente. */
  function vesselKey(value) {
    return text(value).normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/^M\s*\/?\s*V\.?\s+/, "").replace(/[^A-Z0-9]/g, "");
  }

  /** Período do OGMO pelo horário de início (minutos desde 00:00). */
  function periodOf(minutes) {
    const m = ((minutes % 1440) + 1440) % 1440;
    if (m >= 420 && m < 780) return "07x13";
    if (m >= 780 && m < 1140) return "13x19";
    if (m >= 1140 || m < 60) return "19x01";
    return "01x07";
  }

  /* ---------- Datas e horas do Excel (valores crus: data = número inteiro, hora = fração do dia) ---------- */

  function serialParts(serial) {
    const days = Math.floor(serial);
    const date = new Date(Date.UTC(1899, 11, 30) + days * DAY);
    return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
  }
  const pad = n => String(n).padStart(2, "0");
  /** Data do Excel (número) → "AAAA-MM-DD". */
  function serialDate(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 30000 || value > 80000) return null;
    const { y, m, d } = serialParts(value);
    return `${y}-${pad(m)}-${pad(d)}`;
  }
  /** Hora: fração do dia (0,5 = 12:00), texto "14:40" ou "14h40". Devolve minutos desde 00:00. */
  function timeMinutes(value) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      const fraction = value >= 1 ? value % 1 : value;
      return Math.round(fraction * 1440) % 1440;
    }
    const match = /^(\d{1,2})\s*[:hH]\s*(\d{2})/.exec(text(value));
    if (match && Number(match[1]) < 24 && Number(match[2]) < 60) return Number(match[1]) * 60 + Number(match[2]);
    return null;
  }
  /** "AAAA-MM-DD" + minutos (hora de Brasília) → ISO em UTC. */
  function localIso(date, minutes = 0) {
    if (!date) return null;
    const [y, m, d] = date.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d, OFFSET_HOURS, 0) + minutes * 60000).toISOString();
  }
  /** Data e hora do Excel num número só (46022,5) → ISO. */
  function serialIso(value) {
    const date = serialDate(value);
    return date ? localIso(date, Math.round((value % 1) * 1440)) : null;
  }
  const numberOrNull = value => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    const t = text(value).replace(/\./g, "").replace(",", ".");
    return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
  };

  /* ---------- Leitura do Excel do SOF ---------- */

  const HEADER_FIELDS = [
    ["date", /^date$/i], ["day", /^day$/i], ["from", /^from$/i], ["to", /^to$/i], ["gang", /^gang$/i], ["hold", /^hold$/i],
    ["crane", /^crane$/i], ["description", /^(stoppages|occurrences?|description|events?)$/i], ["responsibility", /^responsib/i],
    ["volume", /^(volumes?|vol'?s|skips?|qty|quantity)$/i], ["weight", /^weight/i]
  ];
  const KEY_EVENTS = [
    ["arrival", /arrival at roads/i], ["pilot", /pilot on board/i], ["berthed", /made all fast/i], ["nor", /nor tendered/i],
    ["commenced", /commenced\s+(loading|discharging|operation)/i], ["completed", /completed\s+(loading|discharging|operation)/i],
    ["unberthed", /(vessel\s+)?unberthed|vessel sailed|cast off|last line/i]
  ];

  function sheetRows(XLSX, sheet) {
    return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null, blankrows: true });
  }

  function findHeader(rows) {
    for (let r = 0; r < Math.min(rows.length, 120); r++) {
      const row = rows[r] || [];
      const cols = {};
      row.forEach((cell, c) => { const label = text(cell); const field = HEADER_FIELDS.find(([, re]) => re.test(label)); if (field && !(field[0] in cols)) cols[field[0]] = c; });
      if ("date" in cols && "from" in cols && "to" in cols && "description" in cols) return { row: r, cols };
    }
    return null;
  }

  const stripNumbering = value => text(value).replace(/^\d{1,2}\s*\)\s*/, "");
  /** Valor ao lado de um rótulo ("Vessel", "05)Berth"...) na parte de cima do SOF. */
  function labelValue(rows, regex, limit) {
    for (let r = 0; r < limit; r++) {
      const row = rows[r] || [];
      for (let c = 0; c < row.length; c++) {
        if (typeof row[c] !== "string" || !regex.test(stripNumbering(row[c]))) continue;
        for (let n = c + 1; n < Math.min(row.length, c + 5); n++) if (!isBlank(row[n])) return text(row[n]);
      }
    }
    return "";
  }

  function keyEvents(rows, limit) {
    const found = {};
    for (let r = 0; r < limit; r++) {
      const row = rows[r] || [];
      for (let c = 0; c < Math.min(row.length, 6); c++) {
        const label = stripNumbering(row[c]);
        const event = KEY_EVENTS.find(([key, re]) => !(key in found) && re.test(label));
        if (!event) continue;
        let date = null, minutes = null;
        for (let n = c + 1; n < Math.min(row.length, c + 8) && !date; n++) {
          date = serialDate(row[n]);
          if (date) {
            if (row[n] % 1) minutes = timeMinutes(row[n]);
            for (let h = n + 1; h < Math.min(row.length, n + 3) && minutes === null; h++) minutes = timeMinutes(row[h]);
          }
        }
        if (date) found[event[0]] = { at: localIso(date, minutes || 0), hasTime: minutes !== null, label };
        break;
      }
    }
    return found;
  }

  /** Total da tabela de carga (linha "TOTAL" acima da tabela de ocorrências). */
  function cargoTable(rows, limit) {
    let description = "", total = null;
    for (let r = 0; r < limit; r++) {
      const row = rows[r] || [];
      const descCol = row.findIndex(cell => /cargo description/i.test(stripNumbering(cell)));
      if (descCol >= 0) {
        const below = rows[r + 1] || [];
        if (!description) description = text(below[descCol]);
        const weightCol = row.findIndex(cell => /^weight/i.test(text(cell)));
        if (weightCol >= 0) {
          for (let n = r + 1; n < Math.min(limit, r + 30); n++) {
            const line = rows[n] || [];
            if (line.some(cell => /^total$/i.test(text(cell)))) { total = numberOrNull(line[weightCol]); break; }
          }
        }
      }
    }
    return { description, total };
  }

  function pickSheet(XLSX, workbook) {
    let best = null;
    for (const name of workbook.SheetNames) {
      if (/daily|stowage|plano/i.test(name)) continue;
      const rows = sheetRows(XLSX, workbook.Sheets[name]);
      const header = findHeader(rows);
      if (!header) continue;
      const count = rows.slice(header.row + 1).filter(row => row && !isBlank(row[header.cols.description])).length;
      if (!best || count > best.count) best = { name, rows, header, count };
    }
    return best;
  }

  function vesselFromFile(fileName) {
    const base = text(fileName).replace(/^.*[\\/]/, "").replace(/(\.(xlsx|xlsm|xlsb|xls))+$/i, "").replace(/statement\s+of\s+facts?/i, " ").replace(/\b(draft|parcial|final|c[oó]pia|copy)\b/gi, " ");
    return text(base.replace(/^[\s\-–_.\d]+(?=\D)/, "").replace(/[\s\-–_.(]+$/g, "").replace(/\s+\d+$/, ""));
  }

  /**
   * Lê o Excel do SOF (modelo novo Rev04 e antigo Revisão 03).
   * Devolve o navio, os eventos principais e as ocorrências com data, período, horário, terno, porão,
   * descrição, volumes e peso. `XLSX` é o SheetJS; a planilha deve ser lida com cellDates: false.
   */
  function parseSofWorkbook(XLSX, workbook, fileName = "") {
    const sheet = pickSheet(XLSX, workbook);
    if (!sheet) throw new Error("Não encontrei a tabela de ocorrências (colunas Date, From, To e Stoppages).");
    const { rows, header } = sheet, cols = header.cols, top = header.row;
    const warnings = [];
    const model = rows.slice(0, top).some(row => (row || []).some(cell => /rev(is[aã]o)?\s*0?3\b/i.test(text(cell)))) ? "Rev03"
      : rows.slice(0, top).some(row => (row || []).some(cell => /rev\s*0?4\b/i.test(text(cell)))) ? "Rev04" : "desconhecido";
    // Nome do navio: rótulo "Vessel" (Rev04), título "MV ..." acima da tabela (Revisão 03) ou nome do arquivo.
    // O nome da aba fica por último: abas copiadas de outro SOF mantêm o navio antigo.
    let vessel = labelValue(rows, /^vessel(\s+name)?$/i, top);
    if (!vessel) {
      const title = rows.slice(Math.max(0, top - 6), top).flatMap(row => row || []).find(cell => typeof cell === "string" && /^M\s*\/?\s*V\.?\s+\S/i.test(text(cell)));
      vessel = text(title) || vesselFromFile(fileName) || (!/^(geral|sheet\d*|plan\d*|planilha\d*|total operation)$/i.test(sheet.name) ? sheet.name : "");
    }
    vessel = text(vessel).replace(/^M\s*\/?\s*V\.?\s+/i, "").toUpperCase();
    const keys = keyEvents(rows, top);
    const typeText = labelValue(rows, /^type of operation$/i, top) || keys.commenced?.label || "";
    const operation = /export|loading/i.test(typeText) ? "EXPORTAÇÃO" : /import|discharg/i.test(typeText) ? "IMPORTAÇÃO" : "";
    const cargo = cargoTable(rows, top);

    const events = [];
    let date = null, evening = false;
    for (let r = top + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const rowDate = serialDate(row[cols.date]);
      if (rowDate && rowDate !== date) { date = rowDate; evening = false; }
      const description = text(row[cols.description]);
      if (!description || description === "-" || /^period\s+total/i.test(description) || /^total\b/i.test(description)) continue;
      const fromRaw = timeMinutes(row[cols.from]), toRaw = timeMinutes(row[cols.to]);
      if (fromRaw === null && toRaw === null) continue;
      if (!date) { warnings.push(`Linha ${r + 1} sem data: "${description.slice(0, 60)}".`); continue; }
      const from = fromRaw ?? toRaw, to = toRaw ?? fromRaw;
      // O SOF só escreve a data na primeira linha do dia. Madrugada (antes das 07:00) listada depois de
      // linhas da noite (19:00 em diante) do mesmo bloco é do dia seguinte.
      if (from >= 1140) evening = true;
      const nextDay = evening && from < 420;
      const minutes = to >= from ? to - from : to + 1440 - from;
      const start = localIso(date, (nextDay ? 1440 : 0) + from);
      const day = nextDay ? localIso(date, 1440).slice(0, 10) : date;
      const value = key => key in cols && !isBlank(row[cols[key]]) ? row[cols[key]] : null;
      events.push({
        date: day, period: periodOf(from), start, end: new Date(Date.parse(start) + minutes * 60000).toISOString(), minutes,
        gang: text(value("gang")), hold: text(value("hold")), description, key: normalizeDescription(description),
        volume: numberOrNull(value("volume")), weight: numberOrNull(value("weight")),
        responsible: canonicalResponsible(value("responsibility"))
      });
    }
    if (!events.length) throw new Error("A tabela de ocorrências está vazia.");
    const tons = Math.round(events.reduce((sum, e) => sum + (e.weight || 0), 0) * 1000) / 1000;
    if (cargo.total && tons && Math.abs(cargo.total - tons) / cargo.total > 0.01)
      warnings.push(`A soma dos pesos das ocorrências (${tons.toFixed(3)} t) difere do total da carga (${cargo.total.toFixed(3)} t).`);
    if (tons > 150000) warnings.push(`O peso somado (${Math.round(tons)} t) é alto demais para um navio: confira se a coluna de peso está em kg.`);
    const first = events[0].start, last = events[events.length - 1].end;
    const operationStart = keys.commenced?.at || first;
    const operationEnd = keys.completed?.at || last;
    if (!keys.commenced) warnings.push("Início da operação não encontrado no quadro de eventos: usei a primeira ocorrência.");
    if (!keys.completed) warnings.push("Término da operação não encontrado no quadro de eventos: usei a última ocorrência.");
    return {
      vessel, model, sheet: sheet.name, fileName: text(fileName), operation, cargoDescription: cargo.description,
      berth: labelValue(rows, /^berth(\s*\|\s*bollard)?$/i, top), client: labelValue(rows, /^client(\(s\)|s)?$/i, top),
      arrival: keys.arrival?.at || null, berthStart: keys.berthed?.at || null, berthEnd: keys.unberthed?.hasTime ? keys.unberthed.at : null,
      operationStart, operationEnd, tons: tons || cargo.total || 0, invoiceTons: cargo.total, events, warnings
    };
  }

  /* ---------- Dicionário de responsáveis ---------- */

  /** Conta, para cada descrição, quantas vezes cada responsável foi usado. */
  function learn(events, dictionary = {}) {
    const result = structuredCloneSafe(dictionary);
    for (const event of events) {
      const responsible = canonicalResponsible(event.responsible);
      const key = event.key ?? normalizeDescription(event.description);
      if (!responsible || !key) continue;
      const entry = result[key] ||= { counts: {}, text: text(event.description) };
      entry.counts[responsible] = (entry.counts[responsible] || 0) + 1;
    }
    return result;
  }
  function structuredCloneSafe(value) { return JSON.parse(JSON.stringify(value || {})); }

  function ranking(entry) {
    const counts = Object.entries(entry?.counts || {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
    const total = counts.reduce((sum, [, n]) => sum + n, 0);
    return { counts, total, top: counts[0]?.[0] || "", share: total ? counts[0][1] / total : 0 };
  }

  /** Regras para descrições novas que não deixam dúvida. */
  function ruleFor(key) {
    if (/^(loading|discharging|loaded|discharged|lifting|operation commenced|operation completed|commenced|completed)\b/.test(key) || /\boperation (commenced|completed|resumed)\b/.test(key)) return "Cargo";
    if (/^(rain|raining)\b/.test(key) || /^rain$/.test(key)) return "Rain";
    return "";
  }

  /**
   * Sugestão de responsável para uma ocorrência.
   * status: "sof" (veio do próprio SOF), "auto" (histórico claro, regra ou escolha já confirmada),
   * "confirmar" (histórico dividido) ou "nova" (descrição nunca vista).
   */
  function suggest(event, dictionary = {}) {
    const key = event.key ?? normalizeDescription(event.description);
    const fromSof = canonicalResponsible(event.responsible);
    const entry = dictionary[key];
    const rank = ranking(entry);
    const options = rank.counts.map(([name, count]) => ({ name, count }));
    if (fromSof) return { status: "sof", responsible: fromSof, options };
    if (entry?.fixed && canonicalResponsible(entry.fixed)) return { status: "auto", responsible: entry.fixed, options };
    if (rank.top && rank.share >= AUTO_SHARE) return { status: "auto", responsible: rank.top, options };
    if (rank.top) return { status: "confirmar", responsible: rank.top, options };
    const rule = ruleFor(key);
    if (rule) return { status: "auto", responsible: rule, options };
    return { status: "nova", responsible: "", options };
  }

  /* ---------- Motivos parecidos ---------- */

  const trigrams = key => { const t = ` ${key} `, set = new Set(); for (let i = 0; i < t.length - 2; i++) set.add(t.slice(i, i + 3)); return set; };
  const stems = key => new Set(key.split(" ").filter(Boolean).map(w => w.replace(/(ies|es|s)$/, "")));
  const overlap = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n; };

  /** Semelhança entre duas chaves de descrição (0 a 1): metade pelas letras em comum (pega erro de digitação), metade pelas palavras. */
  function similarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const ta = trigrams(a), tb = trigrams(b), wa = stems(a), wb = stems(b);
    const dice = 2 * overlap(ta, tb) / (ta.size + tb.size);
    const words = overlap(wa, wb) / Math.max(wa.size, wb.size);
    return (dice + words) / 2;
  }

  /**
   * Os motivos mais parecidos com uma descrição nova: compara com o texto de cada motivo
   * e com as descrições já ligadas a ele (known: [chave, código]). Devolve [{ code, score }].
   */
  function similarReasons(description, known, reasons, limit = 3) {
    const key = normalizeDescription(description);
    // "Not worked due to …" é sempre paralisação: os motivos de Carga (loading, discharging) ficam de fora.
    const allowed = new Set(reasons.filter(r => !/^\s*not work/i.test(description) || r.responsible !== "Cargo").map(r => r.code));
    const best = new Map();
    const consider = (code, other) => { if (!allowed.has(code)) return; const score = similarity(key, other); if (score > (best.get(code) || 0)) best.set(code, score); };
    for (const reason of reasons) consider(reason.code, normalizeDescription(reason.text));
    for (const [other, code] of known) consider(code, other);
    return [...best].map(([code, score]) => ({ code, score })).sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /* ---------- Indicadores por navio ---------- */

  const days = (start, end) => { const a = Date.parse(start || ""), b = Date.parse(end || ""); return Number.isFinite(a) && Number.isFinite(b) && b > a ? (b - a) / DAY : 0; };

  /**
   * Tempo de cada responsável no navio, em dias, como na Base SOF:
   * as durações das ocorrências são proporcionais e somam o tempo de operação (início → término).
   */
  function vesselSummary(vessel) {
    const operationDays = days(vessel.operationStart, vessel.operationEnd);
    const totals = Object.fromEntries(RESPONSIBLES.map(name => [name, 0]));
    const stoppages = new Map();
    const events = vessel.events || [];
    const sum = events.reduce((total, e) => total + (e.minutes || 0), 0);
    const scale = sum ? operationDays / sum : 0;
    for (const e of events) {
      const responsible = canonicalResponsible(e.responsible);
      const value = (e.minutes || 0) * scale;
      if (responsible) totals[responsible] += value;
      if (responsible && responsible !== "Cargo" && value > 0) {
        // Com motivo padrão, as paralisações se somam pelo motivo; sem ele, pela descrição.
        const key = e.reason || e.key;
        const id = `${key}|${responsible}`;
        const item = stoppages.get(id) || { key, text: e.reasonText || e.description, responsible, days: 0, count: 0 };
        item.days += value; item.count++;
        stoppages.set(id, item);
      }
    }
    const tons = vessel.tons || 0;
    const rate = divisor => divisor > 0 ? tons / divisor : null;
    return {
      operationDays, berthDays: days(vessel.berthStart, vessel.berthEnd), waitDays: days(vessel.berthStart, vessel.operationStart),
      byResponsible: totals, stoppages: [...stoppages.values()].sort((a, b) => b.days - a.days),
      grossRate: rate(operationDays), netRate: rate(totals.Cargo), triunfoRate: rate(totals.Cargo + totals.Terminal),
      pending: events.filter(e => !canonicalResponsible(e.responsible)).length
    };
  }

  /* ---------- Indicadores do período ---------- */

  const monthOf = iso => { const t = Date.parse(iso || ""); if (!Number.isFinite(t)) return null; const d = new Date(t - OFFSET_HOURS * 3600000); return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 }; };

  /** Mês do navio: pela data de início da operação, como nos demais indicadores do painel. */
  function vesselMonth(vessel) { return monthOf(vessel.operationStart || vessel.berthStart); }

  /** Filtro: { years: Set, months: Set, cargo, operation, berth, vessel }. */
  function filterVessels(vessels, filter = {}) {
    const has = (set, value) => !set || !set.size || set.has(value);
    return vessels.filter(v => {
      const when = vesselMonth(v);
      return when && has(filter.years, when.year) && has(filter.months, when.month) &&
        (!filter.cargo || v.cargo === filter.cargo) && (!filter.operation || v.operation === filter.operation) &&
        (!filter.berth || v.berth === filter.berth) && (!filter.vessel || vesselKey(v.vessel).includes(vesselKey(filter.vessel)));
    });
  }

  /** Totais de um conjunto de navios (cada um com .summary de vesselSummary). */
  function totals(vessels) {
    const byResponsible = Object.fromEntries(RESPONSIBLES.map(name => [name, 0]));
    let tons = 0, operationDays = 0, berthDays = 0, waitDays = 0, waitCount = 0, berthCount = 0;
    for (const v of vessels) {
      const s = v.summary;
      tons += v.tons || 0; operationDays += s.operationDays;
      if (s.berthDays) { berthDays += s.berthDays; berthCount++; }
      if (v.berthStart && v.operationStart) { waitDays += s.waitDays; waitCount++; }
      RESPONSIBLES.forEach(name => { byResponsible[name] += s.byResponsible[name]; });
    }
    const stopped = RESPONSIBLES.filter(name => name !== "Cargo").reduce((sum, name) => sum + byResponsible[name], 0);
    const rate = divisor => divisor > 0 ? tons / divisor : null;
    return {
      vessels: vessels.length, tons, operationDays, berthDays, byResponsible, stoppedDays: stopped,
      grossRate: rate(operationDays), netRate: rate(byResponsible.Cargo), triunfoRate: rate(byResponsible.Cargo + byResponsible.Terminal),
      averageBerthDays: berthCount ? berthDays / berthCount : null, averageWaitDays: waitCount ? waitDays / waitCount : null,
      averageOperationDays: vessels.length ? operationDays / vessels.length : null
    };
  }

  /** Principais paralisações (tudo que não é operação), somadas por descrição e responsável. */
  function topStoppages(vessels, limit = 10) {
    const map = new Map();
    for (const v of vessels) for (const s of v.summary.stoppages) {
      const id = `${s.key}|${s.responsible}`;
      const item = map.get(id) || { key: s.key, text: s.text, responsible: s.responsible, days: 0, count: 0, vessels: 0 };
      item.days += s.days; item.count += s.count; item.vessels++;
      map.set(id, item);
    }
    return [...map.values()].sort((a, b) => b.days - a.days).slice(0, limit);
  }

  /** Mês a mês de dois anos para comparação (ano atual × anterior). */
  function monthlyComparison(vessels, years, filter = {}) {
    return years.map(year => ({
      year,
      months: Array.from({ length: 12 }, (_, i) => totals(filterVessels(vessels, { ...filter, years: new Set([year]), months: new Set([i + 1]) })))
    }));
  }

  /**
   * Ocupação de berço (%): tempo atracado (atracação → desatracação) sobre o tempo do período, por berço.
   * Intervalos que se sobrepõem no mesmo berço contam uma vez.
   */
  function occupancy(vessels, windowStart, windowEnd) {
    const start = Date.parse(windowStart), end = Date.parse(windowEnd);
    if (!(end > start)) return { overall: 0, byBerth: [] };
    const byBerth = new Map();
    for (const v of vessels) {
      const a = Math.max(start, Date.parse(v.berthStart || "")), b = Math.min(end, Date.parse(v.berthEnd || ""));
      if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) continue;
      const berth = v.berth || "Não informado";
      if (!byBerth.has(berth)) byBerth.set(berth, []);
      byBerth.get(berth).push([a, b]);
    }
    const span = end - start;
    const rows = [...byBerth].map(([berth, ranges]) => {
      ranges.sort((x, y) => x[0] - y[0]);
      let busy = 0, cursor = -Infinity;
      for (const [a, b] of ranges) { const from = Math.max(a, cursor); if (b > from) busy += b - from; cursor = Math.max(cursor, b); }
      return { berth, pct: busy / span * 100, days: busy / DAY };
    }).sort((x, y) => x.berth.localeCompare(y.berth, "pt-BR"));
    const overall = rows.length ? rows.reduce((sum, r) => sum + r.pct, 0) / rows.length : 0;
    return { overall, byBerth: rows };
  }

  /** Janela de tempo dos filtros: meses selecionados dos anos selecionados (até agora, se o período ainda corre). */
  function windowFor(years, months, now = Date.now()) {
    const list = [];
    for (const y of years) for (const m of (months.size ? [...months] : Array.from({ length: 12 }, (_, i) => i + 1))) {
      const a = Date.UTC(y, m - 1, 1, OFFSET_HOURS), b = Math.min(Date.UTC(y, m, 1, OFFSET_HOURS), now);
      if (b > a) list.push([a, b]);
    }
    return list;
  }

  /** Ocupação somando várias janelas (vários meses/anos). */
  function occupancyFor(vessels, years, months, now = Date.now()) {
    const windows = windowFor(years, months, now);
    const total = windows.reduce((sum, [a, b]) => sum + (b - a), 0);
    if (!total) return { overall: 0, byBerth: [] };
    const berths = new Map();
    for (const [a, b] of windows) {
      for (const row of occupancy(vessels, new Date(a).toISOString(), new Date(b).toISOString()).byBerth) {
        const item = berths.get(row.berth) || { berth: row.berth, days: 0 };
        item.days += row.days;
        berths.set(row.berth, item);
      }
    }
    const byBerth = [...berths.values()].map(item => ({ ...item, pct: item.days * DAY / total * 100 })).sort((x, y) => x.berth.localeCompare(y.berth, "pt-BR"));
    return { overall: byBerth.length ? byBerth.reduce((sum, r) => sum + r.pct, 0) / byBerth.length : 0, byBerth };
  }

  root.TpsSof = {
    RESPONSIBLES, RESPONSIBLE_LABELS, PERIODS, OPERATIONS, AUTO_SHARE,
    normalizeDescription, cleanDescription, similarity, similarReasons, canonicalResponsible, vesselKey, periodOf, serialDate, serialIso, timeMinutes, localIso,
    parseSofWorkbook, learn, ranking, suggest, vesselSummary, vesselMonth, filterVessels, totals, topStoppages,
    monthlyComparison, occupancy, occupancyFor
  };
})(typeof window !== "undefined" ? window : globalThis);
