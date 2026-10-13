import assert from "node:assert/strict";
import { test } from "node:test";
import { splitText, validateDischarge, validateOperations, saveDataset, loadDataset } from "../netlify/lib/dataset.mjs";

test("divide e recompõe dados UTF-8 sem ultrapassar o limite", () => {
  const source = "Navio 🚢 São Paulo · ".repeat(500);
  const chunks = splitText(source, 451);
  assert.ok(chunks.length > 10);
  assert.equal(chunks.join(""), source);
  assert.ok(chunks.every(chunk => Buffer.byteLength(chunk, "utf8") <= 451));
});

test("rejeita estruturas sem as abas essenciais", () => {
  assert.equal(validateOperations({ source: "navios.xlsm", records: [] }), false);
  assert.equal(validateDischarge({ source: "indicadores.xlsx", dischargeDays: [] }), false);
});

test("grava os blocos antes de publicar a referência e lê a versão ativa", async () => {
  const documents = new Map();
  const db = {
    collection(name) {
      return { doc(id) {
        const key = `${name}/${id}`;
        return {
          async set(value) { documents.set(key, value); },
          async get() { return { exists: documents.has(key), data: () => documents.get(key) }; },
          collection(child) {
            return { doc(chunkId) {
              const chunkKey = `${key}/${child}/${chunkId}`;
              return {
                async set(value) { documents.set(chunkKey, value); },
                async get() { return { exists: documents.has(chunkKey), data: () => documents.get(chunkKey) }; }
              };
            } };
          }
        };
      } };
    }
  };
  const data = { source: "navios.xlsm", records: Array.from({ length: 20000 }, (_, i) => ({ vessel: `Navio ${i} 🚢`, tons: i })) };
  const result = await saveDataset(db, "operations", data);
  assert.ok(result.chunkCount > 1);
  assert.deepEqual(await loadDataset(db, "operations"), data);
});
