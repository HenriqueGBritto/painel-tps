/* Login do painel (Firebase Authentication, e-mail e senha).
   - O administrador cadastra cada pessoa com e-mail, nome, senha provisória e os acessos (tela Acessos).
   - No primeiro acesso a pessoa é obrigada a trocar a senha; até lá o servidor não entrega dados.
   - A senha nunca fica no navegador: o servidor confere com o Firebase e devolve uma sessão num cookie
     HttpOnly (o JavaScript da página não lê). "Manter conectado" = 14 dias (máximo do Firebase);
     sem marcar, o cookie some ao fechar o navegador e a sessão vale no máximo 12 horas.
   - Perfis (acessos) ficam no Firestore em panelUsers/{uid}; alterações vão para panelAccessLog.
   Testado em tests/auth.test.mjs (com um backend em memória no lugar do Firebase). */
import { randomUUID } from "node:crypto";
import { activitiesStore } from "./activities-store.mjs";
import { firebaseAuth } from "./firebase.mjs";

export const SESSION_COOKIE = "tps_sessao";
export const REMEMBER_MS = 14 * 24 * 60 * 60 * 1000;
export const SHORT_MS = 12 * 60 * 60 * 1000;
export const USERS = "panelUsers";
export const ACCESS_LOG = "panelAccessLog";
/** Entradas no painel (login certo e tentativas recusadas). A tela Acessos mostra os últimos 30 dias. */
export const LOGIN_LOG = "panelLoginLog";
export const LOGIN_LOG_DAYS = 30;
/** Chave web do Firebase (pública por natureza: vai para o navegador em qualquer app Firebase). */
const WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY || "AIzaSyBMB0OYAd2Stos2kQbmvK85GoQvQUCyyyc";

/** Telas que o administrador libera por pessoa. */
export const PERMISSIONS = {
  indicadores: "Indicadores",
  lineup: "Lineup",
  producao: "Produção",
  atividades: "Atividades (registrar no turno)",
  requisicoes: "Requisições de estiva",
  compras: "Compras",
  "atividades-config": "Configuração das Atividades",
  equipe: "Equipe (RH)",
  admin: "Administrador (gerencia os acessos)"
};
export const PRESETS = {
  Assistente: ["indicadores", "lineup", "producao", "atividades", "requisicoes"],
  "Gestão": ["indicadores", "lineup", "producao", "atividades", "requisicoes", "compras", "atividades-config", "equipe"]
};

export class AuthError extends Error {
  constructor(status, message, code = null) { super(message); this.status = status; this.code = code; }
}
const fail = (status, message, code) => { throw new AuthError(status, message, code); };

/** Administradores iniciais: entram com todos os acessos no primeiro login (perfil criado sozinho). */
export function adminEmails(env = process.env) {
  return (env.TPS_ADMIN_EMAILS || "henrique.goncalves@triunfologistica.com.br").split(",").map(item => item.trim().toLowerCase()).filter(Boolean);
}

/* ---------- Senha ---------- */

/** Regra do painel (o Firebase também exige 8 caracteres e um número): letras e números, 8 a 128 caracteres. */
export function passwordProblem(password) {
  const value = String(password ?? "");
  if (value.length < 8) return "A senha precisa ter pelo menos 8 caracteres.";
  if (value.length > 128) return "A senha pode ter até 128 caracteres.";
  if (!/[A-Za-zÀ-ÿ]/.test(value)) return "A senha precisa ter pelo menos uma letra.";
  if (!/\d/.test(value)) return "A senha precisa ter pelo menos um número.";
  return null;
}

/* ---------- Backend (Firebase de verdade ou memória para testes e desenvolvimento) ---------- */

function firebaseBackend() {
  const auth = () => firebaseAuth();
  return {
    kind: "firebase",
    async verifySession(cookie) {
      const decoded = await auth().verifySessionCookie(cookie, true);
      return { uid: decoded.uid, email: (decoded.email || "").toLowerCase() };
    },
    async signIn(email, password) {
      const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${WEB_API_KEY}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, returnSecureToken: true }),
        signal: AbortSignal.timeout(10000)
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) return { idToken: data.idToken, uid: data.localId };
      const code = String(data?.error?.message || "");
      if (/USER_DISABLED/.test(code)) fail(403, "Este acesso está bloqueado. Fale com o administrador do painel.", "bloqueado");
      if (/TOO_MANY_ATTEMPTS/.test(code)) fail(429, "Muitas tentativas seguidas. Aguarde alguns minutos e tente de novo.", "tentativas");
      fail(401, "E-mail ou senha incorretos.", "credenciais");
    },
    createSession: (idToken, expiresIn) => auth().createSessionCookie(idToken, { expiresIn }),
    async createUser({ email, password, name }) {
      try { return (await auth().createUser({ email, password, displayName: name })).uid; }
      catch (error) { if (/email-already-exists/.test(error.code || "")) fail(409, "Já existe um acesso com esse e-mail."); throw error; }
    },
    async updateUser(uid, changes) { await auth().updateUser(uid, changes); },
    async revoke(uid) { await auth().revokeRefreshTokens(uid); }
  };
}

/** Backend em memória: testes e servidor local sem conta de serviço. Nunca usado no site publicado. */
export function memoryAuthBackend({ users = [] } = {}) {
  const accounts = new Map(users.map(user => [user.email.toLowerCase(), { uid: user.uid || randomUUID(), password: user.password, disabled: false, validAfter: 0 }]));
  const sessions = new Map();
  let clock = 0;
  const byUid = uid => [...accounts.values()].find(account => account.uid === uid);
  return {
    kind: "memory",
    accounts,
    async verifySession(cookie) {
      const session = sessions.get(cookie);
      const account = session && byUid(session.uid);
      if (!session || !account || account.disabled || session.issued < account.validAfter || Date.now() > session.expires) throw new Error("sessão inválida");
      return { uid: session.uid, email: session.email };
    },
    async signIn(email, password) {
      const account = accounts.get(String(email).toLowerCase());
      if (!account || account.password !== password) fail(401, "E-mail ou senha incorretos.", "credenciais");
      if (account.disabled) fail(403, "Este acesso está bloqueado. Fale com o administrador do painel.", "bloqueado");
      return { idToken: `token:${account.uid}:${String(email).toLowerCase()}`, uid: account.uid };
    },
    async createSession(idToken, expiresIn) {
      const [, uid, email] = idToken.split(":");
      const cookie = `mem-${randomUUID()}`;
      sessions.set(cookie, { uid, email, issued: ++clock, expires: Date.now() + expiresIn });
      return cookie;
    },
    async createUser({ email, password }) {
      if (accounts.has(email)) fail(409, "Já existe um acesso com esse e-mail.");
      const uid = randomUUID();
      accounts.set(email, { uid, password, disabled: false, validAfter: 0 });
      return uid;
    },
    async updateUser(uid, changes) {
      const account = byUid(uid);
      if (!account) fail(404, "Acesso não encontrado.");
      if (changes.password !== undefined) account.password = changes.password;
      if (changes.disabled !== undefined) account.disabled = changes.disabled;
    },
    async revoke(uid) { const account = byUid(uid); if (account) account.validAfter = ++clock; }
  };
}

let override = null;
let shared = null;
/** Só para testes: troca o backend de login e o armazenamento dos perfis. */
export function useAuthBackend(backend, store = null) { override = backend ? { backend, store } : null; profileCache.clear(); }

/** Login desligado só no servidor local sem Firebase (TPS_AUTH_MEMORY=1): backend em memória com contas de teste. */
function context() {
  if (override) return { backend: override.backend, store: override.store || activitiesStore() };
  // Contas de teste só com e-mail .test (nunca valem para pessoas de verdade).
  if (process.env.TPS_AUTH_MEMORY === "1") return { backend: shared ||= memoryAuthBackend({ users: JSON.parse(process.env.TPS_AUTH_TEST_USERS || "[]").filter(user => /@[^@]+\.test$/i.test(user.email)) }), store: activitiesStore() };
  return { backend: shared ||= firebaseBackend(), store: activitiesStore() };
}

/* ---------- Cookie de sessão ---------- */

export function readSessionCookie(request) {
  const header = request.headers.get("cookie") || "";
  const match = header.split(/;\s*/).find(part => part.startsWith(`${SESSION_COOKIE}=`));
  return match ? decodeURIComponent(match.slice(SESSION_COOKIE.length + 1)) : null;
}
/** Set-Cookie da sessão: com "manter conectado", dura 14 dias; sem, some ao fechar o navegador. */
export function sessionCookieHeader(value, { remember = false, secure = true } = {}) {
  return [`${SESSION_COOKIE}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", secure ? "Secure" : null, "SameSite=Lax", remember ? `Max-Age=${REMEMBER_MS / 1000}` : null].filter(Boolean).join("; ");
}
export const clearSessionCookieHeader = (secure = true) => [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", secure ? "Secure" : null, "SameSite=Lax", "Max-Age=0"].filter(Boolean).join("; ");

/* ---------- Perfis ---------- */

const profileCache = new Map();
const PROFILE_TTL_MS = 30 * 1000;
const normalizePermissions = list => [...new Set((Array.isArray(list) ? list : []).map(String).filter(key => key in PERMISSIONS))];
const publicUser = (uid, profile) => ({
  uid, email: profile.email, name: profile.name, permissions: profile.permissions, admin: profile.permissions.includes("admin"),
  assistantId: profile.assistantId || null, mustChangePassword: Boolean(profile.mustChangePassword)
});

/**
 * Acessos novos entram nos perfis antigos uma vez só (versão do perfil):
 * v2 = "Requisições de estiva" liberado para quem já tinha Atividades.
 * v3 = "Compras" liberado para quem já tinha Indicadores (antes Compras seguia os Indicadores).
 */
export const PROFILE_VERSION = 3;
export function upgradeProfile(profile) {
  const version = profile?.profileVersion || 1;
  if (!profile || version >= PROFILE_VERSION) return null;
  const permissions = [...(profile.permissions || [])];
  if (version < 2 && permissions.includes("atividades") && !permissions.includes("requisicoes")) permissions.push("requisicoes");
  if (version < 3 && permissions.includes("indicadores") && !permissions.includes("compras")) permissions.push("compras");
  return { ...profile, permissions, profileVersion: PROFILE_VERSION };
}

async function readProfile(store, uid, { fresh = false } = {}) {
  const cached = profileCache.get(uid);
  if (!fresh && cached && Date.now() - cached.at < PROFILE_TTL_MS) return cached.profile;
  let profile = await store.get(USERS, uid);
  const upgraded = upgradeProfile(profile);
  if (upgraded) { await store.set(USERS, uid, upgraded); profile = upgraded; }
  profileCache.set(uid, { profile, at: Date.now() });
  return profile;
}
async function writeProfile(store, uid, profile) {
  await store.set(USERS, uid, profile);
  profileCache.set(uid, { profile, at: Date.now() });
}
async function log(store, by, action, target, details = "") {
  const at = new Date().toISOString();
  await store.set(ACCESS_LOG, `${at}-${randomUUID().slice(0, 6)}`, { at, by, action, target, details });
}

async function logLogin(store, entry) {
  const at = new Date().toISOString();
  await store.set(LOGIN_LOG, `${at}-${randomUUID().slice(0, 6)}`, { at, ...entry });
}

/**
 * Quem está logado (a partir do cookie) → { user } ou { error, status, code }.
 * Administrador inicial sem perfil ganha o perfil completo no primeiro login.
 */
export async function sessionUser(request) {
  const { backend, store } = context();
  if (!store) return { status: 503, error: "O login precisa do Firestore: configure FIREBASE_SERVICE_ACCOUNT_JSON no Netlify." };
  const cookie = readSessionCookie(request);
  if (!cookie) return { status: 401, error: "Entre com seu e-mail e senha.", code: "sem-sessao" };
  let session;
  try { session = await backend.verifySession(cookie); }
  catch { return { status: 401, error: "Sua sessão terminou. Entre de novo.", code: "sessao-expirada" }; }
  let profile = await readProfile(store, session.uid);
  if (!profile && adminEmails().includes(session.email)) {
    profile = { email: session.email, name: session.email.split("@")[0], permissions: Object.keys(PERMISSIONS), mustChangePassword: false, disabled: false, profileVersion: PROFILE_VERSION, createdAt: new Date().toISOString(), createdBy: { name: "Administrador inicial" } };
    await writeProfile(store, session.uid, profile);
    await log(store, { name: "Sistema" }, "perfil de administrador inicial criado", session.email);
  }
  if (!profile) return { status: 403, error: "Seu acesso ainda não foi liberado. Fale com o administrador do painel.", code: "sem-perfil" };
  if (profile.disabled) return { status: 403, error: "Este acesso está bloqueado. Fale com o administrador do painel.", code: "bloqueado" };
  return { user: publicUser(session.uid, { ...profile, permissions: adminEmails().includes(profile.email) ? Object.keys(PERMISSIONS) : normalizePermissions(profile.permissions) }) };
}

/* ---------- Ações da própria pessoa ---------- */

export async function login(input, { secure = true } = {}) {
  const { backend, store } = context();
  const email = String(input?.email || "").trim().toLowerCase();
  const password = String(input?.password || "");
  if (!email || !password) fail(400, "Preencha o e-mail e a senha.");
  const remember = Boolean(input?.remember);
  const record = (ok, extra = {}) => store ? logLogin(store, { email, ok, remember, ...extra }).catch(error => console.error("Falha ao registrar a entrada:", error)) : null;
  let signed;
  try { signed = await backend.signIn(email, password); }
  catch (error) { if (error instanceof AuthError) await record(false, { reason: error.message }); throw error; }
  const { idToken, uid } = signed;
  const profile = store ? await readProfile(store, uid, { fresh: true }) : null;
  if (profile?.disabled) { await record(false, { uid, name: profile.name, reason: "acesso bloqueado" }); fail(403, "Este acesso está bloqueado. Fale com o administrador do painel.", "bloqueado"); }
  const cookie = await backend.createSession(idToken, remember ? REMEMBER_MS : SHORT_MS);
  if (profile) await writeProfile(store, uid, { ...profile, lastLoginAt: new Date().toISOString() });
  await record(true, { uid, name: profile?.name || null });
  return { setCookie: sessionCookieHeader(cookie, { remember, secure }) };
}

/** Troca de senha (obrigatória no primeiro acesso). A nova senha precisa ser diferente da atual. */
export async function changePassword(user, input, { secure = true } = {}) {
  const { backend, store } = context();
  const password = String(input?.password || "");
  if (password !== String(input?.confirm || "")) fail(400, "A confirmação não é igual à nova senha.");
  const problem = passwordProblem(password);
  if (problem) fail(400, problem);
  const same = await backend.signIn(user.email, password).then(() => true, () => false);
  if (same) fail(400, "A nova senha precisa ser diferente da senha atual.");
  await backend.updateUser(user.uid, { password });
  await backend.revoke(user.uid);
  const profile = await readProfile(store, user.uid, { fresh: true });
  await writeProfile(store, user.uid, { ...profile, mustChangePassword: false, passwordChangedAt: new Date().toISOString() });
  await log(store, { id: user.uid, name: user.name }, "trocou a própria senha", user.email);
  // A troca encerra as sessões antigas; esta já sai com uma sessão nova.
  const { idToken } = await backend.signIn(user.email, password);
  const remember = Boolean(input?.remember);
  return { setCookie: sessionCookieHeader(await backend.createSession(idToken, remember ? REMEMBER_MS : SHORT_MS), { remember, secure }) };
}

/* ---------- Tela Acessos (administrador) ---------- */

export async function listUsers() {
  const { store } = context();
  const since = new Date(Date.now() - LOGIN_LOG_DAYS * 86400000).toISOString();
  const [stored, history, logins] = await Promise.all([store.list(USERS), store.list(ACCESS_LOG), store.list(LOGIN_LOG, { from: since })]);
  const users = await Promise.all(stored.map(async ({ id, ...profile }) => {
    const upgraded = upgradeProfile(profile);
    if (upgraded) await store.set(USERS, id, upgraded);
    return { id, ...(upgraded || profile) };
  }));
  return {
    users: users.map(({ id, ...profile }) => ({ ...publicUser(id, { ...profile, permissions: normalizePermissions(profile.permissions) }), disabled: Boolean(profile.disabled), createdAt: profile.createdAt, lastLoginAt: profile.lastLoginAt || null, bootstrap: adminEmails().includes(profile.email) }))
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
    history: history.slice(-200).reverse(),
    logins: logins.slice(-300).reverse().map(({ at, email, name, ok, remember, reason }) => ({ at, email, name: name || null, ok: Boolean(ok), remember: Boolean(remember), reason: reason || null })),
    permissions: PERMISSIONS, presets: PRESETS
  };
}

const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const describe = permissions => permissions.map(key => PERMISSIONS[key]).join(", ") || "nenhum";

export async function createUser(admin, input) {
  const { backend, store } = context();
  const email = String(input?.email || "").trim().toLowerCase();
  const name = String(input?.name || "").trim().slice(0, 80);
  if (!validEmail(email)) fail(400, "E-mail inválido.");
  if (!name) fail(400, "Preencha o nome.");
  const problem = passwordProblem(input?.password);
  if (problem) fail(400, `Senha provisória: ${problem.charAt(0).toLowerCase()}${problem.slice(1)}`);
  const permissions = normalizePermissions(input?.permissions);
  const uid = await backend.createUser({ email, password: String(input.password), name });
  const now = new Date().toISOString();
  await writeProfile(store, uid, {
    email, name, permissions, assistantId: input?.assistantId ? String(input.assistantId) : null,
    mustChangePassword: true, disabled: false, profileVersion: PROFILE_VERSION, createdAt: now, createdBy: { id: admin.uid, name: admin.name }
  });
  await log(store, { id: admin.uid, name: admin.name }, "criou o acesso", email, `acessos: ${describe(permissions)}`);
  return { uid };
}

export async function updateUser(admin, input) {
  const { backend, store } = context();
  const uid = String(input?.uid || "");
  const profile = await readProfile(store, uid, { fresh: true });
  if (!profile) fail(404, "Acesso não encontrado.");
  const permissions = input?.permissions === undefined ? normalizePermissions(profile.permissions) : normalizePermissions(input.permissions);
  const disabled = input?.disabled === undefined ? Boolean(profile.disabled) : Boolean(input.disabled);
  // Ninguém tira de si mesmo o acesso de administrador nem se bloqueia (evita ficar sem ninguém para gerenciar).
  if (uid === admin.uid && (!permissions.includes("admin") || disabled)) fail(400, "Você não pode tirar o seu próprio acesso de administrador nem se bloquear.");
  const name = input?.name === undefined ? profile.name : String(input.name).trim().slice(0, 80) || profile.name;
  const assistantId = input?.assistantId === undefined ? profile.assistantId || null : (input.assistantId ? String(input.assistantId) : null);
  if (disabled !== Boolean(profile.disabled)) {
    await backend.updateUser(uid, { disabled });
    if (disabled) await backend.revoke(uid);
  }
  await writeProfile(store, uid, { ...profile, name, permissions, disabled, assistantId, updatedAt: new Date().toISOString(), updatedBy: { id: admin.uid, name: admin.name } });
  const changes = [
    describe(permissions) !== describe(normalizePermissions(profile.permissions)) ? `acessos: ${describe(permissions)}` : null,
    disabled !== Boolean(profile.disabled) ? (disabled ? "bloqueado" : "desbloqueado") : null,
    name !== profile.name ? `nome: ${name}` : null,
    assistantId !== (profile.assistantId || null) ? `assistente das Atividades: ${assistantId || "nenhum"}` : null
  ].filter(Boolean);
  if (changes.length) await log(store, { id: admin.uid, name: admin.name }, "alterou o acesso", profile.email, changes.join(" · "));
  return { uid };
}

/** Nova senha provisória (esqueceu a senha): encerra as sessões e obriga a trocar no próximo acesso. */
export async function resetPassword(admin, input) {
  const { backend, store } = context();
  const uid = String(input?.uid || "");
  const profile = await readProfile(store, uid, { fresh: true });
  if (!profile) fail(404, "Acesso não encontrado.");
  const problem = passwordProblem(input?.password);
  if (problem) fail(400, `Senha provisória: ${problem.charAt(0).toLowerCase()}${problem.slice(1)}`);
  await backend.updateUser(uid, { password: String(input.password) });
  await backend.revoke(uid);
  await writeProfile(store, uid, { ...profile, mustChangePassword: true, updatedAt: new Date().toISOString(), updatedBy: { id: admin.uid, name: admin.name } });
  await log(store, { id: admin.uid, name: admin.name }, "definiu nova senha provisória", profile.email);
  return { uid };
}
