/* Escalas e indicadores da aba Equipe. Funções puras (testadas em tests/team-schedule.test.mjs),
   carregadas como script comum no navegador: expõe window.TpsTeam. Usa TpsShifts (shifts.js) para datas e turnos.

   Regras (combinadas com a operação):
   - 2x2 a partir de 01/06/2026: 2 dias A (diurno 07–19) + C (noturno 19–07), 2 dias B + D, e assim por diante.
     15 e 16/10/2026 = A + C (1º e 2º dia); 17 e 18/10/2026 = B + D. Antes de 01/06/2026 a escala era outra.
   - Intermediária: mesmo 2x2, um dia adiantado — 2º dia de uma equipe e 1º da seguinte (16/10/2026 = 1º dia).
   - Capatazia Dia 09:00–18:48 e Capatazia Noite 21:00–06:48, segunda a sexta (a noite de sexta termina no sábado).
   - Administrativo: horário administrativo, segunda a sexta. Gestão: sem escala.
   - O plantão noturno pertence à data em que começou (fuso America/Sao_Paulo). */
(function (root) {
  const S = root.TpsShifts;
  const CYCLE_START = "2026-06-01";
  const REFERENCE = "2026-10-15";
  const WEEKDAYS = [1, 2, 3, 4, 5];
  const HOURS = { dayStart: "07:00", nightStart: "19:00" };

  const GROUPS = {
    A: { label: "Equipe A", kind: "2x2", shift: "D", hours: "07:00–19:00" },
    B: { label: "Equipe B", kind: "2x2", shift: "D", hours: "07:00–19:00" },
    C: { label: "Equipe C", kind: "2x2", shift: "N", hours: "19:00–07:00" },
    D: { label: "Equipe D", kind: "2x2", shift: "N", hours: "19:00–07:00" },
    "Intermediária": { label: "Intermediária", kind: "intermediate", shift: "D", hours: "07:00–19:00" },
    "Capatazia Dia": { label: "Capatazia Dia", kind: "5x2", shift: "D", hours: "09:00–18:48" },
    "Capatazia Noite": { label: "Capatazia Noite", kind: "5x2", shift: "N", hours: "21:00–06:48" },
    Administrativo: { label: "Administrativo", kind: "5x2", shift: "D", hours: "Horário administrativo" },
    "Gestão": { label: "Gestão", kind: "none", shift: null, hours: "Sem escala" }
  };
  /** Ordem das colunas do quadro (igual à aba Resumo da planilha). */
  const SUMMARY_COLUMNS = ["A", "B", "C", "D", "Gestão", "Administrativo", "Intermediária", "Capatazia Dia", "Capatazia Noite"];
  const CATEGORY_ORDER = ["Gestão", "Liderança", "Operação", "Apoio"];
  const ACTIVE = new Set(["Ativo", "Ativo (em transferência)"]);

  const mod = (value, size) => ((value % size) + size) % size;

  /** Equipes do dia: { day, night, dayOfBlock, intermediate } ou null antes do início do 2x2. */
  function rotation(date) {
    if (!S.isDate(date) || date < CYCLE_START) return null;
    const position = mod(S.daysBetween(REFERENCE, date), 4);
    return {
      day: position < 2 ? "A" : "B", night: position < 2 ? "C" : "D", dayOfBlock: position % 2 + 1,
      intermediate: position === 1 || position === 2 ? { works: true, dayOfBlock: position === 1 ? 1 : 2 } : { works: false, dayOfBlock: null }
    };
  }

  /**
   * O grupo trabalha no plantão que começa em `date`? → { works: true|false|null, dayOfBlock, reason }.
   * null = não se aplica (Gestão) ou desconhecido (antes do 2x2, equipe fora da lista).
   */
  function groupWorks(group, date) {
    const config = GROUPS[group];
    if (!config) return { works: null, reason: "equipe fora da lista de escalas" };
    if (config.kind === "none") return { works: null, reason: "sem escala" };
    if (config.kind === "5x2") return { works: WEEKDAYS.includes(S.weekday(date)), dayOfBlock: null };
    const turn = rotation(date);
    if (!turn) return { works: null, reason: "escala anterior ao 2x2 (antes de 01/06/2026)" };
    if (config.kind === "intermediate") return { works: turn.intermediate.works, dayOfBlock: turn.intermediate.dayOfBlock };
    const on = config.shift === "D" ? turn.day === group : turn.night === group;
    return { works: on, dayOfBlock: on ? turn.dayOfBlock : null };
  }

  /** Plantão em andamento num instante: { date, kind: "D" | "N", id } (o noturno pertence à data em que começou). */
  function currentShift(instant = new Date()) {
    const id = S.shiftIdAt(instant, HOURS);
    return { id, ...S.parseId(id) };
  }

  const inRange = (absence, date) => absence.start <= date && date <= absence.end;
  /** Ausência da pessoa na data (férias/afastamento da aba Férias) ou o próprio status "Afastado (INSS)". */
  function absenceOf(person, date, absences = []) {
    const found = absences.find(item => !item.person.external && item.person.id === person.id && inRange(item, date));
    if (found) return found;
    if (person.status === "Afastado (INSS)") return { motive: "Afastado (INSS)", start: null, end: null, cover: null, coverStatus: "não informada", fromStatus: true };
    return null;
  }
  /** Ausências que a pessoa está cobrindo na data. */
  function coveringOn(person, date, absences = []) {
    return absences.filter(item => item.cover && !item.cover.external && item.cover.id === person.id && inRange(item, date));
  }

  const byRole = (people, roleOrder = []) => {
    const order = new Map(roleOrder.map((role, index) => [role, index]));
    return [...people].sort((a, b) => (order.get(a.role) ?? 99) - (order.get(b.role) ?? 99) || a.role.localeCompare(b.role) || a.name.localeCompare(b.name));
  };

  /**
   * Quem está escalado num plantão. date = data de início; kind = "D" (dia) ou "N" (noite) ou null (os dois).
   * Para cada grupo que trabalha: presentes (por função), ausentes (com a cobertura) e quem está cobrindo alguém.
   */
  function roster(date, people, absences = [], { kind = null, roleOrder = [] } = {}) {
    const groups = [];
    Object.entries(GROUPS).forEach(([group, config]) => {
      if (config.kind === "none" || (kind && config.shift !== kind)) return;
      const status = groupWorks(group, date);
      if (!status.works) return;
      const members = people.filter(person => person.team === group);
      if (!members.length) return;
      const present = [], absent = [];
      members.forEach(person => {
        const absence = absenceOf(person, date, absences);
        if (absence) absent.push({ person, absence });
        else present.push(person);
      });
      groups.push({ group, ...config, dayOfBlock: status.dayOfBlock, present: byRole(present, roleOrder), absent: absent.sort((a, b) => a.person.name.localeCompare(b.person.name)) });
    });
    // Quem cobre alguém neste dia (pode ser de outra equipe ou estar de folga na própria escala).
    const covering = people.map(person => ({ person, absences: coveringOn(person, date, absences) })).filter(item => item.absences.length);
    return { date, kind, rotation: rotation(date), groups, covering };
  }

  /** Mês do calendário: para cada dia, as equipes do dia e da noite e quantas pessoas estão fora. */
  function month(year, monthNumber, people = [], absences = []) {
    const first = `${year}-${String(monthNumber).padStart(2, "0")}-01`;
    const days = [];
    for (let date = first; date.slice(0, 7) === first.slice(0, 7); date = S.addDays(date, 1)) {
      const turn = rotation(date);
      const out = absences.filter(item => inRange(item, date) && !item.person.external).length;
      days.push({ date, weekday: S.weekday(date), day: turn?.day || null, night: turn?.night || null, dayOfBlock: turn?.dayOfBlock || null, intermediate: turn?.intermediate.works || false, out });
    }
    return days;
  }

  /** Quadro como na aba Resumo: totais, função × equipe (por categoria) e números por equipe do 2x2. */
  function summary(people, lists = { roles: [] }) {
    const count = (list, predicate = () => true) => list.filter(predicate).length;
    const totals = {
      total: people.length,
      active: count(people, person => ACTIVE.has(person.status)),
      inss: count(people, person => person.status === "Afastado (INSS)"),
      transfer: count(people, person => person.status === "Ativo (em transferência)")
    };
    const roleCategory = new Map((lists.roles || []).map(item => [item.role, item.category]));
    const roles = [...new Set([...(lists.roles || []).map(item => item.role), ...people.map(person => person.role)])].filter(role => people.some(person => person.role === role));
    const row = list => ({
      columns: Object.fromEntries(SUMMARY_COLUMNS.map(column => [column, count(list, person => person.team === column)])),
      total: list.length, inss: count(list, person => person.status === "Afastado (INSS)"), transfer: count(list, person => person.status === "Ativo (em transferência)")
    });
    const categories = CATEGORY_ORDER.concat([...new Set(people.map(person => person.category))].filter(category => !CATEGORY_ORDER.includes(category)))
      .map(category => {
        const categoryRoles = roles.filter(role => (roleCategory.get(role) || people.find(person => person.role === role)?.category) === category);
        const members = people.filter(person => categoryRoles.includes(person.role));
        return { category, roles: categoryRoles.map(role => ({ role, ...row(people.filter(person => person.role === role)) })), subtotal: row(members) };
      }).filter(item => item.roles.length);
    const teams = ["A", "B", "C", "D"].map(team => {
      const members = people.filter(person => person.team === team);
      return { team, ...GROUPS[team], total: members.length, active: count(members, person => ACTIVE.has(person.status)), inss: count(members, person => person.status === "Afastado (INSS)"), transfer: count(members, person => person.status === "Ativo (em transferência)") };
    });
    return { totals, columns: SUMMARY_COLUMNS, categories, grandTotal: row(people), teams };
  }

  const overlap = (a, b) => {
    const start = a.start > b.start ? a.start : b.start, end = a.end < b.end ? a.end : b.end;
    return start <= end ? { start, end } : null;
  };
  /**
   * Alertas de férias e coberturas para ausências que terminam em `from` ou depois:
   * - mesma função e equipe fora ao mesmo tempo;
   * - ausência sem cobertura (marcada "NÃO"/"Sem cobertura" ou não informada);
   * - quem cobre também está fora no período.
   */
  function conflicts(absences, people, { from = "0000-00-00" } = {}) {
    const byId = new Map(people.map(person => [person.id, person]));
    const relevant = absences.filter(item => item.end >= from && !item.person.external && byId.has(item.person.id));
    const alerts = [];
    for (let i = 0; i < relevant.length; i++) {
      for (let j = i + 1; j < relevant.length; j++) {
        const a = relevant[i], b = relevant[j];
        if (a.person.id === b.person.id) continue;
        const pa = byId.get(a.person.id), pb = byId.get(b.person.id);
        const period = pa.role === pb.role && pa.team === pb.team ? overlap(a, b) : null;
        if (period) alerts.push({ type: "mesma função e equipe", level: "atenção", absences: [a, b], period, text: `${pa.name} e ${pb.name} (${pa.role}, ${pa.team}) fora ao mesmo tempo` });
      }
      const item = relevant[i];
      if (item.coverStatus !== "com cobertura") alerts.push({ type: "sem cobertura", level: item.coverStatus === "sem cobertura" ? "atenção" : "informação", absences: [item], period: { start: item.start, end: item.end }, text: `${byId.get(item.person.id).name}: ${item.coverStatus === "sem cobertura" ? "sem cobertura" : "cobertura não informada"}` });
      if (item.cover && !item.cover.external) {
        const busy = absences.find(other => other !== item && !other.person.external && other.person.id === item.cover.id && overlap(item, other));
        if (busy) alerts.push({ type: "cobertura também fora", level: "atenção", absences: [item, busy], period: overlap(item, busy), text: `${item.cover.name} cobre ${byId.get(item.person.id).name}, mas também está fora no período` });
      }
    }
    return alerts.sort((a, b) => a.period.start.localeCompare(b.period.start));
  }

  root.TpsTeam = { CYCLE_START, REFERENCE, HOURS, GROUPS, SUMMARY_COLUMNS, rotation, groupWorks, currentShift, absenceOf, coveringOn, roster, month, summary, conflicts };
})(typeof window !== "undefined" ? window : globalThis);
