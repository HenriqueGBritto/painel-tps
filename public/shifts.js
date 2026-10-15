/* Turnos operacionais e escala 2x2 da aba Atividades.
   Funções puras, usadas no navegador e na API (netlify/lib/activities.mjs) e testadas em tests/shifts.test.mjs.
   Carregado como script comum no navegador: expõe window.TpsShifts.

   Turno operacional = data de início + D (Diurno) ou N (Noturno), ex.: "2026-10-14_N".
   O Noturno atravessa a meia-noite: 02:00 do dia 15 pertence a "2026-10-14_N".
   Todos os horários são de Brasília (America/Sao_Paulo), qualquer que seja o fuso da máquina. */
(function (root) {
  const TZ = "America/Sao_Paulo";
  const DAY = 86400000;
  const DEFAULT_HOURS = { dayStart: "07:00", nightStart: "19:00" };
  const KINDS = { D: "Diurno", N: "Noturno" };
  const WEEKDAYS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
  const ID_PATTERN = /^(20\d\d-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))_([DN])$/;
  const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

  const partsFormat = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });

  /** Data e hora de Brasília de um instante. */
  function zonedParts(date) {
    const p = Object.fromEntries(partsFormat.formatToParts(new Date(date)).map(part => [part.type, part.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute), second: Number(p.second) };
  }

  const minutesOf = time => { const m = TIME_PATTERN.exec(time || ""); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  const isTime = time => TIME_PATTERN.test(time || "");
  const isDate = value => /^20\d\d-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value || "");
  const dayNumber = iso => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / DAY;
  const addDays = (iso, days) => new Date((dayNumber(iso) + days) * DAY).toISOString().slice(0, 10);
  const daysBetween = (from, to) => dayNumber(to) - dayNumber(from);
  const weekday = iso => new Date(dayNumber(iso) * DAY).getUTCDay();

  /** Instante (Date) de uma data e hora de Brasília. Corrige pelo deslocamento do fuso naquele instante. */
  function zonedTime(iso, time) {
    const minutes = minutesOf(time);
    const guess = (dayNumber(iso) * DAY) + minutes * 60000;
    const offsetAt = instant => { const p = zonedParts(instant); return dayNumber(p.date) * DAY + (p.hour * 60 + p.minute) * 60000 + p.second * 1000 - instant; };
    let result = guess - offsetAt(guess);
    result = guess - offsetAt(result);
    return new Date(result);
  }

  const makeId = (date, kind) => `${date}_${kind}`;
  function parseId(id) {
    const match = ID_PATTERN.exec(id || "");
    return match ? { date: match[1], kind: match[2] } : null;
  }
  const isShiftId = id => Boolean(parseId(id));

  /** Turno operacional em que cai um instante. */
  function shiftIdAt(instant, hours = DEFAULT_HOURS) {
    const p = zonedParts(instant);
    const now = p.hour * 60 + p.minute;
    const dayStart = minutesOf(hours.dayStart), nightStart = minutesOf(hours.nightStart);
    if (now >= dayStart && now < nightStart) return makeId(p.date, "D");
    if (now >= nightStart) return makeId(p.date, "N");
    return makeId(addDays(p.date, -1), "N");
  }

  /** Início e fim (Date) de um turno. */
  function bounds(id, hours = DEFAULT_HOURS) {
    const { date, kind } = parseId(id);
    return kind === "D"
      ? { start: zonedTime(date, hours.dayStart), end: zonedTime(date, hours.nightStart) }
      : { start: zonedTime(date, hours.nightStart), end: zonedTime(addDays(date, 1), hours.dayStart) };
  }

  /** Diurno → Noturno do mesmo dia → Diurno do dia seguinte. */
  function next(id) { const { date, kind } = parseId(id); return kind === "D" ? makeId(date, "N") : makeId(addDays(date, 1), "D"); }
  function previous(id) { const { date, kind } = parseId(id); return kind === "N" ? makeId(date, "D") : makeId(addDays(date, -1), "N"); }

  /** Turnos de `from` (inclusive) a `to` (inclusive), em ordem. */
  function range(fromDate, toDate) {
    const ids = [];
    for (let date = fromDate; date <= toDate && ids.length < 800; date = addDays(date, 1)) ids.push(makeId(date, "D"), makeId(date, "N"));
    return ids;
  }

  /**
   * Horário da atividade dentro do turno. No Noturno, horários antes do início do Diurno
   * (ex.: 02:00) caem no dia seguinte à data do turno.
   */
  function dueAt(id, time, hours = DEFAULT_HOURS) {
    if (!isTime(time)) return null;
    const { date, kind } = parseId(id);
    const nextDay = kind === "N" && minutesOf(time) < minutesOf(hours.dayStart);
    return zonedTime(nextDay ? addDays(date, 1) : date, time);
  }

  /**
   * Quem do rodízio trabalha num dia. rotation = { members: [id, id], blockDays: 2, referenceDate }
   * referenceDate = dia em que members[0] faz o 1º dia do seu bloco. Vale para datas antes e depois dela.
   */
  function rotationAt(rotation, date) {
    const members = (rotation?.members || []).filter(Boolean);
    const block = Math.max(1, Math.floor(rotation?.blockDays || 2));
    if (!members.length || !isDate(rotation?.referenceDate)) return null;
    const cycle = members.length * block;
    const position = ((daysBetween(rotation.referenceDate, date) % cycle) + cycle) % cycle;
    return { assistantId: members[Math.floor(position / block)], dayOfBlock: position % block + 1 };
  }

  /**
   * Escalado num turno: o ajuste pontual (troca, falta, cobertura) tem prioridade sobre o rodízio.
   * config.rotations = { D: rotation, N: rotation }; overrides = { [shiftId]: { assistantId, reason } }.
   */
  function scheduledFor(id, config, overrides = {}) {
    const { date, kind } = parseId(id);
    const override = overrides[id];
    if (override?.assistantId) return { assistantId: override.assistantId, source: "ajuste", reason: override.reason || "", dayOfBlock: null };
    const slot = rotationAt(config?.rotations?.[kind], date);
    return slot ? { ...slot, source: "escala", reason: "" } : { assistantId: null, source: "sem escala", reason: "", dayOfBlock: null };
  }

  /**
   * O modelo vale para o turno? template.shift = "D" | "N" | "both";
   * template.weekdays = dias da semana (0 = domingo) pela data de início do turno; vazio = todos.
   */
  function templateApplies(template, id) {
    if (!template || template.active === false) return false;
    const { date, kind } = parseId(id);
    if (template.shift !== "both" && template.shift !== kind) return false;
    const days = Array.isArray(template.weekdays) ? template.weekdays : [];
    return !days.length || days.includes(weekday(date));
  }

  /** Momentos de alerta de uma atividade: no horário e, se pedido, X minutos antes. */
  function alertTimes(task) {
    if (!task?.dueAt) return [];
    const due = Date.parse(task.dueAt);
    if (!Number.isFinite(due)) return [];
    const before = Math.max(0, Math.floor(Number(task.remindBefore) || 0));
    return [...(before ? [{ kind: "antes", at: due - before * 60000, minutes: before }] : []), { kind: "horario", at: due, minutes: 0 }];
  }

  const brDate = iso => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
  /** "Diurno · 14/10/2026" ou "Noturno · 14/10 → 15/10/2026". */
  function label(id) {
    const { date, kind } = parseId(id);
    if (kind === "D") return `Diurno · ${brDate(date)}`;
    const end = addDays(date, 1);
    return `Noturno · ${brDate(date).slice(0, 5)} → ${brDate(end)}`;
  }

  root.TpsShifts = { TZ, DEFAULT_HOURS, KINDS, WEEKDAYS, zonedParts, zonedTime, isTime, isDate, minutesOf, addDays, daysBetween, weekday,
    makeId, parseId, isShiftId, shiftIdAt, bounds, next, previous, range, dueAt, rotationAt, scheduledFor, templateApplies, alertTimes, label };
})(typeof window !== "undefined" ? window : globalThis);
