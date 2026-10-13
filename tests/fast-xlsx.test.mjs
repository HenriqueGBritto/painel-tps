import assert from "node:assert/strict";
import { test } from "node:test";
import { XLSX } from "../netlify/lib/parsers.mjs";
import { readColumns } from "../netlify/lib/fast-xlsx.mjs";

test("leitor enxuto devolve os mesmos valores do SheetJS nas colunas pedidas", () => {
  const ws = XLSX.utils.aoa_to_sheet([
    ["Título & <cabeçalho>", "x", "Ação \"A\""],
    [1.5, "texto", new Date(2026, 9, 5, 22, 30)],
    [null, true, "repetido"],
    ["repetido", 0.0625, 45930.25]
  ], { cellDates: true });
  ws.D2 = { t: "e", v: 42 }; ws["!ref"] = "A1:D4";
  ws.C4.z = "[h]:mm";
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Base Descarga");
  const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
  const fast = readColumns(bytes, { "Base Descarga": [0, 1, 2, 3] }, { cellDates: false }).Sheets["Base Descarga"];
  const reference = XLSX.read(bytes, { type: "array", dense: true }).Sheets["Base Descarga"];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) {
    assert.deepEqual(fast["!data"][r]?.[c]?.v ?? null, reference["!data"][r]?.[c]?.v ?? null, `linha ${r + 1}, coluna ${c + 1}`);
  }
  assert.equal(fast["!data"][1][3], undefined, "erro #N/A fica vazio");
  assert.equal(XLSX.utils.decode_range(fast["!ref"]).e.r, 3);
});

test("ignora abas e colunas fora do pedido", () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["a", "b", "c"]]), "Base Descarga");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["z"]]), "Base SOF");
  const result = readColumns(new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" })), { "Base Descarga": [1] });
  assert.deepEqual(result.SheetNames, ["Base Descarga"]);
  assert.deepEqual(Array.from(result.Sheets["Base Descarga"]["!data"][0], cell => cell?.v), [undefined, "b"]);
});
