/* Corrige o peso (toneladas) do histórico da Base SOF em netlify/lib/initial-sof.json.
   Na aba "Base SOF", o bloco Peso NF / Peso atracado / Peso ao largo / Peso final (colunas J–M) ficou uma linha
   acima em vários navios de gusa: o peso do navio de gusa aparece no navio anterior (BBC DAKOTA com 28.216 t, SEA BRAVE
   com 53.544 t…) e o navio de gusa fica com outro valor. Aqui o peso passa a ser o da planilha de navios quando os dois
   discordam e um deles tem tamanho de navio de gusa (15 mil t ou mais). Nos navios menores, só quando a soma das
   ocorrências do SOF confirma a planilha de navios. Os pesos conferidos pela operação (scripts/sof-pesos-conferidos.json,
   por id do navio) valem acima das regras. O valor antigo fica em tonsBase.
   Uso: node scripts/fix-base-sof-tons.mjs   (baixa a planilha de navios; rodar de novo depois de import-base-sof.mjs) */
process.env.TZ = "America/Sao_Paulo";
import { readFile, writeFile } from "node:fs/promises";
import { loadSheet } from "../netlify/lib/sheets.mjs";
import { matchOperation } from "../netlify/lib/sof.mjs";

const GUSA_SIZE = 15000;
const agree = (a, b) => a > 0 && b > 0 && Math.abs(a - b) / Math.max(a, b) < 0.03;
const round = value => Math.round(value * 1000) / 1000;

/** Peso certo do navio: { tons, why } quando precisa trocar, null quando o da base está certo. */
export function fixedTons(base, sheet, events) {
  if (agree(base, sheet)) return null;
  // Navio pequeno: vale a planilha de navios quando a soma das ocorrências do SOF (em t ou em kg) confirma ela e não a base.
  const confirms = value => agree(events, value) || agree(events / 1000, value);
  if (sheet > 0 && Math.max(base || 0, sheet) < GUSA_SIZE && confirms(sheet) && !confirms(base)) return { tons: sheet, why: "planilha de navios (confirmada pelas ocorrências do SOF)" };
  if (Math.max(base || 0, sheet || 0) < GUSA_SIZE && sheet !== null) return null;
  // Planilha de navios com o peso em milhares (53 em vez de 53.111): o da base está certo.
  if (sheet > 0 && agree(sheet * 1000, base)) return null;
  if (sheet > 0) return { tons: sheet, why: "planilha de navios" };
  if (base >= GUSA_SIZE && events > 0 && events < base / 2) return { tons: events, why: "soma das ocorrências do SOF" };
  return null;
}

const file = new URL("../netlify/lib/initial-sof.json", import.meta.url);
const data = JSON.parse(await readFile(file, "utf8"));
// Sem a conta de serviço (aqui no computador) a planilha vem pela exportação .xlsx, que pode passar dos 8 s do painel.
const { records } = await loadSheet("operations", { timeout: 60000 });
const names = JSON.parse(await readFile(new URL("../netlify/lib/sof-standards.json", import.meta.url), "utf8")).vessels;
const confirmed = JSON.parse(await readFile(new URL("./sof-pesos-conferidos.json", import.meta.url), "utf8"));
const changed = [];
for (const vessel of data.vessels) {
  const base = vessel.tonsBase ?? vessel.tons;
  const name = names[vessel.vessel];
  const match = matchOperation(name ? { ...vessel, vessel: name, originalName: vessel.vessel } : vessel, records);
  const events = round(vessel.events.reduce((sum, e) => sum + (e.weight || 0), 0));
  // Peso conferido pela operação (sof-pesos-conferidos.json) vale acima das regras.
  const checked = confirmed[vessel.id];
  const fix = checked ? (agree(checked.tons, base) && Math.abs(checked.tons - base) < 0.001 ? null : { tons: checked.tons, why: "conferência da operação" })
    : fixedTons(base, match ? match.tons : null, events);
  delete vessel.tonsBase; delete vessel.tonsSource;
  vessel.tons = base;
  if (!fix) continue;
  Object.assign(vessel, { tons: round(fix.tons), tonsBase: base, tonsSource: fix.why, invoiceTons: null });
  changed.push(`${vessel.id} ${vessel.vessel}: ${base} → ${vessel.tons} (${fix.why})`);
}
await writeFile(file, JSON.stringify(data));
console.log(changed.join("\n"));
console.log(`navios corrigidos: ${changed.length} de ${data.vessels.length}`);
