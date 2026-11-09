/* Conta de serviço do painel no Google (a mesma do Firebase, FIREBASE_SERVICE_ACCOUNT_JSON).
   Usada pelo espelho da Base SOF (escreve) e pela leitura das planilhas nativas (sheets-api.mjs). */
import { createSign } from "node:crypto";

const base64url = value => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

/** Conta de serviço da variável de ambiente, ou null quando não está configurada (servidor local). */
export function serviceAccount(env = process.env) {
  try { return env.FIREBASE_SERVICE_ACCOUNT_JSON ? JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON) : null; } catch { return null; }
}

/** Token de acesso da conta de serviço só para planilhas (JWT assinado aqui, sem biblioteca do Google). */
export async function googleToken(account, fetchImpl = fetch, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const unsigned = `${base64url({ alg: "RS256", typ: "JWT" })}.${base64url({ iss: account.client_email, scope: "https://www.googleapis.com/auth/spreadsheets", aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(account.private_key, "base64url");
  const response = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) throw new Error(`Google recusou a conta de serviço: ${body.error_description || body.error || response.status}`);
  return body.access_token;
}
