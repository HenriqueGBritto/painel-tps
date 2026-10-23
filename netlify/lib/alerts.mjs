/* Alertas do painel (sino no cabeçalho). Calculados na hora, a partir do que já está guardado:
   - planilha de navios sem nenhuma alteração há mais de 24 horas, ou lida da cópia de reserva;
   - planilha de indicadores sem descarga registrada há mais de 2 dias, ou lida da cópia de reserva;
   - descarga do mês abaixo do ritmo para cumprir o plano;
   - atividades atrasadas no turno atual;
   - turno atual começou há mais de 30 minutos e ninguém confirmou o recebimento da passagem.
   Cada pessoa só recebe os alertas das telas que tem liberadas. Testado em tests/alerts.test.mjs. */
import "../../public/metrics.js";
import "../../public/shifts.js";
import { getConfig, COLLECTIONS } from "./activities.mjs";

const M = globalThis.TpsMetrics;
const S = globalThis.TpsShifts;
const HOUR = 60 * 60 * 1000;
export const LIMITS = { operationsQuietHours: 24, dischargeQuietDays: 2, receiveGraceMinutes: 30 };

const tons = value => `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 }).format(value)} t`;
const percent = value => `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 }).format(value * 100)}%`;
const brDay = iso => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const time = value => new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
const brToday = now => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(now);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

/** Planilha de navios: reserva ou nenhuma alteração encontrada nas leituras das últimas 24 horas. */
export function operationsAlerts(data, now = new Date()) {
  if (!data) return [];
  if (data.origin === "fallback") return [{ id: "navios-reserva", level: "critical", area: "Planilha de navios", view: "operacional", title: "A planilha de navios não pôde ser lida", detail: "O painel está mostrando a cópia de reserva. Confira o compartilhamento da planilha no Google." }];
  const lastChange = data.changeLog?.[0]?.at;
  if (!lastChange) return [];
  const hours = (now - Date.parse(lastChange)) / HOUR;
  if (hours <= LIMITS.operationsQuietHours) return [];
  const days = Math.floor(hours / 24);
  return [{ id: "navios-parada", level: "warning", area: "Planilha de navios", view: "operacional", title: `Planilha de navios sem alteração há ${days === 1 ? "1 dia" : `${days} dias`}`, detail: `A última alteração encontrada foi na leitura de ${brDay(brToday(new Date(lastChange)))} às ${time(lastChange)}. Confira se a planilha está sendo alimentada.` }];
}

/** Planilha de indicadores: reserva, descarga parada e previsão do mês abaixo do plano. */
export function dischargeAlerts(data, now = new Date()) {
  if (!data) return [];
  if (data.origin === "fallback") return [{ id: "indicadores-reserva", level: "critical", area: "Planilha de indicadores", view: "descarga", title: "A planilha de indicadores não pôde ser lida", detail: "O painel está mostrando a cópia de reserva. Confira o compartilhamento da planilha no Google." }];
  const alerts = [];
  const days = data.dischargeDays || [];
  const today = brToday(now);
  const last = days.reduce((max, row) => row.date > max ? row.date : max, "");
  if (last && daysBetween(last, today) > LIMITS.dischargeQuietDays) {
    alerts.push({ id: "descarga-parada", level: "warning", area: "Descarga", view: "descarga", title: `Sem descarga registrada desde ${brDay(last)}`, detail: `A planilha de indicadores não tem descarga FINALIZADO há ${daysBetween(last, today)} dias. Confira se ela está sendo preenchida.` });
  }
  const year = Number(today.slice(0, 4)), month = Number(today.slice(5, 7));
  const plan = (data.plans || []).find(item => item.year === year && item.month === month) || {};
  const forecast = M.monthForecast(days, { year, month, plan: plan.plan, challenge: plan.challenge });
  const target = forecast?.plan;
  if (target && !target.reached && !target.onTrack && forecast.remaining > 0) {
    alerts.push({
      id: `descarga-ritmo-${year}-${month}`, level: target.share < 0.9 ? "warning" : "info", area: "Descarga", view: "descarga",
      title: `Descarga de ${MONTHS[month - 1]} abaixo do ritmo do plano`,
      detail: `No ritmo atual (${tons(forecast.pace)}/dia), o mês fecha em ${tons(forecast.projection)}, ${percent(target.share)} do plano de ${tons(target.value)}. Para cumprir, faltam ${tons(target.missing)}: ${tons(target.neededPerDay)} por dia nos ${forecast.remaining} dias que restam.`
    });
  }
  return alerts;
}

/** Turno atual: atividades atrasadas e passagem não recebida. Só lê; não cria o turno. */
export async function activityAlerts(store, now = new Date()) {
  if (!store) return [];
  const config = await getConfig(store);
  const shiftId = S.shiftIdAt(now, config.hours);
  const shift = await store.get(COLLECTIONS.shifts, shiftId);
  if (!shift) return [];
  const alerts = [];
  const tasks = await store.list(`shifts/${shiftId}/tasks`);
  const late = tasks.filter(task => task.status === "pending" && task.dueAt && Date.parse(task.dueAt) < now).sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  if (late.length) {
    const names = late.slice(0, 3).map(task => `${task.title} (${time(task.dueAt)})`).join("; ");
    alerts.push({ id: `atividades-atrasadas-${shiftId}`, level: "warning", area: "Atividades", view: "atividades", title: `${late.length} ${late.length === 1 ? "atividade atrasada" : "atividades atrasadas"} no ${S.label(shiftId)}`, detail: `${names}${late.length > 3 ? ` e mais ${late.length - 3}` : ""}.` });
  }
  const startedMinutes = (now - Date.parse(shift.start)) / 60000;
  if (!shift.received && !shift.handover && startedMinutes > LIMITS.receiveGraceMinutes) {
    const who = shift.scheduled?.name ? ` (escalado: ${shift.scheduled.name})` : "";
    alerts.push({ id: `turno-nao-recebido-${shiftId}`, level: "warning", area: "Atividades", view: "atividades", title: `Passagem do turno ainda não recebida`, detail: `O ${S.label(shiftId)} começou às ${time(shift.start)} e ninguém confirmou o recebimento da passagem${who}.` });
  }
  return alerts;
}

/** Requisições de estiva de ontem a amanhã ainda reprovadas ou com pontos a confirmar (sem aprovação justificada). */
export async function requisitionAlerts(store, now = new Date()) {
  if (!store) return [];
  const today = brToday(now);
  const add = (iso, days) => new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + days)).toISOString().slice(0, 10);
  const rows = (await store.list("requisitions", { from: `${add(today, -1)}_`, to: `${add(today, 1)}_~` })).filter(row => !row.override && !row.cancelled);
  const label = row => `${row.number} (${row.period.replace("-", "x")} de ${brDay(row.date)})`;
  const alerts = [];
  // Verificação automática no OGMO (robot/ogmo.mjs): o que falta pedir antes do limite, rodada com erro ou parada.
  const sync = await store.get("requisitionSync", "status");
  if (sync) {
    const nowLocal = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(now).replace(" ", "T");
    const missing = (sync.missing || []).filter(item => item.deadline > nowLocal);
    if (missing.length) alerts.push({ id: `requisicoes-faltando-${missing.map(item => `${item.date}${item.period}${item.vessel}`).join(",")}`, level: "critical", area: "Requisições", view: "requisicoes",
      title: `${missing.length === 1 ? "Falta 1 requisição de estiva" : `Faltam ${missing.length} requisições de estiva`} no OGMO`,
      detail: `${missing.slice(0, 4).map(item => `${item.vessel}: ${item.period.replace("-", "x")} (limite ${item.deadline.slice(11, 16)})`).join("; ")}.` });
    const lastRun = Date.parse(sync.lastRunAt || 0);
    if (sync.error && Date.parse(sync.errorAt || 0) > lastRun) alerts.push({ id: `ogmo-erro-${sync.errorAt}`, level: "warning", area: "Requisições", view: "requisicoes", title: "A verificação no OGMO falhou", detail: sync.error });
    else if (lastRun && now - lastRun > 150 * 60000) alerts.push({ id: `ogmo-parada-${sync.lastRunAt}`, level: "warning", area: "Requisições", view: "requisicoes", title: "A verificação no OGMO está parada", detail: `A última rodada foi em ${time(sync.lastRunAt)} de ${brDay(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date(sync.lastRunAt)))}. Confira o GitHub Actions (Verificação OGMO).` });
  }
  const rejected = rows.filter(row => row.check?.result === "reprovado");
  const pending = rows.filter(row => row.check?.result === "confirmar");
  if (rejected.length) alerts.push({ id: `requisicoes-reprovadas-${rejected.map(row => row.id).join(",")}`, level: "critical", area: "Requisições", view: "requisicoes", title: `${rejected.length} ${rejected.length === 1 ? "requisição de estiva reprovada" : "requisições de estiva reprovadas"}`, detail: `${rejected.slice(0, 4).map(label).join("; ")}. Corrija no OGMO antes do horário-limite ou aprove com justificativa.` });
  if (pending.length) alerts.push({ id: `requisicoes-confirmar-${pending.map(row => row.id).join(",")}`, level: "warning", area: "Requisições", view: "requisicoes", title: `${pending.length} ${pending.length === 1 ? "requisição de estiva" : "requisições de estiva"} com pontos a confirmar`, detail: `${pending.slice(0, 4).map(label).join("; ")}.` });
  return alerts;
}

const ORDER = { critical: 0, warning: 1, info: 2 };

/**
 * Alertas de uma pessoa, conforme os acessos dela. `sources` permite trocar as leituras nos testes.
 * Uma fonte que falha não derruba as outras.
 */
export async function alertsFor(user, { now = new Date(), readOperations, readDischarge, store } = {}) {
  const has = key => user.permissions.includes(key);
  const jobs = [];
  if (has("indicadores") || has("lineup")) jobs.push(readOperations().then(data => operationsAlerts(data, now)));
  if (has("indicadores")) jobs.push(readDischarge().then(data => dischargeAlerts(data, now)));
  if (has("atividades") || has("atividades-config")) jobs.push(activityAlerts(store, now));
  if (has("requisicoes")) jobs.push(requisitionAlerts(store, now));
  const results = await Promise.allSettled(jobs);
  results.filter(result => result.status === "rejected").forEach(result => console.error("Falha ao calcular alertas:", result.reason));
  return results.flatMap(result => result.status === "fulfilled" ? result.value : []).sort((a, b) => ORDER[a.level] - ORDER[b.level]);
}
