/* Arquivos anexados à passagem de serviço (fotos e documentos), guardados no Netlify Blobs.
   O Firestore guarda só a lista (nome, tipo, tamanho); o arquivo fica aqui, pela chave "{turno}/{id}".
   Fora do Netlify (testes e servidor local) usa memória, como snapshots.mjs. */
import { getStore } from "@netlify/blobs";

/** Maior arquivo aceito. As funções do Netlify recebem até 6 MB por pedido. */
export const MAX_BYTES = 5 * 1024 * 1024;
export const MAX_FILES = 8;
export const ALLOWED_TYPES = {
  "image/jpeg": "imagem", "image/png": "imagem", "image/webp": "imagem", "image/gif": "imagem",
  "application/pdf": "PDF",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word", "application/msword": "Word",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel", "application/vnd.ms-excel": "Excel",
  "text/plain": "texto", "text/csv": "planilha CSV"
};

function memoryStore() {
  const files = new Map();
  return {
    async put(key, bytes, metadata) { files.set(key, { data: new Uint8Array(bytes).slice().buffer, metadata: structuredClone(metadata) }); },
    async get(key) { const file = files.get(key); return file ? { data: file.data.slice(0), metadata: structuredClone(file.metadata) } : null; },
    async meta(key) { return files.get(key) ? structuredClone(files.get(key).metadata) : null; }
  };
}

let override = null;
let memory = null;
/** Só para testes: troca o armazenamento. */
export function useAttachmentsStore(store) { override = store; }

export function attachmentsStore() {
  if (override) return override;
  try {
    const blobs = getStore({ name: "painel-tps-anexos", consistency: "strong" });
    return {
      put: (key, bytes, metadata) => blobs.set(key, bytes, { metadata }),
      get: key => blobs.getWithMetadata(key, { type: "arrayBuffer" }),
      meta: async key => (await blobs.getMetadata(key))?.metadata || null
    };
  } catch {
    return memory ||= memoryStore(); // sem ambiente do Netlify Blobs (local/testes)
  }
}
export { memoryStore as memoryAttachmentsStore };
