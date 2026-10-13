/* Leitor enxuto de .xlsx para planilhas muito grandes.
   O SheetJS monta todas as células de todas as colunas; a base de indicadores tem
   ~65 mil linhas × 70 colunas (130 MB de XML) e passaria do limite de tempo do Netlify.
   Aqui só as colunas usadas pelo painel são lidas, e o resultado tem o mesmo formato
   de planilha "densa" do SheetJS ({ "!ref", "!data" }), então o leitor não muda. */
import { inflateRawSync } from "node:zlib";

const decoder = new TextDecoder("utf-8");

function unzip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.byteLength - 22; i >= Math.max(0, bytes.byteLength - 66000); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Arquivo .xlsx inválido.");
  const count = view.getUint16(eocd + 10, true);
  let pointer = view.getUint32(eocd + 16, true);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(pointer, true) !== 0x02014b50) throw new Error("Arquivo .xlsx inválido.");
    const method = view.getUint16(pointer + 10, true);
    const compressed = view.getUint32(pointer + 20, true);
    const nameLength = view.getUint16(pointer + 28, true), extra = view.getUint16(pointer + 30, true), comment = view.getUint16(pointer + 32, true);
    const local = view.getUint32(pointer + 42, true);
    const name = decoder.decode(bytes.subarray(pointer + 46, pointer + 46 + nameLength));
    entries.set(name, { method, compressed, local });
    pointer += 46 + nameLength + extra + comment;
  }
  return name => {
    const entry = entries.get(name);
    if (!entry) return null;
    const start = entry.local + 30 + view.getUint16(entry.local + 26, true) + view.getUint16(entry.local + 28, true);
    const raw = bytes.subarray(start, start + entry.compressed);
    return decoder.decode(entry.method === 0 ? raw : inflateRawSync(raw));
  };
}

const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescape = text => text.indexOf("&") < 0 ? text : text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (all, code) =>
  code[0] === "#" ? String.fromCodePoint(code[1] === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1))) : entities[code] ?? all);
const attributePatterns = new Map();
const attribute = (tag, name) => {
  let pattern = attributePatterns.get(name);
  if (!pattern) attributePatterns.set(name, pattern = new RegExp(`\\s${name}="([^"]*)"`));
  return pattern.exec(tag)?.[1];
};

function sharedStrings(xml) {
  if (!xml) return [];
  const list = [];
  const items = /<si>([\s\S]*?)<\/si>|<si\/>/g;
  let item;
  while ((item = items.exec(xml))) {
    const body = (item[1] || "").replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
    let text = "", part;
    const parts = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    while ((part = parts.exec(body))) text += part[1];
    list.push(unescape(text));
  }
  return list;
}

/** Formatos de número que o Excel trata como data/hora (mesma regra do SheetJS). */
function dateStyles(xml) {
  const custom = new Map();
  for (const tag of xml.match(/<numFmt\s[^>]*>/g) || []) custom.set(Number(attribute(tag, "numFmtId")), unescape(attribute(tag, "formatCode") || ""));
  const isDateFormat = id => {
    if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47) || (id >= 27 && id <= 36) || (id >= 50 && id <= 58)) return true;
    const code = custom.get(id);
    if (!code) return false;
    const plain = code.replace(/"[^"]*"|\\.|\[(?!h\]|hh\]|m\]|mm\]|s\]|ss\])[^\]]*\]/gi, "");
    return /[dmyhs]/i.test(plain) && !/^[#0.,%\s]*$/.test(plain);
  };
  const cellXfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] || "";
  return (cellXfs.match(/<xf\b[^>]*>/g) || []).map(tag => isDateFormat(Number(attribute(tag, "numFmtId") || 0)));
}

const columnIndex = ref => {
  let col = 0;
  for (let i = 0; i < ref.length; i++) {
    const code = ref.charCodeAt(i);
    if (code < 65 || code > 90) break;
    col = col * 26 + code - 64;
  }
  return col - 1;
};

/* Converte o número serial do Excel em Date no fuso local, como o SheetJS faz com cellDates. */
function excelDate(serial) {
  const days = Math.floor(serial), seconds = Math.round((serial - days) * 86400);
  const base = new Date(1899, 11, 30 + days, 0, 0, 0);
  base.setSeconds(seconds);
  return base;
}

function readSheet(xml, strings, dates, columns, cellDates) {
  const wanted = new Set(columns);
  const maxColumn = Math.max(...columns);
  const data = [];
  let lastRow = 0;
  const rowPattern = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  const cellPattern = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let rowMatch;
  while ((rowMatch = rowPattern.exec(xml))) {
    const row = Number(attribute(rowMatch[1], "r")) - 1;
    if (!rowMatch[2]) continue;
    let cells = null, cellMatch;
    cellPattern.lastIndex = 0;
    while ((cellMatch = cellPattern.exec(rowMatch[2]))) {
      const attrs = cellMatch[1];
      const col = columnIndex(attribute(attrs, "r") || "");
      if (col > maxColumn) break;
      if (!wanted.has(col) || !cellMatch[2]) continue;
      const type = attribute(attrs, "t") || "n";
      const body = cellMatch[2];
      let value;
      if (type === "inlineStr") {
        let text = "", part;
        const parts = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
        while ((part = parts.exec(body))) text += part[1];
        value = unescape(text);
      } else {
        const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        if (raw === undefined) continue;
        if (type === "s") value = strings[Number(raw)];
        else if (type === "str") value = unescape(raw);
        else if (type === "b") value = raw === "1";
        else if (type === "e") continue; // #N/A, #REF!… ficam vazios
        else {
          value = Number(raw);
          if (cellDates && dates[Number(attribute(attrs, "s") || 0)]) value = excelDate(value);
        }
      }
      (cells ||= [])[col] = { v: value };
      lastRow = Math.max(lastRow, row);
    }
    if (cells) data[row] = cells;
  }
  return { "!data": data, "!ref": `A1:${columnName(maxColumn)}${lastRow + 1}` };
}

function columnName(index) {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/**
 * Lê só as abas e colunas pedidas.
 * @param {Uint8Array} bytes arquivo .xlsx
 * @param {Record<string, number[]>} plan nome da aba → índices de coluna (0 = A)
 */
export function readColumns(bytes, plan, { cellDates = true } = {}) {
  const file = unzip(bytes);
  const workbook = file("xl/workbook.xml") || "";
  const rels = file("xl/_rels/workbook.xml.rels") || "";
  const targets = new Map((rels.match(/<Relationship\b[^>]*>/g) || []).map(tag => [attribute(tag, "Id"), attribute(tag, "Target")]));
  const strings = sharedStrings(file("xl/sharedStrings.xml"));
  const dates = dateStyles(file("xl/styles.xml") || "");
  const Sheets = {};
  for (const tag of workbook.match(/<sheet\b[^>]*>/g) || []) {
    const name = unescape(attribute(tag, "name") || "");
    if (!plan[name]) continue;
    const target = targets.get(attribute(tag, "r:id"));
    if (!target) continue;
    const path = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
    const xml = file(path);
    if (xml) Sheets[name] = readSheet(xml, strings, dates, plan[name], cellDates);
  }
  return { SheetNames: Object.keys(Sheets), Sheets };
}
