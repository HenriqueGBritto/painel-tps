import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { memoryStore } from "../netlify/lib/activities-store.mjs";
import * as auth from "../netlify/lib/auth.mjs";
import { authorize, can, ACTIONS, REQUIRED } from "../netlify/lib/access.mjs";
import handler from "../netlify/functions/auth.mjs";

const ADMIN = { email: "chefe@painel.test", password: "Chefe12345" };
let backend, store;
const cookieOf = setCookie => setCookie.split(";")[0];
const request = (path, { body, cookie, origin = "https://painel.test" } = {}) => new Request(`https://painel.test${path}`, body === undefined
  ? { headers: cookie ? { cookie } : {} }
  : { method: "POST", body: JSON.stringify(body), headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) } });
const call = async (path, options) => { const response = await handler(request(path, options)); return { status: response.status, body: await response.json(), setCookie: response.headers.get("set-cookie") }; };
async function signIn(email, password, remember = false) {
  const result = await call("/api/auth/login", { body: { email, password, remember } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return cookieOf(result.setCookie);
}

beforeEach(() => {
  process.env.TPS_ADMIN_EMAILS = ADMIN.email;
  backend = auth.memoryAuthBackend({ users: [ADMIN] });
  store = memoryStore();
  auth.useAuthBackend(backend, store);
});

test("senha: pelo menos 8 caracteres, com letra e número", () => {
  assert.match(auth.passwordProblem("abc12"), /8 caracteres/);
  assert.match(auth.passwordProblem("12345678"), /letra/);
  assert.match(auth.passwordProblem("abcdefgh"), /número/);
  assert.equal(auth.passwordProblem("Triunfo2026"), null);
});

test("cookie: HttpOnly e Secure; com 'manter conectado' dura 14 dias, sem ele some ao fechar o navegador", () => {
  const short = auth.sessionCookieHeader("abc");
  assert.match(short, /^tps_sessao=abc; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
  assert.match(auth.sessionCookieHeader("abc", { remember: true }), /Max-Age=1209600$/);
  assert.match(auth.clearSessionCookieHeader(), /Max-Age=0$/);
  assert.equal(auth.readSessionCookie(new Request("https://x.test", { headers: { cookie: "a=1; tps_sessao=xyz; b=2" } })), "xyz");
});

test("cada ação exige o acesso certo", () => {
  const user = permissions => ({ permissions });
  for (const action of Object.values(ACTIONS)) assert.ok(action in REQUIRED, action);
  assert.equal(can(user(["indicadores"]), ACTIONS.readOperations), true);
  assert.equal(can(user(["lineup"]), ACTIONS.readOperations), true);
  assert.equal(can(user(["lineup"]), ACTIONS.readDischarge), false);
  assert.equal(can(user(["atividades"]), ACTIONS.editShift), true);
  assert.equal(can(user(["atividades"]), ACTIONS.configure), false);
  assert.equal(can(user(["atividades-config"]), ACTIONS.readHistory), true);
  assert.equal(can(user(["equipe"]), ACTIONS.readTeam), true);
  assert.equal(can(user(["producao"]), ACTIONS.manageAccess), false);
  assert.equal(can(user([]), ACTIONS.ownAccount), true);
  assert.equal(can(user(["admin"]), "acao:inexistente"), false);
});

test("sem login: 401; senha errada: mensagem sem dizer qual dos dois errou", async () => {
  assert.equal((await authorize(request("/api/data"), ACTIONS.readOperations)).status, 401);
  const wrong = await call("/api/auth/login", { body: { email: ADMIN.email, password: "Errada123" } });
  assert.deepEqual([wrong.status, wrong.body.error], [401, "E-mail ou senha incorretos."]);
  const unknown = await call("/api/auth/login", { body: { email: "ninguem@painel.test", password: "Errada123" } });
  assert.deepEqual([unknown.status, unknown.body.error], [401, "E-mail ou senha incorretos."]);
  assert.equal((await call("/api/auth/eu", { cookie: "tps_sessao=inventado" })).status, 401);
});

test("administrador inicial: primeiro login cria o perfil com todos os acessos", async () => {
  const cookie = await signIn(ADMIN.email, ADMIN.password);
  const me = await call("/api/auth/eu", { cookie });
  assert.equal(me.status, 200);
  assert.deepEqual(me.body.user.permissions, Object.keys(auth.PERMISSIONS));
  assert.equal(me.body.can.admin, true);
  const history = (await call("/api/acessos", { cookie })).body.history;
  assert.match(history[0].action, /administrador inicial/);
});

test("fluxo completo: cadastro com senha provisória, troca obrigatória e acesso só ao liberado", async () => {
  const admin = await signIn(ADMIN.email, ADMIN.password);
  const created = await call("/api/acessos/criar", { cookie: admin, body: { name: "Ana Assistente", email: "Ana@Painel.test", password: "Provisoria1", permissions: ["atividades", "lineup", "inventada"], assistantId: "helio" } });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal((await call("/api/acessos/criar", { cookie: admin, body: { name: "Ana", email: "ana@painel.test", password: "Provisoria1" } })).status, 409, "e-mail repetido");

  let ana = await signIn("ana@painel.test", "Provisoria1");
  const first = await call("/api/auth/eu", { cookie: ana });
  assert.equal(first.body.user.mustChangePassword, true);
  assert.deepEqual(first.body.user.permissions, ["atividades", "lineup"], "acesso desconhecido é descartado");
  const blocked = await authorize(request("/api/atividades/turno", { cookie: ana }), ACTIONS.readShift);
  assert.deepEqual([blocked.status, blocked.code], [403, "trocar-senha"], "nada funciona antes de trocar a senha");

  assert.match((await call("/api/auth/senha", { cookie: ana, body: { password: "Provisoria1", confirm: "Provisoria1" } })).body.error, /diferente/);
  assert.match((await call("/api/auth/senha", { cookie: ana, body: { password: "NovaSenha9", confirm: "OutraSenha9" } })).body.error, /confirmação/);
  assert.match((await call("/api/auth/senha", { cookie: ana, body: { password: "curta1", confirm: "curta1" } })).body.error, /8 caracteres/);
  const changed = await call("/api/auth/senha", { cookie: ana, body: { password: "NovaSenha9", confirm: "NovaSenha9" } });
  assert.equal(changed.status, 200);
  assert.equal((await call("/api/auth/eu", { cookie: ana })).status, 401, "a sessão antiga termina com a troca");
  ana = cookieOf(changed.setCookie);
  assert.equal((await call("/api/auth/login", { body: { email: "ana@painel.test", password: "Provisoria1" } })).status, 401, "a provisória deixa de valer");

  const allowed = await authorize(request("/api/atividades/turno", { cookie: ana }), ACTIONS.editShift);
  assert.equal(allowed.allowed, true);
  assert.deepEqual([allowed.user.name, allowed.user.assistantId], ["Ana Assistente", "helio"]);
  assert.equal((await authorize(request("/x", { cookie: ana }), ACTIONS.readTeam)).status, 403, "Equipe não liberada");
  assert.equal((await authorize(request("/x", { cookie: ana }), ACTIONS.readDischarge)).status, 403, "Descarga é de Indicadores");
  assert.equal((await call("/api/acessos", { cookie: ana })).status, 403, "só administrador vê os acessos");
});

test("administrador altera acessos, bloqueia e redefine a senha", async () => {
  const admin = await signIn(ADMIN.email, ADMIN.password);
  const { body: { uid } } = await call("/api/acessos/criar", { cookie: admin, body: { name: "Bruno", email: "bruno@painel.test", password: "Provisoria1", permissions: ["indicadores"] } });
  await call("/api/acessos/alterar", { cookie: admin, body: { uid, permissions: ["indicadores", "equipe"] } });
  backend.accounts.get("bruno@painel.test").password = "Bruno12345";
  await store.set(auth.USERS, uid, { mustChangePassword: false }, { merge: true });
  auth.useAuthBackend(backend, store); // limpa o cache de perfis, como depois de 30 s
  const bruno = await signIn("bruno@painel.test", "Bruno12345", true);
  assert.equal((await authorize(request("/x", { cookie: bruno }), ACTIONS.readTeam)).allowed, true, "acesso novo vale");

  await call("/api/acessos/alterar", { cookie: admin, body: { uid, disabled: true } });
  assert.equal((await call("/api/auth/eu", { cookie: bruno })).status, 401, "bloquear encerra a sessão");
  assert.equal((await call("/api/auth/login", { body: { email: "bruno@painel.test", password: "Bruno12345" } })).status, 403);
  await call("/api/acessos/alterar", { cookie: admin, body: { uid, disabled: false } });

  assert.equal((await call("/api/acessos/senha", { cookie: admin, body: { uid, password: "Nova1234" } })).status, 200);
  const again = await signIn("bruno@painel.test", "Nova1234");
  assert.equal((await call("/api/auth/eu", { cookie: again })).body.user.mustChangePassword, true, "senha redefinida obriga a trocar");

  const { users, history } = (await call("/api/acessos", { cookie: admin })).body;
  assert.deepEqual(users.map(user => user.name), ["Bruno", "chefe"]);
  assert.ok(history.some(item => /acessos: Indicadores, Equipe/.test(item.details)));
  assert.ok(history.some(item => item.details === "bloqueado"));
  assert.ok(history.some(item => /nova senha provisória/.test(item.action)));
  assert.ok(!JSON.stringify(history).includes("Nova1234"), "o histórico não guarda senhas");
});

test("administrador não tira o próprio acesso nem se bloqueia; pedidos de outro site são recusados", async () => {
  const admin = await signIn(ADMIN.email, ADMIN.password);
  const { uid } = (await call("/api/auth/eu", { cookie: admin })).body.user;
  assert.equal((await call("/api/acessos/alterar", { cookie: admin, body: { uid, disabled: true } })).status, 400);
  const foreign = await call("/api/acessos/criar", { cookie: admin, origin: "https://outro.site", body: { name: "X", email: "x@painel.test", password: "Provisoria1" } });
  assert.equal(foreign.status, 403);
  const out = await call("/api/auth/sair", { cookie: admin, body: {} });
  assert.match(out.setCookie, /Max-Age=0/);
});
