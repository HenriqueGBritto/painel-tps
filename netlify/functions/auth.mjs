/* Login e tela Acessos.
   /api/auth/login (POST), /api/auth/sair (POST), /api/auth/eu (GET), /api/auth/senha (POST)
   /api/acessos (GET lista), /api/acessos/criar, /api/acessos/alterar, /api/acessos/senha (POST, só administrador).
   Regras em netlify/lib/auth.mjs; permissões em netlify/lib/access.mjs. */
import { authorize, denied, can, ACTIONS } from "../lib/access.mjs";
import * as auth from "../lib/auth.mjs";

const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Type": "application/json; charset=utf-8" };
const json = (value, status = 200, extra = {}) => new Response(JSON.stringify(value), { status, headers: { ...headers, ...extra } });
const MAX_BODY = 5_000;

async function readBody(request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY) throw new auth.AuthError(413, "Pedido grande demais.");
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new auth.AuthError(400, "Pedido inválido."); }
}

/** O que a página precisa saber de quem está logado (sem nada sensível). */
function me(user) {
  const screens = Object.fromEntries(Object.keys(auth.PERMISSIONS).map(key => [key, user.permissions.includes(key)]));
  return {
    user: { uid: user.uid, email: user.email, name: user.name, assistantId: user.assistantId, mustChangePassword: user.mustChangePassword, permissions: user.permissions },
    can: { ...screens, operations: can(user, ACTIONS.readOperations), discharge: can(user, ACTIONS.readDischarge), refresh: can(user, ACTIONS.refreshData) }
  };
}

export default async function handler(request) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "");
  // Cookie Secure só fora do servidor local em http.
  const secure = url.protocol === "https:";
  if (request.method === "POST") {
    const origin = request.headers.get("origin");
    const allowedHosts = [url.host, request.headers.get("host"), request.headers.get("x-forwarded-host")].filter(Boolean);
    if (origin && !allowedHosts.includes(new URL(origin).host)) return json({ error: "Origem não permitida." }, 403);
  }
  try {
    if (request.method === "POST" && path === "/api/auth/login") {
      const { setCookie } = await auth.login(await readBody(request), { secure });
      return json({ ok: true }, 200, { "Set-Cookie": setCookie });
    }
    if (request.method === "POST" && path === "/api/auth/sair") return json({ ok: true }, 200, { "Set-Cookie": auth.clearSessionCookieHeader(secure) });

    if (request.method === "GET" && path === "/api/auth/eu") {
      const session = await auth.sessionUser(request);
      if (!session.user) return json({ error: session.error, code: session.code }, session.status, session.status === 401 ? { "Set-Cookie": auth.clearSessionCookieHeader(secure) } : {});
      return json(me(session.user));
    }
    if (request.method === "POST" && path === "/api/auth/senha") {
      const access = await authorize(request, ACTIONS.ownAccount);
      if (!access.allowed) return denied(access);
      const { setCookie } = await auth.changePassword(access.user, await readBody(request), { secure });
      return json({ ok: true }, 200, { "Set-Cookie": setCookie });
    }

    if (path === "/api/acessos" || path.startsWith("/api/acessos/")) {
      const access = await authorize(request, ACTIONS.manageAccess);
      if (!access.allowed) return denied(access);
      if (request.method === "GET" && path === "/api/acessos") return json(await auth.listUsers());
      const actions = { "/api/acessos/criar": auth.createUser, "/api/acessos/alterar": auth.updateUser, "/api/acessos/senha": auth.resetPassword };
      if (request.method === "POST" && actions[path]) return json(await actions[path](access.user, await readBody(request)));
    }
    return json({ error: "Rota não encontrada." }, 404);
  } catch (error) {
    if (error instanceof auth.AuthError) return json({ error: error.message, code: error.code }, error.status);
    console.error("Falha no login/acessos:", error);
    return json({ error: "Não foi possível concluir agora. Tente novamente." }, 500);
  }
}

export const config = { path: ["/api/auth/*", "/api/acessos", "/api/acessos/*"] };
