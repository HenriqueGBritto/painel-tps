/* Leitura da planilha da equipe TPS (aba Equipe do painel). Somente leitura: a planilha é a fonte da verdade.
   Abas usadas: Cadastro (pessoas), Listas (funções/equipes), Férias (blocos mensais em formatos variados)
   e NOVOS TREINAMENTOS (texto livre). Resumo, Escala e DATAS 02X02 são ignoradas (o painel recalcula).
   Tudo o que não der para interpretar ou vincular vai para o relatório de importação, sem perder o texto original.
   Testado em tests/team-parsers.test.mjs. */
import { XLSX } from "./parsers.mjs";

export const TEAM_TABS = { people: "Cadastro", lists: "Listas", vacations: "Férias", trainings: "NOVOS TREINAMENTOS" };
const IGNORED_TABS = ["Resumo", "Escala", "DATAS 02X02"];

/* ---------- Texto, datas e nomes ---------- */

const clean = value => String(value ?? "").replace(/\s+/g, " ").trim();
const plain = value => clean(value).normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
const pad = value => String(value).padStart(2, "0");
const isoFromParts = (year, month, day) => {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? `${year}-${pad(month)}-${pad(day)}` : null;
};

/** Número de série do Excel → "AAAA-MM-DD" (dia 0 = 30/12/1899). */
export function serialToIso(serial) {
  if (typeof serial !== "number" || !Number.isFinite(serial) || serial < 20000 || serial > 80000) return null;
  return new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000).toISOString().slice(0, 10);
}

/**
 * Data de uma célula: número de série ou texto "dd/mm/aaaa" (aceita digitação torta como "31//01/2026").
 * Devolve { date, typed } — typed = veio como texto (vale um aviso no relatório).
 */
export function cellDate(value, fallbackYear = null) {
  if (typeof value === "number") return { date: serialToIso(value), typed: false };
  const text = clean(value);
  let match = /(\d{1,2})\s*\/+\s*(\d{1,2})\s*\/+\s*(\d{2,4})/.exec(text);
  if (match) {
    const year = Number(match[3].length === 2 ? `20${match[3]}` : match[3]);
    return { date: isoFromParts(year, Number(match[2]), Number(match[1])), typed: true };
  }
  match = fallbackYear ? /(\d{1,2})\s*\/\s*(\d{1,2})(?!\s*\/)/.exec(text) : null;
  if (match) return { date: isoFromParts(fallbackYear, Number(match[2]), Number(match[1])), typed: true };
  return { date: null, typed: false };
}

/** Datas citadas num texto ("15 e 16/07/2026", "23 - 24/09/2026", "12/08"), em ordem. */
export function datesInText(text, fallbackYear = 2026) {
  const found = new Set();
  const source = clean(text);
  for (const match of source.matchAll(/(\d{1,2})\s*(?:e|-|a)\s*(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{2,4}))?/gi)) {
    const year = match[4] ? Number(match[4].length === 2 ? `20${match[4]}` : match[4]) : fallbackYear;
    [match[1], match[2]].forEach(day => { const iso = isoFromParts(year, Number(match[3]), Number(day)); if (iso) found.add(iso); });
  }
  for (const match of source.matchAll(/(?<![\d/])(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{2,4}))?(?![\d])/g)) {
    const year = match[3] ? Number(match[3].length === 2 ? `20${match[3]}` : match[3]) : fallbackYear;
    const iso = isoFromParts(year, Number(match[2]), Number(match[1]));
    if (iso) found.add(iso);
  }
  return [...found].sort();
}

/* Pedaços que acompanham o nome nas planilhas e não fazem parte dele. */
const NAME_NOISE = /^(A|B|C|D|ADM|ADMINISTRATIVO|EQUIPE [A-D]|CAPATAZIA( DIA| NOITE| 0?[12])?|MATERIAIS|AVISADO.*|EXCLUIDO|NAO E TPS|RESOLVIDO.*|ENTREGAR CRACHA|SEM EXTRA|FALTOU|FEZ.*|NAO QUIS.*|DESISTIU|FERIAS.*|OK|PTA OK|CARTAO.*|SOLIC.*|MENSAGEM.*|ABERTO.*|ENVIADO|ASO.*|OPMC|CONFERENTE|ESTIVADOR|OPERADOR.*|ASSISTENTE.*|SUPERVISOR.*|AUXILIAR.*|TRABALHADOR.*|BALANCEIRO)$/;
const CONNECTORS = new Set(["DA", "DE", "DO", "DAS", "DOS", "E"]);
/** Palavras soltas que às vezes vêm grudadas no fim do nome ("… DA SILVA avisado"). */
const TRAILING_NOISE = new Set(["AVISADO", "AVISADA", "FALTOU", "FEZ", "OK", "EXCLUIDO", "ENVIADO", "E", "DA", "DE", "DO", "DAS", "DOS"]);

/** Nome comparável: sem acento, caixa, parênteses, matrícula e sufixos como " - A", "(OPMC)", "- AVISADO". */
export function normalizeName(text) {
  const parts = plain(text).replace(/\([^)]*\)/g, " ").split(/\s+[-–—]\s+|\s*\/\s*|\s+-(?=\S)|(?<=\S)-\s+/);
  for (const part of parts) {
    const candidate = part.replace(/\b\d+\b/g, " ").replace(/[^A-Z' ]+/g, " ").replace(/\s+/g, " ").trim();
    const words = candidate.split(" ").filter(word => word.length > 1 || CONNECTORS.has(word));
    while (words.length && TRAILING_NOISE.has(words.at(-1))) words.pop();
    if (words.filter(word => !CONNECTORS.has(word)).length >= 2 && !NAME_NOISE.test(candidate)) return words.join(" ");
  }
  return "";
}

/** Matrícula/chapa num texto: número de 3 a 5 dígitos fora de datas e horários. */
export function matriculaIn(text) {
  const source = typeof text === "number" ? String(text) : clean(text);
  for (const match of source.matchAll(/(?<![\d/:.,])(\d{3,5})(?![\d/:.,]|\s*h\b)/g)) return match[1];
  return null;
}

const significant = name => name.split(" ").filter(word => !CONNECTORS.has(word));
function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 3) return 99;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}

/**
 * Índice das pessoas do Cadastro para vincular os nomes e matrículas das outras abas.
 * resolve({ matricula, name }) → { id, how } ("matricula" | "nome" | "aproximado") ou { external: true }.
 */
export function peopleIndex(people) {
  const byId = new Map(people.map(person => [person.id, person]));
  const byName = new Map();
  people.forEach(person => { const key = normalizeName(person.name); if (key && !byName.has(key)) byName.set(key, person); });
  const keys = [...byName.keys()];
  /** Mesmo nome (exato), nome contido no outro (palavras na mesma ordem) ou erro de digitação pequeno. */
  function byNameMatch(name) {
    const key = normalizeName(name);
    if (!key) return null;
    if (byName.has(key)) return { person: byName.get(key), how: "nome" };
    const words = significant(key);
    const contained = keys.filter(other => {
      const otherWords = significant(other);
      const [short, long] = words.length <= otherWords.length ? [words, otherWords] : [otherWords, words];
      let index = 0;
      return short.length >= 2 && short.every(word => (index = long.indexOf(word, index) + 1) > 0) && short[0] === long[0];
    });
    if (contained.length === 1) return { person: byName.get(contained[0]), how: "aproximado" };
    const near = keys.map(other => ({ other, distance: editDistance(key, other) })).filter(item => item.distance <= 2).sort((a, b) => a.distance - b.distance);
    if (near.length === 1 || (near.length > 1 && near[0].distance < near[1].distance)) return { person: byName.get(near[0].other), how: "aproximado" };
    return null;
  }
  function resolve({ matricula = null, name = "" }) {
    const id = matricula ? String(matricula) : null;
    const byNumber = id ? byId.get(id) : null;
    const named = name ? byNameMatch(name) : null;
    if (byNumber && (!named || named.person === byNumber)) return { id: byNumber.id, how: "matricula" };
    if (named && byNumber) return { id: named.person.id, how: named.how, conflict: `matrícula ${id} informada para ${clean(name)}, mas no Cadastro ${id} é ${byNumber.name}` };
    if (named) return { id: named.person.id, how: named.how, ...(id && id !== named.person.id ? { conflict: `matrícula ${id} informada para ${clean(name)}, mas no Cadastro essa pessoa é ${named.person.id}` } : {}) };
    if (byNumber) return { id: byNumber.id, how: "matricula", ...(name && normalizeName(name) ? { conflict: `nome “${clean(name)}” não confere com o Cadastro (${byNumber.name}) para a matrícula ${id}` } : {}) };
    return { external: true };
  }
  return { byId, resolve };
}

/* ---------- Relatório de importação ---------- */

function createReport() {
  const items = [];
  return {
    items,
    add(sheet, row, level, message, text = "") { items.push({ sheet, row, level, message, text: clean(text).slice(0, 300) }); }
  };
}

const rowsOf = (workbook, name) => workbook.Sheets[name] ? XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: true, defval: null, blankrows: true }) : null;
const filledCells = row => (row || []).map((value, column) => ({ value, column })).filter(cell => clean(cell.value) !== "");

/* ---------- Cadastro e Listas ---------- */

const STATUSES = { "ATIVO": "Ativo", "ATIVO (EM TRANSFERENCIA)": "Ativo (em transferência)", "AFASTADO (INSS)": "Afastado (INSS)", "FERIAS": "Férias" };
const SCHEDULE_HINT = /\b\d{1,2}\s*x\s*\d{1,2}\b|\b\d{1,2}\s*h\b|\bvespertin|\bnoturn|\bnoite\b|\bfolgas?\b|\bescala\b|\bmatutin/i;

/** Colunas pelo nome do cabeçalho (a posição pode mudar na planilha). */
function headerMap(header, wanted) {
  const map = {};
  Object.entries(wanted).forEach(([key, pattern]) => {
    const index = header.findIndex(cell => pattern.test(plain(cell)));
    if (index >= 0) map[key] = index;
  });
  return map;
}

export function parsePeople(rows, report) {
  const headerIndex = rows.findIndex(row => (row || []).some(cell => /^MATRICULA$/.test(plain(cell))) && (row || []).some(cell => /^NOME$/.test(plain(cell))));
  if (headerIndex < 0) { report.add(TEAM_TABS.people, 1, "erro", "Cabeçalho do Cadastro não encontrado (Matrícula e Nome)."); return []; }
  const columns = headerMap(rows[headerIndex], {
    matricula: /^MATRICULA$/, name: /^NOME$/, role: /^FUNCAO$/, category: /^CATEGORIA$/, team: /^EQUIPE$/, shift: /^TURNO$/,
    hours: /^HORARIO$/, schedule: /^ESCALA$/, status: /^STATUS$/, note: /^OBSERVACAO$/
  });
  const people = [];
  const seen = new Set();
  rows.slice(headerIndex + 1).forEach((row, offset) => {
    const line = headerIndex + offset + 2;
    const get = key => columns[key] === undefined ? "" : clean(row?.[columns[key]]);
    const id = get("matricula").replace(/\.0$/, ""), name = get("name");
    if (!id && !name) return;
    if (!id || !name) { report.add(TEAM_TABS.people, line, "erro", "Linha do Cadastro sem matrícula ou sem nome.", `${id} ${name}`); return; }
    if (seen.has(id)) { report.add(TEAM_TABS.people, line, "erro", `Matrícula ${id} repetida no Cadastro; a primeira linha foi mantida.`, name); return; }
    seen.add(id);
    const status = STATUSES[plain(get("status"))] || get("status") || "Ativo";
    if (!STATUSES[plain(get("status"))]) report.add(TEAM_TABS.people, line, "aviso", `Status “${get("status") || "vazio"}” fora da lista; tratado como informado.`, name);
    const note = get("note");
    const destination = /\bvai\s+p(?:ara|\/|\.)?\s*(.+)$/i.exec(note)?.[1]?.trim() || null;
    people.push({
      id, name, role: get("role"), category: get("category"), team: get("team"), shift: get("shift"), hours: get("hours"),
      schedule: get("schedule"), status, note, transferTo: status === "Ativo (em transferência)" ? destination : null,
      customSchedule: Boolean(note && SCHEDULE_HINT.test(note))
    });
  });
  return people;
}

export function parseLists(rows) {
  const header = rows[0] || [];
  const col = pattern => header.findIndex(cell => pattern.test(plain(cell)));
  const roleCol = col(/^FUNCOES?$/), categoryCol = col(/^CATEGORIA$/), teamCol = col(/^EQUIPE$/), statusCol = col(/^STATUS$/);
  const shiftCol = col(/^TURNO$/), hoursCol = col(/^HORARIO$/), scheduleCol = col(/^ESCALA$/);
  const roles = [], teams = [], statuses = [];
  rows.slice(1).forEach(row => {
    if (roleCol >= 0 && clean(row?.[roleCol])) roles.push({ role: clean(row[roleCol]), category: clean(row[categoryCol]) });
    if (teamCol >= 0 && clean(row?.[teamCol])) teams.push({ team: clean(row[teamCol]), shift: clean(row[shiftCol]), hours: clean(row[hoursCol]), schedule: clean(row[scheduleCol]) });
    if (statusCol >= 0 && clean(row?.[statusCol])) statuses.push(clean(row[statusCol]));
  });
  return { roles, teams, statuses };
}

/* ---------- Férias (e demais ausências/coberturas) ---------- */

const MONTHS = ["JANEIRO", "FEVEREIRO", "MARCO", "ABRIL", "MAIO", "JUNHO", "JULHO", "AGOSTO", "SETEMBRO", "OUTUBRO", "NOVEMBRO", "DEZEMBRO"];
const isVacationTitle = text => /F[EÉ]RIAS|COBERTURA/i.test(text) && !/^(MATRIC|CHAPA)/i.test(plain(text));
const isVacationHeader = row => {
  const cells = (row || []).map(plain);
  return cells.some(cell => /^(MATRIC|CHAPA)/.test(cell)) && cells.some(cell => /^NOME/.test(cell));
};
const MOTIVES = { FERIAS: "Férias", AFASTAMENTO: "Afastamento", MOBILIDADE: "Mobilidade", "CARGO VAGO": "Cargo vago" };
const NO_COVER = /^(NAO|SEM COBERTURA|-|—)$/;

/** Colunas de um bloco de Férias. Um segundo par CHAPA/NOME depois das datas é a pessoa que cobre. */
function vacationColumns(header) {
  const cells = header.map(plain);
  const first = (pattern, from = 0) => { const index = cells.findIndex((cell, i) => i >= from && pattern.test(cell)); return index >= 0 ? index : undefined; };
  const columns = {
    matricula: first(/^(MATRIC|CHAPA)/), name: first(/^NOME/), role: first(/^FUN[CÇ]/), team: first(/^(EQUIPE|SETOR|DESCRICAO)$/),
    motive: first(/^MOTIVO/), start: first(/IN[IÍ]CIO|DATAINICIO/), end: first(/TERMINO|DATAFIM|PERIODO FIM|^FIM$/), returns: first(/^RETOR/),
    cover: first(/COBERTURA|QUEM VAI COBRIR/), notice: first(/AVIS/), evaluation: first(/AVALIA/)
  };
  const afterDates = Math.max(columns.end ?? -1, columns.returns ?? -1);
  const coverId = first(/^(MATRIC|CHAPA)/, afterDates + 1), coverName = first(/^NOME/, afterDates + 1);
  if (coverName !== undefined) { columns.coverMatricula = coverId; columns.coverName = coverName; columns.coverRole = first(/^FUN[CÇ]/, coverName + 1); }
  return columns;
}

/** Texto do nome com marcas da planilha: "NÃO É TPS" (externo), "EXCLUIDO", "AVISADO" etc. viram observações. */
function nameFlags(text) {
  const value = plain(text);
  const notes = [];
  if (/NAO E TPS/.test(value)) notes.push("não é TPS");
  if (/EXCLU[I]+DO/.test(value)) notes.push("marcado como excluído");
  if (/AVISADO/.test(value)) notes.push("avisado");
  if (/RESOLVIDO/.test(value)) notes.push("resolvido, já estava assinado");
  if (/ENTREGAR CRACHA/.test(value)) notes.push("entregar crachá");
  return { notes, notTps: /NAO E TPS/.test(value) };
}

export function parseVacations(rows, index, report, year = 2026) {
  const sheet = TEAM_TABS.vacations;
  const absences = [];
  let block = null, columns = null;
  const personRef = (matricula, name, line, role) => {
    const flags = nameFlags(name);
    const resolved = flags.notTps ? { external: true } : index.resolve({ matricula, name });
    if (resolved.conflict) report.add(sheet, line, "aviso", `Vínculo com conflito (${role}): ${resolved.conflict}. Vinculado pelo nome.`, name);
    else if (resolved.how === "aproximado") report.add(sheet, line, "aviso", `Vinculado por aproximação do nome (${role}).`, name);
    if (resolved.external) report.add(sheet, line, "aviso", `Pessoa fora do Cadastro (${role}); entra como externa.`, `${matricula || ""} ${name}`);
    return { ...(resolved.external ? { external: true, id: matricula || null } : { id: resolved.id }), name: normalizeName(name) || clean(name), notes: flags.notes };
  };
  rows.forEach((row, rowIndex) => {
    const line = rowIndex + 1;
    const cells = filledCells(row);
    if (!cells.length) return;
    const firstText = clean(cells[0].value);
    if (cells.length <= 2 && isVacationTitle(firstText)) {
      const monthIndex = MONTHS.findIndex(month => plain(firstText).includes(month));
      block = { title: firstText, month: monthIndex >= 0 ? monthIndex + 1 : null };
      columns = null;
      return;
    }
    if (isVacationHeader(row)) {
      columns = vacationColumns(row);
      if (!block) block = { title: "Bloco sem título", month: null };
      else if (block.used) { block = { title: `Bloco sem título (depois de “${block.title}”)`, month: null }; report.add(sheet, line, "aviso", "Cabeçalho sem título de bloco; o mês é deduzido pelas datas de cada linha.", row.join(" | ")); }
      return;
    }
    if (!columns) { report.add(sheet, line, "aviso", "Linha fora de um bloco reconhecido (sem título e cabeçalho antes).", cells.map(cell => cell.value).join(" | ")); return; }
    const get = key => columns[key] === undefined ? null : row[columns[key]];
    const name = clean(get("name"));
    const matricula = matriculaIn(get("matricula") ?? "");
    if (!name && !matricula) { report.add(sheet, line, "aviso", "Linha sem nome nem matrícula.", cells.map(cell => cell.value).join(" | ")); return; }
    block.used = true;
    const notes = [];
    const start = cellDate(get("start")), end = cellDate(get("end"));
    const returnCell = get("returns");
    const returned = cellDate(returnCell);
    [["início", start, get("start")], ["término", end, get("end")]].forEach(([label, parsed, raw]) => {
      if (!parsed.date) report.add(sheet, line, "erro", `Data de ${label} inválida ou vazia.`, `${name} · ${clean(raw)}`);
      else if (parsed.typed) report.add(sheet, line, "aviso", `Data de ${label} digitada como texto (“${clean(raw)}”); interpretada como ${parsed.date.split("-").reverse().join("/")}.`, name);
    });
    let motive = MOTIVES[plain(get("motive"))] || (clean(get("motive")) ? clean(get("motive")) : null);
    if (returnCell !== null && returnCell !== "" && !returned.date) {
      const text = clean(returnCell);
      if (!motive && MOTIVES[plain(text)]) motive = MOTIVES[plain(text)];
      else notes.push(`retorno: ${text}`);
    }
    if (start.date && end.date) {
      if (end.date < start.date) report.add(sheet, line, "erro", "Término antes do início.", name);
      else if ((Date.parse(end.date) - Date.parse(start.date)) / 86400000 > 60) report.add(sheet, line, "aviso", `Período longo demais para férias (${start.date.split("-").reverse().join("/")} a ${end.date.split("-").reverse().join("/")}); confira as datas.`, name);
    }
    const person = personRef(matricula, name, line, "quem sai");
    notes.push(...person.notes);
    // Cobertura: par CHAPA/NOME depois das datas ou coluna COBERTURA/QUEM VAI COBRIR (texto "NOME - matrícula").
    let cover = null, coverStatus = "não informada";
    const coverName = clean(columns.coverName !== undefined ? get("coverName") : get("cover"));
    const coverId = columns.coverName !== undefined ? matriculaIn(get("coverMatricula") ?? "") : matriculaIn(coverName);
    if (coverName && NO_COVER.test(plain(coverName))) coverStatus = "sem cobertura";
    else if (/^RETORNA EM/.test(plain(coverName))) { notes.push(coverName.toLowerCase()); }
    else if (coverName) {
      if (normalizeName(coverName)) { cover = personRef(coverId, coverName, line, "cobertura"); coverStatus = "com cobertura"; notes.push(...cover.notes.map(note => `cobertura ${note}`)); }
      else notes.push(`cobertura: ${coverName}`);
    }
    // Colunas sem cabeçalho com texto ("ASSINADOS", "NÃO PODE COBRIR…", "Cargo vago") viram observação.
    const known = new Set(Object.values(columns).filter(value => value !== undefined));
    cells.filter(cell => !known.has(cell.column) && typeof cell.value === "string").forEach(cell => notes.push(clean(cell.value)));
    absences.push({
      id: `f${line}`, line, block: block.title, month: block.month, person: { id: person.id, name: person.name, external: Boolean(person.external) },
      role: clean(get("role")), team: clean(get("team")), motive: motive || "Férias",
      start: start.date, end: end.date, returnDate: returned.date, cover: cover ? { id: cover.id, name: cover.name, external: Boolean(cover.external) } : null,
      coverStatus, coverRole: clean(get("coverRole")), notice: clean(get("notice")), evaluation: clean(get("evaluation")), notes: [...new Set(notes.filter(Boolean))]
    });
  });
  return mergeDuplicateAbsences(absences.filter(item => item.start && item.end));
}

/* A mesma ausência às vezes aparece em dois blocos (ex.: lista de férias de julho e de cobertura de agosto).
   Mesma pessoa, motivo e período → um registro só, com os blocos, a cobertura e as observações juntos. */
function mergeDuplicateAbsences(absences) {
  const merged = new Map();
  for (const item of absences) {
    const key = [item.person.id || item.person.name, item.motive, item.start, item.end].join("|");
    const existing = merged.get(key);
    if (!existing) { merged.set(key, { ...item, blocks: [item.block], lines: [item.line] }); continue; }
    existing.blocks.push(item.block);
    existing.lines.push(item.line);
    if (!existing.cover && item.cover) { existing.cover = item.cover; existing.coverStatus = item.coverStatus; existing.coverRole = item.coverRole; }
    if (existing.coverStatus === "não informada" && item.coverStatus !== "não informada") existing.coverStatus = item.coverStatus;
    existing.returnDate ||= item.returnDate;
    existing.notice ||= item.notice;
    existing.evaluation ||= item.evaluation;
    existing.role ||= item.role;
    existing.notes = [...new Set([...existing.notes, ...item.notes])];
  }
  return [...merged.values()];
}

/* ---------- Treinamentos (texto livre) ---------- */

const TRAINING_TITLE = /TREINAMENTO|CURSO|NR\s?35|\bPTA\b|\bASO\b|BRIGADA|RISK FACTOR|HABILITADOS|AGUARDANDO DIAS|NOMES PARA/;
const TRAINING_TYPES = [[/BRIGADA/, "Brigada de Incêndio"], [/RISK FACTOR/, "Risk Factor"], [/HABILITADOS EM PTA/, "PTA (habilitados)"], [/NR\s?35|PTA/, "NR35 / PTA"], [/\bASO\b/, "ASO"]];
const trainingType = title => (TRAINING_TYPES.find(([pattern]) => pattern.test(plain(title))) || [null, "Outro"])[1];

/** Situação de um participante pelas palavras do texto. "CANCELADO … FOI PARA" é remarcação, não cancelamento;
    "Não quis PTA" com certificado/feito continua realizado (recusou só a PTA). */
export function participantStatus(text, { scheduled = false } = {}) {
  const value = plain(text);
  const done = /\bFEZ\b|REALIZOU|PTA OK|ASO OK|JA TEM TREINAMENTO|HABILITAD|\bCERTIFICADO\b(?! PEDIDO)|PEDINDO O CERTIFICADO/.test(value);
  if (/DESIST/.test(value)) return "desistiu";
  if (/NAO QUIS/.test(value) && !(done && /NAO QUIS PTA/.test(value))) return "não quis";
  if (/FALTOU|FALTAS/.test(value) && !done) return "faltou";
  if (/CANCELADO/.test(value) && !/FOI PARA/.test(value)) return "cancelado";
  if (done) return "realizado";
  if (/FERIAS/.test(value) && !/AVISADO|FOI PARA/.test(value)) return "ausente (férias)";
  if (/AVISADO|FOI PARA|\bDIAS?\b|AGUARD|\bDE \d{1,2}H/.test(value) || scheduled) return "agendado";
  return "sem situação";
}
export function certificateStatus(text) {
  const value = plain(text);
  if (/PEDINDO O CERTIFICADO|CERTIFICADO PEDIDO|SOLICITAR CERTIFICADO/.test(value)) return /- ENVIADO\b|RECEBID/.test(value) ? "recebido" : "pedido";
  if (/\bCERTIFICADO\b/.test(value)) return "recebido";
  return null;
}
const TEAM_IN_TEXT = /(?:^|[\s-])(?:EQUIPE\s+)?([A-D])(?=\s*(?:-|–|\/|$))|CAPATAZIA\s*(DIA|NOITE)|\bADM\b/;
function teamIn(text) {
  const match = TEAM_IN_TEXT.exec(plain(text));
  if (!match) return null;
  if (match[1]) return match[1];
  if (match[2]) return `Capatazia ${match[2] === "DIA" ? "Dia" : "Noite"}`;
  return "Administrativo";
}
/* Horário de turma ("10/04/2026 - 05:30 às 07:30") e células de apoio que não são pessoas. */
const SLOT = /^\d{1,2}\/\d{1,2}\/\d{4}\s*-\s*\d{1,2}:\d{2}/;
const NOT_PERSON = /^(QUINTA|SEXTA|SEGUNDA|TERCA|QUARTA|SABADO|DOMINGO)-FEIRA|^CAPATAZIA (DIA|NOITE) \d|^DE \d{1,2}H|^(CANCELADO|CARTO|TROCA DE|AGUARD|REALIZOU|FEZ|NAO QUIS|DESIST|FALTOU|AVISADO|DIA DE FOLGA|MELHOR DIA|SEM EXTRA|CERTIFICADO|OK\b)/;
const isMatriculaNumber = value => typeof value === "number" && value >= 100 && value < 20000;

export function parseTrainings(rows, index, report) {
  const sheet = TEAM_TABS.trainings;
  const trainings = [];
  let current = null, statusContext = null, gridTeams = null, nameColumn = null, pendingNotes = [];
  const start = (title, line) => {
    current = { id: `t${line}`, line, title: clean(title), type: trainingType(title), dates: datesInText(title), location: "", participants: [], notes: pendingNotes };
    pendingNotes = [];
    trainings.push(current);
    statusContext = /AGUARDANDO/.test(plain(title)) ? "aguardando agenda" : null; gridTeams = null; nameColumn = null;
  };
  const note = text => { if (current) current.notes.push(text); else pendingNotes.push(text); };
  const addParticipant = (text, line, column, extras = "", rowDate = null) => {
    const raw = clean(text);
    const name = normalizeName(raw);
    const matricula = matriculaIn(raw) || (extras ? matriculaIn(extras.split(" · ")[0]) : null);
    if (!name && !matricula) return false;
    if (!current) start("Treinamento sem título", line);
    const flags = nameFlags(raw);
    const resolved = flags.notTps ? { external: true } : index.resolve({ matricula, name: raw });
    if (resolved.conflict) report.add(sheet, line, "aviso", `Vínculo com conflito: ${resolved.conflict}. Vinculado pelo nome.`, raw);
    else if (resolved.how === "aproximado") report.add(sheet, line, "aviso", "Vinculado por aproximação do nome.", raw);
    if (resolved.external) report.add(sheet, line, "aviso", "Participante fora do Cadastro; entra como externo.", raw);
    const all = [raw, extras].filter(Boolean).join(" · ");
    const dates = [...new Set([...(rowDate ? [rowDate] : []), ...datesInText(all)])].sort();
    const participant = {
      person: resolved.external ? { external: true, id: matricula, name: name || raw } : { id: resolved.id, name },
      team: gridTeams?.[column] || teamIn(raw) || teamIn(extras) || null,
      status: statusContext || participantStatus(all, { scheduled: dates.length > 0 || current.dates.length > 0 }), certificate: certificateStatus(all), dates, note: all, line
    };
    // A mesma pessoa repetida no mesmo treinamento vira um registro só, com os textos juntos.
    const key = participant.person.id || participant.person.name;
    const existing = current.participants.find(item => (item.person.id || item.person.name) === key);
    if (existing) {
      existing.note = [...new Set([existing.note, participant.note])].join(" · ");
      existing.dates = [...new Set([...existing.dates, ...participant.dates])].sort();
      existing.certificate ||= participant.certificate;
      if (existing.status === "sem situação") existing.status = participant.status;
    } else current.participants.push(participant);
    return true;
  };
  rows.forEach((row, rowIndex) => {
    const line = rowIndex + 1;
    const cells = filledCells(row);
    if (!cells.length) return;
    const texts = cells.map(cell => typeof cell.value === "number" ? cell.value : clean(cell.value));
    const joined = texts.join(" | ");
    const first = plain(texts[0]);
    // Horários de turma soltos numa coluna: anotação do treinamento.
    const slots = cells.filter(cell => typeof cell.value === "string" && SLOT.test(clean(cell.value)));
    slots.forEach(cell => note(`Horário: ${clean(cell.value)}`));
    const content = cells.filter(cell => !slots.includes(cell));
    if (!content.length) return;
    if (/^TOTAL$/.test(first) || content.some(cell => /^TOTAL$/.test(plain(cell.value)))) { note(joined); return; }
    if (/^O TREINAMENTO OCORRERA NA /.test(first)) {
      const place = clean(texts[0]).replace(/^O treinamento ocorrer[áa] na\s*/i, "").replace(/\.$/, "");
      if (current) current.location = place; else pendingNotes.push(`Local: ${place}`);
      return;
    }
    if (/^DESISTENCIAS?$/.test(first)) { statusContext = "desistiu"; gridTeams = null; return; }
    // Cabeçalho com título embutido: "MATRICULA | NOME - DIA 11/09/2026 - CURSO NR35 | FUNÇÃO".
    const embedded = content.find(cell => /^NOME\b.*(CURSO|NR\s?35|DIA)/.test(plain(cell.value)));
    if (embedded) { start(clean(embedded.value).replace(/^NOME\s*-\s*/i, ""), line); nameColumn = embedded.column; return; }
    if (/AINDA NAO FIZERAM/.test(plain(joined))) { start(content.map(cell => clean(cell.value)).join(" "), line); statusContext = "pendente"; return; }
    // Título: célula de texto de treinamento, sem matrícula na linha e sem pessoa ao lado.
    const hasMatricula = content.some(cell => isMatriculaNumber(cell.value)) || content.some(cell => typeof cell.value === "string" && matriculaIn(cell.value));
    const titleCell = content.find(cell => typeof cell.value === "string" && TRAINING_TITLE.test(plain(cell.value)) && !/\s-\s[A-D](\s|$)/.test(plain(cell.value)));
    if (titleCell && !hasMatricula && !/MELHOR DIA/.test(plain(joined))) {
      start(content.filter(cell => typeof cell.value === "string").map(cell => clean(cell.value)).join(" · "), line);
      return;
    }
    // Cabeçalhos de grade por equipe ("EQUIPE A | EQUIPE B | …") e de colunas ("NOME | FUNÇÃO | SETOR").
    if (content.every(cell => /^EQUIPE [A-D]\b/.test(plain(cell.value)))) { gridTeams = Object.fromEntries(content.map(cell => [cell.column, plain(cell.value).slice(7, 8)])); nameColumn = null; return; }
    if (content.length >= 2 && content.every(cell => /^(NOME( COMPLETO)?|FUNCAO|SETOR|MATRICULA|EQUIPE - CONTROLE TPS|MANHA|NOITE)$/.test(plain(cell.value)))) {
      const nameCell = content.find(cell => /^NOME/.test(plain(cell.value)));
      nameColumn = nameCell ? nameCell.column : null;
      return;
    }
    const teamHeader = /^EQUIPE ([A-D])\b/.exec(first);
    if (teamHeader) { gridTeams = { [cells[0].column]: teamHeader[1] }; nameColumn = null; return; }
    // Pessoas: com cabeçalho de colunas, só a coluna NOME; sem ele, cada célula com nome é um participante.
    const rowIso = serialToIso(content.find(cell => typeof cell.value === "number" && serialToIso(cell.value))?.value);
    const matriculaCell = content.find(cell => isMatriculaNumber(cell.value));
    const candidates = content.filter(cell => typeof cell.value === "string" && normalizeName(cell.value) && !NOT_PERSON.test(plain(cell.value)));
    const people = nameColumn !== null ? candidates.filter(cell => cell.column === nameColumn) : candidates;
    if (!people.length) { note(joined); return; }
    let added = 0;
    for (const cell of people) {
      const solo = people.length === 1;
      const text = solo && matriculaCell ? `${matriculaCell.value} - ${cell.value}` : cell.value;
      const extras = solo ? content.filter(other => other !== cell && other !== matriculaCell && typeof other.value === "string").map(other => clean(other.value)).join(" · ") : "";
      if (addParticipant(text, line, cell.column, extras, rowIso)) added++;
    }
    if (!added) report.add(sheet, line, "aviso", "Linha de treinamento não interpretada; mantida como observação.", joined);
  });
  if (pendingNotes.length) pendingNotes.forEach(text => report.add(sheet, 0, "aviso", "Texto fora de um treinamento reconhecido.", text));
  return trainings.filter(training => training.participants.length || training.notes.length);
}

/* ---------- Planilha inteira ---------- */

/** Menções a 12x36 (a operação não tem mais essa escala) em qualquer aba lida. */
function scan12x36(workbook, report) {
  Object.values(TEAM_TABS).forEach(name => (rowsOf(workbook, name) || []).forEach((row, index) => {
    (row || []).forEach(cell => { if (/12\s*x\s*36/i.test(String(cell ?? ""))) report.add(name, index + 1, "aviso", "Menção a 12x36: a operação não tem mais essa escala.", cell); });
  }));
}

export function parseTeamWorkbook(workbook, source = "Planilha da equipe") {
  const report = createReport();
  const missing = [TEAM_TABS.people].filter(name => !workbook.Sheets[name]);
  if (missing.length) throw new Error(`Aba obrigatória ausente na planilha da equipe: ${missing.join(", ")}.`);
  const people = parsePeople(rowsOf(workbook, TEAM_TABS.people), report);
  if (!people.length) throw new Error("Nenhuma pessoa encontrada na aba Cadastro.");
  const index = peopleIndex(people);
  const lists = workbook.Sheets[TEAM_TABS.lists] ? parseLists(rowsOf(workbook, TEAM_TABS.lists)) : { roles: [], teams: [], statuses: [] };
  const absences = workbook.Sheets[TEAM_TABS.vacations] ? parseVacations(rowsOf(workbook, TEAM_TABS.vacations), index, report) : [];
  const trainings = workbook.Sheets[TEAM_TABS.trainings] ? parseTrainings(rowsOf(workbook, TEAM_TABS.trainings), index, report) : [];
  [TEAM_TABS.lists, TEAM_TABS.vacations, TEAM_TABS.trainings].forEach(name => { if (!workbook.Sheets[name]) report.add(name, 0, "aviso", "Aba não encontrada na planilha."); });
  scan12x36(workbook, report);
  return { source, people, lists, absences, trainings, report: report.items, ignoredTabs: IGNORED_TABS };
}
