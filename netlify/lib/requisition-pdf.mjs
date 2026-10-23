/* Leitura do PDF de requisição de estiva impresso pelo sistema do OGMO-RJ ("Visualiza" → imprimir).
   Cada página é um terno (Equipe 1, 2, …) com o mesmo cabeçalho. O PDF tem texto selecionável: a leitura usa
   a posição de cada trecho na página para ligar cada função ao número de vagas da mesma linha.
   extractPages() depende da biblioteca unpdf; parseRequisition() trabalha só com os trechos (testável com
   o texto guardado em tests/fixtures/requisicoes). */

/** Trechos de texto de cada página: [{ x, y, str }] (y cresce para cima, como no PDF). */
export async function extractPages(bytes) {
  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const pages = [];
  for (let number = 1; number <= pdf.numPages; number++) {
    const page = await pdf.getPage(number);
    const { items } = await page.getTextContent();
    pages.push(items.filter(item => item.str && item.str.trim()).map(item => ({ x: Math.round(item.transform[4]), y: Math.round(item.transform[5]), str: item.str.trim() })));
  }
  return pages;
}

export class RequisitionParseError extends Error {}

const SECTIONS = ["ESTIVA", "CONFERENTE", "CONSERTADOR", "VIGIA", "BLOCO", "CAPATAZIA"];
const FUNCTION = /^([A-Z]{2,4})\s*-\s*(.+)$/;
const FAINA = /^(\d+(?:\.\d+)+)\s*-\s*(.*)$/;
const brDate = text => { const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(text || ""); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
const after = (items, label) => {
  const item = items.find(entry => entry.str.startsWith(label));
  return item ? item.str.slice(label.length).trim() : null;
};
const sameRow = (a, b) => Math.abs(a.y - b.y) <= 2;

/** Um terno (uma página). */
function parsePage(items, page) {
  const header = name => items.find(item => item.str === name);
  const faina = header("Faina");
  const estiva = header("ESTIVA");
  if (!faina || !estiva || !items.some(item => item.str.startsWith("Requisição:"))) throw new RequisitionParseError(`A página ${page} não parece uma requisição de estiva do OGMO.`);
  const equipe = Number(after(items, "Equipe:")) || page;

  // Observação geral da requisição: entre a linha "Equipe" e o título "Faina".
  const equipeY = items.find(item => item.str.startsWith("Equipe:"))?.y ?? Infinity;
  const generalNote = items.filter(item => item.y < equipeY - 2 && item.y > faina.y + 2 && item.x < 300).sort((a, b) => b.y - a.y).map(item => item.str).join(" ");

  // Fainas e observação do terno: entre o título "Faina" e os títulos das funções.
  const between = items.filter(item => item.y < faina.y - 2 && item.y > estiva.y + 2 && item.x < 300).sort((a, b) => b.y - a.y || a.x - b.x);
  const fainas = [], observation = [];
  for (const item of between) {
    const match = FAINA.exec(item.str);
    if (match) { if (!/^0+(\.0+)*$/.test(match[1])) fainas.push({ code: match[1], text: match[2].replace(/^\*+\s*/, "").trim() }); }
    else if (!/^\d+$/.test(item.str) && item.str !== "Bordo") observation.push(item.str);
  }

  // Funções: rótulo "COD-NOME" e o número da mesma linha à direita (antes do próximo rótulo).
  const headers = SECTIONS.map(name => header(name)).filter(Boolean);
  const labels = items.filter(item => item.y < estiva.y - 2 && FUNCTION.test(item.str));
  const numbers = items.filter(item => item.y < estiva.y - 2 && /^\d+$/.test(item.str));
  const sectionOf = label => {
    const rows = headers.filter(h => h.y > label.y).sort((a, b) => a.y - b.y);
    const row = rows.length ? rows.filter(h => sameRow(h, rows[0])) : headers;
    // O título fica centralizado sobre a coluna: vale o título cuja coluna começa antes do rótulo.
    const candidates = row.filter(h => h.x - 70 <= label.x).sort((a, b) => b.x - a.x);
    return (candidates[0] || row[0])?.str || null;
  };
  const functions = labels.map(label => {
    const [, code, name] = FUNCTION.exec(label.str);
    const nextLabelX = Math.min(...labels.filter(other => other !== label && sameRow(other, label) && other.x > label.x).map(other => other.x), Infinity);
    const count = numbers.filter(n => sameRow(n, label) && n.x > label.x && n.x < nextLabelX).sort((a, b) => a.x - b.x)[0];
    // Nome que quebra em duas linhas (ex.: "BLC-BLOQUISTA DE" / "CARPINTARIA").
    const continuation = items.find(item => item.x === label.x && item.y < label.y && label.y - item.y <= 12 && !FUNCTION.test(item.str) && !/^\d+$/.test(item.str));
    return { code, name: continuation ? `${name.trim()} ${continuation.str}` : name.trim(), vagas: count ? Number(count.str) : null, section: sectionOf(label) };
  });

  return { equipe, generalNote, fainas, observation: observation.join(" ").replace(/\s+/g, " ").trim(), functions };
}

/** Navio "BALSA RIO PORT II (AT. SKOMER ISLAND)", "NAVIO XX (AL)", "NAVIO (REF.01/02/2026)", "NAVIO (ENLONAMENTO)". */
export function parseVesselName(raw) {
  const text = String(raw || "").replace(/\s+/g, " ").trim().toUpperCase();
  const extras = [...text.matchAll(/\(([^)]*)\)/g)].map(m => m[1].trim());
  const base = text.replace(/\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
  const attached = extras.map(e => /^AT\.?\s*(.+)$/.exec(e)?.[1]?.trim()).find(Boolean) || null;
  const retro = extras.map(e => /^REF\.?\s*(\d{2}\/\d{2}\/\d{4})$/.exec(e)?.[1]).find(Boolean) || null;
  return {
    raw: text, kind: /^BALSA\b/.test(base) ? "balsa" : "navio", name: base.replace(/^BALSA\s+/, ""),
    attachedTo: attached, offshore: extras.includes("AL"), retroactive: retro ? brDate(retro) : null,
    tarp: extras.some(e => /ENLONAMENTO/.test(e)), extras
  };
}

/** Requisição completa a partir dos trechos de todas as páginas. */
export function parseRequisition(pages) {
  if (!Array.isArray(pages) || !pages.length) throw new RequisitionParseError("PDF sem páginas.");
  const first = pages[0];
  const number = after(first, "Requisição:");
  if (!number) throw new RequisitionParseError("Não encontrei o número da requisição. Envie o PDF impresso pelo sistema do OGMO.");
  const printed = after(first, "Data/Hora Impressão:");
  const printedMatch = /(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/.exec(printed || "");
  const ternos = pages.map((items, index) => parsePage(items, index + 1));
  const others = pages.slice(1).map(items => after(items, "Requisição:")).filter(value => value && value !== number);
  if (others.length) throw new RequisitionParseError(`O PDF mistura requisições diferentes (${[number, ...new Set(others)].join(", ")}). Envie uma requisição por arquivo.`);
  const period = (after(first, "Período:") || "").replace(/\s+/g, "");
  return {
    number, vessel: parseVesselName(after(first, "Navio:")),
    local: after(first, "Local Atracação:") || "", berthing: after(first, "Atracação:") || "",
    port: after(first, "Porto:")?.replace(/Data da Operação.*$/, "").trim() || "",
    date: brDate(after(first, "Data da Operação:")), period,
    travelType: after(first, "Tipo de Viagem:") || "", voyage: after(first, "N. Viagem:") || "",
    // Hora de Brasília escrita no PDF (sem fuso): guardada como "AAAA-MM-DDTHH:MM:SS".
    printedAt: printedMatch ? `${printedMatch[3]}-${printedMatch[2]}-${printedMatch[1]}T${printedMatch[4]}:${printedMatch[5]}:${printedMatch[6] || "00"}` : null,
    ternos: ternos.sort((a, b) => a.equipe - b.equipe)
  };
}
