import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

function app() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON não configurado no Netlify.");
  return getApps()[0] || initializeApp({ credential: cert(JSON.parse(raw)) });
}

export function firestore() {
  app();
  return getFirestore();
}

/** Firebase Authentication (contas de login do painel), com a mesma conta de serviço do Firestore. */
export function firebaseAuth() {
  return getAuth(app());
}
