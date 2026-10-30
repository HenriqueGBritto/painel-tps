/* Ponto único de permissão: toda rota que entrega ou grava dados passa por authorize(request, action).
   Quem está logado vem do cookie de sessão (netlify/lib/auth.mjs); cada ação exige um dos acessos
   liberados para a pessoa na tela Acessos. Sem sessão → 401; sem o acesso → 403;
   senha provisória ainda não trocada → 403 com code "trocar-senha" (só a própria conta funciona). */
import { sessionUser } from "./auth.mjs";

export const ACTIONS = {
  readShift: "atividades:ler",
  editShift: "atividades:executar",
  readHistory: "atividades:acompanhar",
  configure: "atividades:configurar",
  readTeam: "equipe:ver",
  refreshTeam: "equipe:atualizar",
  readOperations: "dados:navios",
  readDischarge: "dados:descarga",
  readProduction: "dados:producao",
  refreshData: "dados:atualizar",
  manageAccess: "acessos:gerenciar",
  ownAccount: "conta:propria",
  readAlerts: "alertas:ver",
  readRequisitions: "requisicoes:ver",
  sendRequisitions: "requisicoes:enviar",
  configureRequisitions: "requisicoes:configurar",
  readSof: "sof:ver",
  sendSof: "sof:enviar"
};

/** Acessos que liberam cada ação (basta ter um). Lista vazia = qualquer pessoa logada. */
export const REQUIRED = {
  [ACTIONS.readShift]: ["atividades", "atividades-config"],
  [ACTIONS.editShift]: ["atividades"],
  [ACTIONS.readHistory]: ["atividades", "atividades-config"],
  [ACTIONS.configure]: ["atividades-config"],
  [ACTIONS.readTeam]: ["equipe"],
  [ACTIONS.refreshTeam]: ["equipe"],
  [ACTIONS.readOperations]: ["indicadores", "lineup"],
  [ACTIONS.readDischarge]: ["indicadores"],
  [ACTIONS.readProduction]: ["producao"],
  [ACTIONS.refreshData]: ["indicadores", "lineup", "producao"],
  [ACTIONS.manageAccess]: ["admin"],
  [ACTIONS.ownAccount]: [],
  // Cada pessoa recebe só os alertas das telas dela (filtro em alerts.mjs).
  [ACTIONS.readAlerts]: [],
  [ACTIONS.readRequisitions]: ["requisicoes"],
  [ACTIONS.sendRequisitions]: ["requisicoes"],
  // Feriados mudam a capatazia esperada de todos: só quem configura as Atividades ou administra.
  [ACTIONS.configureRequisitions]: ["atividades-config", "admin"],
  [ACTIONS.readSof]: ["indicadores"],
  // Por enquanto qualquer pessoa logada envia SOF; os acessos serão separados depois.
  [ACTIONS.sendSof]: []
};

export function can(user, action) {
  const required = REQUIRED[action];
  if (!required) return false;
  return required.length === 0 || required.some(key => user.permissions.includes(key));
}

export async function authorize(request, action) {
  if (!(action in REQUIRED)) return { allowed: false, status: 500, error: "Ação desconhecida." };
  const session = await sessionUser(request);
  if (!session.user) return { allowed: false, status: session.status, error: session.error, code: session.code };
  const { user } = session;
  if (user.mustChangePassword && action !== ACTIONS.ownAccount) return { allowed: false, status: 403, error: "Troque a senha provisória para continuar.", code: "trocar-senha", user };
  if (!can(user, action)) return { allowed: false, status: 403, error: "Você não tem acesso a esta parte do painel. Fale com o administrador.", code: "sem-acesso", user };
  return { allowed: true, user };
}

/** Resposta JSON padrão para um pedido recusado por authorize(). */
export function denied(access, headers = {}) {
  return new Response(JSON.stringify({ error: access.error || "Acesso negado.", code: access.code || null }), {
    status: access.status || 403, headers: { "Cache-Control": "no-store", ...headers, "Content-Type": "application/json; charset=utf-8" }
  });
}

/** Autor de uma gravação: a pessoa logada (nas Atividades, o assistente ligado ao acesso, se houver). */
export function actorOf(access) {
  if (!access.user) return null;
  return { id: access.user.assistantId || access.user.uid, name: access.user.name, uid: access.user.uid };
}
