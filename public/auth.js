/* Login do painel: tela de entrada, troca de senha obrigatória no primeiro acesso e menu da conta.
   A senha só vai para o servidor (/api/auth/*), que devolve a sessão num cookie que esta página não lê.
   Expõe window.TpsAuth = { ready (Promise com { user, can }), user, can, logout, changePassword }.
   Carregado antes de app.js: o painel só abre depois do login. */
(function () {
  const $ = id => document.getElementById(id);
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const auth = { user: null, can: {}, ready: null };
  window.TpsAuth = auth;
  let resolveReady;
  auth.ready = new Promise(resolve => { resolveReady = resolve; });

  async function call(path, body) {
    const response = await fetch(`/api/auth${path}`, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data };
  }

  /* ---------- Tela de entrada ---------- */

  function screen(html) {
    let box = $("authScreen");
    if (!box) {
      box = document.createElement("div");
      box.id = "authScreen";
      box.className = "auth-screen";
      document.body.append(box);
    }
    box.innerHTML = `<div class="auth-card" role="dialog" aria-modal="true" aria-labelledby="authTitle">
      <img class="auth-logo" src="/logo-triunfo-horizontal-cor.svg" alt="Triunfo Logística" width="160" height="48">
      ${html}
    </div>`;
    document.body.classList.add("auth-locked");
    box.hidden = false;
    box.querySelector("input")?.focus();
    return box;
  }
  function closeScreen() {
    const box = $("authScreen");
    if (box) box.hidden = true;
    document.body.classList.remove("auth-locked");
  }
  const message = (form, text, isError = true) => { const box = form.querySelector(".auth-message"); box.textContent = text; box.classList.toggle("is-error", isError); };
  const busy = (form, on, label) => { const button = form.querySelector("button[type=submit]"); button.disabled = on; if (label) button.textContent = label; };

  function showLogin(note = "") {
    const box = screen(`<h1 id="authTitle">Painel de Operações</h1>
      <p class="auth-lead">Entre com o e-mail e a senha cadastrados pelo administrador.</p>
      <form class="auth-form" id="authLogin" novalidate>
        <label>E-mail<input name="email" type="email" autocomplete="username" required></label>
        <label>Senha<span class="auth-password"><input name="password" type="password" autocomplete="current-password" required><button type="button" class="auth-eye" data-eye aria-label="Mostrar senha">Mostrar</button></span></label>
        <label class="auth-check"><input name="remember" type="checkbox"> Manter conectado neste computador</label>
        <p class="auth-hint">Sem marcar, você sai ao fechar o navegador. Não marque em computador compartilhado.</p>
        <p class="auth-message" role="alert">${escapeHtml(note)}</p>
        <button type="submit" class="auth-submit">Entrar</button>
        <p class="auth-hint">Esqueceu a senha? Peça ao administrador do painel uma senha provisória nova.</p>
      </form>`);
    const form = box.querySelector("form");
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      if (!data.email || !data.password) { message(form, "Preencha o e-mail e a senha."); return; }
      busy(form, true, "Entrando…");
      message(form, "", false);
      const result = await call("/login", { email: data.email, password: data.password, remember: Boolean(data.remember) }).catch(() => ({ ok: false, data: { error: "Sem conexão com o servidor." } }));
      if (!result.ok) { busy(form, false, "Entrar"); message(form, result.data.error || "Não foi possível entrar."); form.password.select(); return; }
      remember = Boolean(data.remember);
      check();
    });
  }

  let remember = false;

  function passwordForm({ forced }) {
    return `<h1 id="authTitle">${forced ? "Crie a sua senha" : "Trocar senha"}</h1>
      <p class="auth-lead">${forced ? "Este é o seu primeiro acesso (ou a senha foi redefinida). Troque a senha provisória por uma só sua." : "Escolha uma senha nova."}</p>
      <form class="auth-form" id="authPassword" novalidate>
        <label>Nova senha<span class="auth-password"><input name="password" type="password" autocomplete="new-password" minlength="8" required><button type="button" class="auth-eye" data-eye aria-label="Mostrar senha">Mostrar</button></span></label>
        <label>Repita a nova senha<input name="confirm" type="password" autocomplete="new-password" minlength="8" required></label>
        <p class="auth-hint">Pelo menos 8 caracteres, com letras e números. Diferente da senha provisória.</p>
        <p class="auth-message" role="alert"></p>
        <button type="submit" class="auth-submit">Salvar a nova senha</button>
        ${forced ? `<button type="button" class="auth-link" data-logout>Sair</button>` : `<button type="button" class="auth-link" data-cancel>Cancelar</button>`}
      </form>`;
  }

  function showPasswordChange({ forced }) {
    const box = screen(passwordForm({ forced }));
    const form = box.querySelector("form");
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      if (data.password !== data.confirm) { message(form, "A confirmação não é igual à nova senha."); return; }
      busy(form, true, "Salvando…");
      const result = await call("/senha", { password: data.password, confirm: data.confirm, remember }).catch(() => ({ ok: false, data: { error: "Sem conexão com o servidor." } }));
      if (!result.ok) { busy(form, false, "Salvar a nova senha"); message(form, result.data.error || "Não foi possível trocar a senha."); return; }
      if (forced) { check(); return; }
      closeScreen();
      toast("Senha trocada.");
    });
    form.querySelector("[data-cancel]")?.addEventListener("click", closeScreen);
  }

  function toast(text) {
    const box = $("exportStatus");
    if (!box) return;
    box.textContent = text;
    box.hidden = false;
    setTimeout(() => { box.hidden = true; }, 4000);
  }

  document.addEventListener("click", event => {
    const eye = event.target.closest("[data-eye]");
    if (eye) {
      const input = eye.parentElement.querySelector("input");
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      eye.textContent = show ? "Ocultar" : "Mostrar";
      eye.setAttribute("aria-label", show ? "Ocultar senha" : "Mostrar senha");
      return;
    }
    if (event.target.closest("[data-logout]")) logout();
  });

  /* ---------- Sessão ---------- */

  async function check() {
    const result = await call("/eu").catch(() => null);
    if (!result) { showLogin("Sem conexão com o servidor. Tente de novo."); return; }
    if (result.status === 401) { showLogin(result.data.code === "sessao-expirada" ? "Sua sessão terminou. Entre de novo." : ""); return; }
    if (!result.ok) { showLogin(result.data.error || "Não foi possível entrar."); return; }
    auth.user = result.data.user;
    auth.can = result.data.can;
    if (auth.user.mustChangePassword) { showPasswordChange({ forced: true }); return; }
    closeScreen();
    renderAccount();
    resolveReady({ user: auth.user, can: auth.can });
  }

  async function logout() {
    await call("/sair", {}).catch(() => {});
    location.replace(location.pathname);
  }
  auth.logout = logout;
  auth.changePassword = () => showPasswordChange({ forced: false });

  function renderAccount() {
    const foot = document.querySelector(".sidebar-foot");
    if (!foot || !auth.user) return;
    foot.innerHTML = `<div class="account-box"><span class="account-name" title="${escapeHtml(auth.user.email)}">${escapeHtml(auth.user.name)}</span>
      <span class="account-actions"><button type="button" class="account-link" data-change-password>Trocar senha</button><button type="button" class="account-link" data-logout>Sair</button></span></div>`;
    foot.querySelector("[data-change-password]").addEventListener("click", () => showPasswordChange({ forced: false }));
  }

  /* Sessão que termina com a página aberta (outro computador trocou a senha, acesso bloqueado, 14 dias):
     qualquer resposta 401 da API volta para a tela de entrada. */
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const response = await nativeFetch(...args);
    const url = String(args[0]?.url || args[0] || "");
    if (auth.user && response.status === 401 && url.startsWith("/api/") && !url.startsWith("/api/auth/")) {
      auth.user = null;
      showLogin("Sua sessão terminou. Entre de novo.");
    }
    return response;
  };
  // Depois de um novo login com a página já aberta, recarrega para ler os dados de novo.
  const firstReady = auth.ready;
  firstReady.then(() => {
    auth.ready = Promise.resolve({ user: auth.user, can: auth.can });
    resolveReady = () => location.reload();
  });

  check();
})();
