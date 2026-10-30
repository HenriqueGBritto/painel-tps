/* Gera netlify/lib/initial-sof.json a partir da aba "Base SOF" da planilha de indicadores (só 2025 e 2026).
   É o histórico fixo do painel; os SOFs enviados depois ficam no Firestore.
   Uso: node scripts/import-base-sof.mjs [arquivo.xlsx]   (sem arquivo, baixa a planilha do Google) */
process.env.TZ = "America/Sao_Paulo";
import { readFile, writeFile } from "node:fs/promises";
import { XLSX } from "../netlify/lib/parsers.mjs";
import { downloadWorkbook, SHEETS } from "../netlify/lib/sheets.mjs";
import "../public/sof-core.js";

const Sof = globalThis.TpsSof;
const YEARS = new Set([2025, 2026]);
const file = process.argv[2];
const bytes = file ? await readFile(file) : await downloadWorkbook(SHEETS.discharge.defaultId);
const workbook = XLSX.read(bytes, { type: file ? "buffer" : "array", sheets: ["Base SOF"], cellDates: false, cellFormula: false, cellHTML: false, cellText: false });
if (!workbook.Sheets["Base SOF"]) throw new Error("Aba Base SOF não encontrada.");
const rows = XLSX.utils.sheet_to_json(workbook.Sheets["Base SOF"], { header: 1, raw: true, defval: null }).slice(2);
const col = name => XLSX.utils.decode_col(name);
const cell = (row, name) => row[col(name)];
const text = value => String(value ?? "").replace(/\s+/g, " ").trim();
const number = value => typeof value === "number" && Number.isFinite(value) ? value : null;
const blank = value => !text(value) || text(value) === "-";

/* Mesma carga escrita de jeitos diferentes na base → um nome só (o da planilha de navios, quando existe). */
const CARGO_ALIASES = { "AMARRA": "AMARRAS", "TARUGO DE AÇO": "TARUGO", "SAL A GRANEL": "SAL", "CARGA GERAL/ CONT.": "CARGA GERAL / CONTAINER", "CARGA GERAL / CONT.": "CARGA GERAL / CONTAINER", "DORMENTE": "DORMENTES" };
const cargoName = value => { const name = text(value).toUpperCase(); return CARGO_ALIASES[name] || name; };

/* Navios (colunas A–AK). */
const vessels = [];
for (const row of rows) {
  if (!text(cell(row, "B"))) continue;
  const operationStart = Sof.serialIso(cell(row, "F"));
  const year = Sof.vesselMonth({ operationStart })?.year;
  if (!YEARS.has(year)) continue;
  vessels.push({
    vessel: text(cell(row, "B")).toUpperCase(), cargo: cargoName(cell(row, "C")), operation: text(cell(row, "AK")).toUpperCase(),
    berthStart: Sof.serialIso(cell(row, "D")), berthEnd: Sof.serialIso(cell(row, "E")),
    operationStart, operationEnd: Sof.serialIso(cell(row, "G")),
    tons: number(cell(row, "M")) || 0, invoiceTons: number(cell(row, "J")) || null,
    check: ["Q", "R", "S", "T", "U", "V", "W"].map(c => number(cell(row, c)) || 0),
    startSerial: cell(row, "F"), events: []
  });
}

/* Ocorrências (colunas AN–BI), ligadas ao navio pelo nome e pelo início da operação. */
const visits = new Map();
for (const row of rows) {
  if (number(cell(row, "AN")) === null || blank(cell(row, "AV"))) continue;
  const id = `${Sof.vesselKey(cell(row, "BA"))}|${cell(row, "BH")}`;
  if (!visits.has(id)) visits.set(id, { name: text(cell(row, "BA")), start: number(cell(row, "BH")), rows: [] });
  visits.get(id).rows.push(row);
}
const unlinked = [];
for (const visit of visits.values()) {
  const key = Sof.vesselKey(visit.name);
  let target = vessels.find(v => Sof.vesselKey(v.vessel) === key && v.startSerial === visit.start);
  if (!target && visit.start) {
    // Nome parecido ("BBC MONT BLANC 2026" × "BBC MONT BLANC") e início a menos de 5 dias.
    const near = vessels.filter(v => { const k = Sof.vesselKey(v.vessel); return (k.startsWith(key) || key.startsWith(k)) && Math.abs(v.startSerial - visit.start) < 5; })
      .sort((a, b) => Math.abs(a.startSerial - visit.start) - Math.abs(b.startSerial - visit.start));
    target = near[0];
  }
  if (!target) { unlinked.push(`${visit.name} (${visit.rows.length})`); continue; }
  for (const row of visit.rows) {
    const date = Sof.serialDate(cell(row, "AN"));
    const from = Sof.timeMinutes(cell(row, "AQ")), to = Sof.timeMinutes(cell(row, "AR"));
    if (!date || from === null || to === null) continue;
    target.standardRate ||= number(cell(row, "BD")) || null;
    target.place ||= text(cell(row, "BB"));
    target.events.push({
      date, from, minutes: to >= from ? to - from : to + 1440 - from,
      gang: blank(cell(row, "AS")) ? "" : text(cell(row, "AS")), hold: blank(cell(row, "AT")) ? "" : text(cell(row, "AT")),
      description: text(cell(row, "AV")), volume: number(cell(row, "AX")), weight: number(cell(row, "AY")),
      responsible: Sof.canonicalResponsible(cell(row, "AW"))
    });
  }
}

/* Confere o tempo por responsável recalculado com as colunas Q–W da base. */
let checked = 0, close = 0;
const expanded = v => ({ ...v, events: v.events.map(e => ({ ...e, key: Sof.normalizeDescription(e.description) })) });
for (const v of vessels) {
  if (!v.events.length) continue;
  const summary = Sof.vesselSummary(expanded(v));
  const mine = Sof.RESPONSIBLES.map(name => summary.byResponsible[name]);
  checked++;
  if (mine.every((value, i) => Math.abs(value - v.check[i]) < 0.01)) close++;
}

const dictionary = Sof.learn(vessels.flatMap(v => expanded(v).events));
const output = {
  source: "Base SOF (planilha de indicadores)", generatedAt: new Date().toISOString(),
  vessels: vessels.map(({ check, startSerial, ...v }, index) => ({ id: `base-${String(index + 1).padStart(3, "0")}`, source: "base", ...v })),
  dictionary
};
await writeFile(new URL("../netlify/lib/initial-sof.json", import.meta.url), JSON.stringify(output));
const count = output.vessels.reduce((n, v) => n + v.events.length, 0);
console.log(`navios: ${output.vessels.length} (${[...YEARS].map(y => `${y}: ${output.vessels.filter(v => Sof.vesselMonth(v).year === y).length}`).join(", ")}) | ocorrências: ${count} | descrições: ${Object.keys(dictionary).length}`);
console.log(`sem ocorrências: ${output.vessels.filter(v => !v.events.length).map(v => v.vessel).join(", ") || "nenhum"}`);
console.log(`ocorrências sem navio (fora de 2025–2026 ou nome diferente): ${unlinked.join(", ") || "nenhuma"}`);
console.log(`tempo por responsável igual ao da base (±0,01 dia): ${close}/${checked}`);
