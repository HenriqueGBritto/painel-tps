/* Aba Equipe (somente leitura): resumo do quadro, quem está de serviço, calendário das equipes, pessoas,
   férias e coberturas, treinamentos e relatório de importação. Os dados vêm de /api/equipe (planilha da equipe);
   escalas e indicadores são calculados por TpsTeam (team-schedule.js). Expõe window.teamPanel. */
(function () {
  const T = window.TpsTeam, S = window.TpsShifts;
  const VIEWS = {
    resumo: ["Resumo do quadro", "Quadro, efetivo por função e equipe, e transferências. Mesma lógica da aba Resumo da planilha."],
    servico: ["Quem está de serviço", "Equipes escaladas no dia e no turno, sem quem está de férias ou afastado."],
    calendario: ["Calendário das equipes", "Equipe do dia e da noite em cada data. Clique no dia para ver as pessoas."],
    pessoas: ["Pessoas", "Busca e filtros; clique na pessoa para ver a ficha."],
    ferias: ["Férias e coberturas", "Quem está fora, quem cobre e alertas de conflito."],
    treinamentos: ["Treinamentos", "Situação por treinamento e por pessoa."],
    importacao: ["Relatório de importação", "O que não foi possível interpretar ou vincular na planilha."]
  };
  const MONTHS = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
  const WEEKDAYS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
  const state = {
    data: null, view: null, loading: null, error: null, ready: false,
    serviceDate: null, calendar: null, selectedDay: null, vacationMonth: null,
    filters: { q: "", team: "", role: "", category: "", status: "" }, selectedPerson: null, trainingMode: "treinamento", pendingOnly: false
  };

  const $ = id => document.getElementById(id);
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const plain = value => String(value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
  const br = iso => iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "—";
  const brShort = iso => iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : "—";
  const today = () => S.zonedParts(new Date()).date;
  const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;
  const teamBadge = team => /^[A-D]$/.test(team) ? `<span class="team-tag team-${team}" title="Equipe ${team}">${team}</span>` : `<span class="team-tag">${escapeHtml(team || "—")}</span>`;
  const statusClass = status => status === "Afastado (INSS)" ? "is-inss" : status === "Ativo (em transferência)" ? "is-transfer" : "";

  /* ---------- Dados ---------- */

  async function load({ force = false } = {}) {
    if (state.data && !force) return state.data;
    state.loading ||= (async () => {
      announce("Lendo a planilha da equipe…");
      const response = await fetch("/api/equipe", { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Não foi possível ler a planilha da equipe.");
      prepare(data);
      state.data = data;
      state.error = null;
      announce("");
      const link = $("teamSheetLink");
      if (link && data.sheetUrl) { link.href = data.sheetUrl; link.hidden = false; }
      window.renderDataSeal?.();
      return data;
    })().catch(error => { state.error = error; throw error; }).finally(() => { state.loading = null; });
    return state.loading;
  }

  /** Índices para as telas: pessoa por matrícula, ausências e treinamentos por pessoa, ordem das funções. */
  function prepare(data) {
    data.byId = new Map(data.people.map(person => [person.id, person]));
    data.roleOrder = (data.lists?.roles || []).map(item => item.role);
    data.absencesOf = new Map();
    data.coversOf = new Map();
    data.absences.forEach(item => {
      if (!item.person.external) (data.absencesOf.get(item.person.id) || data.absencesOf.set(item.person.id, []).get(item.person.id)).push(item);
      if (item.cover && !item.cover.external) (data.coversOf.get(item.cover.id) || data.coversOf.set(item.cover.id, []).get(item.cover.id)).push(item);
    });
    data.trainingsOf = new Map();
    data.trainings.forEach(training => training.participants.forEach(participant => {
      const key = participant.person.external ? `ext:${participant.person.id || participant.person.name}` : participant.person.id;
      (data.trainingsOf.get(key) || data.trainingsOf.set(key, []).get(key)).push({ training, participant });
    }));
  }

  function announce(message, isError = false) {
    const box = $("teamStatus");
    if (!box) return;
    box.textContent = message;
    box.classList.toggle("is-error", isError);
  }

  const personName = ref => {
    if (!ref) return "—";
    const person = !ref.external && state.data.byId.get(ref.id);
    return person ? person.name : `${ref.name}${ref.external ? " (externo)" : ""}`;
  };
  const personLink = ref => {
    if (!ref) return "—";
    if (ref.external || !state.data.byId.has(ref.id)) return `<span class="team-external">${escapeHtml(ref.name || ref.id)}${ref.id ? ` · ${escapeHtml(ref.id)}` : ""} <small>externo</small></span>`;
    const person = state.data.byId.get(ref.id);
    return `<button type="button" class="team-person-link" data-person="${escapeHtml(person.id)}">${escapeHtml(person.name)}</button>`;
  };
  const marks = person => [
    person.status === "Afastado (INSS)" ? `<span class="team-mark is-inss">Afastado (INSS)</span>` : "",
    person.status === "Ativo (em transferência)" ? `<span class="team-mark is-transfer">Em transferência${person.transferTo ? ` → ${escapeHtml(person.transferTo)}` : ""}</span>` : "",
    person.customSchedule ? `<span class="team-mark is-custom" title="${escapeHtml(person.note)}">Escala diferenciada</span>` : ""
  ].join("");

  /* ---------- Resumo ---------- */

  function renderSummary() {
    const data = state.data;
    const summary = T.summary(data.people, data.lists);
    const columnLabel = { A: "A", B: "B", C: "C", D: "D", "Gestão": "Gestão", Administrativo: "Adm.", "Intermediária": "Interm.", "Capatazia Dia": "Cap. Dia", "Capatazia Noite": "Cap. Noite" };
    const cells = row => summary.columns.map(column => `<td>${row.columns[column] || "<span class=\"team-zero\">0</span>"}</td>`).join("") + `<td><strong>${row.total}</strong></td><td>${row.inss || ""}</td><td>${row.transfer || ""}</td>`;
    const transfers = data.people.filter(person => person.status === "Ativo (em transferência)");
    return `
      <div class="base-kpis team-kpis">
        <article><span>QUADRO ATUAL</span><strong>${summary.totals.total}</strong><small>total de pessoas na escala</small></article>
        <article><span>ATIVOS</span><strong>${summary.totals.active}</strong><small>trabalhando (inclui transferências)</small></article>
        <article><span>AFASTADOS INSS</span><strong>${summary.totals.inss}</strong><small>fora da operação</small></article>
        <article><span>EM TRANSFERÊNCIA</span><strong>${summary.totals.transfer}</strong><small>ativos mudando de função</small></article>
      </div>
      <section class="base-sheet"><div class="base-sheet-head"><div><p class="eyebrow">EFETIVO</p><h3>Por função e equipe</h3></div><span>Revezamento 2x2 (A–D) e grupos fora do 2x2</span></div>
        <div class="base-table-scroll"><table class="base-table team-matrix"><thead><tr><th>Função</th>${summary.columns.map(column => `<th>${columnLabel[column]}</th>`).join("")}<th>Quadro</th><th>Afast.</th><th>Transf.</th></tr></thead><tbody>
          ${summary.categories.map(category => `<tr class="team-category"><th colspan="${summary.columns.length + 4}">${escapeHtml(category.category.toUpperCase())}</th></tr>${category.roles.map(role => `<tr><th>${escapeHtml(role.role)}</th>${cells(role)}</tr>`).join("")}<tr class="team-subtotal"><th>Subtotal ${escapeHtml(category.category)}</th>${cells(category.subtotal)}</tr>`).join("")}
          <tr class="team-total"><th>TOTAL GERAL</th>${cells(summary.grandTotal)}</tr>
        </tbody></table></div>
        <p class="base-footnote">Quadro = todas as pessoas do Cadastro. Afastados e transferências já estão dentro do quadro; quem está em transferência conta como ativo.</p>
      </section>
      <div class="team-two">
        <section class="base-sheet"><div class="base-sheet-head"><div><p class="eyebrow">REVEZAMENTO 2X2</p><h3>Por equipe</h3></div></div>
          <div class="base-table-scroll"><table class="base-table team-teams"><thead><tr><th>Equipe</th><th>Turno</th><th>Quadro</th><th>Ativos</th><th>Afast.</th><th>Transf.</th></tr></thead><tbody>
            ${summary.teams.map(team => `<tr><th>${teamBadge(team.team)} ${escapeHtml(team.label)}</th><td>${team.shift === "D" ? "Diurno" : "Noturno"} · ${team.hours}</td><td>${team.total}</td><td>${team.active}</td><td>${team.inss}</td><td>${team.transfer}</td></tr>`).join("")}
          </tbody></table></div>
        </section>
        <section class="base-sheet"><div class="base-sheet-head"><div><p class="eyebrow">TRANSFERÊNCIAS</p><h3>Ativos em transferência</h3></div><span>${plural(transfers.length, "pessoa", "pessoas")}</span></div>
          ${transfers.length ? `<ul class="team-list">${transfers.map(person => `<li>${personLink({ id: person.id })} <small>${escapeHtml(person.id)} · ${escapeHtml(person.role)} · ${teamBadge(person.team)}</small><span class="team-arrow">→ ${escapeHtml(person.transferTo || "destino não informado na Observação")}</span></li>`).join("")}</ul>` : `<p class="base-empty">Ninguém em transferência.</p>`}
        </section>
      </div>`;
  }

  /* ---------- De serviço / dia do calendário ---------- */

  function groupCard(group, { now = false } = {}) {
    const byRole = new Map();
    group.present.forEach(person => (byRole.get(person.role) || byRole.set(person.role, []).get(person.role)).push(person));
    const absent = group.absent.map(({ person, absence }) => {
      const until = absence.end ? ` até ${brShort(absence.end)}` : "";
      const cover = absence.cover ? `cobertura: ${personLink(absence.cover)}` : absence.coverStatus === "sem cobertura" ? `<span class="team-warn">sem cobertura</span>` : absence.fromStatus ? "" : `<span class="team-muted">cobertura não informada</span>`;
      return `<li>${personLink({ id: person.id })} <small>${escapeHtml(person.role)}</small> <span class="team-mark ${absence.motive === "Afastado (INSS)" ? "is-inss" : "is-away"}">${escapeHtml(absence.motive)}${until}</span> ${cover}</li>`;
    }).join("");
    return `<article class="team-group${now ? " is-now" : ""}">
      <header><div>${/^[A-D]$/.test(group.group) ? teamBadge(group.group) : ""}<h4>${escapeHtml(group.label)}</h4>${now ? `<span class="team-now">agora</span>` : ""}</div><small>${escapeHtml(group.hours)}${group.dayOfBlock ? ` · ${group.dayOfBlock}º dia do plantão` : ""} · ${plural(group.present.length, "presente", "presentes")}</small></header>
      ${[...byRole].map(([role, people]) => `<div class="team-role"><h5>${escapeHtml(role)} <small>${people.length}</small></h5><ul>${people.map(person => `<li>${personLink({ id: person.id })} <small>${escapeHtml(person.id)}</small> ${marks(person)}</li>`).join("")}</ul></div>`).join("")}
      ${absent ? `<div class="team-role team-absent"><h5>Fora neste dia <small>${group.absent.length}</small></h5><ul>${absent}</ul></div>` : ""}
    </article>`;
  }

  function rosterHtml(date, { highlight = null } = {}) {
    const data = state.data;
    const turn = T.rotation(date);
    const day = T.roster(date, data.people, data.absences, { kind: "D", roleOrder: data.roleOrder });
    const night = T.roster(date, data.people, data.absences, { kind: "N", roleOrder: data.roleOrder });
    const column = (title, hours, roster, kind) => `<div class="team-shift"><h3>${title} <small>${hours}</small></h3>${roster.groups.length ? roster.groups.map(group => groupCard(group, { now: highlight === kind && ["A", "B", "C", "D"].includes(group.group) })).join("") : `<p class="base-empty">Nenhum grupo escalado.</p>`}</div>`;
    const covering = day.covering;
    const management = data.people.filter(person => person.team === "Gestão");
    return `
      ${turn ? "" : `<p class="team-note">Escala anterior ao 2x2 (antes de 01/06/2026): o painel não calcula as equipes A–D para esta data.</p>`}
      <div class="team-shifts">
        ${column(`☀ Dia${turn ? ` · Equipe ${turn.day}` : ""}`, "07:00–19:00 (Capatazia Dia 09:00–18:48)", day, "D")}
        ${column(`☾ Noite${turn ? ` · Equipe ${turn.night}` : ""}`, "19:00–07:00 do dia seguinte (Capatazia Noite 21:00–06:48)", night, "N")}
      </div>
      ${covering.length ? `<section class="base-sheet team-covering"><div class="base-sheet-head"><div><p class="eyebrow">COBERTURAS NO DIA</p><h3>Quem está cobrindo alguém</h3></div></div><ul class="team-list">${covering.map(({ person, absences }) => `<li>${personLink({ id: person.id })} <small>${escapeHtml(person.role)} · ${teamBadge(person.team)}</small><span class="team-arrow">cobre ${absences.map(item => `${personLink(item.person)} (${escapeHtml(item.motive.toLowerCase())} até ${brShort(item.end)})`).join(", ")}</span></li>`).join("")}</ul></section>` : ""}
      <p class="team-muted team-management">Gestão (${management.map(person => escapeHtml(person.name)).join(", ") || "—"}): sem escala.</p>`;
  }

  function renderService() {
    const current = T.currentShift();
    const date = state.serviceDate || current.date;
    const isCurrent = date === current.date;
    const turn = T.rotation(current.date);
    const now = turn ? `Agora: plantão ${current.kind === "D" ? `diurno de ${brShort(current.date)} · Equipe ${turn.day}` : `noturno que começou em ${brShort(current.date)} · Equipe ${turn.night}`} (${turn.dayOfBlock}º dia)` : "";
    return `
      <div class="base-filters team-toolbar"><label>Data do plantão<input type="date" data-team-input="service-date" value="${date}"></label>
        <button type="button" class="act-button${isCurrent ? " is-primary" : ""}" data-team-action="service-now">Turno atual</button>
        <button type="button" class="act-button" data-team-action="service-prev" aria-label="Dia anterior">‹ Dia anterior</button>
        <button type="button" class="act-button" data-team-action="service-next" aria-label="Próximo dia">Próximo dia ›</button>
        <span class="team-now-text">${escapeHtml(now)}</span></div>
      <p class="team-note">O plantão noturno pertence à data em que começou: a noite de ${brShort(date)} vai até 07:00 de ${brShort(S.addDays(date, 1))}.</p>
      ${rosterHtml(date, { highlight: isCurrent ? current.kind : null })}`;
  }

  /* ---------- Calendário ---------- */

  function renderCalendar() {
    const now = today();
    const { year, month } = state.calendar ||= { year: Number(now.slice(0, 4)), month: Number(now.slice(5, 7)) };
    const days = T.month(year, month, state.data.people, state.data.absences);
    const blanks = days[0].weekday;
    const cells = days.map(day => `<button type="button" class="team-day${day.date === now ? " is-today" : ""}${day.date === state.selectedDay ? " is-selected" : ""}" data-team-day="${day.date}" aria-pressed="${day.date === state.selectedDay}" aria-label="${br(day.date)}${day.day ? `: dia equipe ${day.day}, noite equipe ${day.night}` : ""}${day.out ? `, ${day.out} fora` : ""}">
        <span class="team-day-number">${Number(day.date.slice(8, 10))}</span>
        ${day.day ? `<span class="team-day-shift">☀ ${teamBadge(day.day)}</span><span class="team-day-shift">☾ ${teamBadge(day.night)}</span><small>${day.dayOfBlock}º dia${day.intermediate ? " · Int." : ""}</small>` : `<small class="team-muted">antes do 2x2</small>`}
        ${day.out ? `<span class="team-day-out">${day.out} fora</span>` : ""}
      </button>`).join("");
    return `
      <div class="team-month-nav"><button type="button" class="act-nav" data-team-action="month-prev" aria-label="Mês anterior">‹</button><h3>${MONTHS[month - 1]} de ${year}</h3><button type="button" class="act-nav" data-team-action="month-next" aria-label="Próximo mês">›</button><button type="button" class="act-link" data-team-action="month-today">Hoje</button></div>
      <div class="team-legend">${["A", "B", "C", "D"].map(team => `${teamBadge(team)} ${["A", "B"].includes(team) ? "dia" : "noite"}`).join(" · ")} · Int. = Intermediária trabalha</div>
      <div class="team-calendar" role="grid">${WEEKDAYS.map(day => `<div class="team-weekday" role="columnheader">${day}</div>`).join("")}${"<div></div>".repeat(blanks)}${cells}</div>
      ${state.selectedDay ? `<section class="team-day-detail" id="teamDayDetail"><div class="base-sheet-head"><div><p class="eyebrow">${WEEKDAYS[S.weekday(state.selectedDay)].toUpperCase()}</p><h3>${br(state.selectedDay)}</h3></div><button type="button" class="act-link" data-team-action="day-close">Fechar</button></div>${rosterHtml(state.selectedDay)}</section>` : ""}`;
  }

  /* ---------- Pessoas ---------- */

  function filteredPeople() {
    const { q, team, role, category, status } = state.filters;
    const query = plain(q).trim();
    return state.data.people.filter(person => (!query || plain(person.name).includes(query) || person.id.includes(query))
      && (!team || person.team === team) && (!role || person.role === role) && (!category || person.category === category) && (!status || person.status === status))
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  }
  const options = (values, selected, all) => `<option value="">${all}</option>${values.map(value => `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(value)}</option>`).join("")}`;
  const unique = key => [...new Set(state.data.people.map(person => person[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR"));

  function personCard(id) {
    const data = state.data;
    const person = data.byId.get(id);
    if (!person) return "";
    const absences = (data.absencesOf.get(id) || []).slice().sort((a, b) => b.start.localeCompare(a.start));
    const covers = (data.coversOf.get(id) || []).slice().sort((a, b) => b.start.localeCompare(a.start));
    const trainings = data.trainingsOf.get(id) || [];
    const now = today();
    const away = T.absenceOf(person, now, data.absences);
    const works = T.groupWorks(person.team, T.currentShift().date);
    return `<article class="team-card" id="teamPersonCard">
      <header><div><p class="eyebrow">${escapeHtml(person.role.toUpperCase())}</p><h3>${escapeHtml(person.name)}</h3><p>Matrícula ${escapeHtml(person.id)} · ${teamBadge(person.team)} ${escapeHtml(T.GROUPS[person.team]?.label || person.team)} · ${escapeHtml(person.status)}</p></div><button type="button" class="act-link" data-team-action="person-close">Fechar</button></header>
      <div class="team-card-grid">
        <dl>
          <dt>Categoria</dt><dd>${escapeHtml(person.category || "—")}</dd>
          <dt>Turno · horário</dt><dd>${escapeHtml(person.shift || "—")} · ${escapeHtml(person.hours || "—")}</dd>
          <dt>Escala</dt><dd>${escapeHtml(person.schedule || "—")}${person.customSchedule ? ` <span class="team-mark is-custom">Escala diferenciada</span>` : ""}</dd>
          <dt>Hoje</dt><dd>${away ? `<span class="team-mark is-away">${escapeHtml(away.motive)}${away.end ? ` até ${brShort(away.end)}` : ""}</span>` : works.works === true ? "Escalado no plantão atual" : works.works === false ? "Folga no plantão atual" : escapeHtml(works.reason || "—")}</dd>
          ${person.transferTo ? `<dt>Transferência</dt><dd>→ ${escapeHtml(person.transferTo)}</dd>` : ""}
          <dt>Observação</dt><dd>${escapeHtml(person.note || "—")}</dd>
        </dl>
        <div>
          <h4>Férias e ausências</h4>
          ${absences.length ? `<ul class="team-list">${absences.map(item => `<li><strong>${escapeHtml(item.motive)}</strong> ${br(item.start)} a ${br(item.end)}${item.returnDate ? ` · retorna ${br(item.returnDate)}` : ""}<span class="team-arrow">${item.cover ? `cobertura: ${personLink(item.cover)}` : escapeHtml(item.coverStatus)}</span>${item.notes.length ? `<small>${escapeHtml(item.notes.join(" · "))}</small>` : ""}</li>`).join("")}</ul>` : `<p class="team-muted">Nenhuma na aba Férias.</p>`}
          <h4>Coberturas feitas</h4>
          ${covers.length ? `<ul class="team-list">${covers.map(item => `<li>Cobriu ${personLink(item.person)} · ${escapeHtml(item.motive.toLowerCase())} de ${brShort(item.start)} a ${br(item.end)}</li>`).join("")}</ul>` : `<p class="team-muted">Nenhuma.</p>`}
          <h4>Treinamentos</h4>
          ${trainings.length ? `<ul class="team-list">${trainings.map(({ training, participant }) => `<li><strong>${escapeHtml(training.type)}</strong> · ${escapeHtml(training.title)}<span class="team-arrow"><span class="team-status is-${plain(participant.status).replace(/[^A-Z]+/g, "-").toLowerCase()}">${escapeHtml(participant.status)}</span>${participant.certificate ? ` · certificado ${escapeHtml(participant.certificate)}` : ""}${participant.dates.length ? ` · ${participant.dates.map(brShort).join(", ")}` : ""}</span></li>`).join("")}</ul>` : `<p class="team-muted">Nenhum registro.</p>`}
        </div>
      </div>
    </article>`;
  }

  function renderPeople() {
    const { filters } = state;
    const people = filteredPeople();
    return `
      <form class="base-filters team-toolbar" data-team-form="people" role="search">
        <label class="base-search">Buscar<input type="search" name="q" value="${escapeHtml(filters.q)}" placeholder="Nome ou matrícula" autocomplete="off"></label>
        <label>Equipe<select name="team">${options(unique("team"), filters.team, "Todas")}</select></label>
        <label>Função<select name="role">${options(unique("role"), filters.role, "Todas")}</select></label>
        <label>Categoria<select name="category">${options(unique("category"), filters.category, "Todas")}</select></label>
        <label>Status<select name="status">${options(unique("status"), filters.status, "Todos")}</select></label>
      </form>
      ${state.selectedPerson ? personCard(state.selectedPerson) : ""}
      <p class="team-count" id="teamPeopleCount">${plural(people.length, "pessoa", "pessoas")}</p>
      <div class="base-table-scroll"><table class="base-table team-people"><thead><tr><th>Nome</th><th>Matrícula</th><th>Função</th><th>Equipe</th><th>Status</th><th>Marcas</th></tr></thead><tbody id="teamPeopleRows">${peopleRows(people)}</tbody></table></div>`;
  }
  const peopleRows = people => people.map(person => `<tr class="${statusClass(person.status)}${person.id === state.selectedPerson ? " is-selected" : ""}"><th>${personLink({ id: person.id })}</th><td>${escapeHtml(person.id)}</td><td>${escapeHtml(person.role)}</td><td>${teamBadge(person.team)}</td><td>${escapeHtml(person.status)}</td><td>${marks(person)}</td></tr>`).join("") || `<tr><td colspan="6" class="base-empty">Ninguém com esses filtros.</td></tr>`;

  /* ---------- Férias e coberturas ---------- */

  function renderVacations() {
    const data = state.data;
    const now = today();
    const { year, month } = state.vacationMonth ||= { year: Number(now.slice(0, 4)), month: Number(now.slice(5, 7)) };
    const first = `${year}-${String(month).padStart(2, "0")}-01`;
    const last = S.addDays(month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`, -1);
    const size = Number(last.slice(8, 10));
    const rows = data.absences.filter(item => item.start <= last && item.end >= first).sort((a, b) => a.start.localeCompare(b.start) || personName(a.person).localeCompare(personName(b.person)));
    const alerts = T.conflicts(data.absences, data.people, { from: now });
    const alertLevel = { "atenção": "is-warn", "informação": "is-info" };
    const bar = item => {
      const startDay = item.start < first ? 1 : Number(item.start.slice(8, 10));
      const endDay = item.end > last ? size : Number(item.end.slice(8, 10));
      return `<span class="team-bar team-bar-${plain(item.motive).replace(/[^A-Z]+/g, "-").toLowerCase()}" style="grid-column:${startDay} / ${endDay + 1}" title="${escapeHtml(`${item.motive}: ${br(item.start)} a ${br(item.end)}`)}">${escapeHtml(item.motive)} · ${brShort(item.start)}–${brShort(item.end)}</span>`;
    };
    const who = item => {
      const person = !item.person.external && data.byId.get(item.person.id);
      return `${personLink(item.person)}<small>${person ? `${escapeHtml(person.role)} · ${teamBadge(person.team)}` : escapeHtml(item.role || "")}</small>`;
    };
    const cover = item => item.cover ? `↳ ${personLink(item.cover)}` : `<span class="${item.coverStatus === "sem cobertura" ? "team-warn" : "team-muted"}">${escapeHtml(item.coverStatus === "sem cobertura" ? "sem cobertura" : "cobertura não informada")}</span>`;
    return `
      <section class="base-sheet"><div class="base-sheet-head"><div><p class="eyebrow">ALERTAS</p><h3>Conflitos a partir de hoje</h3></div><span>${plural(alerts.length, "alerta", "alertas")}</span></div>
        ${alerts.length ? `<ul class="team-alerts">${alerts.map(alert => `<li class="${alertLevel[alert.level] || ""}"><strong>${escapeHtml(alert.type)}</strong> · ${escapeHtml(alert.text)} <small>${br(alert.period.start)} a ${br(alert.period.end)}</small></li>`).join("")}</ul>` : `<p class="base-empty">Nenhum conflito nas férias e coberturas a partir de hoje.</p>`}
      </section>
      <div class="team-month-nav"><button type="button" class="act-nav" data-team-action="vac-prev" aria-label="Mês anterior">‹</button><h3>${MONTHS[month - 1]} de ${year}</h3><button type="button" class="act-nav" data-team-action="vac-next" aria-label="Próximo mês">›</button><span class="team-muted">${plural(rows.length, "ausência", "ausências")} no mês</span></div>
      ${rows.length ? `<div class="team-timeline" style="--days:${size}">
        <div class="team-timeline-row team-timeline-head"><div class="team-timeline-who">Pessoa</div><div class="team-timeline-days">${Array.from({ length: size }, (_, i) => `<span${S.addDays(first, i) === now ? " class=\"is-today\"" : ""}>${i + 1}</span>`).join("")}</div><div class="team-timeline-cover">Cobertura</div></div>
        ${rows.map(item => `<div class="team-timeline-row"><div class="team-timeline-who">${who(item)}</div><div class="team-timeline-days">${bar(item)}</div><div class="team-timeline-cover">${cover(item)}${item.notes.length ? `<small>${escapeHtml(item.notes.join(" · "))}</small>` : ""}</div></div>`).join("")}
      </div>` : `<p class="base-empty">Ninguém fora neste mês pela aba Férias.</p>`}`;
  }

  /* ---------- Treinamentos ---------- */

  const STATUS_ORDER = ["realizado", "agendado", "pendente", "aguardando agenda", "faltou", "não quis", "desistiu", "cancelado", "ausente (férias)", "sem situação"];
  const statusChip = status => `<span class="team-status is-${plain(status).replace(/[^A-Z]+/g, "-").toLowerCase()}">${escapeHtml(status)}</span>`;
  function renderTrainings() {
    const data = state.data;
    const pendingOnly = state.pendingOnly;
    const keep = participant => !pendingOnly || participant.certificate === "pedido";
    const toolbar = `<div class="base-filters team-toolbar"><div class="base-chart-mode" role="group" aria-label="Ver por"><button type="button" data-team-action="training-mode" data-mode="treinamento" aria-pressed="${state.trainingMode === "treinamento"}">Por treinamento</button><button type="button" data-team-action="training-mode" data-mode="pessoa" aria-pressed="${state.trainingMode === "pessoa"}">Por pessoa</button></div>
      <label class="team-check"><input type="checkbox" data-team-input="pending-only"${pendingOnly ? " checked" : ""}> Só certificado pendente</label></div>`;
    if (state.trainingMode === "pessoa") {
      const rows = [...data.trainingsOf].map(([key, items]) => ({ key, items: items.filter(({ participant }) => keep(participant)) })).filter(row => row.items.length)
        .map(row => ({ ...row, ref: row.items[0].participant.person })).sort((a, b) => personName(a.ref).localeCompare(personName(b.ref), "pt-BR"));
      return `${toolbar}<div class="base-table-scroll"><table class="base-table team-trainings-people"><thead><tr><th>Pessoa</th><th>Treinamentos</th></tr></thead><tbody>
        ${rows.map(row => `<tr><th>${personLink(row.ref)}</th><td><ul class="team-list">${row.items.map(({ training, participant }) => `<li><strong>${escapeHtml(training.type)}</strong> · ${escapeHtml(training.title)} ${statusChip(participant.status)}${participant.certificate ? ` <small>certificado ${escapeHtml(participant.certificate)}</small>` : ""}</li>`).join("")}</ul></td></tr>`).join("") || `<tr><td colspan="2" class="base-empty">Nada a mostrar.</td></tr>`}
      </tbody></table></div>`;
    }
    return `${toolbar}${data.trainings.map(training => {
      const participants = training.participants.filter(keep);
      if (pendingOnly && !participants.length) return "";
      const counts = STATUS_ORDER.map(status => [status, training.participants.filter(item => item.status === status).length]).filter(([, count]) => count);
      return `<section class="base-sheet team-training"><div class="base-sheet-head"><div><p class="eyebrow">${escapeHtml(training.type.toUpperCase())}</p><h3>${escapeHtml(training.title)}</h3></div><span>${training.dates.length ? training.dates.map(br).join(", ") : "datas no texto de cada pessoa"}</span></div>
        ${training.location ? `<p class="team-muted">Local: ${escapeHtml(training.location)}</p>` : ""}
        <div class="act-chips">${counts.map(([status, count]) => `<span class="team-status is-${plain(status).replace(/[^A-Z]+/g, "-").toLowerCase()}">${count} ${escapeHtml(status)}</span>`).join("")}</div>
        <div class="base-table-scroll"><table class="base-table team-training-table"><thead><tr><th>Pessoa</th><th>Equipe</th><th>Situação</th><th>Certificado</th><th>Datas</th><th>Texto da planilha</th></tr></thead><tbody>
          ${participants.map(item => `<tr><th>${personLink(item.person)}</th><td>${item.team ? teamBadge(item.team) : "—"}</td><td>${statusChip(item.status)}</td><td>${escapeHtml(item.certificate || "—")}</td><td>${item.dates.map(brShort).join(", ") || "—"}</td><td><small>${escapeHtml(item.note)}</small></td></tr>`).join("")}
        </tbody></table></div>
        ${training.notes.length ? `<details class="chart-data"><summary>Texto não estruturado (${training.notes.length})</summary><ul class="team-list">${training.notes.map(note => `<li><small>${escapeHtml(note)}</small></li>`).join("")}</ul></details>` : ""}
      </section>`;
    }).join("") || `<p class="base-empty">Nenhum treinamento encontrado.</p>`}`;
  }

  /* ---------- Relatório de importação ---------- */

  function renderImport() {
    const report = state.data.report || [];
    const bySheet = [...new Set(report.map(item => item.sheet))].map(sheet => [sheet, report.filter(item => item.sheet === sheet)]);
    return `
      <p class="team-note">Abas lidas: Cadastro, Listas, Férias e NOVOS TREINAMENTOS. Ignoradas (o painel recalcula): ${escapeHtml((state.data.ignoredTabs || []).join(", "))}. Lido em ${escapeHtml(new Date(state.data.generatedAt).toLocaleString("pt-BR", { timeZone: S.TZ }))}.</p>
      <div class="act-chips">${bySheet.map(([sheet, items]) => `<span class="act-chip">${escapeHtml(sheet)}: ${items.length}</span>`).join("")}<span class="act-chip is-not_done">${report.filter(item => item.level === "erro").length} erros</span><span class="act-chip is-transferred">${report.filter(item => item.level === "aviso").length} avisos</span></div>
      ${report.length ? `<div class="base-table-scroll"><table class="base-table team-report"><thead><tr><th>Aba</th><th>Linha</th><th>Tipo</th><th>O que aconteceu</th><th>Texto da planilha</th></tr></thead><tbody>
        ${report.map(item => `<tr class="is-${item.level}"><td>${escapeHtml(item.sheet)}</td><td>${item.row || "—"}</td><td>${escapeHtml(item.level)}</td><td>${escapeHtml(item.message)}</td><td><small>${escapeHtml(item.text)}</small></td></tr>`).join("")}
      </tbody></table></div>` : `<p class="base-empty">Tudo foi interpretado e vinculado.</p>`}`;
  }

  /* ---------- Tela ---------- */

  const RENDER = { resumo: renderSummary, servico: renderService, calendario: renderCalendar, pessoas: renderPeople, ferias: renderVacations, treinamentos: renderTrainings, importacao: renderImport };

  function render() {
    const box = $("teamContent");
    if (!box || !state.view) return;
    const [title, subtitle] = VIEWS[state.view];
    $("teamTitle").textContent = title;
    $("teamSubtitle").textContent = subtitle;
    if (state.error) { box.innerHTML = `<p class="base-empty">${escapeHtml(state.error.message)}</p>`; return; }
    if (!state.data) { box.innerHTML = `<p class="base-empty">Lendo a planilha da equipe…</p>`; return; }
    box.innerHTML = RENDER[state.view]();
  }

  function openPerson(id) {
    state.selectedPerson = id;
    if (state.view !== "pessoas") { window.openTeamView?.("pessoas"); return; }
    render();
    $("teamPersonCard")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function onClick(event) {
    const personButton = event.target.closest("[data-person]");
    if (personButton) { openPerson(personButton.dataset.person); return; }
    const dayButton = event.target.closest("[data-team-day]");
    if (dayButton) {
      state.selectedDay = state.selectedDay === dayButton.dataset.teamDay ? null : dayButton.dataset.teamDay;
      render();
      $("teamDayDetail")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      return;
    }
    const button = event.target.closest("[data-team-action]");
    if (!button) return;
    const action = button.dataset.teamAction;
    const shiftMonth = (key, delta) => { const value = state[key]; const index = value.year * 12 + value.month - 1 + delta; state[key] = { year: Math.floor(index / 12), month: index % 12 + 1 }; };
    if (action === "service-now") state.serviceDate = null;
    if (action === "service-prev" || action === "service-next") state.serviceDate = S.addDays(state.serviceDate || T.currentShift().date, action === "service-prev" ? -1 : 1);
    if (action === "month-prev" || action === "month-next") shiftMonth("calendar", action === "month-prev" ? -1 : 1);
    if (action === "month-today") { state.calendar = null; state.selectedDay = today(); }
    if (action === "day-close") state.selectedDay = null;
    if (action === "vac-prev" || action === "vac-next") shiftMonth("vacationMonth", action === "vac-prev" ? -1 : 1);
    if (action === "person-close") state.selectedPerson = null;
    if (action === "training-mode") state.trainingMode = button.dataset.mode;
    render();
  }

  function onInput(event) {
    const input = event.target;
    if (input.dataset.teamInput === "service-date" && S.isDate(input.value)) { state.serviceDate = input.value; render(); return; }
    if (input.dataset.teamInput === "pending-only") { state.pendingOnly = input.checked; render(); return; }
    const form = input.closest("[data-team-form='people']");
    if (form) {
      state.filters[input.name] = input.value;
      // Só a tabela é redesenhada, para não tirar o foco do campo de busca.
      const people = filteredPeople();
      $("teamPeopleRows").innerHTML = peopleRows(people);
      $("teamPeopleCount").textContent = plural(people.length, "pessoa", "pessoas");
    }
  }

  let started = false;
  function start() {
    if (started) return;
    started = true;
    const box = $("teamContent");
    box.addEventListener("click", onClick);
    box.addEventListener("input", onInput);
    box.addEventListener("change", onInput);
    box.addEventListener("submit", event => event.preventDefault());
  }

  /** Abre uma das subabas (ou fecha, com null). */
  async function show(view) {
    state.view = view && VIEWS[view] ? view : null;
    if (!state.view) return;
    start();
    render();
    try { await load(); render(); }
    catch (error) { announce(error.message, true); render(); }
  }

  window.teamPanel = {
    show,
    VIEWS: Object.keys(VIEWS),
    getMeta: () => state.data ? { origin: state.data.origin, generatedAt: state.data.generatedAt, changeLog: state.data.changeLog, files: state.data.files } : null,
    reload: () => load({ force: true }).then(render)
  };
})();
