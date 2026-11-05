/* Base SOF do painel: histórico fixo (initial-sof.json, gerado por scripts/import-base-sof.mjs a partir da
   aba "Base SOF", 2025 e 2026) + SOFs enviados pela equipe (Firestore, coleção sofVessels).
   O dicionário de responsáveis começa com o histórico e aprende com cada SOF salvo (documento sofConfig/dictionary).
   A desatracação, o berço e o cliente vêm da planilha de navios sempre que o navio for encontrado nela.
   Padrões (sof-standards.json): cada descrição conhecida aponta para um motivo padrão, e o motivo define o responsável;
   nomes de navios, berços, clientes e cargas passam por um de-para. O texto original de cada ocorrência é mantido. */
// Os JSON entram no pacote da função: ler o arquivo pelo caminho falhava no Netlify, onde import.meta.url aponta para a função.
import initialSof from "./initial-sof.json" with { type: "json" };
import standards from "./sof-standards.json" with { type: "json" };
import "../../public/sof-core.js";

export const Sof = globalThis.TpsSof;
export const VESSELS = "sofVessels";
export const CONFIG = "sofConfig";
const MAX_EVENTS = 4000;
const MAX_TEXT = 400;

const removedIds = new Set(standards.removed);

/**
 * Padrões em uso: os do arquivo + o que foi salvo no painel (sofConfig/standards):
 * motivos criados, descrições ligadas na importação de SOF ou na tela Padronizar, e descrições conferidas.
 */
export function buildStandards(saved = {}) {
  const reasons = [...standards.reasons, ...(saved.reasons || [])];
  return {
    reasons, byCode: new Map(reasons.map(r => [r.code, r])),
    descriptions: { ...standards.descriptions, ...(saved.descriptions || {}) },
    confirmed: new Set([...standards.reviewed, ...Object.keys(saved.confirmed || {})]),
    learned: new Set(Object.keys(saved.descriptions || {}))
  };
}
const BASE = buildStandards();
export const REASONS = BASE.reasons;

export async function standardsOf(store) {
  const saved = store ? await store.get(CONFIG, "standards") : null;
  return saved ? buildStandards(saved) : BASE;
}

/** Motivo padrão de uma descrição (pela chave), ou null quando ainda não está no de-para. */
export function reasonOf(key, std = BASE) {
  return std.byCode.get(std.descriptions[key]) || null;
}

/**
 * O motivo da descrição vale primeiro; o escolhido na ocorrência conta quando a descrição não tem motivo
 * ou quando foi fixado à mão na edição do navio (reasonFixed).
 */
function withReason(event, std) {
  const reason = (event.reasonFixed && std.byCode.get(event.reason)) || reasonOf(event.key, std) || std.byCode.get(event.reason);
  return reason ? { ...event, reason: reason.code, reasonText: reason.text, responsible: reason.responsible } : event;
}

/** Valor padronizado por um de-para (comparação em maiúsculas); sem entrada, fica o próprio valor. */
const mapped = (map, value) => { const v = String(value ?? "").trim(); return v.toUpperCase() in map ? map[v.toUpperCase()] : v; };

let seedCache = null;
/** Histórico da Base SOF, com a chave de cada descrição já calculada e os nomes de navio padronizados. */
export function seed() {
  if (seedCache) return seedCache;
  const raw = initialSof;
  return seedCache = { ...raw, vessels: raw.vessels.filter(v => !removedIds.has(v.id)).map(vessel => ({ ...renamed(vessel), events: vessel.events.map(e => expandEvent(e)) })) };
}
export function useSeed(value) { seedCache = value; }

/** Nome padronizado; o nome antigo fica em originalName para achar o navio na planilha de navios. */
function renamed(vessel) {
  const name = standards.vessels[vessel.vessel];
  return name ? { ...vessel, vessel: name, originalName: vessel.vessel } : vessel;
}

/** Ocorrência guardada (data + minuto de início + duração) → com início, fim, período, chave e motivo padrão. */
export function expandEvent(event, std = BASE) {
  const start = event.start || Sof.localIso(event.date, event.from || 0);
  const from = event.from ?? Math.round(((Date.parse(start) / 60000 - 180) % 1440 + 1440) % 1440);
  return withReason({
    ...event, from, start, end: new Date(Date.parse(start) + (event.minutes || 0) * 60000).toISOString(),
    period: event.period || Sof.periodOf(from), key: Sof.normalizeDescription(event.description)
  }, std);
}

/* ---------- Validação do que chega do navegador ---------- */

const str = (value, max = 120) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const iso = value => { const t = Date.parse(value || ""); return Number.isFinite(t) && t > Date.UTC(2020, 0) && t < Date.UTC(2040, 0) ? new Date(t).toISOString() : null; };
const num = value => typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * Confere e limpa um SOF pronto para salvar. Devolve { vessel } ou { error }.
 * Cada ocorrência traz o motivo padrão (o responsável sai dele) ou, sem motivo, o responsável escolhido.
 */
export function validateVessel(input, std = BASE) {
  if (!input || typeof input !== "object") return { error: "Dados do SOF ausentes." };
  const vessel = str(input.vessel, 80).toUpperCase();
  if (!vessel) return { error: "Informe o nome do navio." };
  const operationStart = iso(input.operationStart), operationEnd = iso(input.operationEnd);
  if (!operationStart || !operationEnd || Date.parse(operationEnd) <= Date.parse(operationStart)) return { error: "Confira o início e o término da operação." };
  const operation = str(input.operation, 20).toUpperCase();
  if (!Sof.OPERATIONS.includes(operation)) return { error: "Escolha o tipo de operação." };
  const cargo = str(input.cargo, 60).toUpperCase();
  if (!cargo) return { error: "Informe a carga." };
  const tons = num(input.tons);
  if (tons === null || tons < 0 || tons > 300000) return { error: "Confira o volume (toneladas)." };
  if (!Array.isArray(input.events) || !input.events.length || input.events.length > MAX_EVENTS) return { error: "O SOF precisa ter ocorrências." };
  const events = [];
  for (const [index, e] of input.events.entries()) {
    const start = iso(e?.start);
    const minutes = num(e?.minutes);
    const description = str(e?.description, MAX_TEXT);
    const reason = e?.reason ? std.byCode.get(str(e.reason, 8)) : null;
    if (e?.reason && !reason) return { error: `Motivo desconhecido na ocorrência ${index + 1}.` };
    const responsible = reason?.responsible || Sof.canonicalResponsible(e?.responsible);
    if (!start || minutes === null || minutes < 0 || minutes > 2880 || !description) return { error: `Ocorrência ${index + 1} inválida.` };
    if (!responsible) return { error: `Escolha o motivo da ocorrência ${index + 1} ("${description.slice(0, 50)}").` };
    events.push({ date: str(e.date, 10), start, minutes, gang: str(e.gang, 12), hold: str(e.hold, 12), description, volume: num(e.volume), weight: num(e.weight), responsible, ...(reason ? { reason: reason.code } : {}), ...(e.id ? { id: str(e.id, 24) } : {}) });
  }
  return {
    vessel: {
      vessel, cargo, operation, operationStart, operationEnd, tons,
      berthStart: iso(input.berthStart), berthEnd: iso(input.berthEnd), arrival: iso(input.arrival),
      berth: str(input.berth, 60), client: str(input.client, 80), invoiceTons: num(input.invoiceTons),
      cargoDescription: str(input.cargoDescription, 200), fileName: str(input.fileName, 160), model: str(input.model, 20), events
    }
  };
}

/** Id estável: data de início + nome. Reenviar o SOF do mesmo navio substitui o anterior. */
export function vesselId(vessel) {
  return `${vessel.operationStart.slice(0, 10)}_${Sof.vesselKey(vessel.vessel).slice(0, 40)}`;
}

/* ---------- Leitura ---------- */

/** Histórico + enviados. Um enviado com o mesmo navio e início (±2 dias) de um do histórico o substitui. */
export async function allVessels(store, std) {
  std ||= await standardsOf(store);
  const sent = store ? await store.list(VESSELS) : [];
  const removed = new Set(sent.filter(v => v.deleted && v.replaces).map(v => v.replaces));
  const uploaded = sent.filter(v => !v.deleted && !removedIds.has(v.id)).map(v => ({ ...renamed(v), source: "sof", events: (v.events || []).map(e => expandEvent(e, std)) }));
  const sameName = (a, b) => [a.vessel, a.originalName].some(x => x && [b.vessel, b.originalName].some(y => y && Sof.vesselKey(x) === Sof.vesselKey(y)));
  const replaced = vessel => uploaded.some(u => sameName(u, vessel) && Math.abs(Date.parse(u.operationStart) - Date.parse(vessel.operationStart)) < 2 * 86400000);
  const edited = new Set(uploaded.map(u => u.replaces).filter(Boolean));
  let history = seed().vessels.filter(v => !removed.has(v.id) && !edited.has(v.id) && !replaced(v));
  // O histórico já vem com os padrões do arquivo; o que foi mudado no painel é aplicado por cima.
  if (std !== BASE) history = history.map(v => ({ ...v, events: v.events.map(e => withReason(e, std)) }));
  return [...history, ...uploaded].sort((a, b) => a.operationStart.localeCompare(b.operationStart));
}

/** Navio da planilha de navios com o mesmo nome e atracação/início mais próximos (até 5 dias). */
export function matchOperation(vessel, records) {
  const key = Sof.vesselKey(vessel.vessel);
  if (!key) return null;
  // A planilha de navios pode ainda usar o nome antigo (com operação, mês ou erro de digitação).
  if (vessel.originalName) return matchOperation({ ...vessel, originalName: "" }, records) || matchOperation({ ...vessel, vessel: vessel.originalName, originalName: "" }, records);
  const when = Date.parse(vessel.berthStart || vessel.operationStart);
  const near = records.filter(r => {
    const k = Sof.vesselKey(r.vessel);
    return k && (k === key || (Math.min(k.length, key.length) >= 5 && (k.startsWith(key) || key.startsWith(k))));
  }).map(r => ({ r, gap: Math.abs(Date.parse(r.berthStart || r.operationStart || "") - when) }))
    .filter(x => Number.isFinite(x.gap) && x.gap < 5 * 86400000).sort((a, b) => a.gap - b.gap);
  return near[0]?.r || null;
}

/** Completa com a planilha de navios (desatracação sempre preferida, berço, cliente e atracação) e padroniza berço, cliente e carga. */
export function enrich(vessel, records) {
  const match = matchOperation(vessel, records);
  // Campo editado à mão no painel (locked) não é trocado pelo da planilha.
  const locked = new Set(vessel.locked || []);
  const pick = (field, fromSheet) => locked.has(field) ? vessel[field] ?? null : fromSheet;
  const full = !match ? { ...vessel, matched: false } : {
    ...vessel, matched: true,
    berthEnd: pick("berthEnd", match.berthEnd || vessel.berthEnd || null),
    berthStart: pick("berthStart", vessel.berthStart || match.berthStart || null),
    berth: pick("berth", match.berth && match.berth !== "Não informado" ? match.berth : vessel.berth || ""),
    client: pick("client", match.client && match.client !== "Não informado" ? match.client : vessel.client || "")
  };
  return { ...full, berth: mapped(standards.berths, full.berth), client: mapped(standards.clients, full.client), cargo: mapped(standards.cargos, full.cargo) };
}

/** Resumo para os indicadores (sem a lista de ocorrências, que vem só no detalhe). */
export function summaryOf(vessel) {
  const { events, changes, ...rest } = vessel;
  const summary = Sof.vesselSummary(vessel);
  return { ...rest, events: events.length, summary: { ...summary, stoppages: summary.stoppages.slice(0, 25) } };
}

/** Navio completo para a exportação: resumo calculado + ocorrências sem os campos internos. */
export function exportOf(vessel) {
  const { operationDays, berthDays, waitDays, byResponsible, grossRate, netRate, triunfoRate } = Sof.vesselSummary(vessel);
  const events = vessel.events.map(({ date, start, end, minutes, period, gang, hold, description, reason = "", reasonText = "", volume, weight, responsible }) =>
    ({ date, start, end, minutes, period, gang, hold, description, reason, reasonText, volume, weight, responsible }));
  const { changes, ...rest } = vessel;
  return { ...rest, savedBy: vessel.savedBy?.name || "", events, summary: { operationDays, berthDays, waitDays, byResponsible, grossRate, netRate, triunfoRate } };
}

/* ---------- Dicionário ---------- */

/** Histórico + o que foi aprendido/fixado no painel. Descrição com motivo padrão fica fixa no responsável do motivo. */
export async function dictionary(store, std) {
  std ||= await standardsOf(store);
  const saved = store ? await store.get(CONFIG, "dictionary") : null;
  const merged = JSON.parse(JSON.stringify(seed().dictionary));
  for (const [key, entry] of Object.entries(saved?.entries || {})) {
    const target = merged[key] ||= { counts: {}, text: entry.text || key };
    for (const [name, count] of Object.entries(entry.counts || {})) target.counts[name] = (target.counts[name] || 0) + count;
    if (entry.fixed) { target.fixed = entry.fixed; target.fixedBy = entry.fixedBy; target.fixedAt = entry.fixedAt; }
  }
  for (const [key, entry] of Object.entries(merged)) {
    const reason = reasonOf(key, std);
    if (reason) Object.assign(entry, { fixed: reason.responsible, reason: reason.code, reasonText: reason.text, fixedBy: "", fixedAt: "" });
  }
  return merged;
}

/** Soma as escolhas de um SOF salvo ao dicionário (só o que foi aprendido no painel fica no Firestore). */
export async function learnFrom(store, events) {
  const saved = (await store.get(CONFIG, "dictionary")) || { entries: {} };
  const entries = saved.entries || {};
  for (const event of events) {
    const key = Sof.normalizeDescription(event.description);
    if (!key) continue;
    const entry = entries[key] ||= { counts: {}, text: event.description };
    entry.counts[event.responsible] = (entry.counts[event.responsible] || 0) + 1;
  }
  await store.set(CONFIG, "dictionary", { entries, updatedAt: new Date().toISOString() });
}

/** Fixa (ou solta, com responsible vazio) o responsável de uma descrição. */
export async function fixResponsible(store, key, responsible, actor) {
  const name = responsible ? Sof.canonicalResponsible(responsible) : "";
  if (responsible && !name) return { error: "Responsável inválido." };
  const clean = Sof.normalizeDescription(key) === key ? key : null;
  if (!clean) return { error: "Descrição inválida." };
  const reason = reasonOf(clean, await standardsOf(store));
  if (reason) return { error: `Essa descrição segue o motivo padrão "${reason.text}", que é sempre ${Sof.RESPONSIBLE_LABELS[reason.responsible]}.` };
  const saved = (await store.get(CONFIG, "dictionary")) || { entries: {} };
  const entries = saved.entries || {};
  const entry = entries[clean] ||= { counts: {}, text: seed().dictionary[clean]?.text || clean };
  if (name) Object.assign(entry, { fixed: name, fixedBy: actor?.name || "", fixedAt: new Date().toISOString() });
  else { delete entry.fixed; delete entry.fixedBy; delete entry.fixedAt; }
  await store.set(CONFIG, "dictionary", { entries, updatedAt: new Date().toISOString() });
  return { ok: true };
}

/* ---------- Motivos padrão (só quem tem o acesso de administrador muda) ---------- */

const PREFIX = { Terminal: "T", Vessel: "N", Client: "C", Rain: "R", Port: "P", Others: "O", Cargo: "L" };
const savedStandards = async store => (await store.get(CONFIG, "standards")) || {};
const saveStandards = (store, saved) => store.set(CONFIG, "standards", { ...saved, updatedAt: new Date().toISOString() });

/** Descrição nova escolhida na importação de um SOF passa a valer para os próximos (não muda o que já estava ligado). */
export async function learnStandards(store, events) {
  const std = await standardsOf(store);
  const fresh = {};
  for (const event of events) {
    const key = Sof.normalizeDescription(event.description);
    if (key && event.reason && !std.descriptions[key] && std.byCode.has(event.reason)) fresh[key] = event.reason;
  }
  if (!Object.keys(fresh).length) return;
  const saved = await savedStandards(store);
  await saveStandards(store, { ...saved, descriptions: { ...(saved.descriptions || {}), ...fresh } });
}

/** Cria um motivo padrão. Paralisação sempre começa com "Not worked due to". */
export async function createReason(store, input, actor) {
  const responsible = Sof.canonicalResponsible(input?.responsible);
  if (!responsible) return { error: "Escolha o responsável do motivo." };
  let text = str(input?.text, 160).replace(/\.+$/, "");
  if (responsible !== "Cargo") text = text.replace(/^not worked due to\s*/i, "");
  if (text.length < 3) return { error: "Escreva o motivo." };
  text = `${responsible === "Cargo" ? text.charAt(0).toUpperCase() + text.slice(1) : `Not worked due to ${text}`}.`;
  const std = await standardsOf(store);
  const same = std.reasons.find(r => Sof.normalizeDescription(r.text) === Sof.normalizeDescription(text));
  if (same) return { error: `Esse motivo já existe: "${same.text}" (${Sof.RESPONSIBLE_LABELS[same.responsible]}).` };
  const prefix = PREFIX[responsible];
  const next = 1 + Math.max(0, ...std.reasons.filter(r => r.code.startsWith(prefix)).map(r => Number(r.code.slice(1)) || 0));
  const reason = { code: `${prefix}${String(next).padStart(2, "0")}`, responsible, text, createdBy: actor?.name || "", createdAt: new Date().toISOString() };
  const saved = await savedStandards(store);
  await saveStandards(store, { ...saved, reasons: [...(saved.reasons || []), reason] });
  return { reason };
}

/** Liga descrições a um motivo (ou só confirma o motivo atual, sem reason) e marca como conferidas. */
export async function setDescriptions(store, keys, code, actor) {
  const std = await standardsOf(store);
  const list = [...new Set((Array.isArray(keys) ? keys : []).map(k => String(k)))].slice(0, 2000);
  if (!list.length || list.some(k => !k || Sof.normalizeDescription(k) !== k)) return { error: "Descrição inválida." };
  if (code && !std.byCode.has(code)) return { error: "Motivo desconhecido." };
  if (!code && list.some(k => !std.descriptions[k])) return { error: "Escolha um motivo para as descrições sem motivo." };
  const saved = await savedStandards(store);
  const stamp = { by: actor?.name || "", at: new Date().toISOString() };
  const descriptions = { ...(saved.descriptions || {}) }, confirmed = { ...(saved.confirmed || {}) };
  for (const key of list) {
    if (code) descriptions[key] = code;
    confirmed[key] = stamp;
  }
  await saveStandards(store, { ...saved, descriptions, confirmed });
  return { ok: true, count: list.length };
}

/**
 * Todas as descrições da base com o motivo atual, para a tela Padronizar.
 * status: "conferida" (revisada por você), "importacao" (escolhida ao enviar um SOF), "automatica" (ligada por regra) ou "sem-motivo".
 */
export function descriptionList(vessels, std) {
  const map = new Map();
  for (const v of vessels) for (const e of v.events) {
    const id = e.key || e.description;
    const item = map.get(id) || { key: e.key, texts: new Map(), count: 0, minutes: 0, vessels: new Set() };
    item.count++; item.minutes += e.minutes || 0; item.vessels.add(v.id);
    item.texts.set(e.description, (item.texts.get(e.description) || 0) + 1);
    map.set(id, item);
  }
  return [...map.values()].map(item => {
    const reason = reasonOf(item.key, std);
    const status = !reason ? "sem-motivo" : std.confirmed.has(item.key) ? "conferida" : std.learned.has(item.key) ? "importacao" : "automatica";
    const texts = [...item.texts].sort((a, b) => b[1] - a[1]);
    return { key: item.key, text: texts[0][0], variants: texts.length, count: item.count, minutes: item.minutes, vessels: item.vessels.size, reason: reason?.code || "", status };
  }).sort((a, b) => b.minutes - a.minutes);
}

/* ---------- Edição de um navio (administrador) ---------- */

const EDIT_FIELDS = [["vessel", "Navio"], ["cargo", "Carga"], ["operation", "Operação"], ["client", "Cliente"], ["berth", "Berço"], ["tons", "Volume (t)"],
  ["berthStart", "Atracação"], ["operationStart", "Início da operação"], ["operationEnd", "Término da operação"], ["berthEnd", "Desatracação"]];
/** Campos que vêm da planilha de navios: editados à mão, passam a valer o que foi digitado. */
const SHEET_FIELDS = ["berth", "client", "berthStart", "berthEnd"];
const isDate = field => /Start|End/.test(field);
const sameValue = (field, a, b) => isDate(field) ? (!a && !b) || Date.parse(a || "") === Date.parse(b || "") : String(a ?? "") === String(b ?? "");
const when = value => { const t = Date.parse(value || ""); if (!Number.isFinite(t)) return "—"; const d = new Date(t - 3 * 3600000).toISOString(); return `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)} ${d.slice(11, 16)}`; };
const shown = (field, value) => value === null || value === undefined || value === "" ? "—" : isDate(field) ? when(value) : field === "tons" ? Number(value).toLocaleString("pt-BR") : String(value);
const eventLabel = e => `${when(e.start)} · ${String(e.description).slice(0, 60)}`;

/** Ocorrências com id estável (as que ainda não têm ganham pela ordem), para comparar antes e depois da edição. */
export const withIds = events => events.map((e, i) => e.id ? e : { ...e, id: `e${i + 1}` });

/** O que mudou entre o navio mostrado no painel e o editado, em frases curtas para o histórico de alterações. */
export function diffVessel(before, after, std = BASE) {
  const items = [];
  for (const [field, name] of EDIT_FIELDS) if (!sameValue(field, before[field], after[field])) items.push(`${name}: ${shown(field, before[field])} → ${shown(field, after[field])}`);
  const old = new Map(before.events.map(e => [e.id, e]));
  const reasonName = code => std.byCode.get(code)?.text.replace(/^Not worked due to /, "").replace(/\.$/, "") || "sem motivo";
  for (const e of after.events) {
    const prev = old.get(e.id);
    old.delete(e.id);
    if (!prev) { items.push(`Ocorrência incluída: ${eventLabel(e)} (${e.minutes} min)`); continue; }
    const parts = [];
    if (!sameValue("start", prev.start, e.start)) parts.push(`início ${when(prev.start)} → ${when(e.start)}`);
    if (prev.minutes !== e.minutes) parts.push(`duração ${prev.minutes} → ${e.minutes} min`);
    if (prev.description !== e.description) parts.push(`descrição "${prev.description}" → "${e.description}"`);
    if ((prev.reason || "") !== (e.reason || "")) parts.push(`motivo ${reasonName(prev.reason)} → ${reasonName(e.reason)}`);
    for (const [field, name] of [["gang", "terno"], ["hold", "porão"], ["weight", "peso"], ["volume", "volume"]])
      if (String(prev[field] ?? "") !== String(e[field] ?? "")) parts.push(`${name} ${prev[field] ?? "—"} → ${e[field] ?? "—"}`);
    if (parts.length) items.push(`Ocorrência ${eventLabel(prev)}: ${parts.join("; ")}`);
  }
  for (const e of old.values()) items.push(`Ocorrência removida: ${eventLabel(e)} (${e.minutes} min)`);
  return items;
}

/**
 * Salva a edição de um navio. O do histórico vira uma cópia no Firestore (id edit_<id>, replaces = id do histórico);
 * apagar a cópia devolve o original. Cada edição entra no histórico de alterações do navio (quem, quando, o quê).
 */
export async function saveEdit(store, id, input, records, actor) {
  const std = await standardsOf(store);
  const current = (await allVessels(store, std)).find(v => v.id === id);
  if (!current) return { error: "Navio não encontrado.", status: 404 };
  // Campo que não veio na edição fica como aparece no painel (já completado pela planilha de navios).
  const before = { ...enrich(current, records), events: withIds(current.events) };
  const { vessel, error } = validateVessel({ ...before, ...input, events: input?.events }, std);
  if (error) return { error, status: 400 };
  const stamp = Date.now().toString(36);
  const fresh = vessel.events.map((e, i) => ({ ...e, id: e.id || `n${i + 1}-${stamp}` })).sort((a, b) => a.start.localeCompare(b.start));
  // Descrição nova escolhida aqui passa a valer como na importação; motivo diferente do da descrição fica só nesta ocorrência.
  await learnStandards(store, fresh);
  const learned = await standardsOf(store);
  const events = fresh.map(e => {
    const byDescription = reasonOf(Sof.normalizeDescription(e.description), learned);
    return e.reason && byDescription && byDescription.code !== e.reason ? { ...e, reasonFixed: true } : e;
  });
  const after = { ...vessel, events };
  const items = diffVessel(before, { ...after, events: events.map(e => expandEvent(e, learned)) }, learned);
  if (!items.length) return { ok: true, id, changes: [] };
  const locked = [...new Set([...(current.locked || []), ...SHEET_FIELDS.filter(f => !sameValue(f, before[f], after[f]))])];
  const docId = current.source === "sof" ? current.id : `edit_${current.id}`;
  const stored = current.source === "sof" ? (await store.get(VESSELS, docId)) || {} : {};
  const now = new Date().toISOString();
  await store.set(VESSELS, docId, {
    ...stored, ...after, id: docId,
    origin: current.origin || current.source, ...(current.source === "base" ? { replaces: current.id } : {}),
    ...(current.originalName ? { originalName: current.originalName } : {}),
    savedAt: stored.savedAt || now, savedBy: stored.savedBy || actor || null,
    locked, editedAt: now, editedBy: actor || null,
    changes: [...(stored.changes || []), { at: now, by: actor?.name || "", items }].slice(-200)
  });
  return { ok: true, id: docId, changes: items };
}
