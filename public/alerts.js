/* Sino de alertas no cabeçalho. Os alertas vêm de /api/alertas (netlify/lib/alerts.mjs), já filtrados
   pelas telas de cada pessoa. Confere ao abrir, a cada 5 minutos e quando a aba volta a ficar visível.
   O número no sino conta só os alertas ainda não vistos neste navegador. */
(function () {
  const POLL_MS = 5 * 60 * 1000;
  const SEEN_KEY = "tps-alertas-vistos";
  const $ = id => document.getElementById(id);
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const state = { alerts: [], checkedAt: null, timer: null };
  const LEVELS = { critical: "Crítico", warning: "Atenção", info: "Aviso" };

  const seen = {
    get() { try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || "[]")); } catch { return new Set(); } },
    set(ids) { try { localStorage.setItem(SEEN_KEY, JSON.stringify([...ids].slice(-200))); } catch { /* sem armazenamento: o número volta ao recarregar */ } }
  };

  function render() {
    const button = $("alertsButton"), count = $("alertsCount"), body = $("alertsBody");
    const viewed = seen.get();
    const fresh = state.alerts.filter(alert => !viewed.has(alert.id)).length;
    count.textContent = fresh ? String(fresh) : "";
    count.hidden = !fresh;
    button.dataset.level = state.alerts[0]?.level || "none";
    button.setAttribute("aria-label", state.alerts.length ? `Alertas: ${state.alerts.length}${fresh ? `, ${fresh} novos` : ""}` : "Alertas: nenhum");
    const time = state.checkedAt ? new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" }).format(new Date(state.checkedAt)) : "";
    body.innerHTML = state.alerts.length
      ? `<ul class="alerts-list">${state.alerts.map(alert => `<li><button type="button" class="alerts-item is-${alert.level}${viewed.has(alert.id) ? "" : " is-new"}" data-view="${escapeHtml(alert.view)}">
          <span class="alerts-meta">${LEVELS[alert.level] || ""} · ${escapeHtml(alert.area)}</span>
          <strong>${escapeHtml(alert.title)}</strong><span>${escapeHtml(alert.detail)}</span></button></li>`).join("")}</ul>`
      : `<p class="alerts-empty">Nenhum alerta agora.</p>`;
    $("alertsChecked").textContent = time ? `Conferido às ${time}` : "";
  }

  async function check() {
    try {
      const response = await fetch("/api/alertas", { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json();
      state.alerts = data.alerts || [];
      state.checkedAt = data.checkedAt;
      render();
    } catch { /* sem conexão: tenta de novo na próxima rodada */ }
  }

  function toggle(open) {
    const panel = $("alertsPanel");
    panel.hidden = !open;
    $("alertsButton").setAttribute("aria-expanded", String(open));
    if (open) {
      // Abrir o painel marca os alertas como vistos (o destaque "novo" some na próxima abertura).
      render();
      const ids = seen.get();
      state.alerts.forEach(alert => ids.add(alert.id));
      seen.set(ids);
      $("alertsCount").hidden = true;
    }
  }

  async function start() {
    const { user } = await window.TpsAuth.ready;
    // Só há alertas de Indicadores, Lineup, Atividades e Requisições: sem nenhuma dessas telas, o sino nem aparece.
    if (!["indicadores", "lineup", "atividades", "atividades-config", "requisicoes"].some(key => user.permissions.includes(key))) return;
    $("alertsWrap").hidden = false;
    $("alertsButton").addEventListener("click", () => toggle($("alertsPanel").hidden));
    $("alertsClose").addEventListener("click", () => { toggle(false); $("alertsButton").focus(); });
    $("alertsBody").addEventListener("click", event => {
      const item = event.target.closest("[data-view]");
      if (!item) return;
      toggle(false);
      window.openView?.(item.dataset.view);
    });
    document.addEventListener("click", event => { if (!$("alertsPanel").hidden && !$("alertsWrap").contains(event.target)) toggle(false); });
    document.addEventListener("keydown", event => { if (event.key === "Escape" && !$("alertsPanel").hidden) { toggle(false); $("alertsButton").focus(); } });
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") check(); });
    state.timer = setInterval(check, POLL_MS);
    render();
    check();
  }

  window.alertsPanel = { check };
  start();
})();
