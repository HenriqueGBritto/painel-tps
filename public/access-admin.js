/* Tela Administração → Acessos: cadastrar pessoas (e-mail, nome, senha provisória), liberar as telas de cada uma,
   bloquear e definir nova senha provisória. Dados de /api/acessos (netlify/functions/auth.mjs).
   Expõe window.accessPanel = { show(open) }. */
(function () {
  const $ = id => document.getElementById(id);
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const dateTime = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
  const when = value => value ? dateTime.format(new Date(value)).replace(",", "") : "";
  const state = { data: null, assistants: [], editing: null, started: false, busy: false };

  async function api(path, body) {
    const response = await fetch(path, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Não foi possível falar com o servidor.");
    return data;
  }
  function announce(text, isError = false) {
    const box = $("accessStatus");
    box.textContent = text;
    box.classList.toggle("is-error", isError);
  }

  /** Senha provisória legível para ditar ou mandar à pessoa (sem letras que se confundem). */
  function provisional() {
    const letters = "abcdefghjkmnpqrstuvwxyz", digits = "23456789";
    const pick = (set, n) => Array.from(crypto.getRandomValues(new Uint32Array(n)), value => set[value % set.length]).join("");
    return `Tps${pick(letters, 5)}${pick(digits, 3)}`;
  }

  function permissionsHtml(selected = []) {
    const { permissions, presets } = state.data;
    return `<fieldset class="access-perms"><legend>O que a pessoa pode ver e fazer</legend>
        ${Object.entries(permissions).map(([key, label]) => `<label><input type="checkbox" name="perm" value="${key}"${selected.includes(key) ? " checked" : ""}>${escapeHtml(label)}</label>`).join("")}
      </fieldset>
      <div class="access-presets">Atalhos: ${Object.keys(presets).map(name => `<button type="button" class="act-link" data-preset="${escapeHtml(name)}">${escapeHtml(name)}</button>`).join("")}<button type="button" class="act-link" data-preset="">Limpar</button></div>`;
  }
  function assistantHtml(selected = null) {
    if (!state.assistants.length) return "";
    return `<label>Assistente nas Atividades<select name="assistantId"><option value="">Nenhum</option>${state.assistants.map(item => `<option value="${escapeHtml(item.id)}"${item.id === selected ? " selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}</select></label>`;
  }

  function render() {
    const { users, history, permissions } = state.data;
    const me = window.TpsAuth?.user?.uid;
    const label = key => permissions[key] || key;
    const items = users.map(user => {
      const editing = state.editing === user.uid;
      const tags = [
        user.disabled ? `<span class="access-tag is-warn">Bloqueado</span>` : "",
        user.mustChangePassword ? `<span class="access-tag is-warn">Falta trocar a senha provisória</span>` : "",
        ...user.permissions.map(key => `<span class="access-tag">${escapeHtml(label(key))}</span>`),
        user.permissions.length ? "" : `<span class="access-tag is-warn">Sem nenhum acesso</span>`
      ].join("");
      const edit = editing ? `<form class="access-form" data-form="edit" data-uid="${escapeHtml(user.uid)}">
          <label>Nome<input name="name" value="${escapeHtml(user.name)}" maxlength="80" required></label>
          ${assistantHtml(user.assistantId)}
          ${user.bootstrap ? `<p class="act-muted access-actions">Administrador inicial: sempre tem todos os acessos.</p>` : permissionsHtml(user.permissions)}
          <div class="access-actions"><button type="submit" class="act-button is-primary">Salvar</button><button type="button" class="act-link" data-action="cancel">Cancelar</button></div>
          <div class="access-actions">
            <button type="button" class="act-button" data-action="reset">Definir nova senha provisória</button>
            ${user.uid === me ? "" : `<button type="button" class="act-button" data-action="${user.disabled ? "enable" : "disable"}">${user.disabled ? "Desbloquear" : "Bloquear acesso"}</button>`}
          </div>
        </form>` : "";
      return `<li class="access-item${user.disabled ? " is-disabled" : ""}" data-uid="${escapeHtml(user.uid)}">
        <div class="access-item-head"><div><strong>${escapeHtml(user.name)}</strong> <small>${escapeHtml(user.email)}</small></div>
          <div><small>${user.lastLoginAt ? `Último acesso ${when(user.lastLoginAt)}` : "Ainda não entrou"}</small> ${editing ? "" : `<button type="button" class="act-link" data-action="edit">Editar</button>`}</div></div>
        <div class="access-tags">${tags}</div>${edit}</li>`;
    }).join("");
    $("accessContent").innerHTML = `<div class="access-grid">
      <section class="access-card">
        <h3>Novo acesso</h3>
        <p class="act-muted">A pessoa entra com este e-mail e a senha provisória, e no primeiro acesso é obrigada a criar uma senha própria. Passe a senha provisória em particular (pessoalmente ou mensagem direta).</p>
        <form class="access-form" data-form="create">
          <label>Nome<input name="name" maxlength="80" required autocomplete="off"></label>
          <label>E-mail<input name="email" type="email" required autocomplete="off" spellcheck="false"></label>
          <label>Senha provisória<input name="password" value="${provisional()}" minlength="8" required autocomplete="off" spellcheck="false"></label>
          ${assistantHtml()}
          ${permissionsHtml(state.data.presets.Assistente)}
          <div class="access-actions"><button type="submit" class="act-button is-primary">Cadastrar</button></div>
        </form>
      </section>
      <section class="access-card">
        <h3>Pessoas com acesso (${users.length})</h3>
        <p class="act-muted">Mudanças de acesso valem em até 30 segundos. Bloquear encerra as sessões abertas da pessoa.</p>
        <ul class="access-list">${items || `<li class="act-muted">Ninguém cadastrado ainda.</li>`}</ul>
      </section>
      <section class="access-card">
        <h3>Histórico de alterações</h3>
        <ul class="access-history">${history.map(item => `<li><time>${when(item.at)}</time><strong>${escapeHtml(item.by?.name || "")}</strong> ${escapeHtml(item.action)}: ${escapeHtml(item.target)}${item.details ? ` · ${escapeHtml(item.details)}` : ""}</li>`).join("") || `<li class="act-muted">Sem alterações registradas.</li>`}</ul>
      </section>
    </div>`;
  }

  async function load() {
    announce("Carregando acessos…");
    try {
      const [data, settings] = await Promise.all([api("/api/acessos"), api("/api/atividades/configuracao").catch(() => null)]);
      state.data = data;
      state.assistants = (settings?.assistants || []).filter(item => item.active !== false);
      render();
      announce("");
    } catch (error) {
      announce(error.message, true);
    }
  }

  async function act(run, success) {
    if (state.busy) return;
    state.busy = true;
    try {
      await run();
      state.editing = null;
      await load();
      announce(success);
    } catch (error) {
      announce(error.message, true);
    } finally {
      state.busy = false;
    }
  }
  const formPermissions = form => [...form.querySelectorAll("input[name=perm]:checked")].map(input => input.value);

  function onSubmit(event) {
    const form = event.target.closest("form[data-form]");
    if (!form) return;
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    if (form.dataset.form === "create") {
      const body = { name: data.name, email: data.email, password: data.password, assistantId: data.assistantId || null, permissions: formPermissions(form) };
      act(() => api("/api/acessos/criar", body), `Acesso de ${data.name} criado. Senha provisória: ${data.password}`);
    }
    if (form.dataset.form === "edit") {
      const user = state.data.users.find(item => item.uid === form.dataset.uid);
      const body = { uid: form.dataset.uid, name: data.name, assistantId: data.assistantId ?? undefined, ...(user?.bootstrap ? {} : { permissions: formPermissions(form) }) };
      act(() => api("/api/acessos/alterar", body), "Acesso atualizado.");
    }
  }

  function onClick(event) {
    const preset = event.target.closest("[data-preset]");
    if (preset) {
      const keys = state.data.presets[preset.dataset.preset] || [];
      preset.closest("form").querySelectorAll("input[name=perm]").forEach(input => { input.checked = keys.includes(input.value); });
      return;
    }
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const uid = button.closest("[data-uid]")?.dataset.uid;
    const user = state.data.users.find(item => item.uid === uid);
    const action = button.dataset.action;
    if (action === "edit") { state.editing = uid; render(); $("accessContent").querySelector(`form[data-uid="${CSS.escape(uid)}"] input`)?.focus(); }
    if (action === "cancel") { state.editing = null; render(); }
    if (action === "disable" && confirm(`Bloquear o acesso de ${user.name}? As sessões abertas dela terminam.`)) act(() => api("/api/acessos/alterar", { uid, disabled: true }), `Acesso de ${user.name} bloqueado.`);
    if (action === "enable") act(() => api("/api/acessos/alterar", { uid, disabled: false }), `Acesso de ${user.name} desbloqueado.`);
    if (action === "reset") {
      const password = prompt(`Nova senha provisória para ${user.name} (ela terá de trocar no próximo acesso):`, provisional());
      if (password) act(() => api("/api/acessos/senha", { uid, password }), `Nova senha provisória de ${user.name}: ${password}`);
    }
  }

  function show(open) {
    if (!open) return;
    if (!state.started) {
      state.started = true;
      $("accessContent").addEventListener("submit", onSubmit);
      $("accessContent").addEventListener("click", onClick);
    }
    load();
  }

  window.accessPanel = { show };
})();
