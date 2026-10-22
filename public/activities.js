/* Aba Atividades: lista do turno, passagem de serviço, acompanhamento e configuração da escala.
   Os dados vêm de /api/atividades (netlify/functions/atividades.mjs); os turnos são calculados por TpsShifts (shifts.js).
   Expõe window.activitiesPanel = { start, show }. */
(function () {
  const S = window.TpsShifts;
  const POLL_VISIBLE_MS = 30000;
  const POLL_BACKGROUND_MS = 60000;
  const ALERT_CHECK_MS = 20000;
  /** Alerta perdido (página fechada no horário) só sai se a página abrir até este tempo depois. */
  const ALERT_GRACE_MS = 15 * 60000;
  const KEYS = { alerts: "tps-atividades-alertas", sent: "tps-atividades-alertas-enviados" };

  const state = {
    view: null,            // "turno" | "acompanhamento" | "configuracao" | null (aba fechada)
    current: null,         // turno atual (sempre acompanhado, para os alertas)
    viewed: null,          // turno exibido (atual, anterior ou futuro)
    viewedId: null,        // null = turno atual
    settings: null,
    busy: false,
    noteFiles: [],         // anexos do editor de observação aberto
    historyRows: [],       // turnos do acompanhamento (para baixar a passagem de lá)
    dragging: null,        // atividade sendo arrastada
    editor: null,          // editor aberto na lista: { type: "not-done" | "note" | "assign" | "add", taskId }
    editingTemplate: null,
    pollTimer: null,
    alertTimer: null,
    started: false
  };

  const $ = id => document.getElementById(id);
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const storage = {
    get(key) { try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* navegador sem armazenamento: segue sem lembrar */ } }
  };
  const timeFormat = new Intl.DateTimeFormat("pt-BR", { timeZone: S.TZ, hour: "2-digit", minute: "2-digit" });
  const dateTimeFormat = new Intl.DateTimeFormat("pt-BR", { timeZone: S.TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const hm = value => value ? timeFormat.format(new Date(value)) : "";
  const dmhm = value => value ? dateTimeFormat.format(new Date(value)).replace(",", " às") : "";
  const brDate = iso => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
  const shortLabel = id => { const { date, kind } = S.parseId(id); return `${S.KINDS[kind]} ${brDate(date).slice(0, 5)}`; };

  async function api(path, body) {
    const response = await fetch(`/api/atividades${path}`, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Não foi possível falar com o servidor.");
    return data;
  }

  /* ---------- Quem registra: a pessoa logada (o servidor grava o autor pelo login) ---------- */

  function identity() {
    const user = window.TpsAuth?.user;
    return user ? { id: user.assistantId || user.uid, name: user.name } : null;
  }

  function identityHtml() {
    const me = identity();
    return me ? `<div class="act-identity is-confirmed"><span>Registrando como <strong>${escapeHtml(me.name)}</strong></span></div>` : "";
  }

  function requireIdentity() {
    const me = identity();
    if (!me) announce("Entre com seu login para registrar.", true);
    return me;
  }

  /* ---------- Carregamento ---------- */

  function announce(message, isError = false) {
    const box = state.view === "acompanhamento" ? $("activitiesHistoryStatus") : state.view === "configuracao" ? $("activitiesSettingsStatus") : $("activitiesStatus");
    if (!box) return;
    box.textContent = message;
    box.classList.toggle("is-error", isError);
  }

  async function loadSettings() {
    state.settings = await api("/configuracao");
    return state.settings;
  }

  /** Atualiza o turno atual (e o exibido, se for outro). Usa a versão para não reler o que não mudou. */
  async function refresh({ force = false } = {}) {
    const currentVersion = force ? "" : state.current?.shift.version || "";
    const current = await api(`/turno?id=atual${currentVersion ? `&versao=${encodeURIComponent(currentVersion)}` : ""}`);
    if (!current.unchanged) state.current = current;
    if (state.viewedId && state.viewedId !== state.current.shift.id) {
      const viewedVersion = force || state.viewed?.shift.id !== state.viewedId ? "" : state.viewed?.shift.version || "";
      const viewed = await api(`/turno?id=${encodeURIComponent(state.viewedId)}${viewedVersion ? `&versao=${encodeURIComponent(viewedVersion)}` : ""}`);
      if (!viewed.unchanged) state.viewed = viewed;
    } else {
      state.viewedId = null;
      state.viewed = state.current;
    }
    if (state.view === "turno") renderShift();
    checkAlerts();
  }

  function schedulePolling() {
    clearTimeout(state.pollTimer);
    const active = state.view === "turno" || alertsEnabled();
    if (!active) return;
    const wait = document.visibilityState === "visible" && state.view === "turno" ? POLL_VISIBLE_MS : POLL_BACKGROUND_MS;
    state.pollTimer = setTimeout(async () => {
      try { await refresh(); } catch { /* tenta de novo na próxima rodada */ }
      schedulePolling();
    }, wait);
  }

  /* ---------- Alertas no computador ---------- */

  const notificationsSupported = () => "Notification" in window;
  const alertsEnabled = () => notificationsSupported() && Notification.permission === "granted" && storage.get(KEYS.alerts) === true;

  async function toggleAlerts() {
    if (!notificationsSupported()) { announce("Este navegador não mostra notificações.", true); return; }
    if (alertsEnabled()) { storage.set(KEYS.alerts, false); renderAlertButton(); schedulePolling(); announce("Alertas desligados neste computador."); return; }
    const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (permission !== "granted") { announce("O navegador bloqueou as notificações. Libere em Configurações do site (cadeado ao lado do endereço).", true); renderAlertButton(); return; }
    storage.set(KEYS.alerts, true);
    renderAlertButton();
    schedulePolling();
    announce("Alertas ligados. Eles aparecem enquanto o painel estiver aberto em alguma aba.");
  }

  function renderAlertButton() {
    const button = $("activitiesAlerts");
    if (!button) return;
    const on = alertsEnabled();
    button.textContent = on ? "Alertas ligados" : "Ativar alertas";
    button.classList.toggle("is-on", on);
    button.setAttribute("aria-pressed", String(on));
    button.title = on ? "Clique para desligar os alertas neste computador" : "Notificar no computador no horário das atividades";
  }

  /** Registra o alerta como enviado; devolve false se outra aba já enviou. */
  function claimAlert(key) {
    const sent = storage.get(KEYS.sent) || {};
    if (sent[key]) return false;
    const cutoff = Date.now() - 3 * 86400000;
    for (const [old, at] of Object.entries(sent)) if (at < cutoff) delete sent[old];
    sent[key] = Date.now();
    storage.set(KEYS.sent, sent);
    return true;
  }

  function notify(task, alert, shiftId) {
    const key = `${shiftId}:${task.id}:${alert.kind}`;
    if (!claimAlert(key)) return;
    const title = alert.kind === "antes" ? `Em ${alert.minutes} min: ${task.title}` : `Agora: ${task.title}`;
    const body = [task.time ? `${task.time} · ${shortLabel(shiftId)}` : shortLabel(shiftId), task.description].filter(Boolean).join("\n");
    try {
      const notification = new Notification(title, { body, tag: key, requireInteraction: true, icon: "/favicon.svg" });
      notification.onclick = () => { window.focus(); window.openActivities?.(); notification.close(); };
    } catch { /* alguns navegadores só notificam via service worker; o destaque em vermelho continua valendo */ }
  }

  /* Uma aba por vez confere os alertas (Web Locks); a marca no localStorage impede repetir em outra aba. */
  function checkAlerts() {
    if (!alertsEnabled() || !state.current) return;
    const run = () => {
      const now = Date.now();
      const shiftId = state.current.shift.id;
      for (const task of state.current.tasks) {
        if (task.status !== "pending") continue;
        for (const alert of S.alertTimes(task)) if (now >= alert.at && now - alert.at < ALERT_GRACE_MS) notify(task, alert, shiftId);
      }
    };
    if (navigator.locks?.request) navigator.locks.request("tps-atividades-alertas", run).catch(run);
    else run();
  }

  /* ---------- Tela do turno ---------- */

  const isOverdue = (task, now = Date.now()) => task.status === "pending" && task.dueAt && Date.parse(task.dueAt) < now;
  const STATUS_TEXT = { pending: "Pendente", done: "Feito", not_done: "Não feito", transferred: "Passou para o turno seguinte" };

  function shiftFlags(data) {
    const shift = data.shift, now = Date.now();
    const started = now >= Date.parse(shift.start);
    const closed = Boolean(shift.handover);
    const isCurrent = shift.id === data.currentShiftId;
    return { started, closed, isCurrent, isFuture: shift.id > data.currentShiftId, editable: started && !closed && !shift.missing, canAdd: shift.id >= data.currentShiftId && !closed };
  }

  /** Responsável da atividade: o atribuído ou, sem atribuição, o escalado do turno. */
  function responsibleHtml(task, shift) {
    const scheduled = shift.scheduled;
    if (!task.assignee) return scheduled?.name ? `Responsável: <strong>${escapeHtml(scheduled.name)}</strong> <span class="act-muted-inline">(escalado)</span>` : "";
    const away = scheduled?.assistantId && task.assignee.id !== scheduled.assistantId;
    return `Responsável: <strong>${escapeHtml(task.assignee.name)}</strong>${away ? ` <span class="act-badge is-warn">não está neste turno · atribua a outra pessoa se precisar</span>` : ""}`;
  }

  function editorHtml(task, shift) {
    const editor = state.editor;
    if (!editor || editor.taskId !== task.id) return "";
    const id = escapeHtml(task.id);
    if (editor.type === "not-done") return `<form class="act-editor" data-form="not-done" data-task="${id}"><label>Por que não foi feita?<input name="reason" maxlength="500" required></label><div class="act-form-buttons"><button type="submit" class="act-button is-primary">Registrar</button><button type="button" class="act-link" data-action="cancel">Cancelar</button></div></form>`;
    if (editor.type === "note") return `<form class="act-editor" data-form="note" data-task="${id}">
      <label>Observação<textarea name="note" maxlength="2000" rows="2">${escapeHtml(task.note || "")}</textarea></label>
      <div class="act-attach">
        <label class="act-button act-attach-button">📎 Anexar imagem ou documento<input type="file" data-action="attach" multiple accept="${ATTACH_ACCEPT}"></label>
        <small class="act-muted">Fotos, PDF, Word, Excel ou texto · até ${ATTACH_MAX_MB} MB cada, ${ATTACH_MAX_FILES} por atividade. Fotos grandes são reduzidas antes de enviar.</small>
        <ul class="act-attach-list" id="activitiesNoteFiles">${noteFilesHtml()}</ul>
      </div>
      <div class="act-form-buttons"><button type="submit" class="act-button is-primary">Salvar observação</button><button type="button" class="act-link" data-action="cancel">Cancelar</button></div>
    </form>`;
    if (editor.type === "assign") {
      const options = (state.settings?.assistants || []).filter(item => item.active !== false).map(item => `<option value="${escapeHtml(item.id)}"${task.assignee?.id === item.id ? " selected" : ""}>${escapeHtml(item.name)}${item.id === shift.scheduled?.assistantId ? " (escalado)" : ""}</option>`).join("");
      return `<form class="act-editor" data-form="assign" data-task="${id}"><label>Atribuir a<select name="assigneeId"><option value="">Escalado do turno${shift.scheduled?.name ? ` (${escapeHtml(shift.scheduled.name)})` : ""}</option>${options}</select></label><div class="act-form-buttons"><button type="submit" class="act-button is-primary">Atribuir</button><button type="button" class="act-link" data-action="cancel">Cancelar</button></div></form>`;
    }
    return "";
  }

  function taskHtml(task, flags, shift) {
    const overdue = isOverdue(task);
    const classes = ["act-task", `is-${task.status}`, overdue ? "is-overdue" : "", task.origin === "carried" ? "is-carried" : ""].filter(Boolean).join(" ");
    const id = escapeHtml(task.id);
    const open = task.status !== "transferred" && flags.canAdd; // turno atual ou futuro, não encerrado
    const meta = [];
    if (task.origin === "carried") meta.push(`<span class="act-badge is-carried">Herdada de ${escapeHtml(shortLabel(task.fromShift))}${task.withoutHandover ? " · sem passagem registrada" : ""}</span>`);
    if (task.pendingFromPrevious) meta.push(`<span class="act-badge is-carried">Ficou pendente também no ${escapeHtml(shortLabel(task.pendingFromPrevious))}</span>`);
    if (task.origin === "adhoc") meta.push(`<span class="act-badge">Incluída por ${escapeHtml(task.createdBy?.name || "")}</span>`);
    if (task.remindBefore) meta.push(`<span class="act-badge">Lembrete ${task.remindBefore} min antes</span>`);
    if (overdue) meta.push(`<span class="act-badge is-late">Atrasada</span>`);
    const result = task.status === "done" ? `Concluída por ${escapeHtml(task.doneBy?.name)} às ${hm(task.doneAt)}`
      : task.status === "not_done" ? `Não feita: ${escapeHtml(task.reason)} (${escapeHtml(task.doneBy?.name)}, ${hm(task.doneAt)})`
      : task.status === "transferred" ? `Passou para ${escapeHtml(shortLabel(task.transferredTo))}` : "";
    const hasNote = Boolean(task.note || task.attachments?.length);
    const editingNote = state.editor?.type === "note" && state.editor.taskId === task.id;
    const note = hasNote && !editingNote
      ? `<div class="act-note">${task.note ? `<strong>Obs.:</strong> <span class="act-note-text">${escapeHtml(task.note)}</span> ` : ""}<small>${escapeHtml(task.noteBy?.name || "")}${task.noteAt ? `, ${dmhm(task.noteAt)}` : ""}</small>${attachmentsHtml(shift.id, task.attachments)}</div>` : "";
    const checkable = flags.editable && (task.status === "pending" || task.status === "done");
    const actions = [];
    if (flags.editable && task.status === "pending") actions.push(`<button type="button" class="act-link" data-action="not-done" data-task="${id}">Não feita</button>`);
    if (flags.editable && task.status === "not_done") actions.push(`<button type="button" class="act-link" data-action="undo" data-task="${id}">Desfazer</button>`);
    if (open) actions.push(`<button type="button" class="act-link" data-action="note" data-task="${id}">${hasNote ? "Editar observação" : "Observação / anexo"}</button>`);
    if (open && task.status === "pending") actions.push(`<button type="button" class="act-link" data-action="assign" data-task="${id}">Atribuir</button>`);
    if (open && task.origin === "adhoc" && task.status === "pending") actions.push(`<button type="button" class="act-link" data-action="remove" data-task="${id}">Excluir</button>`);
    const draggable = flags.canAdd && task.status !== "transferred";
    return `<li class="${classes}" data-id="${id}">
      ${draggable ? `<button type="button" class="act-drag" data-drag="${id}" aria-label="Mover: ${escapeHtml(task.title)} (arraste ou use as setas)" title="Arraste para mudar a ordem"><span aria-hidden="true"></span></button>` : `<span class="act-drag-space" aria-hidden="true"></span>`}
      <label class="act-done" title="${checkable ? "Marcar como concluída" : escapeHtml(STATUS_TEXT[task.status])}"><input type="checkbox" data-action="toggle-done" data-task="${id}"${task.status === "done" ? " checked" : ""}${checkable ? "" : " disabled"} aria-label="Concluída: ${escapeHtml(task.title)}"><span aria-hidden="true"></span></label>
      <span class="act-time">${task.time ? `<small>até</small>${escapeHtml(task.time)}` : "—"}</span>
      <div class="act-body">
        <strong>${escapeHtml(task.title)}</strong>
        ${task.description ? `<p>${escapeHtml(task.description)}</p>` : ""}
        <p class="act-responsible">${responsibleHtml(task, shift)}</p>
        ${meta.length ? `<div class="act-meta">${meta.join("")}</div>` : ""}
        ${result ? `<p class="act-result">${result}</p>` : ""}
        ${note}
        ${editorHtml(task, shift)}
      </div>
      <div class="act-actions">${actions.join("")}</div>
    </li>`;
  }

  function handoverInHtml(data, flags) {
    const previous = data.previous;
    const carried = data.tasks.filter(task => task.origin === "carried");
    if (!previous && !carried.length) return "";
    const shift = data.shift;
    const handover = previous?.handover
      ? `<p class="act-handover-by">Encerrado por <strong>${escapeHtml(previous.handover.by?.name)}</strong> em ${dmhm(previous.handover.at)}</p>${previous.handover.notes ? `<blockquote>${escapeHtml(previous.handover.notes)}</blockquote>` : "<p class=\"act-muted\">Sem observações.</p>"}${attachmentsHtml(previous.id, previous.handover.attachments)}`
      : `<p class="act-warning">Sem passagem registrada: o turno anterior não foi encerrado.${carried.length ? " As pendências vieram automaticamente na virada do turno." : ""}</p>`;
    const pending = carried.length ? `<p><strong>${carried.length}</strong> ${carried.length === 1 ? "pendência herdada, destacada" : "pendências herdadas, destacadas"} na lista abaixo.</p>` : "";
    const received = shift.received
      ? `<p class="act-ok">Recebimento confirmado por ${escapeHtml(shift.received.by?.name)} em ${dmhm(shift.received.at)}.</p>`
      : flags.editable ? `<button type="button" class="act-button is-primary" data-action="receive">Confirmar recebimento</button>` : `<p class="act-muted">Recebimento não confirmado.</p>`;
    return `<section class="act-card act-handover-in${shift.received ? "" : " is-attention"}">
      <div class="act-card-head"><p class="eyebrow">PASSAGEM RECEBIDA</p><h3>${escapeHtml(previous ? previous.label : "Turno anterior")}</h3></div>
      ${handover}${pending}${received}
    </section>`;
  }

  /** Última linha da lista: "+" abre a inclusão de uma atividade neste turno. */
  function addRowHtml(data) {
    if (state.editor?.type !== "add") return `<li class="act-add-row"><button type="button" class="act-plus" data-action="add" aria-label="Adicionar atividade neste turno" title="Adicionar atividade neste turno">+</button><span>Adicionar atividade</span></li>`;
    const options = (state.settings?.assistants || []).filter(item => item.active !== false).map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join("");
    return `<li class="act-add-row is-open"><form data-form="add" class="act-form act-editor">
      <label class="is-wide">Atividade<input name="title" maxlength="120" required placeholder="O que precisa ser feito"></label>
      <label>Até (horário, opcional)<input name="time" type="time"></label>
      <label>Lembrar antes (min)<input name="remindBefore" type="number" min="0" max="240" step="5" value="0"></label>
      <label>Responsável<select name="assigneeId"><option value="">Escalado do turno${data.shift.scheduled?.name ? ` (${escapeHtml(data.shift.scheduled.name)})` : ""}</option>${options}</select></label>
      <label class="is-wide">Detalhes (opcional)<textarea name="description" maxlength="1000" rows="2"></textarea></label>
      <div class="is-wide act-form-buttons"><button type="submit" class="act-button is-primary">Adicionar</button><button type="button" class="act-link" data-action="cancel">Cancelar</button></div>
    </form></li>`;
  }

  function closeHtml(data, flags) {
    const shift = data.shift;
    if (shift.handover) return `<section class="act-card act-closed"><div class="act-card-head act-list-head"><div><p class="eyebrow">PASSAGEM DE SERVIÇO</p><h3>Turno encerrado</h3></div>${downloadButtonsHtml(shift.id)}</div>
      <p>Encerrado por <strong>${escapeHtml(shift.handover.by?.name)}</strong> em ${dmhm(shift.handover.at)}.</p>${shift.handover.notes ? `<blockquote>${escapeHtml(shift.handover.notes)}</blockquote>` : ""}${attachmentsHtml(shift.id, shift.handover.attachments)}</section>`;
    if (!flags.editable) return "";
    const pending = data.tasks.filter(task => task.status === "pending").length;
    return `<details class="act-card act-close" data-key="close">
      <summary>Encerrar turno e passar o serviço</summary>
      <form data-form="close" class="act-form">
        <label class="is-wide">Observações para quem assume<textarea name="notes" maxlength="4000" rows="4" placeholder="Situação dos navios, o que ficou em andamento, recados…"></textarea></label>
        <p class="is-wide act-muted">${pending ? `${pending} ${pending === 1 ? "pendência passa" : "pendências passam"} para o ${escapeHtml(S.label(S.next(shift.id)))}.` : "Nenhuma pendência: tudo foi tratado."}</p>
        <button type="submit" class="act-button is-primary">Encerrar turno</button>
      </form>
    </details>`;
  }

  /* ---------- Anexos das observações ---------- */

  const ATTACH_MAX_MB = 5;
  const ATTACH_MAX_FILES = 8;
  const ATTACH_ACCEPT = "image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.csv";
  /** Fotos acima disso são reduzidas (lado maior 2000 px, JPEG) antes do envio. */
  const SHRINK_ABOVE_BYTES = 1.5 * 1024 * 1024;
  /** O arquivo fica no turno em que foi enviado (file.shift); atividades herdadas levam o anexo junto. */
  const attachmentUrl = (shiftId, file, download = false) => `/api/atividades/anexo?turno=${encodeURIComponent(file.shift || shiftId)}&id=${encodeURIComponent(file.id)}${download ? "&baixar=1" : ""}`;
  const fileSize = bytes => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const isImage = file => String(file.type || "").startsWith("image/");

  function attachmentsHtml(shiftId, list) {
    if (!list?.length) return "";
    const images = list.filter(isImage), documents = list.filter(file => !isImage(file));
    return `<div class="act-attachments">
      ${images.length ? `<div class="act-thumbs">${images.map(file => `<a href="${attachmentUrl(shiftId, file)}" target="_blank" rel="noopener" title="${escapeHtml(file.name)}"><img src="${attachmentUrl(shiftId, file)}" alt="${escapeHtml(file.name)}" loading="lazy"></a>`).join("")}</div>` : ""}
      ${documents.length ? `<ul class="act-docs">${documents.map(file => `<li><a href="${attachmentUrl(shiftId, file, true)}">${escapeHtml(file.name)}</a> <small>${escapeHtml(file.kind || "")} · ${fileSize(file.size)}</small></li>`).join("")}</ul>` : ""}
    </div>`;
  }

  /** Anexos do editor de observação aberto (os que a atividade já tinha + os enviados agora). */
  function noteFilesHtml() {
    return state.noteFiles.map(file => file.uploading
      ? `<li class="is-uploading">${escapeHtml(file.name)} <small>enviando…</small></li>`
      : `<li>${isImage(file) ? "🖼" : "📄"} ${escapeHtml(file.name)} <small>${fileSize(file.size)}</small> <button type="button" class="act-link" data-action="unattach" data-file="${escapeHtml(file.id)}" aria-label="Tirar ${escapeHtml(file.name)}">Tirar</button></li>`).join("");
  }
  function renderNoteFiles() {
    const list = $("activitiesNoteFiles");
    if (list) list.innerHTML = noteFilesHtml();
  }

  /** Reduz fotos grandes no navegador: o envio fica rápido e cabe no limite do servidor. */
  async function prepareFile(file) {
    if (!isImage(file) || file.type === "image/gif" || file.size <= SHRINK_ABOVE_BYTES || !window.createImageBitmap) return file;
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.85));
      return blob ? new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" }) : file;
    } catch {
      return file;
    }
  }

  async function uploadFiles(input) {
    const shiftId = state.viewed.shift.id;
    const actor = requireIdentity(shiftId);
    const chosen = [...input.files];
    input.value = "";
    if (!actor || !chosen.length) return;
    const list = state.noteFiles;
    if (list.length + chosen.length > ATTACH_MAX_FILES) { announce(`Anexe até ${ATTACH_MAX_FILES} arquivos por atividade.`, true); return; }
    for (const original of chosen) {
      const placeholder = { id: `tmp-${Math.random()}`, name: original.name, uploading: true };
      list.push(placeholder);
      renderNoteFiles();
      try {
        const file = await prepareFile(original);
        if (file.size > ATTACH_MAX_MB * 1048576) throw new Error(`"${original.name}" passa de ${ATTACH_MAX_MB} MB.`);
        const response = await fetch(`/api/atividades/anexo?turno=${encodeURIComponent(shiftId)}`, {
          method: "POST", body: file,
          headers: { "Content-Type": file.type || "application/octet-stream", "X-Arquivo": encodeURIComponent(file.name) }
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Não foi possível enviar o arquivo.");
        list.splice(list.indexOf(placeholder), 1, data);
        announce(`Anexado: ${data.name}.`);
      } catch (error) {
        list.splice(list.indexOf(placeholder), 1);
        announce(error.message, true);
      }
      renderNoteFiles();
    }
  }

  /* ---------- Passagem em PDF ou JPG ---------- */

  function downloadButtonsHtml(shiftId) {
    return `<div class="act-download" role="group" aria-label="Baixar a passagem de serviço"><span>Baixar</span><button type="button" class="act-button" data-download="pdf" data-shift="${escapeHtml(shiftId)}">PDF</button><button type="button" class="act-button" data-download="jpg" data-shift="${escapeHtml(shiftId)}">JPG</button></div>`;
  }

  function loadLibrary(url, globalName) {
    if (window[globalName]) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = url;
      script.onload = () => window[globalName] ? resolve() : reject(new Error("Biblioteca indisponível."));
      script.onerror = () => reject(new Error("Não foi possível carregar o gerador de arquivos. Verifique a conexão."));
      document.head.appendChild(script);
    });
  }

  /** Folha A4 (retrato) com a passagem: cabeçalho, observações, anexos e a lista com situação de cada atividade. */
  function reportElement({ shift, tasks, received }) {
    const sheet = document.createElement("article");
    sheet.className = "act-report";
    // Imagens anexadas às observações das atividades vão para o fim da folha, com o nome da atividade.
    const images = tasks.flatMap(task => (task.attachments || []).filter(isImage).map(file => ({ file, task })));
    const docsOf = task => (task.attachments || []).filter(file => !isImage(file));
    const statusCell = task => task.status === "done" ? "✔ Concluída" : task.status === "not_done" ? `✖ Não feita: ${escapeHtml(task.reason)}` : task.status === "transferred" ? `→ Passou para ${escapeHtml(shortLabel(task.transferredTo))}` : "Pendente";
    sheet.innerHTML = `
      <header><img src="/logo-triunfo-horizontal-cor.svg" alt="Triunfo Logística"><div><small>PASSAGEM DE SERVIÇO</small><h1>${escapeHtml(shift.label)}</h1><p>${hm(shift.start)}–${hm(shift.end)} · Escalado: ${escapeHtml(shift.scheduled?.name || "—")}</p></div></header>
      <section class="act-report-facts">
        <p><b>Encerrado por</b> ${escapeHtml(shift.handover.by?.name)} em ${dmhm(shift.handover.at)}</p>
        <p><b>Recebimento</b> ${received ? `${escapeHtml(received.by?.name)} em ${dmhm(received.at)}` : "não confirmado"}</p>
      </section>
      <h2>Observações</h2>
      <p class="act-report-notes">${escapeHtml(shift.handover.notes || "Sem observações.")}</p>

      <h2>Atividades</h2>
      <table><thead><tr><th>Até</th><th>Atividade</th><th>Situação</th><th>Responsável / quem fez</th><th>Observação</th></tr></thead><tbody>
        ${tasks.map(task => `<tr><td>${task.time || "—"}</td><td>${escapeHtml(task.title)}</td><td>${statusCell(task)}</td><td>${escapeHtml(task.assignee?.name || shift.scheduled?.name || "")}${task.doneBy ? `<br><small>${escapeHtml(task.doneBy.name)}, ${dmhm(task.doneAt)}</small>` : ""}</td><td>${escapeHtml(task.note || "")}${docsOf(task).map(file => `<br><small>📄 ${escapeHtml(file.name)}</small>`).join("")}${(task.attachments || []).some(isImage) ? `<br><small>🖼 imagem no fim da folha</small>` : ""}</td></tr>`).join("")}
      </tbody></table>
      ${images.length ? `<h2>Imagens anexadas</h2><div class="act-report-images">${images.map(({ file, task }) => `<figure><img src="${attachmentUrl(shift.id, file)}" alt=""><figcaption>${escapeHtml(task.title)} · ${escapeHtml(file.name)}</figcaption></figure>`).join("")}</div>` : ""}
      <footer>Gerado em ${dmhm(new Date().toISOString())} · Painel de Operações Triunfo Logística</footer>`;
    return sheet;
  }

  async function downloadHandover(shiftId, format, button) {
    const source = state.viewed?.shift.id === shiftId ? { shift: state.viewed.shift, tasks: state.viewed.tasks, received: state.viewed.next?.received }
      : (() => { const row = state.historyRows.find(item => item.id === shiftId); return row && { shift: row, tasks: row.tasks, received: state.historyRows.find(item => item.id === S.next(shiftId))?.received }; })();
    if (!source?.shift.handover) { announce("Só dá para baixar a passagem de um turno encerrado.", true); return; }
    button.disabled = true;
    announce("Gerando o arquivo…");
    const stage = document.createElement("div");
    stage.className = "act-report-stage";
    stage.appendChild(reportElement(source));
    document.body.appendChild(stage);
    try {
      await loadLibrary("vendor/html2canvas.min.js", "html2canvas");
      if (format === "pdf") await loadLibrary("vendor/jspdf.umd.min.js", "jspdf");
      await Promise.all([...stage.querySelectorAll("img")].map(img => img.decode().catch(() => img.remove())));
      const canvas = await window.html2canvas(stage.firstElementChild, { scale: 2, backgroundColor: "#ffffff", useCORS: true, logging: false });
      const name = `passagem-de-servico_${S.parseId(shiftId).date}_${S.parseId(shiftId).kind === "D" ? "diurno" : "noturno"}`;
      const blob = format === "pdf" ? pdfFromCanvas(canvas) : await new Promise((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error("Não foi possível gerar a imagem.")), "image/jpeg", 0.92));
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `${name}.${format}`;
      document.body.appendChild(link);
      link.click();
      setTimeout(() => { URL.revokeObjectURL(link.href); link.remove(); }, 1000);
      announce(`Passagem baixada em ${format.toUpperCase()}.`);
    } catch (error) {
      announce(error.message || "Não foi possível gerar o arquivo.", true);
    } finally {
      stage.remove();
      button.disabled = false;
    }
  }

  /** A4 retrato; a imagem da folha é fatiada em páginas quando passa de uma. */
  function pdfFromCanvas(canvas) {
    const pdf = new window.jspdf.jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
    const pageWidth = 210, pageHeight = 297, margin = 10;
    const width = pageWidth - margin * 2;
    const sliceHeight = Math.floor(canvas.width * (pageHeight - margin * 2) / width);
    for (let top = 0, page = 0; top < canvas.height; top += sliceHeight, page++) {
      const slice = document.createElement("canvas");
      slice.width = canvas.width; slice.height = Math.min(sliceHeight, canvas.height - top);
      slice.getContext("2d").drawImage(canvas, 0, top, canvas.width, slice.height, 0, 0, canvas.width, slice.height);
      if (page) pdf.addPage();
      pdf.addImage(slice.toDataURL("image/jpeg", 0.92), "JPEG", margin, margin, width, slice.height * width / canvas.width);
    }
    return pdf.output("blob");
  }

  /* ---------- Ordem da lista (arrastar com o mouse ou setas no teclado) ---------- */

  const listOrder = list => [...list.querySelectorAll(".act-task[data-id]")].map(item => item.dataset.id);

  function saveOrder(list, before) {
    const order = listOrder(list);
    if (order.join() === before.join()) return;
    const shiftId = state.viewed.shift.id;
    const actor = requireIdentity(shiftId);
    if (!actor) { renderShift(); return; }
    act(() => api("/turno/ordem", { shiftId, order, actor }), "Ordem salva. As atividades fixas seguem essa ordem nos próximos turnos.");
  }

  /**
   * Arrastar pela alça (seis pontinhos) com mouse, caneta ou dedo (eventos de ponteiro, sem o arrastar nativo do navegador,
   * que falha em telas de toque e em alguns navegadores embutidos). A linha acompanha o ponteiro e as outras
   * abrem espaço; ao soltar, a ordem é salva.
   */
  function setupDrag(box) {
    let drag = null;
    const sibling = element => element?.matches(".act-task[data-id]") ? element : null;
    // A própria linha nunca sai do lugar na página (isso faria o navegador soltar o arraste): são as vizinhas que trocam de lado.
    const move = event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      event.preventDefault();
      const { item, list } = drag;
      item.style.transform = "";
      for (let moved = true; moved;) {
        moved = false;
        const previous = sibling(item.previousElementSibling), next = sibling(item.nextElementSibling);
        if (previous && event.clientY < previous.getBoundingClientRect().top + previous.offsetHeight / 2) {
          drag.startY -= previous.offsetHeight;
          list.insertBefore(previous, item.nextSibling);
          moved = true;
        } else if (next && event.clientY > next.getBoundingClientRect().top + next.offsetHeight / 2) {
          drag.startY += next.offsetHeight;
          list.insertBefore(next, item);
          moved = true;
        }
      }
      const height = item.offsetHeight;
      item.style.transform = `translateY(${Math.max(-height, Math.min(height, event.clientY - drag.startY))}px)`;
    };
    const finish = event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const { item, list, before } = drag;
      item.classList.remove("is-dragging");
      item.style.transform = "";
      list.classList.remove("is-sorting");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      drag = null;
      state.dragging = null;
      saveOrder(list, before);
    };
    box.addEventListener("pointerdown", event => {
      const handle = event.target.closest(".act-drag");
      if (!handle || event.button > 0 || drag) return;
      event.preventDefault();
      const item = handle.closest(".act-task"), list = item.parentElement;
      drag = { item, list, pointerId: event.pointerId, before: listOrder(list), startY: event.clientY };
      state.dragging = item.dataset.id;
      item.classList.add("is-dragging");
      list.classList.add("is-sorting");
      window.addEventListener("pointermove", move, { passive: false });
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    });
    // Teclado: foco na alça e setas para cima/baixo.
    box.addEventListener("keydown", event => {
      const handle = event.target.closest(".act-drag");
      if (!handle || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault();
      const item = handle.closest(".act-task"), list = item.parentElement;
      const start = listOrder(list);
      const sibling = event.key === "ArrowUp" ? item.previousElementSibling : item.nextElementSibling;
      if (!sibling?.matches(".act-task[data-id]")) return;
      event.key === "ArrowUp" ? list.insertBefore(item, sibling) : list.insertBefore(sibling, item);
      handle.focus();
      clearTimeout(state.orderTimer);
      state.keyboardOrderStart ||= start;
      state.orderTimer = setTimeout(() => { saveOrder(list, state.keyboardOrderStart); state.keyboardOrderStart = null; }, 900);
    });
  }

  function renderShift() {
    const box = $("activitiesShift");
    const data = state.viewed;
    if (!box || !data) return;
    const flags = shiftFlags(data);
    const shift = data.shift;
    const scheduled = scheduledHtml(shift.scheduled);
    const tag = flags.isCurrent ? "TURNO ATUAL" : flags.isFuture ? "TURNO FUTURO" : "TURNO ANTERIOR";
    const done = data.tasks.filter(task => task.status === "done").length;
    const counted = data.tasks.filter(task => task.status !== "transferred").length;
    const late = data.tasks.filter(task => isOverdue(task)).length;
    const rows = data.tasks.map(task => taskHtml(task, flags, shift)).join("") + (flags.canAdd ? addRowHtml(data) : "");
    const list = rows
      ? `<ul class="act-tasks">${rows}</ul>`
      : `<p class="act-empty">${shift.missing ? "Este turno não teve registro no painel." : "Nenhuma atividade neste turno."}</p>`;
    // Não redesenha enquanto a pessoa digita, escolhe uma data ou arrasta uma atividade.
    if (state.dragging || document.activeElement?.closest?.("#activitiesShift form, #activitiesShift .act-pick")) return;
    const openDetails = [...box.querySelectorAll("details[open][data-key]")].map(item => item.dataset.key);
    box.innerHTML = `
      <div class="act-shiftbar">
        <button type="button" class="act-nav" data-action="previous" aria-label="Turno anterior">‹</button>
        <div class="act-shift-title">
          <p class="eyebrow">${tag}</p>
          <h3>${escapeHtml(shift.label)}</h3>
          <p>${hm(shift.start)}–${hm(shift.end)} · Escalado: ${scheduled}</p>
        </div>
        <button type="button" class="act-nav" data-action="next" aria-label="Próximo turno">›</button>
        <div class="act-pick" role="group" aria-label="Ver outro turno">
          <label>Ver o dia<input type="date" data-pick="date" value="${shift.date}"></label>
          <label>Turno<select data-pick="kind"><option value="D"${shift.kind === "D" ? " selected" : ""}>Diurno</option><option value="N"${shift.kind === "N" ? " selected" : ""}>Noturno</option></select></label>
          ${flags.isCurrent ? "" : `<button type="button" class="act-link" data-action="current">Voltar ao turno atual</button>`}
        </div>
      </div>
      ${flags.isCurrent ? identityHtml() : ""}
      ${handoverInHtml(data, flags)}
      <section class="act-card">
        <div class="act-card-head act-list-head"><div><p class="eyebrow">ATIVIDADES</p><h3>${counted ? `${done} de ${counted} feitas` : "Lista do turno"}</h3></div><div class="act-list-tools">${late ? `<span class="act-badge is-late">${late} ${late === 1 ? "atrasada" : "atrasadas"}</span>` : ""}${flags.canAdd && data.tasks.length > 1 ? `<span class="act-sort-hint">Arraste pela alça <span class="act-grip-icon" aria-hidden="true"></span> para mudar a ordem</span>` : ""}</div></div>
        ${list}
      </section>
      ${closeHtml(data, flags)}`;
    openDetails.forEach(key => box.querySelector(`details[data-key="${key}"]`)?.setAttribute("open", ""));
  }

  async function act(run, success) {
    if (state.busy) return;
    state.busy = true;
    try {
      await run();
      if (success) announce(success);
      await refresh({ force: true });
    } catch (error) {
      announce(error.message, true);
    } finally {
      state.busy = false;
    }
  }

  /** Abre um editor na lista (motivo, observação, responsável ou inclusão); só um por vez. */
  function openEditor(type, taskId = null) {
    state.editor = type ? { type, taskId } : null;
    const task = state.viewed?.tasks.find(item => item.id === taskId);
    state.noteFiles = type === "note" && task ? (task.attachments || []).map(file => ({ ...file })) : [];
    document.activeElement?.blur();
    renderShift();
    $("activitiesShift").querySelector(".act-editor textarea, .act-editor input:not([type=hidden]), .act-editor select")?.focus();
  }

  function onShiftClick(event) {
    const download = event.target.closest("button[data-download]");
    if (download) { downloadHandover(download.dataset.shift, download.dataset.download, download); return; }
    const button = event.target.closest("button[data-action]");
    if (!button || !state.viewed) return;
    const shiftId = state.viewed.shift.id;
    const taskId = button.dataset.task;
    const action = button.dataset.action;
    if (action === "previous" || action === "next") {
      state.viewedId = action === "previous" ? S.previous(shiftId) : S.next(shiftId);
      state.editor = null;
      announce("Carregando turno…");
      refresh().then(() => announce("")).catch(error => announce(error.message, true));
      return;
    }
    if (action === "current") { state.viewedId = null; state.editor = null; refresh().catch(error => announce(error.message, true)); return; }
    if (["not-done", "note", "assign", "add"].includes(action)) { openEditor(action, taskId); return; }
    if (action === "cancel") { openEditor(null); return; }
    if (action === "unattach") { state.noteFiles = state.noteFiles.filter(file => file.id !== button.dataset.file); renderNoteFiles(); return; }
    const actor = requireIdentity(shiftId);
    if (!actor) return;
    if (action === "undo") act(() => api("/tarefa/situacao", { shiftId, taskId, status: "pending", actor }), "Atividade voltou para pendente.");
    if (action === "remove" && confirm("Excluir esta atividade?")) act(() => api("/tarefa/excluir", { shiftId, taskId, actor }), "Atividade excluída.");
    if (action === "receive") act(() => api("/receber", { shiftId, actor }), "Recebimento confirmado.");
  }

  function onShiftSubmit(event) {
    const form = event.target.closest("form[data-form]");
    if (!form) return;
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const shiftId = state.viewed.shift.id;
    const actor = requireIdentity(shiftId);
    if (!actor) return;
    const taskId = form.dataset.task;
    const close = () => { state.editor = null; document.activeElement?.blur(); };
    if (form.dataset.form === "not-done") { close(); act(() => api("/tarefa/situacao", { shiftId, taskId, status: "not_done", reason: data.reason, actor }), "Registrado como não feita."); }
    if (form.dataset.form === "note") {
      if (state.noteFiles.some(file => file.uploading)) { announce("Aguarde o envio dos anexos terminar.", true); return; }
      const attachments = state.noteFiles.map(file => ({ id: file.id, shift: file.shift || shiftId }));
      close();
      act(() => api("/tarefa/observacao", { shiftId, taskId, note: data.note, attachments, actor }), data.note.trim() || attachments.length ? "Observação salva." : "Observação apagada.");
    }
    if (form.dataset.form === "assign") { close(); act(() => api("/tarefa/responsavel", { shiftId, taskId, assigneeId: data.assigneeId || null, actor }), "Responsável atualizado."); }
    if (form.dataset.form === "add") { close(); act(() => api("/tarefa", { ...data, shiftId, actor }), `Atividade incluída no ${S.label(shiftId)}.`); }
    if (form.dataset.form === "close") {
      const pending = state.viewed.tasks.filter(task => task.status === "pending").length;
      if (!confirm(pending ? `Encerrar o turno? ${pending} ${pending === 1 ? "pendência passa" : "pendências passam"} para o turno seguinte.` : "Encerrar o turno?")) return;
      document.activeElement?.blur();
      act(() => api("/encerrar", { shiftId, notes: data.notes, actor }), "Turno encerrado. A passagem ficou registrada para quem assume.");
    }
  }

  /** Caixa de seleção: marca como concluída ou volta para pendente. */
  function onShiftChange(event) {
    if (event.target.dataset.action === "attach") { uploadFiles(event.target); return; }
    if (event.target.dataset.pick) {
      const bar = event.target.closest(".act-pick");
      const date = bar.querySelector("[data-pick=date]").value, kind = bar.querySelector("[data-pick=kind]").value;
      if (!S.isDate(date)) return;
      state.viewedId = S.makeId(date, kind);
      state.editor = null;
      event.target.blur();
      announce("Carregando turno…");
      refresh().then(() => announce("")).catch(error => announce(error.message, true));
      return;
    }
    if (event.target.dataset.action !== "toggle-done") return;
    const box = event.target;
    const actor = requireIdentity(state.viewed.shift.id);
    if (!actor) { box.checked = !box.checked; return; }
    const status = box.checked ? "done" : "pending";
    act(() => api("/tarefa/situacao", { shiftId: state.viewed.shift.id, taskId: box.dataset.task, status, actor }), status === "done" ? "Atividade concluída." : "Atividade voltou para pendente.");
  }

  /* ---------- Acompanhamento ---------- */

  function historyShiftHtml(shift) {
    const count = status => shift.tasks.filter(task => task.status === status).length;
    const chips = [["done", "feita", "feitas"], ["not_done", "não feita", "não feitas"], ["pending", "pendente", "pendentes"], ["transferred", "passou adiante", "passaram adiante"]]
      .map(([status, one, many]) => count(status) ? `<span class="act-chip is-${status}">${count(status)} ${count(status) === 1 ? one : many}</span>` : "").join("");
    const handover = shift.handover
      ? `Passagem por <strong>${escapeHtml(shift.handover.by?.name)}</strong> em ${dmhm(shift.handover.at)}${shift.handover.notes ? `<blockquote>${escapeHtml(shift.handover.notes)}</blockquote>` : ""}${attachmentsHtml(shift.id, shift.handover.attachments)}`
      : `<span class="act-warning">Sem passagem registrada</span>`;
    const received = shift.received ? `Recebido por <strong>${escapeHtml(shift.received.by?.name)}</strong> em ${dmhm(shift.received.at)}` : "Recebimento não confirmado";
    const rows = shift.tasks.map(task => `<tr class="is-${task.status}"><td>${task.time || "—"}</td><td>${escapeHtml(task.title)}${task.origin === "carried" ? ` <span class="act-badge is-carried">herdada</span>` : ""}</td><td>${STATUS_TEXT[task.status]}${task.reason ? `: ${escapeHtml(task.reason)}` : ""}</td><td>${escapeHtml(task.doneBy?.name || "")}${task.doneAt ? ` · ${dmhm(task.doneAt)}` : ""}</td><td>${escapeHtml(task.note || "")}${attachmentsHtml(shift.id, task.attachments)}</td></tr>`).join("");
    return `<article class="base-sheet act-history-shift">
      <div class="base-sheet-head"><div><p class="eyebrow">${escapeHtml(shift.kind === "D" ? "DIURNO" : "NOTURNO")}</p><h3>${escapeHtml(shift.label)}</h3></div><span>Escalado: ${escapeHtml(shift.scheduled?.name || "—")}${shift.handover ? downloadButtonsHtml(shift.id) : ""}</span></div>
      <div class="act-chips">${chips || `<span class="act-muted">Sem atividades</span>`}</div>
      <div class="act-history-handover"><p>${handover}</p><p>${received}</p></div>
      ${rows ? `<details><summary>Ver atividades (${shift.tasks.length})</summary><div class="base-table-scroll"><table class="base-table act-table"><thead><tr><th>Até</th><th>Atividade</th><th>Situação</th><th>Quem / quando</th><th>Observação</th></tr></thead><tbody>${rows}</tbody></table></div></details>` : ""}
    </article>`;
  }

  async function loadHistory() {
    const from = $("activitiesFrom").value, to = $("activitiesTo").value, who = $("activitiesWho").value;
    announce("Carregando…");
    try {
      const { shifts } = await api(`/historico?de=${from}&ate=${to}${who ? `&assistente=${encodeURIComponent(who)}` : ""}`);
      state.historyRows = shifts.slice();
      $("activitiesExport").disabled = !shifts.length;
      $("activitiesHistory").innerHTML = shifts.length ? shifts.reverse().map(historyShiftHtml).join("") : `<p class="act-empty">Nenhum turno registrado no período.</p>`;
      announce(`${shifts.length} ${shifts.length === 1 ? "turno" : "turnos"} no período.`);
    } catch (error) {
      announce(error.message, true);
    }
  }

  /** Excel do período filtrado: uma aba com os turnos (passagem e totais) e outra com cada atividade. */
  function exportHistory() {
    const rows = state.historyRows;
    if (!rows.length || !window.XLSX) return;
    const when = value => value ? dmhm(value) : "";
    const shifts = rows.map(shift => {
      const count = status => shift.tasks.filter(task => task.status === status).length;
      return {
        Turno: shift.label, Data: brDate(shift.date), Escalado: shift.scheduled?.name || "",
        Atividades: shift.tasks.length, Feitas: count("done"), "Não feitas": count("not_done"), Pendentes: count("pending"), "Passaram adiante": count("transferred"),
        "Encerrado por": shift.handover?.by?.name || "", "Encerrado em": when(shift.handover?.at), "Observações da passagem": shift.handover?.notes || "",
        "Recebido por": shift.received?.by?.name || "", "Recebido em": when(shift.received?.at)
      };
    });
    const tasks = rows.flatMap(shift => shift.tasks.map(task => ({
      Turno: shift.label, Data: brDate(shift.date), "Até": task.dueAt ? hm(task.dueAt) : "", Atividade: task.title,
      Origem: task.origin === "carried" ? "Herdada" : task.origin === "template" ? "Fixa" : "Incluída",
      "Responsável": task.assignee?.name || shift.scheduled?.name || "", "Situação": STATUS_TEXT[task.status] || task.status,
      Motivo: task.reason || "", "Registrado por": task.doneBy?.name || "", "Registrado em": when(task.doneAt),
      "Observação": task.note || "", Anexos: (task.attachments || []).length || ""
    })));
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(shifts), "Turnos");
    XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(tasks), "Atividades");
    XLSX.writeFile(book, `atividades-${$("activitiesFrom").value}-a-${$("activitiesTo").value}.xlsx`);
  }

  function setupHistoryFilters() {
    const today = S.zonedParts(new Date()).date;
    if (!$("activitiesFrom").value) { $("activitiesFrom").value = S.addDays(today, -2); $("activitiesTo").value = today; }
    const select = $("activitiesWho");
    const current = select.value;
    select.innerHTML = `<option value="">Todos</option>${(state.settings?.assistants || []).map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join("")}`;
    select.value = current;
  }

  /* ---------- Configuração ---------- */

  const assistantOptions = (selected, { blank = false } = {}) => `${blank ? `<option value="">—</option>` : ""}${(state.settings.assistants || []).map(item => `<option value="${escapeHtml(item.id)}"${item.id === selected ? " selected" : ""}>${escapeHtml(item.name)}${item.active === false ? " (inativo)" : ""}</option>`).join("")}`;
  const nameOf = id => state.settings.assistants.find(item => item.id === id)?.name || "—";
  const daysText = weekdays => !weekdays?.length ? "Todos os dias" : weekdays.map(day => S.WEEKDAYS[day]).join(", ");
  const shiftText = { D: "Diurno", N: "Noturno", both: "Os dois turnos" };

  function scheduleFromForm(form) {
    const data = new FormData(form);
    const rotation = kind => ({ members: [data.get(`${kind}1`), data.get(`${kind}2`)].filter(Boolean), blockDays: Number(data.get(`${kind}Block`)), referenceDate: data.get(`${kind}Reference`) });
    return { hours: { dayStart: data.get("dayStart"), nightStart: data.get("nightStart") }, rotations: { D: rotation("D"), N: rotation("N") } };
  }

  /** Próximos 14 dias como o servidor calcula para os turnos (equipe de plantão, coberturas, ajustes ou rodízio). */
  function previewHtml() {
    const today = S.zonedParts(new Date()).date;
    const mark = slot => slot.source === "ajuste" ? " *" : slot.source === "cobertura" ? " ↺" : slot.absent ? " !" : "";
    const cell = slot => `${escapeHtml(slot.name || "—")}${slot.team ? ` <small>${escapeHtml(slot.team)}</small>` : ""}${slot.dayOfBlock ? ` <small>${slot.dayOfBlock}º</small>` : ""}${mark(slot)}`;
    const rows = (state.settings.preview || []).map(({ date, D, N }) => `<tr${date === today ? ` class="is-today"` : ""}><td>${brDate(date).slice(0, 5)} ${S.WEEKDAYS[S.weekday(date)]}</td><td title="${escapeHtml(D.reason || "")}">${cell(D)}</td><td title="${escapeHtml(N.reason || "")}">${cell(N)}</td></tr>`).join("");
    return `<table class="base-table act-table"><thead><tr><th>Dia</th><th>Diurno</th><th>Noturno</th></tr></thead><tbody>${rows}</tbody></table><p class="act-muted">Letra = equipe de plantão; número = dia do plantão. * ajuste pontual · ↺ cobrindo férias · ! assistente fora sem cobertura (passe o mouse para ver).</p>`;
  }

  /** Escalado no cabeçalho do turno: nome, equipe, dia do plantão e avisos (ajuste, cobertura, ausência). */
  function scheduledHtml(slot) {
    if (!slot?.name) return slot?.reason ? `<span class="act-badge is-late">${escapeHtml(slot.reason)}</span>` : "Sem escala definida";
    return `${escapeHtml(slot.name)}${slot.team ? ` · Equipe ${escapeHtml(slot.team)}` : ""}${slot.dayOfBlock ? ` (${slot.dayOfBlock}º dia)` : ""}`
      + (slot.source === "ajuste" ? ` <span class="act-badge">Ajuste: ${escapeHtml(slot.reason)}</span>` : "")
      + (slot.source === "cobertura" ? ` <span class="act-badge is-carried">${escapeHtml(slot.reason)}</span>` : "")
      + (slot.absent ? ` <span class="act-badge is-late">${escapeHtml(slot.reason)}</span>` : "");
  }

  function templateFormHtml(template = null) {
    const t = template || { shift: "N", weekdays: [], remindBefore: 0 };
    const days = S.WEEKDAYS.map((day, index) => `<label class="act-day"><input type="checkbox" name="weekdays" value="${index}"${!t.weekdays?.length || t.weekdays.includes(index) ? " checked" : ""}>${day}</label>`).join("");
    return `<form data-form="template" class="act-form">
      <label class="is-wide">Título<input name="title" maxlength="120" required value="${escapeHtml(t.title || "")}"></label>
      <label class="is-wide">Descrição (opcional)<textarea name="description" maxlength="1000" rows="2">${escapeHtml(t.description || "")}</textarea></label>
      <label>Turno<select name="shift">${Object.entries(shiftText).map(([value, text]) => `<option value="${value}"${t.shift === value ? " selected" : ""}>${text}</option>`).join("")}</select></label>
      <label>Horário (opcional)<input name="time" type="time" value="${escapeHtml(t.time || "")}"></label>
      <label>Lembrar antes (min)<input name="remindBefore" type="number" min="0" max="240" step="5" value="${t.remindBefore || 0}"></label>
      <label>Responsável fixo (opcional)<select name="assigneeId"><option value="">Escalado do turno</option>${assistantOptions(t.assigneeId || null)}</select></label>
      <fieldset class="is-wide act-days"><legend>Dias (pela data de início do turno)</legend>${days}</fieldset>
      <p class="is-wide act-muted">Vale a partir do turno atual. Turnos já encerrados não mudam.</p>
      <div class="is-wide act-form-buttons"><button type="submit" class="act-button is-primary">${template ? "Salvar alterações" : "Incluir modelo"}</button>${template ? `<button type="button" class="act-link" data-action="cancel-template">Cancelar edição</button>` : ""}</div>
    </form>`;
  }

  function renderSettings() {
    const box = $("activitiesSettings");
    if (!box || !state.settings) return;
    if (document.activeElement?.closest?.("#activitiesSettings form")) return;
    const { config, assistants, templates, overrides } = state.settings;
    const rotationFields = kind => {
      const r = config.rotations[kind];
      return `<fieldset class="act-rotation"><legend>${S.KINDS[kind]}</legend>
        <label>1º do rodízio<select name="${kind}1">${assistantOptions(r.members[0])}</select></label>
        <label>2º do rodízio<select name="${kind}2">${assistantOptions(r.members[1], { blank: true })}</select></label>
        <label>Dias seguidos<input name="${kind}Block" type="number" min="1" max="7" value="${r.blockDays}"></label>
        <label>1º dia do 1º<input name="${kind}Reference" type="date" value="${r.referenceDate}"></label>
      </fieldset>`;
    };
    const today = S.zonedParts(new Date()).date;
    const overrideRows = overrides.map(row => `<li><span><strong>${escapeHtml(S.label(row.id))}</strong> · ${escapeHtml(nameOf(row.assistantId))} cobre · ${escapeHtml(row.reason)}</span><button type="button" class="act-link" data-action="remove-override" data-shift="${escapeHtml(row.id)}">Remover</button></li>`).join("");
    const templateRows = templates.map(t => `<li><span class="act-time">${t.time || "—"}</span><div class="act-body"><strong>${escapeHtml(t.title)}</strong><p>${shiftText[t.shift]} · ${daysText(t.weekdays)}${t.remindBefore ? ` · lembrete ${t.remindBefore} min antes` : ""}${t.assigneeId ? ` · responsável: ${escapeHtml(nameOf(t.assigneeId))}` : ""}</p></div><div class="act-actions"><button type="button" class="act-link" data-action="edit-template" data-id="${escapeHtml(t.id)}">Editar</button><button type="button" class="act-link" data-action="remove-template" data-id="${escapeHtml(t.id)}">Excluir</button></div></li>`).join("");
    box.innerHTML = `
      <section class="act-card">
        <div class="act-card-head"><p class="eyebrow">ESCALA DOS ASSISTENTES</p><h3>Segue a aba Equipe</h3></div>
        <p class="${state.settings.teamSource ? "act-ok" : "act-warning"}">${state.settings.teamSource
          ? "O escalado de cada turno é o assistente da equipe de plantão (dia A ou B, noite C ou D), pela matrícula do Cadastro. De férias, entra quem cobre, se for um dos assistentes abaixo."
          : "A planilha da equipe não está disponível agora: vale o rodízio de reserva abaixo."}</p>
        <div class="act-settings-grid">
          <details class="act-reserve"${state.settings.teamSource ? "" : " open"}>
            <summary>Horários dos turnos e rodízio de reserva</summary>
            <form data-form="schedule" class="act-form">
              <label>Início do Diurno<input name="dayStart" type="time" value="${config.hours.dayStart}" required></label>
              <label>Início do Noturno<input name="nightStart" type="time" value="${config.hours.nightStart}" required></label>
              ${rotationFields("D")}${rotationFields("N")}
              <p class="is-wide act-muted">O rodízio só vale quando a planilha da equipe está indisponível, antes de 01/06/2026 ou se nenhum assistente estiver ligado à equipe de plantão. "1º dia do 1º" é uma data em que o 1º do rodízio faz o primeiro dia do seu bloco.</p>
              <div class="is-wide act-form-buttons"><button type="submit" class="act-button is-primary">Salvar</button></div>
            </form>
          </details>
          <div><h4>Próximos 14 dias</h4><div id="activitiesPreview">${previewHtml()}</div></div>
        </div>
      </section>
      <section class="act-card">
        <div class="act-card-head"><p class="eyebrow">TROCAS, FALTAS E COBERTURAS</p><h3>Ajustes pontuais</h3></div>
        <form data-form="override" class="act-form">
          <label>Data de início do turno<input name="date" type="date" value="${today}" required></label>
          <label>Turno<select name="kind"><option value="D">Diurno</option><option value="N">Noturno</option></select></label>
          <label>Quem cobre<select name="assistantId">${assistantOptions(null)}</select></label>
          <label class="is-wide">Motivo<input name="reason" maxlength="200" required placeholder="Troca de plantão, falta, cobertura…"></label>
          <div class="is-wide act-form-buttons"><button type="submit" class="act-button is-primary">Registrar ajuste</button></div>
        </form>
        ${overrideRows ? `<ul class="act-simple-list">${overrideRows}</ul>` : `<p class="act-muted">Nenhum ajuste nos próximos dias.</p>`}
      </section>
      <section class="act-card">
        <div class="act-card-head"><p class="eyebrow">ATIVIDADES FIXAS</p><h3>Modelos recorrentes</h3></div>
        ${templateRows ? `<ul class="act-tasks act-templates">${templateRows}</ul>` : `<p class="act-muted">Nenhum modelo cadastrado.</p>`}
        <h4>${state.editingTemplate ? "Editar modelo" : "Novo modelo"}</h4>
        ${templateFormHtml(state.editingTemplate)}
      </section>
      <section class="act-card">
        <div class="act-card-head"><p class="eyebrow">EQUIPE</p><h3>Assistentes</h3></div>
        <p class="act-muted">A matrícula liga o assistente à pessoa do Cadastro e à equipe A/B/C/D dela.</p>
        <ul class="act-simple-list">${assistants.map(item => `<li><form data-form="assistant" data-id="${escapeHtml(item.id)}" class="act-inline-form"><input name="name" value="${escapeHtml(item.name)}" maxlength="60" required aria-label="Nome"><input name="matricula" value="${escapeHtml(item.matricula || "")}" inputmode="numeric" maxlength="6" placeholder="Matrícula" aria-label="Matrícula de ${escapeHtml(item.name)}" class="act-matricula"><label class="act-check"><input type="checkbox" name="active"${item.active !== false ? " checked" : ""}>Ativo</label><button type="submit" class="act-link">Salvar</button><small class="act-linked">${item.linked ? `${escapeHtml(item.linked.name)} · Equipe ${escapeHtml(item.linked.team)}${item.linked.status !== "Ativo" ? ` · ${escapeHtml(item.linked.status)}` : ""}` : item.matricula && state.settings.teamSource ? `<span class="act-warning">matrícula não encontrada no Cadastro</span>` : ""}</small></form></li>`).join("")}
          <li><form data-form="assistant" class="act-inline-form"><input name="name" maxlength="60" required placeholder="Novo assistente" aria-label="Nome do novo assistente"><input name="matricula" inputmode="numeric" maxlength="6" placeholder="Matrícula" aria-label="Matrícula do novo assistente" class="act-matricula"><input type="hidden" name="active" value="on"><button type="submit" class="act-link">Incluir</button></form></li></ul>
      </section>`;
  }

  async function settingsAct(run, success) {
    const actor = requireIdentity();
    if (!actor) return;
    try {
      await run(actor);
      await loadSettings();
      document.activeElement?.blur();
      renderSettings();
      announce(success);
      refresh({ force: true }).catch(() => {});
    } catch (error) {
      announce(error.message, true);
    }
  }

  function onSettingsSubmit(event) {
    const form = event.target.closest("form[data-form]");
    if (!form) return;
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    if (form.dataset.form === "schedule") settingsAct(actor => api("/escala", { ...scheduleFromForm(form), actor }), "Escala salva.");
    if (form.dataset.form === "override") settingsAct(actor => api("/ajustes", { shiftId: S.makeId(data.date, data.kind), assistantId: data.assistantId, reason: data.reason, actor }), "Ajuste registrado.");
    if (form.dataset.form === "assistant") settingsAct(actor => api("/assistentes", { id: form.dataset.id || null, name: data.name, matricula: data.matricula ?? "", active: Boolean(data.active), actor }), "Assistente salvo.");
    if (form.dataset.form === "template") {
      const weekdays = new FormData(form).getAll("weekdays").map(Number);
      const body = { id: state.editingTemplate?.id || null, title: data.title, description: data.description, shift: data.shift, time: data.time, remindBefore: data.remindBefore, weekdays, assigneeId: data.assigneeId || null };
      settingsAct(actor => api("/modelos", { ...body, actor }).then(() => { state.editingTemplate = null; }), "Modelo salvo. Já vale para o turno atual e os próximos.");
    }
  }

  function onSettingsClick(event) {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    if (action === "edit-template") { state.editingTemplate = state.settings.templates.find(t => t.id === button.dataset.id) || null; document.activeElement?.blur(); renderSettings(); $("activitiesSettings").querySelector("[data-form='template'] input")?.focus(); }
    if (action === "cancel-template") { state.editingTemplate = null; document.activeElement?.blur(); renderSettings(); }
    if (action === "remove-template" && confirm("Excluir este modelo? As atividades pendentes dele saem dos turnos atual e futuros.")) settingsAct(actor => api("/modelos/remover", { id: button.dataset.id, actor }), "Modelo excluído.");
    if (action === "remove-override") settingsAct(actor => api("/ajustes/remover", { shiftId: button.dataset.shift, actor }), "Ajuste removido.");
  }

  /* ---------- Entrada ---------- */

  /** Chamado ao abrir o painel: liga o acompanhamento em segundo plano se os alertas estiverem ativos. */
  function start() {
    if (state.started) return;
    state.started = true;
    $("activitiesShift").addEventListener("click", onShiftClick);
    $("activitiesShift").addEventListener("submit", onShiftSubmit);
    $("activitiesShift").addEventListener("change", onShiftChange);
    setupDrag($("activitiesShift"));
    $("activitiesHistory").addEventListener("click", event => { const button = event.target.closest("button[data-download]"); if (button) downloadHandover(button.dataset.shift, button.dataset.download, button); });
    $("activitiesAlerts").addEventListener("click", toggleAlerts);
    $("activitiesHistoryForm").addEventListener("submit", event => { event.preventDefault(); loadHistory(); });
    $("activitiesExport").addEventListener("click", exportHistory);
    $("activitiesSettings").addEventListener("submit", onSettingsSubmit);
    $("activitiesSettings").addEventListener("click", onSettingsClick);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && (state.view === "turno" || alertsEnabled())) refresh().catch(() => {}); schedulePolling(); });
    state.alertTimer = setInterval(() => { checkAlerts(); if (state.view === "turno") renderShift(); }, ALERT_CHECK_MS);
    renderAlertButton();
    if (alertsEnabled()) Promise.all([loadSettings(), refresh()]).catch(() => {}).finally(schedulePolling);
  }

  /** Abre uma das telas da aba (ou fecha, com null). */
  async function show(view) {
    start();
    state.view = view;
    schedulePolling();
    if (!view) return;
    try {
      if (!state.settings || view === "configuracao") await loadSettings();
      if (view === "turno") { if (!state.viewed) announce("Carregando o turno…"); await refresh(); announce(""); }
      if (view === "acompanhamento") { setupHistoryFilters(); await loadHistory(); }
      if (view === "configuracao") { renderSettings(); announce(""); }
    } catch (error) {
      announce(error.message, true);
    }
  }

  window.activitiesPanel = { start, show };
})();
