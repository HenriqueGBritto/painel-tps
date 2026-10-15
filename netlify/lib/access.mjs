/* Ponto único de permissão das rotas que gravam ou leem dados de pessoas (abas Atividades e Equipe).
   Hoje tudo é liberado: ainda não há login e o autor é o nome escolhido na tela.

   Quando o login chegar (Firebase Authentication, perfis Administrador / Gestão / Assistente):
   1. ler o token "Authorization: Bearer …" e validar com firebase-admin/auth;
   2. buscar o perfil do usuário e conferir se ele pode fazer `action` (ver ACTIONS);
   3. devolver { allowed: false, status: 401|403 } quando não puder;
   4. devolver `user` com { uid, name, role }: as rotas passam a usar esse autor no lugar do escolhido na tela. */

/** Ações das rotas, para o mapa de perfis futuro. */
export const ACTIONS = {
  readShift: "atividades:ler",
  editShift: "atividades:executar",
  readHistory: "atividades:acompanhar",
  configure: "atividades:configurar",
  readTeam: "equipe:ver",
  refreshTeam: "equipe:atualizar"
};

export async function authorize(request, action) {
  if (!Object.values(ACTIONS).includes(action)) return { allowed: false, status: 500, error: "Ação desconhecida." };
  return { allowed: true, user: null };
}

/**
 * Autor de uma gravação. Sem login, vem do corpo do pedido (assistente identificado na tela).
 * Com login, `user` da autorização prevalece.
 */
export function actorOf(access, body) {
  if (access.user) return { id: access.user.uid, name: access.user.name };
  const name = String(body?.actor?.name || "").trim().slice(0, 80);
  const id = String(body?.actor?.id || "").trim().slice(0, 80) || null;
  return name ? { id, name } : null;
}
