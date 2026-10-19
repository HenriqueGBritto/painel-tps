/* Sessão de teste para chamar as rotas protegidas (login em memória, sem Firebase). */
import { randomUUID } from "node:crypto";
import { memoryAuthBackend, useAuthBackend, login, PERMISSIONS, USERS } from "../netlify/lib/auth.mjs";
import { memoryStore } from "../netlify/lib/activities-store.mjs";

export const testAuth = { backend: memoryAuthBackend(), store: memoryStore() };

/** Cria um acesso de teste e devolve o cabeçalho Cookie de uma sessão dele. */
export async function sessionCookie({ name = "Pessoa de teste", assistantId = null, permissions = Object.keys(PERMISSIONS), mustChangePassword = false } = {}) {
  useAuthBackend(testAuth.backend, testAuth.store);
  const email = `teste-${randomUUID().slice(0, 8)}@painel.test`;
  const password = `Teste${randomUUID().slice(0, 8)}1`;
  const uid = await testAuth.backend.createUser({ email, password });
  await testAuth.store.set(USERS, uid, { email, name, assistantId, permissions, mustChangePassword, disabled: false });
  const { setCookie } = await login({ email, password });
  return { cookie: setCookie.split(";")[0], uid, email, password };
}
