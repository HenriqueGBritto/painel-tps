const MONTHS = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
const MONTHS_FULL = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];

const state = { records: [], activeRecords: [], years: new Set(), months: new Set(), chartPoints: [], gusaRecords: [], gusaActiveRecords: [], lineupRecords: [], lineupDisplayRecords: [], tideDays: null, tidePeaks: [], menu: "indicadores", indicator: "operacional", lineupView: "planejamento", activityView: "turno", teamView: "resumo", gusaMonths: new Set(), activeDrawer: null, dataUpdatedAt: null };
const fmtInt = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
const fmtOne = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmtTwo = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", year: "numeric" });
const fmtDateTime = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

const $ = (id) => document.getElementById(id);
const parseDate = (value) => value ? new Date(value) : null;

function selected(records = state.records) {
  return records.filter(r => (!state.years.size || state.years.has(r.year)) && (!state.months.size || state.months.has(r.month)));
}

function setupFilters() {
  const years = [...new Set(state.records.map(r => r.year))].sort();
  $("yearFilters").innerHTML = years.map(y => `<label class="filter-option"><input type="checkbox" value="${y}" aria-label="${y}"><span>${y}</span></label>`).join("");
  $("monthFilters").innerHTML = MONTHS_FULL.map((m, i) => `<label class="filter-option"><input type="checkbox" value="${i + 1}" aria-label="${m}"><span>${m}</span></label>`).join("");
  bindFilterGroup("yearFilters", state.years);
  bindFilterGroup("monthFilters", state.months);
  $("clearFilters").addEventListener("click", () => { state.years.clear(); state.months.clear(); document.querySelectorAll(".filter-option input").forEach(c => c.checked=false); updateFilterSummaries(); render(); syncUrl(); });
  document.addEventListener("click", event => document.querySelectorAll(".multi-select[open]").forEach(d => { if(!d.contains(event.target)) d.removeAttribute("open"); }));
}

function bindFilterGroup(id, selection) {
  $(id).addEventListener("change", (event) => {
    const input = event.target.closest("input"); if (!input) return;
    const value = Number(input.value);
    input.checked ? selection.add(value) : selection.delete(value);
    updateFilterSummaries(); render(); syncUrl();
  });
}

function updateFilterSummaries(){
  $("yearSummary").textContent=state.years.size?[...state.years].sort().join(", "):"Todos os anos";
  $("monthSummary").textContent=state.months.size===0?"Todos os meses":state.months.size===1?MONTHS_FULL[[...state.months][0]-1]:`${state.months.size} meses selecionados`;
}

/* Cálculos dos KPIs em metrics.js (testados em tests/metrics.test.mjs). */
function occupancy(records, periodRecords = records) {
  return TpsMetrics.occupancy(records, state.years, state.months, periodRecords);
}

const KPI_FIELDS = [["vessels", "kpiVesselsDelta"], ["tons", "kpiTonsDelta"], ["productivity", "kpiProductivityDelta"], ["occupancy", "kpiOccupancyDelta"]];

/* Variação contra o período anterior equivalente. Positivo em grafite, negativo em vermelho. */
function renderKpiDeltas(current) {
  const period = TpsMetrics.previousPeriod(state.years, state.months, new Date());
  const previous = period ? TpsMetrics.previousKpis(state.records, period) : null;
  KPI_FIELDS.forEach(([field, id]) => {
    const node = $(id);
    if (!node) return;
    // Em período em andamento a ocupação usa a capacidade do mês inteiro; a comparação ficaria distorcida.
    const change = period && !(field === "occupancy" && period.inProgress) ? TpsMetrics.kpiVariation(field, current, previous) : null;
    node.hidden = !change;
    if (!change) { node.textContent = ""; delete node.dataset.direction; return; }
    const arrow = change.direction === "up" ? "▲" : change.direction === "down" ? "▼" : "=";
    node.dataset.direction = change.direction;
    node.textContent = `${arrow} ${fmtOne.format(Math.abs(change.pct))}% vs. ${period.label}`;
    node.setAttribute("aria-label", `${change.direction === "up" ? "Alta" : change.direction === "down" ? "Queda" : "Estável"} de ${fmtOne.format(Math.abs(change.pct))}% em relação a ${period.label}`);
  });
}

function render() {
  const data = selected();
  $("chartTooltip").style.opacity = 0;
  const kpi = TpsMetrics.kpis(state.records, state.years, state.months);
  $("kpiVessels").textContent = fmtInt.format(kpi.vessels);
  $("kpiTons").textContent = fmtTwo.format(kpi.tons) + " t";
  $("kpiProductivity").textContent = fmtTwo.format(kpi.productivity) + " t/dia";
  $("kpiOccupancy").textContent = fmtOne.format(kpi.occupancy) + "%";
  renderKpiDeltas(kpi);
  const activeCount = activeSelection().length;
  $("kpiVesselsNote").textContent = `${fmtInt.format(activeCount)} ${activeCount===1?"navio em atendimento":"navios em atendimento"}`;
  $("selectionSummary").textContent = selectionText(data.length);
  renderChart(data); renderCargoChart(data); renderBreakdowns(data); renderActiveOverview(); renderOccupancyBreakdown(data);
}

function renderOccupancyBreakdown(records){
  const berths=[...new Set(records.map(r=>r.berth))].sort((a,b)=>a.localeCompare(b,"pt-BR"));
  $("occupancyBreakdown").innerHTML=berths.length?berths.map(berth=>{
    const value=occupancy(records.filter(r=>r.berth===berth),records);
    return `<div class="occupancy-row"><div><strong>${escapeHtml(berth)}</strong><span>${fmtOne.format(value)}%</span></div><div class="occupancy-track"><i style="width:${Math.max(0,Math.min(100,value))}%"></i></div></div>`;
  }).join(""):'<div class="empty">Nenhum berço nos filtros selecionados.</div>';
}

function activeSelection(){return state.activeRecords.filter(r=>(!state.years.size||state.years.has(r.year))&&(!state.months.size||state.months.has(r.month)))}

function berthOccupation(startValue){
  const start=parseDate(startValue);
  if(!start||Number.isNaN(start.getTime()))return "tempo não disponível";
  return formatDuration(Date.now()-start.getTime());
}

function formatDuration(milliseconds){
  const minutes=Math.max(0,Math.floor(milliseconds/60000));
  const days=Math.floor(minutes/1440),hours=Math.floor(minutes%1440/60),remaining=minutes%60;
  return `${days?`${days} ${days===1?"dia":"dias"} e `:""}${hours} h ${String(remaining).padStart(2,"0")} min`;
}

function completedBerthOccupation(record){
  const start=parseDate(record.berthStart),end=parseDate(record.berthEnd);
  return start&&end&&end>=start?formatDuration(end-start):"tempo não disponível";
}

function renderActiveOverview(){
  const rows=activeSelection();
  $("activeOverview").hidden=!rows.length;
  $("activeOverviewList").innerHTML=rows.map((r,index)=>`<button type="button" class="active-item active-item-button" data-active-overview="${index}" aria-label="Ver detalhes da operação do navio ${escapeHtml(r.vessel)}"><div><strong>${escapeHtml(r.vessel)}</strong><span>${escapeHtml(r.operation)} · ${escapeHtml(r.berth)}</span><span>Atracação: ${r.berthStart?fmtDateTime.format(parseDate(r.berthStart)):"data não informada"}</span><span>Ocupação de berço: ${berthOccupation(r.berthStart)}</span></div><div class="active-weight"><strong>${fmtTwo.format(r.partialTons)} t</strong><span>volume parcial</span></div></button>`).join("");
}

function selectionText(count) {
  const years = state.years.size ? [...state.years].sort().join(", ") : "todos os anos";
  const months = state.months.size ? [...state.months].sort((a,b)=>a-b).map(m => MONTHS_FULL[m-1].toLowerCase()).join(", ") : "todos os meses";
  return `${fmtInt.format(count)} operações em ${years} • ${months}`;
}

function monthlyData(records) {
  const keys = [...new Set(records.map(r => `${r.year}-${String(r.month).padStart(2,"0")}`))].sort();
  return keys.map(key => { const [year,month] = key.split("-").map(Number); const rows = records.filter(r => r.year === year && r.month === month); return { key, year, month, label: `${MONTHS[month-1]}/${String(year).slice(-2)}`, rows, tons: rows.reduce((s,r)=>s+r.tons,0), vessels: rows.length }; });
}

/* Evolução mensal em dois painéis alinhados pelo mesmo eixo de meses:
   volume (t) em cima, em vermelho, e navios embaixo, em grafite. Cada painel tem o seu eixo Y. */
function renderChart(records) {
  const canvas = $("monthlyChart"), wrap = canvas.parentElement, scroller = wrap.parentElement, ratio = window.devicePixelRatio || 1;
  const points = monthlyData(records); state.chartPoints = [];
  $("monthlyDataRows").innerHTML = points.map(p => `<tr><td>${MONTHS_FULL[p.month-1]} ${p.year}</td><td>${fmtTwo.format(p.tons)}</td><td>${p.vessels}</td></tr>`).join("") || '<tr><td colspan="3">Sem dados no período.</td></tr>';
  const peak = [...points].sort((a,b) => b.tons-a.tons)[0];
  $("monthlyInsight").textContent = peak ? `Leitura: maior volume em ${MONTHS_FULL[peak.month-1]} de ${peak.year}, com ${fmtTwo.format(peak.tons)} t e ${peak.vessels} navios. Volume e quantidade de navios usam o mês de início da operação.` : "Leitura: não há operações concluídas para os filtros selecionados.";
  wrap.style.width = `${Math.max(scroller.clientWidth, points.length * 58 + 96)}px`;
  const width = wrap.clientWidth, height = wrap.clientHeight; canvas.width = width * ratio; canvas.height = height * ratio;
  const ctx = canvas.getContext("2d"); ctx.scale(ratio, ratio); ctx.clearRect(0,0,width,height);
  if (!points.length) { ctx.fillStyle="#8A8C91"; ctx.font="700 15px DIN, Arial Narrow, Arial, sans-serif"; ctx.textAlign="center"; ctx.fillText("Nenhum dado para os filtros selecionados", width/2, height/2); return; }
  const pad = { left:68, right:28, top:28, bottom:62 }, gapBetween = 44;
  const plotH = height - pad.top - pad.bottom - gapBetween;
  const panels = [
    { key:"tons", title:"Volume (t)", color:"#DA202C", top:pad.top, h:Math.round(plotH*.62),
      max:Math.ceil(Math.max(...points.map(p=>p.tons))*1.18/50000)*50000 || 1,
      label:v => v>=1000?`${fmtOne.format(v/1000)} mil`:fmtInt.format(v) },
    { key:"vessels", title:"Navios", color:"#2F2F2F", h:0,
      max:Math.max(4, Math.ceil(Math.max(...points.map(p=>p.vessels))*1.25/2)*2),
      label:v => fmtInt.format(v) }
  ];
  panels[1].top = panels[0].top + panels[0].h + gapBetween; panels[1].h = plotH - panels[0].h;
  const cw = width - pad.left - pad.right, slot = cw / points.length, barW = Math.min(26, slot * .56);
  const xOf = i => pad.left + slot * i + slot / 2;
  ctx.textBaseline = "middle";
  panels.forEach(panel => {
    const base = panel.top + panel.h, ticks = panel.key === "vessels" ? 2 : 4;
    ctx.fillStyle = "#2F2F2F"; ctx.font = "700 12px DIN, Arial Narrow, Arial, sans-serif"; ctx.textAlign = "left";
    ctx.fillText(panel.title.toUpperCase(), pad.left, panel.top - 16);
    ctx.font = "12px Poppins, Helvetica, Arial, sans-serif";
    for (let i = 0; i <= ticks; i++) {
      const y = panel.top + panel.h * i / ticks;
      ctx.strokeStyle = "#EAEAEA"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke();
      ctx.fillStyle = "#636363"; ctx.textAlign = "right"; ctx.fillText(fmtInt.format(panel.max * (1 - i / ticks)), pad.left - 10, y);
    }
    points.forEach((p, i) => {
      const value = p[panel.key], bh = panel.h * value / panel.max, x = xOf(i), y = base - bh;
      ctx.fillStyle = panel.color; roundRect(ctx, x - barW / 2, y, barW, bh, 3); ctx.fill();
      if (value > 0) { ctx.fillStyle = "#2F2F2F"; ctx.font = "700 11px DIN, Arial Narrow, Arial, sans-serif"; ctx.textAlign = "center"; ctx.fillText(panel.label(value), x, y - 9); }
      state.chartPoints.push({ x: x - slot / 2 + 2, y: panel.top, w: slot - 4, h: panel.h, point: p });
    });
    ctx.strokeStyle = "#B0B0B0"; ctx.beginPath(); ctx.moveTo(pad.left, base + .5); ctx.lineTo(width - pad.right, base + .5); ctx.stroke();
  });
  const baseline = panels[1].top + panels[1].h;
  ctx.font = "12px Poppins, Helvetica, Arial, sans-serif"; ctx.fillStyle = "#636363"; ctx.textAlign = "center";
  points.forEach((p, i) => ctx.fillText(MONTHS[p.month - 1], xOf(i), baseline + 17));
  let groupStart = 0;
  for (let i = 1; i <= points.length; i++) {
    if (i === points.length || points[i].year !== points[groupStart].year) {
      const firstX = pad.left + slot * groupStart, lastX = pad.left + slot * i;
      ctx.strokeStyle = "#D5D5D5"; ctx.beginPath(); ctx.moveTo(firstX + 4, baseline + 36); ctx.lineTo(lastX - 4, baseline + 36); ctx.stroke();
      ctx.fillStyle = "#2F2F2F"; ctx.font = "700 12px DIN, Arial Narrow, Arial, sans-serif"; ctx.fillText(String(points[groupStart].year), (firstX + lastX) / 2, baseline + 50);
      ctx.font = "12px Poppins, Helvetica, Arial, sans-serif";
      if (i < points.length) panels.forEach(panel => { ctx.strokeStyle = "#D5D5D5"; ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.moveTo(lastX, panel.top); ctx.lineTo(lastX, panel.top + panel.h); ctx.stroke(); ctx.setLineDash([]); });
      groupStart = i;
    }
  }
}

function roundRect(ctx,x,y,w,h,r){if(!(w>0&&h>0)){ctx.beginPath();return}r=Math.max(0,Math.min(r,w/2,h/2));ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath()}

function renderBreakdowns(records){const operations=group(records,"operation"),berths=group(records,"berth");renderBars("operationBreakdown",operations,4);renderBars("berthBreakdown",berths,5);[["operationInsight",operations,"operação"],["berthInsight",berths,"berço"]].forEach(([id,items,label])=>{const total=items.reduce((sum,item)=>sum+item.value,0),top=items[0];$(id).textContent=top?`Leitura: ${top.label} concentra ${formatCargoPercent(top.value/total)}% do volume por ${label} no filtro atual.`:"Leitura: sem volume no período selecionado."})}
function group(records,key){const map=new Map();records.forEach(r=>map.set(r[key],(map.get(r[key])||0)+r.tons));return [...map].map(([label,value])=>({label,value})).sort((a,b)=>b.value-a.value)}
function renderBars(id,items,limit){const rows=items.slice(0,limit),max=rows[0]?.value||1;$(id).innerHTML=rows.length?rows.map(x=>`<div class="bar-row"><span class="bar-label" title="${escapeHtml(x.label)}">${escapeHtml(x.label)}</span><div class="bar-track"><div class="bar-fill" style="width:${x.value/max*100}%"></div></div><span class="bar-value">${fmtTwo.format(x.value)} t</span></div>`).join(""):`<div class="empty">Sem dados.</div>`}
/* Ranking de barras horizontais: todas as cargas, com toneladas e percentual no rótulo.
   A maior carga em vermelho cheio; as demais em vermelho claro, para o destaque ficar evidente. */
function renderCargoChart(records){
  const {total,items}=TpsMetrics.cargoRanking(records);
  if(!total){$("cargoChart").innerHTML='<div class="empty">Sem volume para os filtros selecionados.</div>';$("cargoInsight").textContent="Leitura: sem volume no período selecionado.";return}
  const max=items[0].tons;
  const rows=items.map((item,index)=>`<li class="cargo-rank-row${index===0?" is-top":""}"><span class="cargo-rank-label" title="${escapeHtml(item.label)}">${escapeHtml(item.label)}</span><span class="cargo-rank-track" aria-hidden="true"><i style="width:${Math.max(.6,item.tons/max*100)}%"></i></span><span class="cargo-rank-value"><b>${formatCargoPercent(item.share)}%</b> ${fmtTwo.format(item.tons)} t</span></li>`).join("");
  $("cargoChart").innerHTML=`<p class="cargo-rank-total"><strong>${fmtTwo.format(total)} t</strong> em ${items.length} ${items.length===1?"carga":"cargas"}</p><ol class="cargo-rank" aria-label="Participação por carga, da maior para a menor">${rows}</ol>`;
  $("cargoInsight").textContent=`Leitura: ${items[0].label} lidera a composição, com ${formatCargoPercent(items[0].share)}% do volume filtrado.`;
}
function formatCargoPercent(share){const percent=share*100;return new Intl.NumberFormat("pt-BR",{minimumFractionDigits:percent<.01?3:2,maximumFractionDigits:percent<.01?3:2}).format(percent)}
function escapeHtml(value){return String(value).replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]))}

function handleChartMove(event){const rect=event.currentTarget.getBoundingClientRect(),x=event.clientX-rect.left,y=event.clientY-rect.top;const hit=state.chartPoints.find(p=>x>=p.x&&x<=p.x+p.w&&y>=p.y-24&&y<=p.y+p.h);const tip=$("chartTooltip");if(!hit){tip.style.opacity=0;event.currentTarget.style.cursor="default";return}event.currentTarget.style.cursor="pointer";tip.innerHTML=`<strong>${MONTHS_FULL[hit.point.month-1]} ${hit.point.year}</strong><br>${fmtTwo.format(hit.point.tons)} t · ${hit.point.vessels} ${hit.point.vessels===1?"navio":"navios"}`;tip.style.left=`${hit.x+hit.w/2}px`;tip.style.top=`${Math.max(40,hit.y)}px`;tip.style.opacity=1}
function handleChartClick(event){const rect=event.currentTarget.getBoundingClientRect(),x=event.clientX-rect.left,y=event.clientY-rect.top;const hit=state.chartPoints.find(p=>x>=p.x&&x<=p.x+p.w&&y>=p.y-24&&y<=p.y+p.h+10);if(hit)openDrawer(hit.point)}

function showDrawer(title,summary,content){
  state.activeDrawer=null;
  $("drawerTitle").textContent=title;
  $("drawerSummary").innerHTML=summary;
  $("vesselList").innerHTML=content;
  $("vesselDrawer").classList.add("open");$("drawerBackdrop").classList.add("open");$("vesselDrawer").setAttribute("aria-hidden","false");document.body.style.overflow="hidden";
  $("vesselDrawer").scrollTop=0;$("closeDrawer").focus();
}
function drawerStat(label,value){return `<div class="drawer-stat"><span>${label}</span><strong>${value}</strong></div>`}
function openDrawer(point){const summary=drawerStat("Navios atendidos",point.vessels)+drawerStat("Volume total",`${fmtTwo.format(point.tons)} t`);const content=[...point.rows].sort((a,b)=>new Date(a.operationStart||a.berthStart)-new Date(b.operationStart||b.berthStart)).map(r=>`<article class="vessel-item"><div class="vessel-top"><strong>${escapeHtml(r.vessel)}</strong><span class="vessel-ton">${fmtTwo.format(r.tons)} t</span></div><div class="vessel-meta"><span>${escapeHtml(r.operation)}</span><span>${escapeHtml(r.cargo)}</span><span>${escapeHtml(r.berth)}</span><span>Início: ${r.operationStart||r.berthStart?fmtDate.format(parseDate(r.operationStart||r.berthStart)):"data não informada"}</span></div></article>`).join("");showDrawer(`${MONTHS_FULL[point.month-1]} de ${point.year}`,summary,content)}

function matchingActiveRecord(record,rows){return rows.find(row=>row.year===record.year&&row.vessel.trim().toLocaleUpperCase("pt-BR")===record.vessel.trim().toLocaleUpperCase("pt-BR"))||null}
function vesselKey(value){return String(value||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]/gi,"").toUpperCase()}
function matchingLineupRecord(vessel){const key=vesselKey(vessel);if(!key||key==="TBN")return null;const matches=state.lineupRecords.filter(row=>vesselKey(row.vessel)===key);return matches.length===1?matches[0]:null}
function operationDetailRow(label,value){return `<div class="operation-detail-row"><span>${label}</span><strong>${value}</strong></div>`}
function operationalTimestamp(value){
  if(typeof value!=="string"||!value)return null;
  const explicitZone=/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  const date=new Date(explicitZone?value:`${value}-03:00`);
  return Number.isNaN(date.getTime())?null:date;
}
function lastCompletedPeriod(importedAt){
  const imported=parseDate(importedAt);
  if(!imported||Number.isNaN(imported.getTime()))return null;
  const parts=Object.fromEntries(new Intl.DateTimeFormat("en-US",{timeZone:"America/Sao_Paulo",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",hourCycle:"h23"}).formatToParts(imported).map(part=>[part.type,part.value]));
  const hour=Number(parts.hour);
  const closingHour=hour>=19?19:hour>=13?13:hour>=7?7:hour>=1?1:19;
  const day=new Date(Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day)-(hour<1?1:0)));
  const date=`${day.getUTCFullYear()}-${String(day.getUTCMonth()+1).padStart(2,"0")}-${String(day.getUTCDate()).padStart(2,"0")}`;
  return new Date(`${date}T${String(closingHour).padStart(2,"0")}:00:00-03:00`);
}
function activeForecast(overview,gusa,lineup){
  const produced=gusa?(Number.isFinite(gusa.berthDraftTons)?gusa.berthDraftTons:Number.isFinite(gusa.draftTons)&&Number.isFinite(gusa.offshoreDraftTons)?Math.max(0,gusa.draftTons-gusa.offshoreDraftTons):null):(Number.isFinite(overview?.partialTons)?overview.partialTons:null);
  const planned=Number.isFinite(lineup?.plannedBerthTons)&&lineup.plannedBerthTons>0?lineup.plannedBerthTons:Number.isFinite(lineup?.plannedTons)&&lineup.plannedTons>0?lineup.plannedTons:null;
  const started=operationalTimestamp(overview?.operationStart||gusa?.operationStart);
  const periodEnd=lastCompletedPeriod(state.dataUpdatedAt);
  const elapsed=started&&periodEnd&&periodEnd>started?(periodEnd-started)/86400000:null;
  const rate=produced!==null&&elapsed>0?produced/elapsed:null;
  const remaining=planned!==null&&produced!==null?Math.max(0,planned-produced):null;
  const etaDate=remaining>0&&rate>0?new Date(periodEnd.getTime()+remaining/rate*86400000):null;
  return {produced,planned,started,periodEnd,elapsed,rate,remaining,etaDate};
}
function nextHighTide(reference){
  if(!(reference instanceof Date)||Number.isNaN(reference.getTime()))return null;
  const notBefore=Math.max(reference.getTime(),Date.now());
  return state.tidePeaks.find(event=>event.date.getTime()>=notBefore)||null;
}
function tideDetail(reference){
  if(!state.tideDays)return "Tábua de maré indisponível";
  if(!reference)return "Aguardando previsão de término";
  const peak=nextHighTide(reference);
  return peak?`${fmtDateTime.format(peak.date)} · ${fmtTwo.format(peak.height)} m`:"Sem preamar futura na tábua de 2026";
}
window.dashboardTideDetail=tideDetail;
function activeOperationDetails(overview,gusa){
  const vessel=gusa?.vessel||overview?.vessel||"Navio em operação";
  const lineup=matchingLineupRecord(vessel);
  const berthStart=overview?.berthStart||gusa?.berthStart;
  const {produced,planned,started,periodEnd,elapsed,rate,remaining,etaDate}=activeForecast(overview,gusa,lineup);
  const now=Date.now();
  const eta=remaining===0?"Peso previsto atracado atingido":etaDate?fmtDateTime.format(etaDate):"Indisponível";
  const tideReference=etaDate||(remaining===0?new Date():null);
  const summary=drawerStat("Berço ocupado",berthOccupation(berthStart))+drawerStat("Prancha até último período",rate>0?`${fmtTwo.format(rate)} t/dia`:"—");
  const lastUpdate=state.dataUpdatedAt&&parseDate(state.dataUpdatedAt)?fmtDateTime.format(parseDate(state.dataUpdatedAt)):"não informada";
  const identification=overview?operationDetailRow("Operação",escapeHtml(overview.operation))+operationDetailRow("Carga",escapeHtml(overview.cargo))+operationDetailRow("Berço",escapeHtml(overview.berth)):"";
  const components=gusa?operationDetailRow("Peso atracado",Number.isFinite(gusa.berthDraftTons)?`${fmtTwo.format(gusa.berthDraftTons)} t`:"Não informado")+operationDetailRow("Peso ao largo",Number.isFinite(gusa.offshoreDraftTons)?`${fmtTwo.format(gusa.offshoreDraftTons)} t`:"Não informado"):"";
  const content=`<div class="operation-detail">${identification}${operationDetailRow("Atracação",berthStart?fmtDateTime.format(parseDate(berthStart)):"Não informada")}${operationDetailRow("Início da operação",started?fmtDateTime.format(started):"Não informado")}${operationDetailRow("Tempo em operação até agora",started&&now>=started.getTime()?formatDuration(now-started.getTime()):"Não disponível")}${operationDetailRow("Último período considerado",periodEnd?fmtDateTime.format(periodEnd):"Não disponível")}${operationDetailRow("Tempo até o último período",elapsed!==null?formatDuration(periodEnd-started):"Não disponível")}${components}${operationDetailRow("Peso produzido atracado",produced!==null?`${fmtTwo.format(produced)} t`:"Não disponível")}${operationDetailRow("Peso previsto atracado · LINEUP",planned!==null?`${fmtTwo.format(planned)} t`:"Não informado")}${operationDetailRow("Peso previsto ao largo · LINEUP",Number.isFinite(lineup?.plannedOffshoreTons)?`${fmtTwo.format(lineup.plannedOffshoreTons)} t`:"Não informado")}${operationDetailRow("Saldo atracado até o previsto",remaining!==null?`${fmtTwo.format(remaining)} t`:"Não disponível")}${operationDetailRow("Previsão de término atracado",eta)}${operationDetailRow("Próxima preamar para desatracação",tideDetail(tideReference))}</div><p class="operation-detail-note">Prancha = peso produzido atracado informado na importação ÷ tempo do início da operação até o último fechamento anterior à importação (01h, 07h, 13h ou 19h). A previsão parte desse fechamento e projeta apenas o saldo até o peso previsto atracado na LINEUP. A preamar indicada é a primeira após o término estimado (ou após agora, se o peso já foi atingido), na estação Ilha Fiscal. Confirme as condições de navegação antes de desatracar. Planilha importada em ${lastUpdate}.</p>`;
  return {title:vessel,summary,content};
}
function openActiveOperation(overview,gusa){
  const detail=activeOperationDetails(overview,gusa);
  showDrawer(detail.title,detail.summary,detail.content);
  state.activeDrawer={overview,gusa};
}
function refreshActiveOperationDetail(){
  if(!state.activeDrawer||!$("vesselDrawer").classList.contains("open"))return;
  const detail=activeOperationDetails(state.activeDrawer.overview,state.activeDrawer.gusa);
  $("drawerSummary").innerHTML=detail.summary;
  $("vesselList").innerHTML=detail.content;
}
function setupActiveOperationDetails(){
  $("activeOverviewList").addEventListener("click",event=>{const button=event.target.closest("[data-active-overview]");if(!button)return;const overview=activeSelection()[Number(button.dataset.activeOverview)];if(overview)openActiveOperation(overview,matchingActiveRecord(overview,state.gusaActiveRecords))});
}

function detailItem(record,kind,active=false){
  const occupation=active?berthOccupation(record.berthStart):completedBerthOccupation(record);
  const tons=active?record.partialTons:record.tons;
  const value=kind==="volume"?`${fmtTwo.format(tons)} t`:occupation;
  const label=kind==="volume"?(active?"volume parcial":"volume movimentado"):(active?"ocupação até agora":"ocupação de berço");
  const dates=active?`Atracação: ${record.berthStart?fmtDateTime.format(parseDate(record.berthStart)):"não informada"}`:`Atracação: ${record.berthStart?fmtDateTime.format(parseDate(record.berthStart)):"não informada"} · Desatracação: ${record.berthEnd?fmtDateTime.format(parseDate(record.berthEnd)):"não informada"}`;
  return `<article class="vessel-item detail-item"><div class="vessel-top"><strong>${escapeHtml(record.vessel)}</strong><span class="detail-status ${active?"in-progress":""}">${active?"Em atendimento":"Atendido"}</span></div><div class="detail-main"><strong>${value}</strong><span>${label}</span></div><div class="vessel-meta"><span>${escapeHtml(record.berth)}</span><span>${dates}</span>${kind==="vessels"?`<span>Ocupação: ${occupation}</span>`:""}</div></article>`;
}

function openCardDetails(kind){
  const completed=[...selected()].sort((a,b)=>new Date(b.berthStart)-new Date(a.berthStart));
  const active=[...activeSelection()].sort((a,b)=>new Date(b.berthStart)-new Date(a.berthStart));
  const sections=[];
  if(active.length)sections.push(`<h3 class="drawer-section-title">Em atendimento · ${active.length}</h3>`+active.map(r=>detailItem(r,kind,true)).join(""));
  if(completed.length)sections.push(`<h3 class="drawer-section-title">Atendidos · ${completed.length}</h3>`+completed.map(r=>detailItem(r,kind)).join(""));
  const content=sections.join("")||'<div class="empty">Nenhum navio nos filtros selecionados.</div>';
  let title,summary;
  if(kind==="vessels"){
    title="Navios atendidos e em atendimento";
    summary=drawerStat("Atendidos",fmtInt.format(completed.length))+drawerStat("Em atendimento",fmtInt.format(active.length));
  }else if(kind==="volume"){
    title="Volume por navio";
    summary=drawerStat("Volume concluído",`${fmtTwo.format(completed.reduce((sum,r)=>sum+r.tons,0))} t`)+drawerStat("Volume parcial",`${fmtTwo.format(active.reduce((sum,r)=>sum+r.partialTons,0))} t`);
  }else{
    title="Ocupação de berço por navio";
    summary=drawerStat("Atendidos",fmtInt.format(completed.length))+drawerStat("Em atendimento",fmtInt.format(active.length));
  }
  showDrawer(title,summary,content);
}
function setupCardDetails(){document.querySelectorAll(".kpi-action").forEach(card=>{const open=()=>openCardDetails(card.dataset.detail);card.addEventListener("click",open);card.addEventListener("keydown",event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();open()}})})}
function closeDrawer(){state.activeDrawer=null;$("vesselDrawer").classList.remove("open");$("drawerBackdrop").classList.remove("open");$("vesselDrawer").setAttribute("aria-hidden","true");document.body.style.overflow=""}

function activateNavigation(){
  const indicatorMenu=state.menu==="indicadores";
  $("indicatorNav").hidden=!indicatorMenu;$("lineupNav").hidden=state.menu!=="lineup";$("activityNav").hidden=state.menu!=="atividades";$("teamNav").hidden=state.menu!=="equipe";
  document.querySelectorAll(".side-link").forEach(button=>{const active=button.dataset.menu===state.menu;button.classList.toggle("active",active);active?button.setAttribute("aria-current","page"):button.removeAttribute("aria-current")});
  document.querySelectorAll("[data-indicator]").forEach(button=>{const active=button.dataset.indicator===state.indicator;button.classList.toggle("active",active);active?button.setAttribute("aria-current","page"):button.removeAttribute("aria-current")});
  document.querySelectorAll("[data-lineup]").forEach(button=>{const active=button.dataset.lineup===state.lineupView;button.classList.toggle("active",active);active?button.setAttribute("aria-current","page"):button.removeAttribute("aria-current")});
  document.querySelectorAll("[data-activity]").forEach(button=>{const active=button.dataset.activity===state.activityView;button.classList.toggle("active",active);active?button.setAttribute("aria-current","page"):button.removeAttribute("aria-current")});
  document.querySelectorAll("[data-team]").forEach(button=>{const active=button.dataset.team===state.teamView;button.classList.toggle("active",active);active?button.setAttribute("aria-current","page"):button.removeAttribute("aria-current")});
  const activityPanels={turno:"atividades",acompanhamento:"acompanhamento",configuracao:"configuracao"};
  const visible=indicatorMenu?(["descarga","pesagem"].includes(state.indicator)?state.indicator:"geral"):state.menu==="producao"?"producao":state.menu==="atividades"?activityPanels[state.activityView]:state.menu==="equipe"?"equipe":(state.lineupView==="mares"?"mares":"lineup");
  document.querySelectorAll(".tab-panel").forEach(panel=>panel.classList.toggle("active",panel.id===visible));
  document.body.dataset.indicator=state.indicator;
  $("generalTitle").querySelector("h2").textContent=state.indicator==="ocupacao"?"Ocupação de berço":"Operacional";
  if(visible==="geral"&&state.indicator==="operacional")render();
  if(visible==="lineup")renderLineup();
  if(visible==="mares")renderTides();
  if(visible==="producao")window.productionPanel?.load();
  if(visible==="descarga"||visible==="pesagem")window.dischargePanel?.load();
  window.activitiesPanel?.show(state.menu==="atividades"?state.activityView:null);
  window.teamPanel?.show(state.menu==="equipe"?state.teamView:null);
  renderDataSeal();
  syncUrl();
}
function setupNavigation(){
  const sidebar=$("sidebar"), menuButton=$("mobileMenuButton");
  const hoverEnabled=window.matchMedia("(hover: hover) and (pointer: fine)");
  let pinned=false, hovered=false, closeTimer;
  const syncMenu=()=>{
    const open=pinned||hovered;
    sidebar.classList.toggle("open",open);
    sidebar.inert=!open;
    sidebar.setAttribute("aria-hidden",String(!open));
    document.body.classList.toggle("menu-open",open);
    menuButton.setAttribute("aria-expanded",String(open));
    menuButton.setAttribute("aria-label",open?"Fechar menu lateral":"Abrir menu lateral");
    menuButton.title=open?"Fechar menu":"Abrir menu";
  };
  const closeMenu=()=>{clearTimeout(closeTimer);pinned=false;hovered=false;syncMenu()};
  document.querySelector(".side-nav").addEventListener("click",event=>{const button=event.target.closest("[data-menu]");if(!button)return;state.menu=button.dataset.menu;activateNavigation();closeMenu();menuButton.focus({preventScroll:true})});
  $("indicatorNav").addEventListener("click",event=>{const button=event.target.closest("[data-indicator]");if(!button)return;state.indicator=button.dataset.indicator;activateNavigation()});
  $("lineupNav").addEventListener("click",event=>{const button=event.target.closest("[data-lineup]");if(!button)return;state.lineupView=button.dataset.lineup;activateNavigation()});
  $("activityNav").addEventListener("click",event=>{const button=event.target.closest("[data-activity]");if(!button)return;state.activityView=button.dataset.activity;activateNavigation()});
  $("teamNav").addEventListener("click",event=>{const button=event.target.closest("[data-team]");if(!button)return;state.teamView=button.dataset.team;activateNavigation()});
  menuButton.addEventListener("mouseenter",()=>{if(!hoverEnabled.matches)return;clearTimeout(closeTimer);hovered=true;syncMenu()});
  menuButton.addEventListener("mouseleave",()=>{if(!hoverEnabled.matches)return;closeTimer=setTimeout(()=>{if(!sidebar.matches(":hover")){hovered=false;syncMenu()}},350)});
  sidebar.addEventListener("mouseenter",()=>{if(!hoverEnabled.matches)return;clearTimeout(closeTimer);hovered=true;syncMenu()});
  sidebar.addEventListener("mouseleave",()=>{if(!hoverEnabled.matches)return;hovered=false;syncMenu()});
  menuButton.addEventListener("click",()=>{clearTimeout(closeTimer);pinned=!pinned;hovered=false;syncMenu()});
  document.addEventListener("click",event=>{if((pinned||hovered)&&!sidebar.contains(event.target)&&!menuButton.contains(event.target))closeMenu()});
  document.addEventListener("keydown",event=>{if(event.key==="Escape"&&(pinned||hovered)){closeMenu();menuButton.focus({preventScroll:true})}});
  syncMenu();
  activateNavigation();
}

function setupGusa(){
  const available=gusaAvailableMonths();
  $("gusaMonthFilters").innerHTML=available.map(m=>`<label class="filter-option"><input type="checkbox" value="${m}" aria-label="${MONTHS_FULL[m-1]}"><span>${MONTHS_FULL[m-1]}</span></label>`).join("");
  $("gusaMonthFilters").addEventListener("change",event=>{
    const input=event.target.closest("input");if(!input)return;
    const month=Number(input.value);input.checked?state.gusaMonths.add(month):state.gusaMonths.delete(month);
    $("gusaMonthSummary").textContent=state.gusaMonths.size===0?"Todos os meses":state.gusaMonths.size===1?MONTHS_FULL[[...state.gusaMonths][0]-1]:`${state.gusaMonths.size} meses selecionados`;
    renderGusa();
  });
  renderGusa();
}

function gusaAvailableMonths(){return [...new Set([...state.gusaRecords,...state.gusaActiveRecords].map(r=>r.month))].sort((a,b)=>a-b)}
function gusaSelection(){return state.gusaRecords.filter(r=>!state.gusaMonths.size||state.gusaMonths.has(r.month))}
function gusaActiveSelection(){return state.gusaActiveRecords.filter(r=>!state.gusaMonths.size||state.gusaMonths.has(r.month))}
function signedTons(value){return `${value>0?"+":""}${fmtOne.format(value)} t`}
function signedPct(value){return `${value>0?"+":""}${fmtTwo.format(value*100)}%`}

function renderGusa(){
  const rows=gusaSelection();
  const activeRows=gusaActiveSelection();
  const sum=key=>rows.reduce((total,row)=>total+(Number.isFinite(row[key])?row[key]:0),0);
  const draft=sum("draftTons"),scale=sum("scaleTons"),invoice=sum("invoiceTons");
  const availableMonths=gusaAvailableMonths();
  const fullPeriod=availableMonths.length?`${MONTHS_FULL[availableMonths[0]-1].toLowerCase()} a ${MONTHS_FULL[availableMonths.at(-1)-1].toLowerCase()} de 2026`:"2026";
  $("gusaSummary").textContent=`${rows.length} ${rows.length===1?"navio concluído":"navios concluídos"} · ${activeRows.length} em andamento · ${state.gusaMonths.size?[...state.gusaMonths].sort((a,b)=>a-b).map(m=>MONTHS_FULL[m-1].toLowerCase()).join(", "):fullPeriod}`;
  const knownActive=activeRows.filter(r=>Number.isFinite(r.draftTons));
  const missingActive=activeRows.length-knownActive.length;
  const moved=draft+knownActive.reduce((total,row)=>total+row.draftTons,0);
  $("gusaMoved").textContent=rows.length||knownActive.length?`${fmtTwo.format(moved)} t`:"—";
  $("gusaMovedNote").textContent=missingActive?`${missingActive} ${missingActive===1?"navio em andamento sem peso arqueado":"navios em andamento sem peso arqueado"} · importe a planilha atualizada`:`${fmtTwo.format(draft)} t concluídas + ${fmtTwo.format(moved-draft)} t em andamento · peso total arqueado`;
  $("gusaDraft").textContent=`${fmtOne.format(draft)} t`;
  $("gusaScale").textContent=`${fmtOne.format(scale)} t`;
  $("gusaDraftScale").textContent=signedTons(draft-scale);
  $("gusaDraftScalePct").textContent=scale?`${signedPct((draft-scale)/scale)} sobre a balança`:"diferença entre os totais";
  $("gusaDraftInvoice").textContent=signedTons(draft-invoice);
  $("gusaDraftInvoicePct").textContent=invoice?`${signedPct((draft-invoice)/invoice)} sobre a NF`:"diferença sobre a NF";
  $("gusaScaleInvoice").textContent=signedTons(scale-invoice);
  $("gusaScaleInvoicePct").textContent=invoice?`${signedPct((scale-invoice)/invoice)} sobre a NF`:"diferença sobre a NF";
  renderGusaMonthly(rows);renderGusaDeviations(rows);renderActiveGusa();
}

function renderActiveGusa(){
  const rows=gusaActiveSelection();
  $("activeGusa").hidden=!rows.length;
  $("activeGusaList").innerHTML=rows.map((r,index)=>`<button type="button" class="active-item active-item-button" data-active-gusa="${index}" aria-label="Ver detalhes da operação do navio ${escapeHtml(r.vessel)}"><div><strong>${escapeHtml(r.vessel)}</strong><span>Desde ${r.berthStart?fmtDate.format(parseDate(r.berthStart)):"data não informada"} · NF ${r.invoiceTons===null?"pendente":fmtTwo.format(r.invoiceTons)+" t"}</span><span>${Number.isFinite(r.berthDraftTons)||Number.isFinite(r.offshoreDraftTons)?`Atracado ${fmtTwo.format(r.berthDraftTons||0)} t + ao largo ${fmtTwo.format(r.offshoreDraftTons||0)} t`:""}</span></div><div class="active-weight"><strong>${Number.isFinite(r.draftTons)?fmtTwo.format(r.draftTons)+" t":"—"}</strong><span>${Number.isFinite(r.draftTons)?"peso total arqueado · parcial":"peso arqueado indisponível"}</span></div></button>`).join("");
}

function renderGusaMonthly(rows){
  const months=[...new Set(rows.map(r=>r.month))].sort((a,b)=>a-b);
  if(!months.length){$("gusaMonthlyChart").innerHTML='<div class="empty">Sem navios concluídos nos meses selecionados.</div>';return}
  const data=months.map(month=>{const vessels=rows.filter(r=>r.month===month);return{month,count:vessels.length,draft:vessels.reduce((s,r)=>s+r.draftTons,0),scale:vessels.reduce((s,r)=>s+r.scaleTons,0),invoice:vessels.reduce((s,r)=>s+r.invoiceTons,0)}});
  const max=Math.max(...data.flatMap(d=>[d.draft,d.scale,d.invoice]))*1.08;
  $("gusaMonthlyChart").innerHTML=data.map(d=>`<div class="gusa-month"><div class="gusa-month-bars"><div class="gusa-bar draft" style="height:${d.draft/max*100}%" title="${MONTHS_FULL[d.month-1]}: arqueado ${fmtOne.format(d.draft)} t"></div><div class="gusa-bar scale" style="height:${d.scale/max*100}%" title="${MONTHS_FULL[d.month-1]}: balança ${fmtOne.format(d.scale)} t"></div><div class="gusa-bar invoice" style="height:${d.invoice/max*100}%" title="${MONTHS_FULL[d.month-1]}: NF ${fmtOne.format(d.invoice)} t"></div></div><strong>${MONTHS[d.month-1]}</strong><span>${d.count} ${d.count===1?"navio":"navios"}</span><div class="gusa-month-values" aria-label="Pesos em toneladas"><span title="Arqueado: ${fmtTwo.format(d.draft)} t"><i class="draft"></i>${fmtOne.format(d.draft/1000)} mil</span><span title="Balança: ${fmtTwo.format(d.scale)} t"><i class="scale"></i>${fmtOne.format(d.scale/1000)} mil</span><span title="Nota fiscal: ${fmtTwo.format(d.invoice)} t"><i class="invoice"></i>${fmtOne.format(d.invoice/1000)} mil</span></div></div>`).join("");
}

function renderGusaDeviations(rows){
  if(!rows.length){$("gusaDeviationChart").innerHTML='<div class="empty">Sem navios concluídos nos meses selecionados.</div>';return}
  const data=rows.filter(r=>r.invoiceTons>0).sort((a,b)=>new Date(a.departure)-new Date(b.departure));
  const maxDeviation=Math.max(.01,...data.flatMap(r=>[Math.abs((r.draftTons-r.invoiceTons)/r.invoiceTons),Math.abs((r.scaleTons-r.invoiceTons)/r.invoiceTons)]));
  const bound=Math.ceil(maxDeviation/.0025)*.0025;
  const threshold=.005/bound*50;
  const bar=(value,kind)=>{const width=Math.min(50,Math.abs(value)/bound*50);const left=value>=0?50:50-width;return `<div class="deviation-bar ${kind} ${Math.abs(value)>.005?"outside":""}" style="left:${left}%;width:${width}%"></div>`};
  const axis=`<div class="deviation-axis"><span style="left:0">−${fmtOne.format(bound*100)}%</span><span style="left:${50-threshold}%">−0,5%</span><span style="left:50%">0</span><span style="left:${50+threshold}%">+0,5%</span><span style="left:100%">+${fmtOne.format(bound*100)}%</span></div>`;
  $("gusaDeviationChart").innerHTML=`<div class="deviation-axis-row"><div></div>${axis}<div></div></div>`+data.map(r=>{
    const draft=(r.draftTons-r.invoiceTons)/r.invoiceTons,scale=(r.scaleTons-r.invoiceTons)/r.invoiceTons;
    const plot=(value,kind)=>`<div class="deviation-track" style="--band-left:${50-threshold}%;--band-width:${threshold*2}%">${bar(value,kind)}</div>`;
    return `<div class="deviation-row"><div class="deviation-vessel"><strong>${escapeHtml(r.vessel)}</strong><span title="Início da operação">${fmtDate.format(parseDate(r.operationStart || r.departure))}</span></div><div class="deviation-plots">${plot(draft,"draft")}${plot(scale,"scale")}</div><div class="deviation-values"><span class="${Math.abs(draft)>.005?"outside":""}">${signedPct(draft)}</span><span class="${Math.abs(scale)>.005?"outside":""}">${signedPct(scale)}</span></div></div>`;
  }).join("");
}

function lineupDateInput(date){return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`}
function lineupShortDate(date){return `${String(date.getDate()).padStart(2,"0")}/${String(date.getMonth()+1).padStart(2,"0")}`}
function setupLineup(){
  $("lineupStart").value=lineupDateInput(new Date());
  $("lineupStart").addEventListener("change",renderLineup);
  $("lineupDays").addEventListener("change",renderLineup);
  $("lineupGantt").addEventListener("click",event=>{
    const button=event.target.closest("[data-lineup-id]");if(!button)return;
    const display=state.lineupDisplayRecords.find(item=>item.row.id===button.dataset.lineupId);if(!display)return;
    const row=display.row;
    const plannedBerth=Number.isFinite(row.plannedBerthTons)?row.plannedBerthTons:row.plannedTons;
    const overviewMatches=state.activeRecords.filter(item=>vesselKey(item.vessel)===vesselKey(row.vessel));
    const gusaMatches=state.gusaActiveRecords.filter(item=>vesselKey(item.vessel)===vesselKey(row.vessel));
    const overview=overviewMatches.length===1?overviewMatches[0]:null,gusa=gusaMatches.length===1?gusaMatches[0]:null;
    const forecast=overview||gusa?activeForecast(overview,gusa,row):null;
    const plannedEnd=parseDate(row.plannedBerthEnd);
    const now=new Date();
    const tideReference=forecast?.etaDate&&forecast.etaDate>now?forecast.etaDate:display.active?now:plannedEnd;
    const tideBasis=forecast?.etaDate&&forecast.etaDate>now?"Término atracado estimado":display.active?"Ainda atracado · agora":"Desatracação prevista na LINEUP";
    const summary=drawerStat("Berço",escapeHtml(row.berth))+drawerStat("Peso previsto atracado",Number.isFinite(plannedBerth)?`${fmtTwo.format(plannedBerth)} t`:"—");
    const content=`<div class="operation-detail">${operationDetailRow("Situação",display.active?"Atracado · sem desatracação registrada":"Planejado")}${display.active?operationDetailRow("Atracação real",fmtDateTime.format(display.start)):""}${operationDetailRow("Operação",escapeHtml(row.operation))}${operationDetailRow("Carga",escapeHtml(row.cargo))}${operationDetailRow("Cliente",escapeHtml(row.client))}${operationDetailRow("Peso previsto atracado",Number.isFinite(plannedBerth)?`${fmtTwo.format(plannedBerth)} t`:"Não informado")}${operationDetailRow("Peso previsto ao largo",Number.isFinite(row.plannedOffshoreTons)?`${fmtTwo.format(row.plannedOffshoreTons)} t`:"Não informado")}${operationDetailRow("Atracação prevista",row.plannedBerthStart?fmtDateTime.format(parseDate(row.plannedBerthStart)):"Não informada")}${operationDetailRow("Desatracação prevista",plannedEnd?fmtDateTime.format(plannedEnd):"Não informada")}${forecast?.etaDate?operationDetailRow("Término atracado estimado",fmtDateTime.format(forecast.etaDate)):""}${operationDetailRow("Referência para a maré",tideBasis)}${operationDetailRow("Próxima preamar para desatracação",tideDetail(tideReference))}</div><p class="operation-detail-note">A faixa de navio atracado vai da atracação real até agora enquanto não houver desatracação registrada. A preamar é prevista para a estação Ilha Fiscal; a altura não confirma, sozinha, uma janela segura de navegação.</p>`;
    showDrawer(row.vessel,summary,content);
  });
  renderLineup();
}
function lineupDisplayRows(now=new Date()){
  const active=state.activeRecords.filter(record=>record.berthStart&&!record.berthEnd&&parseDate(record.berthStart));
  const used=new Set();
  const planned=state.lineupRecords.map(row=>{
    const matches=active.filter(record=>vesselKey(record.vessel)!=="TBN"&&vesselKey(record.vessel)===vesselKey(row.vessel));
    const current=matches.length===1&&matchingLineupRecord(matches[0].vessel)===row?matches[0]:null;
    if(current)used.add(current.id);
    return {row,active:!!current,berth:current?.berth||row.berth,start:current?parseDate(current.berthStart):parseDate(row.plannedBerthStart),end:current?now:parseDate(row.plannedBerthEnd)};
  });
  return planned.concat(active.filter(record=>!used.has(record.id)).map(record=>({
    row:{id:`active-${record.id}`,vessel:record.vessel,berth:record.berth,operation:record.operation,cargo:record.cargo,client:"Não informado",plannedBerthTons:null,plannedOffshoreTons:null,plannedBerthStart:null,plannedBerthEnd:null},
    active:true,berth:record.berth,start:parseDate(record.berthStart),end:now
  })));
}
function renderLineup(){
  const startValue=$("lineupStart").value;
  const start=startValue?new Date(`${startValue}T00:00:00`):new Date();start.setHours(0,0,0,0);
  const days=Number($("lineupDays").value)||10;
  const end=new Date(start);end.setDate(end.getDate()+days);
  const span=end-start;
  const scheduled=lineupDisplayRows().filter(item=>item.start&&item.end&&item.end>item.start&&item.start<end&&item.end>start);
  state.lineupDisplayRecords=scheduled;
  const berths=[...new Set(scheduled.map(item=>item.berth))].sort((a,b)=>a.localeCompare(b,"pt-BR"));
  $("lineupSummary").textContent=`${scheduled.length} ${scheduled.length===1?"navio":"navios"} · ${berths.length} ${berths.length===1?"berço":"berços"} · ${fmtDate.format(start)} a ${fmtDate.format(new Date(end-1))}`;
  if(!scheduled.length){$("lineupGantt").innerHTML='<div class="empty">Nenhum navio com janela planejada neste período. Ajuste a data ou o número de dias.</div>';return}
  const minWidth=Math.max(580,days*58);
  const ticks=Array.from({length:days},(_,i)=>{const day=new Date(start);day.setDate(day.getDate()+i);return `<span class="lineup-day" style="left:${i/days*100}%;width:${100/days}%" title="${fmtDate.format(day)}">${lineupShortDate(day)}</span>`}).join("");
  const now=Date.now(),todayLine=now>=start&&now<end?`<div class="lineup-today" style="left:${(now-start)/span*100}%" title="Agora"></div>`:"";
  const rows=berths.map(berth=>{
    const vessels=scheduled.filter(item=>item.berth===berth).sort((a,b)=>a.start-b.start);
    const laneEnds=[];
    const bars=vessels.map(item=>{
      const r=item.row,a=item.start.getTime(),b=item.end.getTime();
      const labelPixels=Math.ceil(r.vessel.length*7.4+(r.geport?String(r.geport).length*6.5+24:0)+18);
      const actualPixels=(b-a)/span*minWidth;
      const endOfDay=new Date(item.end);endOfDay.setHours(24,0,0,0);
      const displayEnd=actualPixels<labelPixels?Math.min(end.getTime(),Math.max(b,endOfDay.getTime(),a+labelPixels/minWidth*span)):b;
      let lane=laneEnds.findIndex(value=>value<=a);if(lane<0)lane=laneEnds.length;laneEnds[lane]=displayEnd;
      const left=Math.max(0,(a-start)/span*100),right=Math.min(100,(displayEnd-start)/span*100),width=Math.max(0,right-left);
      const title=item.active?`${r.vessel}${r.geport?` - ${r.geport}`:""} · atracado desde ${fmtDateTime.format(item.start)} · ainda no berço`:`${r.vessel}${r.geport?` - ${r.geport}`:""} · previsto de ${fmtDateTime.format(item.start)} até ${fmtDateTime.format(item.end)}`;
      return `<button type="button" class="lineup-bar ${item.active?"is-active":""} ${displayEnd>b?"has-label-extension":""}" data-lineup-id="${escapeHtml(r.id)}" style="left:${left}%;width:${width}%;top:${lane*42+8}px;--scheduled-width:${Math.min(100,(b-a)/(displayEnd-a)*100)}%" title="${escapeHtml(title)}"><span class="lineup-bar-heading"><strong>${escapeHtml(r.vessel)}</strong>${r.geport?`<span class="lineup-geport">- ${escapeHtml(r.geport)}</span>`:""}</span><span class="lineup-bar-cargo">${escapeHtml(r.cargo)}</span></button>`;
    }).join("");
    return `<div class="lineup-row"><div class="lineup-berth">${escapeHtml(berth)}</div><div class="lineup-track" style="height:${Math.max(54,laneEnds.length*42+12)}px;--day-width:${100/days}%">${todayLine}${bars}</div></div>`;
  }).join("");
  $("lineupGantt").style.minWidth=`${minWidth+170}px`;
  $("lineupGantt").innerHTML=`<div class="lineup-axis"><div class="lineup-axis-label">BERÇO</div><div class="lineup-axis-days">${ticks}${todayLine}</div></div>${rows}`;
}

function buildTidePeaks(days){
  const events=Object.entries(days||{}).flatMap(([day,items])=>(items||[]).map(item=>({date:new Date(`${day}T${item.time}:00-03:00`),height:Number(item.height)}))).filter(event=>!Number.isNaN(event.date.getTime())&&Number.isFinite(event.height)).sort((a,b)=>a.date-b.date);
  return events.filter((event,index)=>event.height>(events[index-1]?.height??-Infinity)&&event.height>=(events[index+1]?.height??-Infinity));
}
async function setupTides(){
  const today=new Date();
  $("tideDate").value=today.getFullYear()===2026?lineupDateInput(today):"2026-12-31";
  $("tideDate").addEventListener("change",renderTides);
  try{
    const response=await fetch("/tides-2026.json");
    if(!response.ok)throw new Error("Não foi possível carregar a tábua de maré.");
    const payload=await response.json();state.tideDays=payload.days;state.tidePeaks=buildTidePeaks(payload.days);
    renderTides();
  }catch(error){$("tideStatus").textContent=error.message;$("tideDays").innerHTML=""}
}
function renderTides(){
  if(!state.tideDays)return;
  const chosen=$("tideDate").value;
  if(!/^2026-\d{2}-\d{2}$/.test(chosen)||!state.tideDays[chosen]){$("tideStatus").textContent="Escolha uma data de 2026.";$("tideDays").innerHTML="";return}
  const start=new Date(`${chosen}T12:00:00`);
  const available=[];
  for(let i=0;i<5;i++){const date=new Date(start);date.setDate(date.getDate()+i);const key=lineupDateInput(date);if(state.tideDays[key])available.push({date,events:state.tideDays[key],key})}
  $("tideStatus").textContent=`${available.length} ${available.length===1?"dia":"dias"} de previsões · Ilha Fiscal · UTC−3`;
  $("tideDays").innerHTML=available.map(({date,events,key})=>{
    const today=key===lineupDateInput(new Date());
    const highest=Math.max(...events.map(event=>event.height));
    return `<article class="tide-day ${today?"today":""}"><div class="tide-day-heading"><div><strong>${new Intl.DateTimeFormat("pt-BR",{weekday:"long",day:"2-digit",month:"long"}).format(date)}</strong><span>${today?"Hoje":"Previsão"}</span></div></div><div class="tide-events">${events.map(event=>{const peak=event.height===highest;return `<div class="tide-event ${peak?"highest":""}"><div><time>${event.time}</time>${peak?'<span class="tide-peak-label">Maior altura do dia</span>':""}</div><strong>${fmtTwo.format(event.height)} m</strong></div>`}).join("")}</div></article>`;
  }).join("");
}

function registerWebMCP(){
  const context=document.modelContext;
  if(!context?.registerTool)return;
  try{
    context.registerTool({
      name:"set_dashboard_filters",
      title:"Filtrar painel operacional",
      description:"Seleciona anos e meses no painel e atualiza todos os indicadores e gráficos visíveis.",
      inputSchema:{
        type:"object",
        properties:{
          years:{type:"array",items:{type:"integer",enum:[2024,2025,2026]}},
          months:{type:"array",items:{type:"integer",minimum:1,maximum:12}}
        },
        required:["years","months"],
        additionalProperties:false
      },
      annotations:{readOnlyHint:true,untrustedContentHint:false},
      execute(input){
        if(!Array.isArray(input.years)||!Array.isArray(input.months)||input.months.some(m=>!Number.isInteger(m)||m<1||m>12))throw new Error("Filtros inválidos");
        state.years=new Set(input.years); state.months=new Set(input.months);
        document.querySelectorAll("#yearFilters input").forEach(c=>c.checked=state.years.has(Number(c.value)));
        document.querySelectorAll("#monthFilters input").forEach(c=>c.checked=state.months.has(Number(c.value)));
        updateFilterSummaries();
        render();
        return {years:[...state.years],months:[...state.months],records:selected().length};
      }
    });
  }catch(error){console.warn("WebMCP indisponível",error)}
}

/* ---------- Visão na URL (aba, ano, mês e intervalo) ---------- */
const urlState={applying:false,pending:null};
function currentView(){
  if(state.menu==="producao")return "producao";
  if(state.menu==="atividades")return state.activityView==="turno"?"atividades":state.activityView;
  if(state.menu==="equipe")return state.teamView==="resumo"?"equipe":`equipe-${state.teamView}`;
  if(state.menu==="lineup")return state.lineupView==="mares"?"mares":"lineup";
  return state.indicator;
}
function currentUrlView(){
  const view=currentView();
  if(view==="descarga"){const range=window.dischargePanel?.getRange()||{};return {view,start:range.start,end:range.end}}
  if(view==="pesagem"){const w=window.dischargePanel?.getWeighing()||{};return {view,years:w.year?[w.year]:[],months:w.month?[w.month]:[]}}
  return {view,years:[...state.years],months:[...state.months]};
}
/* Grava a visão atual na URL. Cada mudança feita pela pessoa vira uma entrada do histórico (voltar/avançar). */
function syncUrl(){
  if(urlState.applying||!state.records.length)return;
  const view=currentView();
  if((view==="descarga"||view==="pesagem")&&window.dischargePanel?.isLoading?.())return;
  const query=TpsUrlState.serialize(currentUrlView());
  if(query===location.search)return;
  history.pushState(null,"",`${location.pathname}${query}${location.hash}`);
}
window.syncUrl=syncUrl;
/* Aplica a visão da URL: na abertura da página e ao usar voltar/avançar. */
function applyUrl(search){
  const target=TpsUrlState.parse(search);
  urlState.applying=true;
  try{
    if(target.view==="producao")state.menu="producao";
    else if(["atividades","acompanhamento","configuracao"].includes(target.view)){state.menu="atividades";state.activityView=target.view==="atividades"?"turno":target.view}
    else if(target.view==="equipe"||target.view.startsWith("equipe-")){state.menu="equipe";state.teamView=target.view==="equipe"?"resumo":target.view.slice(7)}
    else if(target.view==="lineup"||target.view==="mares"){state.menu="lineup";state.lineupView=target.view==="mares"?"mares":"planejamento"}
    else{state.menu="indicadores";state.indicator=target.view}
    if(target.view==="operacional"||target.view==="ocupacao"){
      const known=new Set(state.records.map(r=>r.year));
      state.years.clear();target.years.filter(y=>known.has(y)).forEach(y=>state.years.add(y));
      state.months.clear();target.months.forEach(m=>state.months.add(m));
      document.querySelectorAll("#yearFilters input").forEach(input=>input.checked=state.years.has(Number(input.value)));
      document.querySelectorAll("#monthFilters input").forEach(input=>input.checked=state.months.has(Number(input.value)));
      updateFilterSummaries();
    }
    urlState.pending=target;
    activateNavigation();
    if(target.view==="ocupacao")render();
    window.onDischargeReady();
  }finally{urlState.applying=false}
}
/* Filtros de Descarga e Pesagem só podem ser aplicados depois que a planilha de indicadores carrega. */
window.onDischargeReady=()=>{
  const target=urlState.pending;
  if(!window.dischargePanel||window.dischargePanel.isLoading())return;
  if(!target||!["descarga","pesagem"].includes(target.view)){if(!urlState.applying)syncUrl();return}
  urlState.pending=null;
  const wasApplying=urlState.applying;urlState.applying=true;
  try{
    if(target.view==="descarga")window.dischargePanel.setRange(target.start,target.end);
    if(target.view==="pesagem")window.dischargePanel.setWeighing(target.years[0],target.months[0]);
  }finally{urlState.applying=wasApplying}
};
window.addEventListener("popstate",()=>applyUrl(location.search));

/* Botão "Atualizar dados": pede ao servidor uma nova leitura das duas planilhas.
   Depois de atualizar, recarrega a página na mesma visão (a URL guarda aba e filtros). */
function setupRefresh(){
  const button=$("refreshData"),label=button.querySelector("span"),toast=$("exportStatus");
  let timer;
  const announce=(text,ms=0)=>{clearTimeout(timer);toast.textContent=text;toast.hidden=false;if(ms)timer=setTimeout(()=>{toast.hidden=true},ms)};
  button.addEventListener("click",async()=>{
    if(button.disabled)return;
    button.disabled=true;button.classList.add("is-busy");label.textContent="Lendo planilhas…";
    // Na aba Equipe, o botão relê só a planilha da equipe e atualiza a aba sem recarregar a página.
    const team=state.menu==="equipe";
    announce(team?"Lendo a planilha da equipe no Google…":"Lendo as planilhas de navios e de indicadores no Google. Isso leva cerca de 20 segundos.");
    try{
      const response=await fetch(team?"/api/refresh?base=equipe":"/api/refresh",{method:"POST",headers:{"Content-Type":"application/json"}});
      const result=await response.json().catch(()=>({}));
      if(result.status==="refreshed"&&team){await window.teamPanel?.reload();renderDataSeal();announce("Planilha da equipe atualizada.",5000)}
      else if(result.status==="refreshed"){announce("Dados atualizados. Recarregando o painel…");setTimeout(()=>location.reload(),600);return}
      else if(result.status==="partial"&&team)announce(Object.values(result.results||{})[0]?.error||"Não foi possível ler a planilha da equipe agora.",7000);
      else if(result.status==="recent"){const minutes=Math.max(1,Math.ceil((result.retryInMs||0)/60000));announce(`Os dados foram lidos há menos de 5 minutos. Tente de novo em ${minutes} ${minutes===1?"minuto":"minutos"}.`,7000)}
      else if(result.status==="running")announce("Outra atualização já está em andamento. Aguarde alguns segundos e recarregue a página.",7000);
      else if(result.status==="partial"){const failed=Object.entries(result.results||{}).filter(([,r])=>!r.ok).map(([kind])=>kind==="operations"?"navios":"indicadores");announce(`Não foi possível ler a planilha de ${failed.join(" e ")}. A outra foi atualizada; recarregando…`,7000);setTimeout(()=>location.reload(),2500);return}
      else announce(result.error||"Não foi possível atualizar agora. Tente novamente em alguns minutos.",7000);
    }catch{announce("Sem conexão com o servidor. Tente novamente.",7000)}
    button.disabled=false;button.classList.remove("is-busy");label.textContent="Atualizar dados";
  });
}

function showDataSource(payload){
  state.dataMeta={origin:payload.origin,lastRecordAt:payload.lastRecordAt,generatedAt:payload.generatedAt,fallbackReason:payload.fallbackReason,changeLog:payload.changeLog,files:payload.files};
  renderDataSeal();
}

/* Painel aberto pelo selo: o que mudou em cada planilha nas últimas leituras.
   O histórico vem pronto do servidor (netlify/lib/changes.mjs), um registro por leitura com alteração. */
const brDateTime=value=>{const date=new Date(value);return Number.isNaN(date.getTime())?"":new Intl.DateTimeFormat("pt-BR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit",timeZone:"America/Sao_Paulo"}).format(date).replace(","," às")};
function changesBaseHtml(title,meta,current){
  const tag=current?"<small>tela atual</small>":"";
  if(!meta)return `<section class="changes-base"><h3>${title}${tag}</h3><p class="changes-read">Lendo a planilha…</p></section>`;
  const files=(meta.files||[]).map(file=>`<li>${file.url?`<a href="${escapeHtml(file.url)}" target="_blank" rel="noopener">${escapeHtml(file.name)}</a>`:escapeHtml(file.name)}</li>`).join("");
  const head=`<h3>${title}${tag}</h3>${files?`<ul class="changes-files" aria-label="Arquivos lidos">${files}</ul>`:""}`;
  if(meta.origin==="fallback")return `<section class="changes-base">${head}<p class="changes-note">A planilha não pôde ser lida agora (${escapeHtml(meta.fallbackReason||"motivo não informado")}). O painel mostra a última base salva.</p></section>`;
  const log=Array.isArray(meta.changeLog)?meta.changeLog:[];
  const read=`<p class="changes-read">Última leitura: ${brDateTime(meta.generatedAt)}</p>`;
  if(!log.length)return `<section class="changes-base">${head}${read}<p class="changes-note">Ainda não há alterações registradas. O registro compara cada leitura com a anterior e começa a aparecer aqui a partir da próxima leitura que encontrar diferença.</p></section>`;
  const latestIsNow=log[0].at===meta.generatedAt;
  const note=latestIsNow?"":`<p class="changes-note">A última leitura não encontrou diferença em relação à anterior. Abaixo, as alterações mais recentes encontradas.</p>`;
  const entries=log.map((entry,index)=>`<details class="changes-entry"${index===0?" open":""}><summary>Leitura de ${brDateTime(entry.at)}<span>${entry.total} ${entry.total===1?"alteração":"alterações"}</span></summary>${entry.sections.map(section=>`<div class="changes-section"><h4>${escapeHtml(section.title)} (${section.count})</h4><ul>${section.items.map(item=>`<li>${escapeHtml(item)}</li>`).join("")}</ul>${section.count>section.items.length?`<p class="changes-more">e mais ${section.count-section.items.length}.</p>`:""}</div>`).join("")}</details>`).join("");
  return `<section class="changes-base">${head}${read}${note}${entries}</section>`;
}
function renderChanges(){
  const panel=$("changesPanel");if(!panel||panel.hidden)return;
  const dischargeView=state.menu==="indicadores"&&["descarga","pesagem"].includes(state.indicator);
  const bases=state.menu==="equipe"?[["Planilha da equipe",window.teamPanel?.getMeta(),true]]:[["Planilha de navios",state.dataMeta,!dischargeView],["Planilha de indicadores",window.dischargePanel?.getMeta(),dischargeView]];
  if(dischargeView)bases.reverse();
  $("changesBody").innerHTML=bases.map(([title,meta,current])=>changesBaseHtml(title,meta,current)).join("");
}
function setupChanges(){
  const seal=$("updatedAt"),panel=$("changesPanel"),wrap=$("dataSealWrap");
  // A planilha de indicadores só carrega ao abrir Descarga/Pesagem; o painel pede a leitura para mostrar as duas.
  const toggle=open=>{panel.hidden=!open;seal.setAttribute("aria-expanded",String(open));if(open){renderChanges();window.dischargePanel?.load()}};
  seal.addEventListener("click",()=>toggle(panel.hidden));
  $("changesClose").addEventListener("click",()=>{toggle(false);seal.focus()});
  document.addEventListener("click",event=>{if(!panel.hidden&&!wrap.contains(event.target))toggle(false)});
  document.addEventListener("keydown",event=>{if(event.key==="Escape"&&!panel.hidden){toggle(false);seal.focus()}});
}

/* Selo do cabeçalho: mostra até quando vão os dados da base da tela aberta.
   Descarga e Pesagem usam a planilha de indicadores; o resto, a de navios. Produção tem planilhas próprias. */
function renderDataSeal(){
  const seal=$("updatedAt");if(!seal)return;
  const dischargeView=state.menu==="indicadores"&&["descarga","pesagem"].includes(state.indicator);
  const wrap=$("dataSealWrap");
  if(state.menu==="producao"||state.menu==="atividades"){wrap.hidden=true;$("changesPanel").hidden=true;seal.setAttribute("aria-expanded","false");return}
  wrap.hidden=false;
  renderChanges();
  if(state.menu==="equipe"){
    const meta=window.teamPanel?.getMeta();
    if(!meta){seal.dataset.level="loading";seal.textContent="Lendo a planilha da equipe…";seal.title="";return}
    seal.dataset.level="ok";seal.textContent=`Planilha da equipe · lida em ${brDateTime(meta.generatedAt)}`;
    seal.title="Horário em que o painel leu a planilha da equipe (1 vez por dia ou pelo botão Atualizar dados). Clique para ver o que mudou.";
    return;
  }
  const meta=dischargeView?window.dischargePanel?.getMeta():state.dataMeta;
  const base=dischargeView?"planilha de indicadores":"planilha de navios";
  if(!meta){seal.dataset.level="loading";seal.textContent=dischargeView?"Lendo a planilha de indicadores…":"Lendo a planilha de navios…";seal.title="";return}
  const status=TpsMetrics.freshness(meta,new Date());
  seal.dataset.level=status.level;
  seal.textContent=status.text;
  seal.title=status.level==="critical"
    ?`Não foi possível ler a ${base} no Google agora (${meta.fallbackReason||"motivo não informado"}). Recarregue em alguns minutos.`
    :status.level==="warning"
      ?`O último registro da ${base} tem ${status.ageDays} dias. Confira se a planilha está sendo atualizada.`
      :`Último registro da ${base} e horário em que o painel leu a planilha. Clique para ver o que mudou.`;
}
window.renderDataSeal=renderDataSeal;
/* Texto "Dados até…" da base usada por uma tela, para o cabeçalho da exportação. */
window.getExportDataNote=sectionId=>{
  if(sectionId==="producao")return "";
  const meta=["descarga","pesagem"].includes(sectionId)?window.dischargePanel?.getMeta():state.dataMeta;
  return meta?TpsMetrics.freshness(meta,new Date()).text:"";
};

async function init(){const response=await fetch("/api/data");if(!response.ok)throw new Error("Não foi possível carregar a base operacional.");const payload=await response.json();state.records=payload.records;state.activeRecords=payload.activeRecords||[];state.gusaActiveRecords=payload.gusaActiveRecords||[];state.lineupRecords=payload.lineupRecords||[];state.dataUpdatedAt=payload.generatedAt||null;const today=new Date();state.gusaRecords=(payload.gusaRecords||[]).filter(r=>r.year===2026&&parseDate(r.departure)<=today);showDataSource(payload);setupFilters();setupLineup();window.dischargePanel?.setup();urlState.applying=true;setupNavigation();await setupTides();setupCardDetails();setupRefresh();setupChanges();window.activitiesPanel?.start();setupActiveOperationDetails();render();urlState.applying=false;applyUrl(location.search);setInterval(()=>{renderActiveOverview();refreshActiveOperationDetail();renderLineup()},60000);registerWebMCP();$("monthlyChart").addEventListener("mousemove",handleChartMove);$("monthlyChart").addEventListener("mouseleave",()=>$("chartTooltip").style.opacity=0);$("monthlyChart").addEventListener("click",handleChartClick);$("closeDrawer").addEventListener("click",closeDrawer);$("drawerBackdrop").addEventListener("click",closeDrawer);document.addEventListener("keydown",e=>{if(e.key==="Escape")closeDrawer()});window.addEventListener("resize",()=>{clearTimeout(window.__resize);window.__resize=setTimeout(render,120)})}
document.fonts?.addEventListener?.("loadingdone",()=>{if(state.records.length)render()});
init().catch(error=>{document.querySelector("main").innerHTML=`<div class="empty"><strong>Não foi possível abrir o painel.</strong><p>${escapeHtml(error.message)}</p></div>`});
/* Clique numa notificação de atividade: abre a lista do turno. */
window.openActivities=()=>{state.menu="atividades";state.activityView="turno";activateNavigation()};
/* Ficha de pessoa aberta de outra subaba da Equipe: vai para Pessoas. */
window.openTeamView=view=>{state.menu="equipe";state.teamView=view;activateNavigation()};
