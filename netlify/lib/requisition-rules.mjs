/* Conferência da requisição de estiva pela instrução de trabalho (IT "Requisição de estiva", revisão de 23/10/2026).
   Entrada: a requisição lida do PDF (requisition-pdf.mjs) e o contexto (lineup, feriados, outras requisições do período).
   Saída: itens { level: "ok" | "erro" | "confirmar", text, ref } e o resultado:
     reprovado = algum erro; confirmar = só pontos a verificar; aprovado = nada a apontar.
   Composições tiradas dos exemplos da IT: ferro gusa (5.2 a 5.7), tubos (6.1 a 6.3), carga geral e balsa (7.1 a 7.4),
   granéis e enlonamento (8.1), big bag (9.1), amarras (9.2), dormentes (9.3) e containers (9.4).
   A hora do pedido não é conferida (o PDF só traz a hora da impressão, que não importa).
   Itens que a IT manda "perguntar ao responsável" (guia, empilhador, alavanca, tratorista do granel) são aceitos e
   aparecem como observação. Testado em tests/requisitions.test.mjs. */

/** Períodos do OGMO no Rio (o 01-07 leva a data do dia anterior à madrugada). A hora do pedido não é conferida. */
export const PERIODS = ["07-13", "13-19", "19-01", "01-07"];

/** Fainas da tabela da seção 12 (mais a 3.8.7, balsa de descarga atracada, que existe fora da tabela). */
export const FAINAS = {
  "3.5": "Sal marinho", "4.2.2": "Carvão", "4.1.2.1": "Enxofre", "4.1.3.2": "Trigo, malte a granel", "3.8.4": "Ferro gusa", "3.8.7": "Ferro gusa (balsa descarga atracada)",
  "4.2.4": "Diversos (espodumênio, cloreto de potássio, sucata…)", "5.9.1": "Zinco e barrilha", "3.8.3": "Trigo e sal a granel", "5.0": "Volume indivisível",
  "5.9.3": "Rolo de arame, tubo, perfil, tarugo, bobina", "6.1": "Container cheio", "6.3": "Container vazio", "7.0": "Carga geral", "11.0": "Bobina de papel", "9.4": "Dormentes", "15.0": "Container flexível / big bag"
};
const GROUPS = {
  gusa: ["3.8.4", "3.8.7"], tubos: ["5.9.3"], cargaGeral: ["7.0", "11.0"], granel: ["3.5", "3.8.3", "4.1.2.1", "4.1.3.2", "4.2.2", "4.2.4"],
  bigbag: ["15.0"], amarras: ["5.0"], dormentes: ["9.4"], container: ["6.1", "6.3"]
};
const groupOf = faina => Object.entries(GROUPS).find(([, codes]) => codes.includes(faina))?.[0] || null;
/** Palavras do produto que a observação de cada terno precisa ter (3.4). Carga geral varia demais: só a operação. */
const PRODUCT_WORDS = {
  gusa: /GUSA/, tubos: /TUBO|ARAME|PERFIL|TARUGO|BOBINA/, granel: /POTASS|GESSO|ESPODUM|MAGNETITA|GRANE|SUCATA|CARVAO|ENXOFRE|TRIGO|MALTE|SAL\b|BARRILHA/,
  bigbag: /BIG ?BAG/, amarras: /AMARRA/, dormentes: /DORMENTE/, container: /CONTAINER|CONTEINER/
};
/** Funções que só podem ir no 1º terno quando há mais de um (seções 3, 5.3, 6.2 e 6.2 Nota 7). */
const FIRST_TERNO_ONLY = { CFC: "Conferente Chefe", CSC: "Consertador Chefe", ENB: "Encarregado de Bloco", BLM: "Bloquista de Material" };
const BLOCO = ["BLE", "BLP", "ENB", "BLM", "BLC"];

const normalize = text => String(text || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
const brDay = iso => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const addDays = (iso, days) => new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + days)).toISOString().slice(0, 10);
const weekday = iso => new Date(`${iso}T12:00:00Z`).getUTCDay();
const WEEKDAYS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

/* ---------- Feriados (capatazia própria não trabalha: 4 PE do OGMO no ferro gusa) ---------- */

function easter(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
/** Lista inicial (editável na aba): nacionais, Rio de Janeiro (estado e cidade), Carnaval e Corpus Christi. */
export function defaultHolidays(year) {
  const fixed = [["01-01", "Confraternização Universal"], ["01-20", "São Sebastião (cidade do Rio)"], ["04-21", "Tiradentes"], ["04-23", "São Jorge (estado do RJ)"], ["05-01", "Dia do Trabalho"],
    ["09-07", "Independência"], ["10-12", "Nossa Senhora Aparecida"], ["11-02", "Finados"], ["11-15", "Proclamação da República"], ["11-20", "Consciência Negra"], ["12-25", "Natal"]];
  const e = easter(year);
  return [...fixed.map(([md, name]) => ({ date: `${year}-${md}`, name })),
    { date: addDays(e, -48), name: "Carnaval (segunda)" }, { date: addDays(e, -47), name: "Carnaval (terça)" },
    { date: addDays(e, -2), name: "Sexta-feira Santa" }, { date: addDays(e, 60), name: "Corpus Christi" }].sort((a, b) => a.date.localeCompare(b.date));
}

/** Capatazia do ferro gusa no dia: 2 nossos + 2 do OGMO em dia útil; 4 do OGMO em sábado, domingo e feriado. */
export function expectedCapatazia(date, holidays = []) {
  const holiday = holidays.find(item => item.date === date);
  const day = weekday(date);
  if (holiday) return { count: 4, why: `feriado (${holiday.name})` };
  if (day === 0 || day === 6) return { count: 4, why: WEEKDAYS[day] };
  return { count: 2, why: `dia útil (${WEEKDAYS[day]})` };
}

/* ---------- Tipo de operação e composição esperada ---------- */

const directionOf = text => /DESCARGA|DECARGA|DESEMBARQUE|IMPORTA/.test(normalize(text)) ? "descarga" : /EMBARQUE|EXPORTA/.test(normalize(text)) ? "embarque" : null;

export function operationOf(requisition) {
  const faina = requisition.ternos.find(t => t.fainas[0])?.fainas[0]?.code || null;
  const group = groupOf(faina);
  const offshore = /LARGO/.test(normalize(requisition.berthing)) || /LARGO/.test(normalize(requisition.local));
  const kind = requisition.vessel.kind;
  const direction = requisition.ternos.map(t => directionOf(t.observation)).find(Boolean) || (kind === "balsa" && offshore && group === "gusa" ? "descarga" : null);
  const observations = normalize(requisition.ternos.map(t => t.observation).join(" "));
  const op = { faina, group, offshore, kind, direction, tarp: requisition.vessel.tarp, observations };
  op.spec = specFor(op, requisition);
  op.key = op.spec?.key || null;
  return op;
}

const role = (qty, extra = {}) => ({ qty: qty === null ? null : [].concat(qty), ...extra });
const first = qty => role(qty, { first: true });
const optional = (qty, note) => role(qty, { optional: true, note });

/**
 * Composição esperada por terno. roles: código → { qty: [aceitos] | null (qualquer), first, optional, note };
 * cm: contramestre ("CMP" = padrão CMP, CMA aceito no lugar; "any" = CMP ou CMA); pe: regra da capatazia;
 * forbidden: código → { level, text } para funções que não devem ir.
 */
function specFor(op, requisition) {
  const { group, kind, offshore, direction, observations } = op;
  if (op.tarp) return { key: "enlonamento", ref: "8.1", title: "enlonamento (capatazia)", cm: null, roles: { PE: role(null) }, pe: "own" };
  if (group === "gusa") {
    const base = { cm: "CMP", ref: "5" };
    if (kind === "balsa" && !offshore && direction === "embarque") return { ...base, key: "gusa-balsa-atracada-embarque", ref: "5.2", title: "balsa atracada, embarque de ferro gusa", faina: "3.8.4", roles: { ETR: role(1), CFC: first(1), CFP: role(1) }, pe: "gusa" };
    if (kind === "navio" && !offshore && direction === "embarque") return { ...base, key: "gusa-navio-atracado-embarque", ref: "5.3", title: "navio atracado, embarque de ferro gusa", faina: "3.8.4",
      roles: { GC: role(1), ESI: role(1), CFC: first(1), CFP: role(1), ETR: { ...optional(1, "tratorista só com cerca no porão (5.7)"), level: "confirmar" }, ENB: { ...optional(1, "equipe de bloco para cerca (5.7)"), level: "confirmar" }, BLM: { ...optional(1, "equipe de bloco para cerca (5.7)"), level: "confirmar" }, BLC: { ...optional(null, "equipe de bloco para cerca (5.7)"), level: "confirmar" } }, pe: "gusa" };
    if (kind === "navio" && offshore) return { ...base, key: "gusa-navio-largo-embarque", ref: "5.4", title: "navio ao largo, embarque de ferro gusa", faina: "3.8.4", roles: { GC: role(1), ESI: role(1), CFP: role(1) }, pe: "none" };
    if (kind === "balsa" && offshore) return { ...base, key: "gusa-balsa-largo-descarga", ref: "5.5", title: "balsa ao largo, descarga de ferro gusa", faina: "3.8.4", roles: { ETR: role(1), EE: role(3), CFC: first(1) }, pe: "none", forbidden: { CFP: { level: "erro", text: "balsa ao largo não leva conferente de porão: o CFP vai nos ternos do navio (5.5)" } } };
    if (kind === "balsa" && !offshore && direction === "descarga") return { ...base, key: "gusa-balsa-atracada-descarga", ref: "5.6", title: "balsa atracada, descarga de ferro gusa", faina: "3.8.7", roles: { ETR: role(1), EE: role(1), CFC: first(1), CFP: role(1) }, pe: "gusa" };
    return null;
  }
  if (!group || offshore) return null; // fora da IT: ao largo só existe para ferro gusa
  if (kind === "balsa") {
    if (!["cargaGeral", "amarras"].includes(group)) return null;
    return { key: `${group}-balsa`, ref: "7.3.2", title: `balsa de ${group === "amarras" ? "amarras" : "carga geral"}`, cm: "any", roles: { EE: role(4), EGU: optional(2, "estivador guia conforme a carga (7.3 e 7.4 Nota 2)") }, pe: "none" };
  }
  const ship = { cm: "any", roles: { GC: role(1), ESI: role(1), EE: role(4), CFC: first(1), CFP: role(1), EGU: optional(2, "estivador guia conforme a carga") } };
  const consertador = { CSC: first(1), CBD: role(1) };
  const blocoPadrao = { ENB: first(1), BLP: role(2) };
  if (group === "tubos") {
    const amarrados = /AMARRAD/.test(observations);
    const roles = { ...ship.roles, EE: role([4, 6], { note: "6 quando o tubo precisa de homens de alavanca (6.1 Nota 1)" }), EGU: optional(2, "estivador guia, se a operação pedir (6.1 Nota 2)"), ...(amarrados ? consertador : {}) };
    const forbidden = amarrados ? {} : { CSC: { level: "erro", text: "tubos soltos não levam consertador (6.1 Nota 1)" }, CBD: { level: "erro", text: "tubos soltos não levam consertador (6.1 Nota 1)" } };
    if (direction === "descarga") return { ...ship, key: "tubos-desembarque", ref: "6.2", title: `navio, desembarque de tubos${amarrados ? " amarrados" : ""}`, roles: { ...roles, ENB: first(1), BLM: first(1), BLC: role(1), BLP: optional(2, "bloquista de peação, se a operação pedir (6.2 Nota 3)") }, pe: "4-or-barge", forbidden: { ...forbidden, BLE: { level: "erro", text: "bloquista de equipe (BLE 4) é só para EMBARQUE de tubos; no desembarque vão ENB, BLM e BLC (6.2 Nota 3)" } } };
    return { ...ship, key: amarrados ? "tubos-embarque-amarrados" : "tubos-embarque-soltos", ref: amarrados ? "6.2" : "6.1", title: `navio, embarque de tubos ${amarrados ? "amarrados" : "soltos"}`, roles: { ...roles, BLE: role(4) }, pe: 4, forbidden };
  }
  if (group === "cargaGeral") {
    const empty = /VAZIO/.test(observations);
    return { ...ship, key: "carga-geral-navio", ref: "7.1", title: `navio, ${direction === "descarga" ? "descarga" : "embarque"} de carga geral${empty ? " (carretel vazio)" : ""}`,
      roles: { ...ship.roles, ...(empty ? {} : consertador), ...blocoPadrao, EEM: optional(1, "empilhador conforme a operação (7.1 Nota 1)"), EGU: optional(2, "estivador guia conforme a carga (7.3 Nota 1)") },
      pe: "4-or-barge", forbidden: empty ? { CSC: { level: "confirmar", text: "carretel vazio não precisa de consertador (7.4 Nota 1)" }, CBD: { level: "confirmar", text: "carretel vazio não precisa de consertador (7.4 Nota 1)" } } : {} };
  }
  if (group === "granel") {
    const sweep = /VARR/.test(observations);
    return { ...ship, key: "granel-navio", ref: "8.1", title: `navio, ${direction === "embarque" ? "embarque" : "descarga"} de granel${sweep ? " com varredura" : ""}`,
      roles: { GC: role(1), ESI: role(1), EE: role(sweep ? 4 : 1, { hint: sweep ? "com varredura são 1 + 3 (8.1 Nota 3)" : "EE 4 só com varredura, dita na observação (8.1 Nota 3)" }), CFC: first(1), CFP: role(1), ETR: optional(1, "tratorista a partir do 2º período do navio (8.1 Nota 2)") },
      pe: "none", forbidden: { PE: { level: "confirmar", text: "a capatazia do granel (enlonamento) vai numa requisição separada, NAVIO (ENLONAMENTO) (8.1 Nota 1)" } } };
  }
  if (group === "bigbag") return { ...ship, key: "bigbag-navio", ref: "9.1", title: "navio, big bag", roles: { ...ship.roles, ...consertador, ...blocoPadrao, EEM: optional(1, "empilhador conforme a operação") }, pe: 4 };
  if (group === "amarras") return { ...ship, key: "amarras-navio", ref: "9.2", title: "navio, amarras", roles: { ...ship.roles, ...consertador, ...blocoPadrao }, pe: "4-or-barge" };
  if (group === "dormentes") return { ...ship, key: "dormentes-navio", ref: "9.3", title: "navio, dormentes", roles: { ...ship.roles, EEM: role(1), ...consertador, ...blocoPadrao }, pe: 4 };
  if (group === "container") return { ...ship, key: "container-navio", ref: "9.4", title: `navio, container ${op.faina === "6.3" ? "vazio" : "cheio"}`, roles: { ...ship.roles, ...blocoPadrao }, pe: 4 };
  return null;
}

/** Compara um terno com a composição esperada: { problems (erros), notes ({ level, text }) }. */
function compareTerno(spec, terno, index, pe) {
  const present = new Map();
  terno.functions.filter(f => f.vagas > 0).forEach(f => present.set(f.code, (present.get(f.code) || 0) + f.vagas));
  const names = Object.fromEntries(terno.functions.map(f => [f.code, f.name]));
  const problems = [], notes = [];
  // Terno só de bloco (6.1 Nota 3): a equipe de bloco pode pedir um terno próprio.
  if (present.size && [...present.keys()].every(code => BLOCO.includes(code))) { notes.push({ level: "ok", text: "terno só de bloco, a pedido da equipe de bloco (6.1 Nota 3)" }); return { problems, notes }; }
  if (spec.cm) {
    const cms = [...present.keys()].filter(code => /^CM/.test(code));
    const total = cms.reduce((sum, code) => sum + present.get(code), 0);
    if (!cms.length) problems.push(spec.cm === "CMP" ? "falta CMP (contra mestre porão)" : "falta o contra mestre (CMA ou CMP)");
    for (const code of cms) {
      if (code === "CMG") problems.push(`CMG (Contra Mestre Geral) no lugar do ${spec.cm === "CMP" ? "CMP (Contra Mestre Porão)" : "CMA ou CMP"}`);
      else if (spec.cm === "CMP" && code === "CMA") notes.push({ level: "ok", text: "CMA no lugar do CMP (pedido do especialista)" });
      else if (!["CMP", "CMA"].includes(code)) problems.push(`${code}-${names[code]} no lugar do contra mestre`);
      present.delete(code);
    }
    if (total > 1) problems.push(`${total} contra mestres (o padrão é 1)`);
  }
  const roles = { ...spec.roles };
  if (spec.pe === "gusa") roles.PE = role(pe.count, { why: pe.why });
  else if (spec.pe === 4) roles.PE = role(4);
  else if (spec.pe === "4-or-barge") roles.PE = role([0, 4]);
  for (const [code, rule] of Object.entries(roles)) {
    const have = present.get(code) || 0;
    present.delete(code);
    if (rule.first && index > 0) continue; // no 2º terno em diante: apontado na regra do 1º terno
    if (rule.optional) {
      if (!have) continue;
      if (rule.qty && !rule.qty.includes(have)) notes.push({ level: "confirmar", text: `${code} com ${have} (o usual é ${rule.qty.join(" ou ")}): ${rule.note}` });
      else notes.push({ level: rule.level || "ok", text: `${code} ${have}: ${rule.note}` });
      continue;
    }
    if (rule.qty === null) { if (!have) problems.push(`falta ${code}`); continue; }
    if (!rule.qty.includes(have)) {
      if (code === "PE" && rule.why) problems.push(`capatazia (PE) ${have} — o esperado é ${rule.qty[0]} por ser ${rule.why}`);
      else problems.push(have ? `${code} com ${have} (o padrão é ${rule.qty.filter(Boolean).join(" ou ")}${rule.hint ? `; ${rule.hint}` : ""})` : `falta ${code} (${rule.qty.filter(Boolean).join(" ou ")})`);
    } else if (rule.note && have !== rule.qty[0]) notes.push({ level: "ok", text: `${code} ${have}: ${rule.note}` });
  }
  for (const [code, have] of present) {
    if (code in FIRST_TERNO_ONLY && index > 0) continue;
    const forbidden = spec.forbidden?.[code];
    if (forbidden?.level === "confirmar") notes.push({ level: "confirmar", text: `${code} ${have}: ${forbidden.text}` });
    else problems.push(forbidden ? `${code} ${have}: ${forbidden.text}` : `${code}-${names[code]} (${have}) não faz parte da composição`);
  }
  return { problems, notes };
}

/* ---------- Lineup ---------- */

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) { const tmp = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = tmp; }
  }
  return row[b.length];
}
const vesselKey = name => normalize(name).replace(/^(MV|M\/V|MT|M\/T)\s+/, "");
const placeNumbers = text => new Set((normalize(text).match(/\d+/g) || []));
const placeType = text => /PATIO/.test(normalize(text)) ? "PATIO" : /ARMAZEM|ARM\b/.test(normalize(text)) ? "ARMAZEM" : /LARGO|FUNDEIO/.test(normalize(text)) ? "LARGO" : normalize(text);

/** Navio da requisição no lineup (o navio da balsa é o que vem em "(AT. NAVIO)"). */
export function lineupCheck(requisition, lineup) {
  if (!Array.isArray(lineup) || !lineup.length) return [{ level: "ok", text: "Lineup indisponível agora: navio e local não foram cruzados.", ref: "2.7", info: true }];
  if (requisition.vessel.kind === "balsa" && !requisition.vessel.attachedTo) return [];
  const target = vesselKey(requisition.vessel.attachedTo || requisition.vessel.name);
  const names = [...new Map(lineup.map(row => [vesselKey(row.vessel), row])).entries()];
  const exact = lineup.filter(row => vesselKey(row.vessel) === target);
  const items = [];
  if (!exact.length) {
    const near = names.map(([name, row]) => ({ name, row, d: distance(name, target) })).filter(item => item.d <= Math.max(2, Math.floor(target.length / 6))).sort((a, b) => a.d - b.d)[0];
    if (near) return [{ level: "confirmar", text: `O navio "${target}" não está no Lineup; o mais parecido é "${near.name}". Confira se o nome foi digitado certo.`, ref: "2.6" }];
    return [{ level: "confirmar", text: `O navio "${target}" não foi encontrado no Lineup. Confira o nome.`, ref: "2.6" }];
  }
  items.push({ level: "ok", text: `Navio "${target}" encontrado no Lineup.`, ref: "2.6" });
  if (/LARGO/.test(normalize(requisition.local))) return items;
  // Local: mesmo tipo (pátio/armazém) e algum número em comum com o berço do lineup.
  const date = requisition.date;
  const row = exact.sort((a, b) => Math.abs(Date.parse(a.plannedBerthStart || a.berthStart || 0) - Date.parse(date)) - Math.abs(Date.parse(b.plannedBerthStart || b.berthStart || 0) - Date.parse(date)))[0];
  if (!row?.berth) return items;
  const same = placeType(row.berth) === placeType(requisition.local) && [...placeNumbers(requisition.local)].some(n => placeNumbers(row.berth).has(n));
  items.push(same
    ? { level: "ok", text: `Local "${requisition.local}" combina com o berço do Lineup (${row.berth}).`, ref: "2.7" }
    : { level: "confirmar", text: `Local "${requisition.local}" diferente do berço do Lineup (${row.berth}). Local errado gera custo de TRNU e uma segunda requisição: confirme antes da escalação.`, ref: "2.7" });
  return items;
}

/* ---------- Retroativo (seção 10) ---------- */

/** Pedido retroativo: mostra o dia do trabalho original e o do pedido, para conferir se o custo do período é o mesmo. */
export function retroactiveCheck(requisition) {
  const retro = requisition.vessel.retroactive;
  if (!retro) return [];
  return [{ level: "confirmar", text: `Pedido retroativo do trabalho de ${WEEKDAYS[weekday(retro)]} ${brDay(retro)}, lançado com data de ${WEEKDAYS[weekday(requisition.date)]} ${brDay(requisition.date)}, período ${requisition.period.replace("-", "x")}. Confira se o período tem o mesmo custo do trabalho original.`, ref: "10" }];
}

/* ---------- Conferência completa ---------- */

const count = (terno, code) => terno.functions.filter(f => f.code === code && f.vagas > 0).reduce((sum, f) => sum + f.vagas, 0);
const sameShift = (a, b) => a.number !== b.number && a.date === b.date && a.period === b.period;
const shipOf = requisition => vesselKey(requisition.vessel.attachedTo || requisition.vessel.name);

export function checkRequisition(requisition, { lineup = null, holidays = [], related = [] } = {}) {
  const items = [];
  const add = (level, text, ref, extra = {}) => items.push({ level, text, ref, ...extra });
  const op = operationOf(requisition);
  const spec = op.spec;
  const many = requisition.ternos.length > 1;
  const v = requisition.vessel;
  const others = related.filter(other => sameShift(other, requisition));

  // Cabeçalho (seção 2).
  normalize(requisition.port) === "RIO DE JANEIRO" ? add("ok", "Porto: Rio de Janeiro.", "1.6") : add("erro", `Porto "${requisition.port}": deveria ser Rio de Janeiro.`, "1.6");
  normalize(requisition.travelType) === "LONGO CURSO" ? add("ok", "Tipo de viagem: Longo Curso.", "2.8") : add("erro", `Tipo de viagem "${requisition.travelType}": marque Longo Curso.`, "2.8");
  const generalNote = normalize(requisition.ternos.map(t => t.generalNote).join(" "));
  /EPI/.test(generalNote) && /OBRIGA/.test(generalNote) ? add("ok", "Observação com a obrigatoriedade do EPI.", "2.10") : add("erro", "Falta a frase da obrigatoriedade do EPI na observação da requisição (ex.: É OBRIGATÓRIO O USO DE EPI).", "2.10");
  const offshoreLocal = /LARGO/.test(normalize(requisition.local));
  if (/LARGO/.test(normalize(requisition.berthing)) !== offshoreLocal) add("erro", `"Atracação: ${requisition.berthing}" não combina com o local "${requisition.local}" (ao largo usa o local Rio ao Largo).`, "2.9");
  else add("ok", `${requisition.berthing} em ${requisition.local}.`, "2.9");

  // Nome do navio (5.2 Obs.2, 5.4 Obs.2, 8.1, 10).
  if (v.kind === "balsa" && !op.offshore && !v.attachedTo) add("erro", `Balsa atrelada ao navio deve ser cadastrada como "BALSA XX (AT. NAVIO XX)"; está "${v.raw}".`, "5.2");
  else if (v.kind === "navio" && op.offshore && !v.offshore) add("erro", `Navio ao largo deve ser cadastrado como "NAVIO XX (AL)"; está "${v.raw}".`, "5.4");
  else add("ok", `Nome no padrão: ${v.raw}.`, "2.6");

  // Faina (seção 12).
  const fainaCodes = [...new Set(requisition.ternos.filter(t => t.fainas[0]).map(t => t.fainas[0].code))];
  if (!fainaCodes.length) add("erro", "Nenhuma faina informada.", "3.3");
  else if (fainaCodes.length > 1) add("erro", `Ternos com fainas diferentes (${fainaCodes.join(", ")}).`, "3.3");
  else if (!FAINAS[fainaCodes[0]]) add("confirmar", `Faina ${fainaCodes[0]} fora da tabela de fainas.`, "12");
  else if (spec?.faina && spec.faina !== fainaCodes[0]) add("erro", `Faina ${fainaCodes[0]} para ${spec.title}: o padrão é ${spec.faina}.`, spec.ref);
  else add("ok", `Faina ${fainaCodes[0]} – ${FAINAS[fainaCodes[0]]}.`, "12");

  // Observação de cada terno: operação e produto (3.4) e frases obrigatórias de cada carga.
  const product = op.tarp ? null : PRODUCT_WORDS[op.group];
  const dormentesJunto = op.group !== "dormentes" && others.some(other => shipOf(other) === shipOf(requisition) && operationOf(other).group === "dormentes");
  for (const terno of requisition.ternos) {
    const obs = normalize(terno.observation);
    const label = `Terno ${terno.equipe}`;
    if (!directionOf(obs) || (product && !product.test(obs))) add("erro", `${label}: a observação deve dizer a operação e o produto (ex.: EMBARQUE DE FERRO GUSA); está "${terno.observation || "vazia"}".`, "3.4", { terno: terno.equipe });
    if (spec?.key === "gusa-balsa-largo-descarga" && !/LANCHA/.test(obs)) add("erro", `${label}: na operação ao largo, a observação deve trazer o horário e o local de saída da lancha.`, "5.5", { terno: terno.equipe });
    if (op.group === "dormentes" && !/TYVEK/.test(obs)) add("erro", `${label}: dormentes exigem na observação o uso do macacão Tyvek.`, "9.3", { terno: terno.equipe });
    if (dormentesJunto && !/TYVEK/.test(obs)) add("erro", `${label}: há descarga de dormentes no mesmo navio e período; a observação deve dizer que os TPAs estarão de macacão Tyvek e máscara.`, "9.3", { terno: terno.equipe });
  }
  if (!items.some(item => item.ref === "3.4" && item.level === "erro")) add("ok", "Observação de todos os ternos com operação e produto.", "3.4");

  // Funções só no 1º terno.
  if (many) for (const terno of requisition.ternos.slice(1)) for (const [code, name] of Object.entries(FIRST_TERNO_ONLY)) {
    if (count(terno, code)) add("erro", `Terno ${terno.equipe}: ${name} (${code}) vai só no 1º terno.`, "3.7", { terno: terno.equipe });
  }

  // Composição de cada terno.
  if (!spec) {
    const why = op.offshore && op.group !== "gusa" ? "operação ao largo fora de ferro gusa não está na IT"
      : !op.group ? `faina ${op.faina || "—"} sem composição na IT`
      : !op.direction ? "a observação não diz se é embarque ou descarga"
      : `${op.kind} de ${FAINAS[op.faina] || "carga"} não está na IT`;
    add("confirmar", `Composição não conferida (${why}). Confira pela IT.`, "5–9");
  } else {
    const pe = expectedCapatazia(requisition.date, holidays);
    for (const [index, terno] of requisition.ternos.entries()) {
      const { problems, notes } = compareTerno(spec, terno, index, pe);
      notes.forEach(note => add(note.level, `Terno ${terno.equipe}: ${note.text}.`, spec.ref, { terno: terno.equipe }));
      if (problems.length) add("erro", `Terno ${terno.equipe} (${spec.title}): ${problems.join("; ")}.`, spec.ref, { terno: terno.equipe });
      else add("ok", `Terno ${terno.equipe}: composição de ${spec.title}${spec.pe === "gusa" ? `, com PE ${pe.count} (${pe.why})` : ""}.`, spec.ref, { terno: terno.equipe });
    }
    // Sem capatazia no navio: só quando a carga vai para/vem da balsa (7.3, 7.4, 9.2 Nota 1).
    if (spec.pe === "4-or-barge" && requisition.ternos.some(t => !count(t, "PE"))) {
      const barge = others.find(other => other.vessel.kind === "balsa" && vesselKey(other.vessel.attachedTo || "") === shipOf(requisition));
      barge ? add("ok", `Sem capatazia: a carga vai para/vem da balsa (requisição ${barge.number}).`, "7.3")
        : add("confirmar", "Sem capatazia: só vale quando a carga vai para/vem da balsa. Se for descarregar no chão, são 4 PE. A requisição da balsa deste período ainda não foi enviada.", "7.3");
    }
  }

  // Balsa ao largo × navio ao largo do mesmo período (5.5 Obs.2, 3 e 5).
  if (spec?.key === "gusa-balsa-largo-descarga" || spec?.key === "gusa-navio-largo-embarque") {
    const ship = shipOf(requisition);
    const shipReq = spec.key === "gusa-balsa-largo-descarga" ? others.find(r => r.vessel.kind === "navio" && vesselKey(r.vessel.name) === ship) : requisition;
    const barges = (spec.key === "gusa-balsa-largo-descarga" ? [requisition, ...others] : others).filter(r => r.vessel.kind === "balsa" && vesselKey(r.vessel.attachedTo || "") === ship && /LARGO/.test(normalize(r.local)));
    if (!shipReq || !barges.length) add("confirmar", `Ainda não chegou a requisição ${spec.key === "gusa-balsa-largo-descarga" ? "do navio" : "da balsa"} ao largo deste período: a quantidade de ternos e o conferente chefe são conferidos quando ela for enviada.`, "5.5");
    else {
      const bargeTernos = barges.reduce((sum, r) => sum + r.ternos.length, 0);
      bargeTernos === shipReq.ternos.length ? add("ok", `Balsa${barges.length > 1 ? "s" : ""} com ${bargeTernos} terno(s), igual ao navio.`, "5.5") : add("erro", `Navio ao largo com ${shipReq.ternos.length} terno(s) e balsa(s) com ${bargeTernos}: devem ser iguais.`, "5.5");
      const cfcBarges = barges.filter(r => r.ternos.some(t => count(t, "CFC")));
      if (cfcBarges.length > 1) add("erro", `Conferente chefe em ${cfcBarges.length} balsas: com mais de uma balsa, ele vai só em uma.`, "5.5");
    }
  }

  items.push(...lineupCheck(requisition, lineup));
  items.push(...retroactiveCheck(requisition));
  const result = items.some(item => item.level === "erro") ? "reprovado" : items.some(item => item.level === "confirmar") ? "confirmar" : "aprovado";
  return { result, operation: spec ? { key: spec.key, title: spec.title, ref: spec.ref } : { key: null, title: op.faina ? FAINAS[op.faina] || `faina ${op.faina}` : "não identificada" }, items };
}
