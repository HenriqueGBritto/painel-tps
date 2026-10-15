(() => {
  const menu = document.getElementById('exportMenu');
  const status = document.getElementById('exportStatus');
  const names = { geral: 'Indicadores', descarga: 'Descarga', pesagem: 'Pesagem', lineup: 'Lineup', mares: 'Tábua de maré', producao: 'Produção', atividades: 'Atividades do turno', acompanhamento: 'Acompanhamento de atividades', configuracao: 'Configuração das atividades' };
  let busy = false;
  let statusTimer;

  function announce(message, timeout = 0) {
    clearTimeout(statusTimer);
    status.textContent = message;
    status.hidden = false;
    if (timeout) statusTimer = setTimeout(() => { status.hidden = true; }, timeout);
  }

  function loadLibrary(url, globalName) {
    if (window[globalName]) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = url;
      script.onload = () => window[globalName] ? resolve() : reject(new Error('Biblioteca indisponível'));
      script.onerror = () => reject(new Error('Não foi possível carregar o recurso de exportação. Verifique a conexão.'));
      document.head.appendChild(script);
    });
  }

  function selectedContext(section) {
    if (section.id === 'geral') {
      return `${document.getElementById('yearSummary').textContent} · ${document.getElementById('monthSummary').textContent}`;
    }
    if (section.id === 'descarga') {
      const br = value => value ? `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}` : '—';
      return `${br(document.getElementById('dischargeStart').value)} a ${br(document.getElementById('dischargeEnd').value)}`;
    }
    if (section.id === 'pesagem') return `${document.getElementById('weighingYear').selectedOptions[0]?.textContent || ''} · ${document.getElementById('weighingMonth').selectedOptions[0]?.textContent || ''}`;
    if (section.id === 'lineup') return document.getElementById('lineupSummary').textContent;
    if (section.id === 'producao') {
      const cargo = document.getElementById('productionCargo');
      const vessel = document.getElementById('productionVessel');
      return `${cargo.selectedOptions[0]?.textContent || 'Todas as cargas'} · ${vessel.selectedOptions[0]?.textContent || 'Todos os navios'}`;
    }
    return '';
  }

  const exportNumber = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const exportDay = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' });
  const productionTimeExport = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
  const productionClockExport = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }
  function duration(minutes) {
    return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`;
  }

  function productionSummary(section) {
    const data = window.getProductionExportData?.();
    if (!data) throw new Error('Aguarde o carregamento da produção antes de exportar.');
    const summary = document.createElement('section');
    summary.className = 'export-production-summary';
    const planned = data.planned;
    const balance = planned === null ? null : Math.max(0, planned - data.produced);
    const percent = planned > 0 ? data.produced / planned * 100 : null;
    const shifts = data.shifts || [];
    const lastEnd = data.lastShift?.end;
    const periods = lastEnd ? Array.from({ length: 8 }, (_, index) => {
      const end = new Date(lastEnd.getTime() - (7 - index) * 21600000);
      const start = new Date(end.getTime() - 21600000);
      const localStart = new Date(start.getTime() - 10800000);
      const localEnd = new Date(end.getTime() - 10800000);
      const shift = shifts.find(item => item.end?.getTime() === end.getTime());
      const stops = (data.stops || []).flatMap(stop => {
        const from = Math.max(start.getTime(), stop.startAt?.getTime() || 0);
        const to = Math.min(end.getTime(), stop.endAt?.getTime() || 0);
        const minutes = Math.max(0, Math.round((to - from) / 60000));
        return minutes ? [{ description: stop.description, minutes }] : [];
      });
      const stopMinutes = stops.reduce((sum, stop) => sum + stop.minutes, 0);
      const reasons = new Map();
      stops.forEach(stop => reasons.set(stop.description, (reasons.get(stop.description) || 0) + stop.minutes));
      const reasonText = [...reasons].sort((a, b) => b[1] - a[1]).map(([reason, minutes]) => `${reason} (${duration(minutes)})`).join(' · ');
      return { date: exportDay.format(start), period: `${String(localStart.getUTCHours()).padStart(2, '0')}:00–${String(localEnd.getUTCHours()).padStart(2, '0')}:00`, tons: shift?.tons || 0, stopMinutes, reasonText };
    }) : [];
    const latest = periods.at(-1);
    const latestStart = lastEnd ? lastEnd.getTime() - 21600000 : 0;
    const shiftStops = (data.stops || []).flatMap(stop => {
      const from = Math.max(latestStart, stop.startAt?.getTime() || 0);
      const to = Math.min(lastEnd?.getTime() || 0, stop.endAt?.getTime() || 0);
      return to > from ? [{ description: stop.description, location: stop.location, from, to, minutes: Math.round((to - from) / 60000) }] : [];
    });
    const shiftStopMinutes = shiftStops.reduce((sum, stop) => sum + stop.minutes, 0);
    const shiftStopRows = shiftStops.map(stop => {
      const crossesMidnight = exportDay.format(new Date(stop.from)) !== exportDay.format(new Date(stop.to));
      const startTime = productionClockExport.format(new Date(stop.from));
      const endTime = `${productionClockExport.format(new Date(stop.to))}${crossesMidnight ? ' (+1 dia)' : ''}`;
      return `<div class="export-stop-item"><span>${escapeHtml(stop.description)} — ${escapeHtml(startTime)} às ${escapeHtml(endTime)}</span><b>— ${duration(stop.minutes)}</b></div>`;
    }).join('');
    const reasons = new Map();
    (data.stops || []).forEach(stop => {
      const reason = (stop.description || 'Não informado').replace(/\.+$/, '').trim();
      const key = reason.toLocaleLowerCase('pt-BR');
      const item = reasons.get(key) || { reason, minutes: 0 };
      item.minutes += stop.duration || 0;
      reasons.set(key, item);
    });
    const reasonList = [...reasons.values()].sort((a, b) => b.minutes - a.minutes).slice(0, 5);
    const maxReason = reasonList[0]?.minutes || 1;
    const maxTons = Math.max(...periods.map(period => period.tons), 1);
    const kpi = (label, value, note, extra = '') => `<article class="${extra}"><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`;
    summary.innerHTML = `<div class="export-production-title"><div><small>RELATÓRIO DE OPERAÇÃO · ${escapeHtml(latest ? `${latest.date} · ${latest.period}` : 'Sem turno registrado')}</small><h2>${escapeHtml(data.vessel)}</h2><p>${escapeHtml(data.cargo)} · ${planned === null ? 'Meta não informada' : `${exportNumber.format(planned)} t previstas`}</p></div><div class="export-production-progress">${percent === null ? 'Meta não informada' : `${exportNumber.format(percent)}% do previsto`}</div></div>
      <div class="export-production-kpis">
        ${kpi(data.sourceKind === 'potassio' ? 'TOTAL DESCARREGADO' : 'TOTAL PRODUZIDO', `${exportNumber.format(data.produced)} t`, 'Até o último período registrado')}
        ${kpi('SALDO TOTAL', balance === null ? '—' : `${exportNumber.format(balance)} t`, planned === null ? 'Meta não informada' : 'Restante previsto', 'export-kpi-balance')}
        ${kpi('PRODUÇÃO DO TURNO', latest ? `${exportNumber.format(latest.tons)} t` : '—', latest ? `${latest.date} · ${latest.period}` : 'Nenhum período registrado')}
        ${kpi('TÉRMINO PREVISTO', data.eta ? escapeHtml(productionTimeExport.format(data.eta)) : '—', data.dailyRate > 0 ? `Ritmo atual: ${exportNumber.format(data.dailyRate)} t/dia` : 'Aguardando produção')}
      </div>
<div class="export-production-middle"><div class="export-production-ship"><h3>PRODUÇÃO POR PORÃO</h3><div class="export-production-ship-visual"></div></div><div class="export-production-shift-stops"><h3>PARADAS DO TURNO</h3><strong>${duration(shiftStopMinutes)}</strong><p>${shiftStops.length} ${shiftStops.length === 1 ? 'parada registrada' : 'paradas registradas'} no último período</p><div class="export-stop-track"><i style="width:${Math.min(100, shiftStopMinutes / 360 * 100)}%"></i></div>${shiftStops.length ? shiftStopRows : '<p class="export-stop-none">Sem paradas registradas neste turno.</p>'}</div></div>
      <div class="export-production-bottom"><div class="export-production-periods"><h3>PRODUÇÃO POR TURNO</h3><div class="export-period-bars">${periods.map(period => `<div class="export-period"><b>${exportNumber.format(period.tons)}</b><i style="height:${Math.max(3, period.tons / maxTons * 110)}px"></i><span>${period.date}<br>${period.period.slice(0, 5)}</span></div>`).join('') || '<p>Sem períodos registrados.</p>'}</div></div><div class="export-production-reasons"><h3>PARALISAÇÕES ACUMULADAS</h3><p>Desde o início da operação · ${duration((data.stops || []).reduce((sum, stop) => sum + (stop.duration || 0), 0))} registrados</p>${reasonList.map(item => `<div class="export-reason"><span>${escapeHtml(item.reason)}</span><i><b style="width:${item.minutes / maxReason * 100}%"></b></i><strong>${duration(item.minutes)}</strong></div>`).join('') || '<p>Sem paralisações registradas.</p>'}</div></div><footer class="export-production-footnote">Dados até o último período registrado. Tempos de paradas podem se sobrepor entre ternos; a previsão usa a prancha real atual.</footer>`;
    const operationTime = window.getProductionTimeMetrics?.(data);
    const shiftPanel = summary.querySelector('.export-production-shift-stops');
    shiftPanel.querySelector('h3').textContent = 'TEMPOS DA OPERAÇÃO';
    shiftPanel.querySelector(':scope > strong')?.remove();
    shiftPanel.querySelector(':scope > p')?.remove();
    shiftPanel.querySelector('.export-stop-track')?.remove();
    const timeStats = document.createElement('div');
    timeStats.className = 'export-production-time-stats';
    timeStats.innerHTML = `<div><span>TOTAL</span><strong>${operationTime ? duration(operationTime.totalMinutes) : '—'}</strong></div><div><span>PRODUTIVO EST.</span><strong>${operationTime ? duration(operationTime.productiveMinutes) : '—'}</strong></div><div><span>PARADO</span><strong>${operationTime ? duration(operationTime.stoppedMinutes) : '—'}</strong></div>`;
    shiftPanel.querySelector('h3').after(timeStats);
    const shiftHeading = document.createElement('h4');
    shiftHeading.textContent = `PARADAS DO ÚLTIMO TURNO · ${duration(shiftStopMinutes)}`;
    timeStats.after(shiftHeading);
    summary.querySelector('.export-production-footnote').textContent = 'Dados até o último período registrado. Tempo produtivo estimado = tempo total menos a união dos intervalos de parada, sem dupla contagem. Paradas de ternos simultâneos não significam necessariamente parada do navio inteiro.';
    const ship = section.querySelector('.production-vessel-diagram');
    if (ship) {
      const clone = ship.cloneNode(true);
      clone.querySelectorAll('.is-selected').forEach(item => item.classList.remove('is-selected'));
      clone.querySelectorAll('[aria-pressed]').forEach(item => item.setAttribute('aria-pressed', 'false'));
      summary.querySelector('.export-production-ship-visual').appendChild(clone);
    } else summary.querySelector('.export-production-ship').remove();
    return summary;
  }

  /* Logo horizontal colorido convertido em PNG: o html2canvas não desenha SVG de forma confiável. */
  let logoPng;
  async function logoDataUrl() {
    if (logoPng) return logoPng;
    const image = new Image();
    image.src = 'logo-triunfo-horizontal-cor.svg';
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth * 3; canvas.height = image.naturalHeight * 3;
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    logoPng = canvas.toDataURL('image/png');
    return logoPng;
  }
  const generatedAt = () => new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }).format(new Date());

  async function createStage(section) {
    const stage = document.createElement('div');
    stage.className = 'export-stage';
    if (section.id === 'producao') stage.classList.add('export-stage-production');
    const header = document.createElement('header');
    header.className = 'export-stage-header';
    const title = section.id === 'geral' ? document.querySelector('#generalTitle h2')?.textContent : names[section.id];
    const context = selectedContext(section);
    const logo = await logoDataUrl();
    header.innerHTML = `<img class="export-logo" alt="Triunfo Logística"><div class="export-title"><small>PAINEL DE OPERAÇÕES TPS</small><h1></h1><p></p></div><div class="export-meta"><span class="export-generated"></span><span class="export-data"></span></div>`;
    header.querySelector('.export-logo').src = logo;
    header.querySelector('h1').textContent = section.id === 'producao' ? 'Relatório de operação · Produção' : (title || names[section.id]);
    header.querySelector('p').textContent = context ? `Filtros: ${context}` : '';
    header.querySelector('.export-generated').textContent = `Gerado em ${generatedAt()}`;
    header.querySelector('.export-data').textContent = window.getExportDataNote?.(section.id) || '';
    stage.appendChild(header);
    if (section.id === 'producao') {
      stage.appendChild(productionSummary(section));
      document.body.appendChild(stage);
      return stage;
    }
    const clone = section.cloneNode(true);
    clone.classList.add('export-section');
    const originalCanvases = [...section.querySelectorAll('canvas')];
    [...clone.querySelectorAll('canvas')].forEach((canvas, index) => {
      const original = originalCanvases[index];
      if (!original || !original.width || !original.height) return;
      const image = document.createElement('img');
      image.src = original.toDataURL('image/png');
      image.alt = 'Gráfico';
      image.className = 'export-chart-image';
      image.style.width = `${original.getBoundingClientRect().width}px`;
      image.style.height = `${original.getBoundingClientRect().height}px`;
      canvas.replaceWith(image);
    });
    stage.appendChild(clone);
    document.body.appendChild(stage);
    return stage;
  }

  /* Página A4 paisagem (281 × 194 mm úteis): o conteúdo ocupa a parte de cima e
     o rodapé da marca fica numa faixa própria em todas as páginas. */
  const pageHeight = width => Math.floor(width * 194 / 281);
  const footerHeight = width => Math.round(pageHeight(width) * 0.045);
  function slices(canvas) {
    const height = pageHeight(canvas.width) - footerHeight(canvas.width);
    return Array.from({ length: Math.ceil(canvas.height / height) }, (_, index) => ({ y: index * height, height }));
  }
  function drawFooter(ctx, width, top, height, index, total) {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, top, width, height);
    ctx.fillStyle = '#DA202C';
    ctx.fillRect(Math.round(width * 0.03), top + Math.round(height * 0.18), width - Math.round(width * 0.06), Math.max(2, Math.round(height * 0.05)));
    const size = Math.round(height * 0.34);
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#2F2F2F';
    ctx.font = `600 ${size}px Poppins, Helvetica, Arial, sans-serif`;
    ctx.textAlign = 'left';
    ctx.fillText('Triunfo Logística · Painel de Operações TPS', Math.round(width * 0.03), top + height * 0.62);
    if (total > 1) {
      ctx.fillStyle = '#636363';
      ctx.font = `400 ${size}px Poppins, Helvetica, Arial, sans-serif`;
      ctx.textAlign = 'right';
      ctx.fillText(`Página ${index + 1} de ${total}`, width - Math.round(width * 0.03), top + height * 0.62);
    }
  }

  function drawPage(source, slice, index = 0, total = 1) {
    const page = document.createElement('canvas');
    page.width = source.width;
    page.height = slice.height + footerHeight(source.width);
    const ctx = page.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, page.width, page.height);
    const available = Math.max(0, Math.min(slice.height, source.height - slice.y));
    if (available) ctx.drawImage(source, 0, slice.y, source.width, available, 0, 0, source.width, available);
    drawFooter(ctx, page.width, slice.height, page.height - slice.height, index, total);
    return page;
  }

  /* Produção: tudo numa página só (a imagem é reduzida se precisar), com o rodapé abaixo. */
  function singleLandscapePage(source) {
    const page = document.createElement('canvas');
    page.width = source.width;
    page.height = pageHeight(source.width) - footerHeight(source.width);
    const ctx = page.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, page.width, page.height);
    const scale = Math.min(1, page.height / source.height);
    ctx.drawImage(source, (page.width - source.width * scale) / 2, 0, source.width * scale, source.height * scale);
    return page;
  }

  async function rasterizeExportCranes(stage) {
    const cranes = [...stage.querySelectorAll('.production-crane-silhouette')];
    await Promise.all(cranes.map(crane => new Promise((resolve, reject) => {
      const svg = crane.cloneNode(true);
      svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      svg.setAttribute('width', '100');
      svg.setAttribute('height', '110');
      const source = new Image();
      source.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 300;
          canvas.height = 330;
          canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
          const image = document.createElement('img');
          image.src = canvas.toDataURL('image/png');
          image.className = crane.getAttribute('class');
          image.style.cssText = crane.style.cssText;
          image.alt = '';
          image.setAttribute('aria-hidden', 'true');
          crane.replaceWith(image);
          image.decode().then(resolve, reject);
        } catch (error) { reject(error); }
      };
      source.onerror = () => reject(new Error('Não foi possível preparar o desenho dos guindastes para exportação.'));
      source.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
    })));
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function toBlob(canvas) {
    return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Não foi possível gerar a imagem.')), 'image/png'));
  }

  async function saveImage(canvas, filename) {
    const pages = slices(canvas);
    const columns = Math.min(pages.length, Math.ceil(Math.sqrt(pages.length * 1.5)));
    const rows = Math.ceil(pages.length / columns);
    const pageH = pages[0].height + footerHeight(canvas.width);
    const image = document.createElement('canvas');
    image.width = columns * canvas.width;
    image.height = rows * pageH;
    const ctx = image.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, image.width, image.height);
    pages.forEach((slice, index) => {
      ctx.drawImage(drawPage(canvas, slice, index, pages.length), (index % columns) * canvas.width, Math.floor(index / columns) * pageH);
    });
    download(await toBlob(image), filename);
  }

  function savePdf(canvas, filename) {
    const pdf = new window.jspdf.jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true });
    const pages = slices(canvas);
    pages.forEach((slice, index) => {
      if (index) pdf.addPage('a4', 'landscape');
      const page = drawPage(canvas, slice, index, pages.length);
      pdf.addImage(page.toDataURL('image/jpeg', 0.88), 'JPEG', 8, 8, 281, 194, undefined, 'FAST');
    });
    pdf.save(filename);
  }

  async function run(format) {
    if (busy) return;
    const section = document.querySelector('main > section.tab-panel.active');
    if (!section) return;
    busy = true;
    menu.open = false;
    let stage;
    const scrollY = window.scrollY;
    try {
      announce(`Preparando ${format === 'pdf' ? 'PDF' : 'imagem'} em paisagem…`);
      await loadLibrary('vendor/html2canvas.min.js', 'html2canvas');
      if (format === 'pdf') await loadLibrary('vendor/jspdf.umd.min.js', 'jspdf');
      await document.fonts.ready;
      window.scrollTo(0, 0);
      stage = await createStage(section);
      if (section.id === 'producao') await rasterizeExportCranes(stage);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const captured = await window.html2canvas(stage, {
        backgroundColor: '#FFFFFF', scale: 1.5, useCORS: true, logging: false,
        width: stage.scrollWidth, height: stage.scrollHeight,
        windowWidth: Math.max(stage.scrollWidth, window.innerWidth),
        windowHeight: Math.max(stage.scrollHeight, window.innerHeight)
      });
      const canvas = section.id === 'producao' ? singleLandscapePage(captured) : captured;
      const suffix = `${section.id}-${new Date().toISOString().slice(0, 10)}`;
      if (format === 'pdf') savePdf(canvas, `triunfo-${suffix}.pdf`);
      else await saveImage(canvas, `triunfo-${suffix}.png`);
      announce('Arquivo exportado com sucesso.', 4000);
    } catch (error) {
      console.error('Falha ao exportar o painel:', error);
      announce(error.message || 'Não foi possível exportar esta visão.', 7000);
    } finally {
      stage?.remove();
      window.scrollTo(0, scrollY);
      busy = false;
    }
  }

  document.getElementById('exportPdf').addEventListener('click', () => run('pdf'));
  document.getElementById('exportImage').addEventListener('click', () => run('image'));
  document.addEventListener('click', event => { if (!menu.contains(event.target)) menu.open = false; });
})();
