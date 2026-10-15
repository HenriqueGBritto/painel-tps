/* Armazenamento da aba Atividades.
   - Produção: Firestore (FIREBASE_SERVICE_ACCOUNT_JSON no Netlify).
   - Desenvolvimento local (scripts/dev-server.mjs, netlify dev) e testes: memória, perdida ao reiniciar.
   Sem Firestore fora do desenvolvimento, as rotas respondem 503 em vez de gravar em memória e perder dados.

   Interface mínima, igual nos dois casos. `collection` aceita caminho de subcoleção ("shifts/2026-10-14_D/tasks"). */
import { firestore } from "./firebase.mjs";

export function memoryStore() {
  const data = new Map();
  const bucket = collection => { if (!data.has(collection)) data.set(collection, new Map()); return data.get(collection); };
  return {
    kind: "memory",
    async get(collection, id) { const value = bucket(collection).get(id); return value ? structuredClone(value) : null; },
    async set(collection, id, value, { merge = false } = {}) {
      const current = merge ? bucket(collection).get(id) || {} : {};
      bucket(collection).set(id, structuredClone({ ...current, ...value }));
    },
    /** Grava só se ainda não existir. Devolve true se gravou. */
    async create(collection, id, value) {
      if (bucket(collection).has(id)) return false;
      bucket(collection).set(id, structuredClone(value));
      return true;
    },
    async remove(collection, id) { bucket(collection).delete(id); },
    /** Documentos da coleção; com from/to, só ids nesse intervalo (inclusive), em ordem de id. */
    async list(collection, { from = null, to = null } = {}) {
      return [...bucket(collection)]
        .filter(([id]) => (from === null || id >= from) && (to === null || id <= to))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, value]) => ({ id, ...structuredClone(value) }));
    }
  };
}

/* O Firestore recusa campos `undefined`; a ida e volta em JSON os remove. */
const clean = value => JSON.parse(JSON.stringify(value));

export function firestoreStore(db) {
  return {
    kind: "firestore",
    async get(collection, id) { const doc = await db.collection(collection).doc(id).get(); return doc.exists ? doc.data() : null; },
    async set(collection, id, value, { merge = false } = {}) { await db.collection(collection).doc(id).set(clean(value), { merge }); },
    async create(collection, id, value) {
      try { await db.collection(collection).doc(id).create(clean(value)); return true; }
      catch (error) { if (error.code === 6 || /already exists/i.test(error.message)) return false; throw error; }
    },
    async remove(collection, id) { await db.collection(collection).doc(id).delete(); },
    async list(collection, { from = null, to = null } = {}) {
      let query = db.collection(collection).orderBy("__name__");
      if (from !== null) query = query.startAt(from);
      if (to !== null) query = query.endAt(to);
      const snapshot = await query.get();
      return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    }
  };
}

let override = null;
let shared = null;
/** Só para testes: troca o armazenamento. */
export function useActivitiesStore(store) { override = store; }

const isDevelopment = env => env.NETLIFY_DEV === "true" || env.TPS_ACTIVITIES_MEMORY === "1";

/** Armazenamento em uso, ou null quando não há Firestore configurado em produção. */
export function activitiesStore(env = process.env) {
  if (override) return override;
  if (env.FIREBASE_SERVICE_ACCOUNT_JSON) return shared ||= firestoreStore(firestore());
  if (isDevelopment(env)) return shared ||= memoryStore();
  return null;
}
