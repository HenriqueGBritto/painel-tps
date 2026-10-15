/* O que mudou entre duas leituras da mesma planilha.
   Cada leitura nova é comparada com a cópia anterior; quando há diferença, entra um
   registro no histórico (changeLog) guardado junto da cópia e mostrado ao clicar no selo.
   Os textos já saem prontos em português para a página só exibir. */

/** Leituras com alteração mantidas no histórico. */
export const MAX_ENTRIES = 15;
/** Linhas por seção dentro de um registro (o total continua informado em `count`). */
export const MAX_ITEMS = 30;

const TZ = "America/Sao_Paulo";
const upper = value => String(value ?? "").trim().toLocaleUpperCase("pt-BR");
const isDateOnly = value => /^\d{4}-\d{2}-\d{2}$/.test(value);
const dayMonthYear = iso => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const dateTimeFormat = new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

/** "13/10 15:02" para data e hora; "13/10/2026" para dia sem hora. */
export function when(value) {
  if (!value) return "sem data";
  if (isDateOnly(value)) return dayMonthYear(value);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : dateTimeFormat.format(date).replace(",", "");
}
const tons = value => Number.isFinite(value) ? `${Math.round(value).toLocaleString("pt-BR")} t` : "vazio";
const perDay = value => Number.isFinite(value) ? `${Math.round(value).toLocaleString("pt-BR")} t/dia` : "vazio";
const percent = value => Number.isFinite(value) ? `${Math.round(value * (value <= 1 ? 100 : 1))}%` : "vazio";
const plain = value => value === null || value === undefined || value === "" ? "vazio" : String(value);

const sameValue = (a, b) => {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 0.0005;
  return (a ?? null) === (b ?? null) || (a ?? "") === (b ?? "");
};

/** "volume 10.000 t → 10.500 t; desatracação 12/10 08:00 → 12/10 10:30" ou "" sem diferença. */
function fieldChanges(before, after, fields) {
  return fields
    .filter(([key]) => !sameValue(before[key], after[key]))
    .map(([key, label, format = plain]) => `${label} ${format(before[key])} → ${format(after[key])}`)
    .join("; ");
}

/** Indexa linhas por chave; chaves repetidas ganham um sufixo para não se sobreporem. */
function indexBy(rows, key) {
  const map = new Map();
  for (const row of rows || []) {
    const base = key(row);
    let unique = base, n = 2;
    while (map.has(unique)) unique = `${base}#${n++}`;
    map.set(unique, row);
  }
  return map;
}

class Sections {
  constructor() { this.list = []; this.byTitle = new Map(); }
  add(title, text) {
    let section = this.byTitle.get(title);
    if (!section) { section = { title, count: 0, items: [] }; this.byTitle.set(title, section); this.list.push(section); }
    section.count++;
    if (section.items.length < MAX_ITEMS) section.items.push(text);
  }
  result() { return this.list; }
}

/* ---------- Planilha de navios ---------- */

const vesselKey = row => `${upper(row.vessel)}|${(row.berthStart || row.operationStart || "").slice(0, 16)}`;
const CONCLUDED_FIELDS = [
  ["berthStart", "atracação", when], ["operationStart", "início da operação", when], ["operationEnd", "fim da operação", when],
  ["berthEnd", "desatracação", when], ["tons", "volume", tons], ["productivity", "prancha", perDay],
  ["berth", "berço"], ["operation", "operação"], ["cargo", "carga"], ["client", "cliente"]
];
const ACTIVE_FIELDS = [
  ["operationStart", "início da operação", when], ["partialTons", "volume parcial", tons],
  ["berth", "berço"], ["operation", "operação"], ["cargo", "carga"], ["client", "cliente"]
];
const GUSA_FIELDS = [
  ["departure", "saída", when], ["draftTons", "calado", tons], ["invoiceTons", "nota fiscal", tons], ["scaleTons", "balança", tons]
];
const LINEUP_FIELDS = [
  ["plannedBerthStart", "atracação prevista", when], ["plannedBerthEnd", "desatracação prevista", when],
  ["berth", "berço"], ["progress", "andamento", percent], ["plannedBerthTons", "peso no berço", tons],
  ["plannedOffshoreTons", "peso ao largo", tons], ["operation", "operação"], ["cargo", "carga"], ["client", "cliente"], ["agent", "agência"]
];

export function diffOperations(previous, next) {
  const out = new Sections();
  const before = { done: indexBy(previous.records, vesselKey), active: indexBy(previous.activeRecords, vesselKey) };
  const after = { done: indexBy(next.records, vesselKey), active: indexBy(next.activeRecords, vesselKey) };

  for (const [key, row] of after.active) {
    const old = before.active.get(key);
    if (!old && !before.done.has(key)) out.add("Novas atracações", `${row.vessel}: atracou em ${when(row.berthStart)} no berço ${row.berth} · ${row.cargo}`);
    else if (old) {
      const changes = fieldChanges(old, row, ACTIVE_FIELDS);
      if (changes) out.add("Navios em operação", `${row.vessel}: ${changes}`);
    }
  }
  for (const [key, row] of after.done) {
    const old = before.done.get(key);
    if (old) {
      const changes = fieldChanges(old, row, CONCLUDED_FIELDS);
      if (changes) out.add("Navios concluídos corrigidos", `${row.vessel} (atracação ${when(row.berthStart)}): ${changes}`);
    } else if (before.active.has(key)) {
      out.add("Operações encerradas", `${row.vessel}: desatracou em ${when(row.berthEnd)} · ${tons(row.tons)} · ${perDay(row.productivity)}`);
    } else {
      out.add("Navios concluídos incluídos", `${row.vessel}: atracação ${when(row.berthStart)}, desatracação ${when(row.berthEnd)} · ${row.cargo} · ${tons(row.tons)}`);
    }
  }
  for (const [key, row] of [...before.done, ...before.active]) {
    if (!after.done.has(key) && !after.active.has(key)) out.add("Registros removidos ou com atracação alterada", `${row.vessel}: atracação ${when(row.berthStart)}`);
  }

  const gusaKey = row => `${upper(row.vessel)}|${(row.berthStart || row.operationStart || "").slice(0, 16)}`;
  const gusaBefore = { done: indexBy(previous.gusaRecords, gusaKey), active: indexBy(previous.gusaActiveRecords, gusaKey) };
  for (const [key, row] of indexBy(next.gusaRecords, gusaKey)) {
    const old = gusaBefore.done.get(key) || gusaBefore.active.get(key);
    if (!old) out.add("Ferro gusa", `${row.vessel}: incluído, saída ${when(row.departure)} · balança ${tons(row.scaleTons)}`);
    else if (!gusaBefore.done.has(key)) out.add("Ferro gusa", `${row.vessel}: saída registrada em ${when(row.departure)} · balança ${tons(row.scaleTons)}`);
    else {
      const changes = fieldChanges(old, row, GUSA_FIELDS);
      if (changes) out.add("Ferro gusa", `${row.vessel}: ${changes}`);
    }
  }
  for (const [key, row] of indexBy(next.gusaActiveRecords, gusaKey)) {
    const old = gusaBefore.active.get(key);
    if (!old && !gusaBefore.done.has(key)) out.add("Ferro gusa", `${row.vessel}: em operação desde ${when(row.operationStart || row.berthStart)}`);
    else if (old) {
      const changes = fieldChanges(old, row, GUSA_FIELDS);
      if (changes) out.add("Ferro gusa", `${row.vessel}: ${changes}`);
    }
  }

  const lineupKey = row => `${upper(row.vessel)}|${upper(row.geport)}`;
  const lineupBefore = indexBy(previous.lineupRecords, lineupKey);
  const lineupAfter = indexBy(next.lineupRecords, lineupKey);
  for (const [key, row] of lineupAfter) {
    const old = lineupBefore.get(key);
    if (!old) out.add("Lineup", `${row.vessel}: incluído, atracação prevista ${when(row.plannedBerthStart)} no berço ${row.berth}`);
    else {
      const changes = fieldChanges(old, row, LINEUP_FIELDS);
      if (changes) out.add("Lineup", `${row.vessel}: ${changes}`);
    }
  }
  for (const [key, row] of lineupBefore) {
    if (!lineupAfter.has(key)) out.add("Lineup", `${row.vessel}: saiu do lineup`);
  }
  return out.result();
}

/* ---------- Planilha de indicadores ---------- */

const monthText = (year, month) => `${MONTHS[month - 1]}/${year}`;

export function diffDischarge(previous, next) {
  const out = new Sections();
  const daysBefore = indexBy(previous.dischargeDays, row => row.date);
  const daysAfter = indexBy(next.dischargeDays, row => row.date);
  for (const [date, row] of daysAfter) {
    const old = daysBefore.get(date);
    if (!old) out.add("Descarga por dia", `${when(date)}: dia incluído com ${tons(row.tons)} · ${row.wagons} vagões`);
    else {
      const changes = fieldChanges(old, row, [["tons", "volume", tons], ["wagons", "vagões"]]);
      if (changes) out.add("Descarga por dia", `${when(date)}: ${changes}`);
    }
  }
  for (const [date] of daysBefore) if (!daysAfter.has(date)) out.add("Descarga por dia", `${when(date)}: dia removido`);

  const vesselDayKey = row => `${row.date}|${upper(row.vessel)}`;
  const vesselsBefore = indexBy(previous.dischargeVessels, vesselDayKey);
  for (const [key, row] of indexBy(next.dischargeVessels, vesselDayKey)) {
    const old = vesselsBefore.get(key);
    if (!old) out.add("Descarga por navio", `${row.vessel} em ${when(row.date)}: ${tons(row.tons)}`);
    else if (!sameValue(old.tons, row.tons)) out.add("Descarga por navio", `${row.vessel} em ${when(row.date)}: ${tons(old.tons)} → ${tons(row.tons)}`);
  }

  const before = previous.inProgress || {}, after = next.inProgress || {};
  if (!sameValue(before.records, after.records)) out.add("Em descarga agora", `Registros em descarga: ${plain(before.records)} → ${plain(after.records)}`);

  const plansBefore = indexBy(previous.plans, row => `${row.year}-${row.month}`);
  for (const [key, row] of indexBy(next.plans, row => `${row.year}-${row.month}`)) {
    const old = plansBefore.get(key);
    const changes = old ? fieldChanges(old, row, [["plan", "plano", tons], ["challenge", "desafio", tons], ["actual", "realizado", tons]]) : `plano ${tons(row.plan)} incluído`;
    if (changes) out.add("Plano mensal", `${monthText(row.year, row.month)}: ${changes}`);
  }

  const occurrenceKey = row => [row.date, row.code, upper(row.reason), upper(row.responsible)].join("|");
  const occurrencesBefore = indexBy(previous.occurrences, occurrenceKey);
  for (const [key, row] of indexBy(next.occurrences, occurrenceKey)) {
    const added = row.count - (occurrencesBefore.get(key)?.count || 0);
    if (added > 0) out.add("Ocorrências", `${when(row.date)}: ${row.reason} (${row.responsible}) · ${added} ${added === 1 ? "nova" : "novas"}`);
  }

  const weighingKey = row => `${upper(row.vessel)}|${row.year}-${row.month}`;
  const weighingsBefore = indexBy(previous.weighings, weighingKey);
  for (const [key, row] of indexBy(next.weighings, weighingKey)) {
    const old = weighingsBefore.get(key);
    if (!old) out.add("Pesagem", `${row.vessel} (${monthText(row.year, row.month)}): incluído · descarregado ${tons(row.unloadedTons)}`);
    else {
      const changes = fieldChanges(old, row, [["invoiceTons", "nota fiscal", tons], ["unloadedTons", "descarregado", tons], ["draftTons", "calado", tons], ["status", "situação"], ["client", "cliente"]]);
      if (changes) out.add("Pesagem", `${row.vessel} (${monthText(row.year, row.month)}): ${changes}`);
    }
  }
  return out.result();
}

/**
 * Leitura nova pronta para guardar: carrega o histórico da cópia anterior e, se algo
 * mudou, acrescenta um registro no topo. Sem cópia anterior não há com o que comparar.
 */
/* ---------- Planilha da equipe ---------- */

const PERSON_FIELDS = [["status", "status"], ["team", "equipe"], ["role", "função"], ["note", "observação"]];
const absenceKey = item => [item.person?.id || upper(item.person?.name), item.motive, item.start, item.end].join("|");
const coverName = item => item.cover?.name || (item.coverStatus === "sem cobertura" ? "sem cobertura" : "não informada");

export function diffTeam(previous, next) {
  const out = new Sections();
  const before = indexBy(previous.people, row => row.id);
  const after = indexBy(next.people, row => row.id);
  for (const [id, row] of after) {
    const old = before.get(id);
    if (!old) out.add("Incluídos no Cadastro", `${row.name} (${id}): ${row.role} · ${row.team} · ${row.status}`);
    else {
      const changes = fieldChanges(old, row, PERSON_FIELDS);
      if (changes) out.add("Mudanças no Cadastro", `${row.name} (${id}): ${changes}`);
    }
  }
  for (const [id, row] of before) if (!after.has(id)) out.add("Saíram do Cadastro", `${row.name} (${id}): ${row.role} · ${row.team}`);
  const absencesBefore = indexBy(previous.absences, absenceKey);
  const absencesAfter = indexBy(next.absences, absenceKey);
  for (const [key, row] of absencesAfter) {
    const old = absencesBefore.get(key);
    if (!old) out.add("Férias e ausências incluídas", `${row.person.name}: ${row.motive.toLowerCase()} de ${when(row.start)} a ${when(row.end)} · cobertura: ${coverName(row)}`);
    else if (coverName(old) !== coverName(row)) out.add("Coberturas alteradas", `${row.person.name} (${when(row.start)} a ${when(row.end)}): ${coverName(old)} → ${coverName(row)}`);
  }
  for (const [key, row] of absencesBefore) if (!absencesAfter.has(key)) out.add("Férias e ausências retiradas", `${row.person.name}: ${row.motive.toLowerCase()} de ${when(row.start)} a ${when(row.end)}`);
  const participants = list => new Map((list || []).flatMap(training => training.participants.map(item => [`${training.title}|${item.person.id || item.person.name}`, { training, item }])));
  const trainingsBefore = participants(previous.trainings), trainingsAfter = participants(next.trainings);
  for (const [key, { training, item }] of trainingsAfter) {
    const old = trainingsBefore.get(key)?.item;
    if (!old) out.add("Treinamentos", `${item.person.name}: incluído em “${training.title}” (${item.status})`);
    else {
      const changes = fieldChanges(old, item, [["status", "situação"], ["certificate", "certificado"]]);
      if (changes) out.add("Treinamentos", `${item.person.name} em “${training.title}”: ${changes}`);
    }
  }
  return out.result();
}

export function withChangeLog(kind, previous, next) {
  const log = Array.isArray(previous?.changeLog) ? previous.changeLog : [];
  if (!previous || previous.origin === "fallback") return { ...next, changeLog: log };
  const sections = kind === "operations" ? diffOperations(previous, next) : kind === "team" ? diffTeam(previous, next) : diffDischarge(previous, next);
  if (!sections.length) return { ...next, changeLog: log };
  const entry = { at: next.generatedAt, since: previous.generatedAt, total: sections.reduce((sum, s) => sum + s.count, 0), sections };
  return { ...next, changeLog: [entry, ...log].slice(0, MAX_ENTRIES) };
}
