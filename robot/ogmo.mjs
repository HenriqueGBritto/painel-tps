/* Robô de consulta do OGMO-RJ (GitHub Actions: .github/workflows/ogmo.yml).
   Entra no sistema de requisições do OGMO com o login da empresa (segredos do GitHub), lê a lista de requisições
   de ontem, hoje e amanhã, baixa o PDF ("Visualiza") das ativas e manda para o painel conferir. Das já escaladas,
   baixa também o DA9 (trabalhadores escalados).
   Busca sob demanda (aba Requisições → "Buscar no OGMO"): OGMO_PEDIDO e OGMO_DATAS trocam os dias lidos.
   SÓ CONSULTA: as ações permitidas estão em ogmo-lib.mjs; qualquer outro envio ao OGMO é bloqueado antes de sair,
   e toda caixa de confirmação do OGMO é recusada.
   Modo diagnóstico (OGMO_MODO=diagnostico): só lista as requisições de hoje e testa o botão do PDF, sem mandar nada ao painel. */
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { extractText, getDocumentProxy } from "unpdf";
import { isAllowed, actionOf, MENU_REGISTRO, PDF_BUTTONS, DA9_BUTTON, datesAround, datesBetween, brDate, parseGrid, pdfMatches, isDa9 } from "./ogmo-lib.mjs";

const OGMO = "https://www.ogmorj.com.br/weboperador/WEBOPERADOR12081830.dll";
const env = process.env;
const DIAGNOSTIC = env.OGMO_MODO === "diagnostico";
/** Busca pedida na aba Requisições: id do pedido e os dias (OGMO_DATAS = "AAAA-MM-DD:AAAA-MM-DD"). */
const REQUEST = !DIAGNOSTIC && env.OGMO_PEDIDO ? env.OGMO_PEDIDO : null;
const PANEL = (env.PAINEL_URL || "https://paineltps.netlify.app").replace(/\/$/, "");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = (...parts) => console.log(new Date().toISOString().slice(11, 19), ...parts);

for (const name of ["OGMO_EMPRESA", "OGMO_USUARIO", "OGMO_SENHA", ...(DIAGNOSTIC ? [] : ["OGMO_SYNC_TOKEN"])]) {
  if (!env[name]) { console.error(`Falta o segredo ${name} no GitHub (Settings → Secrets and variables → Actions).`); process.exit(2); }
}

async function panel(path, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${PANEL}/api/requisicoes/ogmo${path}`, { method, body, headers: { Authorization: `Bearer ${env.OGMO_SYNC_TOKEN}`, ...headers }, signal: AbortSignal.timeout(60000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Painel respondeu ${response.status} em ${path}: ${data.error || ""}`);
  return data;
}

// No GitHub, OGMO_NAVEGADOR=chrome usa o Google Chrome que já vem na máquina (sem baixar navegador).
const browser = await chromium.launch(env.OGMO_NAVEGADOR ? { channel: env.OGMO_NAVEGADOR } : {});
const context = await browser.newContext({ acceptDownloads: true, locale: "pt-BR", timezoneId: "America/Sao_Paulo", viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
page.setDefaultTimeout(30000);

// Imagem vazia no lugar das do OGMO: a tela do IntraWeb só inicia (body onload="Initialize()") depois de carregar
// todas as imagens, e o servidor do OGMO demora a entregá-las. O robô clica pelos nomes, não precisa delas.
const BLANK_GIF = Buffer.from("R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==", "base64");

// Trava de segurança: nenhum envio ao OGMO fora das ações de consulta.
let blocked = null;
await page.route("**/*", route => {
  const request = route.request();
  if (request.method() === "POST" && /\/EXEC$/i.test(request.url()) && !isAllowed(request.postData())) {
    blocked = actionOf(request.postData()) || "(sem ação)";
    return route.abort();
  }
  if (["image", "media", "font"].includes(request.resourceType())) return route.fulfill({ status: 200, contentType: "image/gif", body: BLANK_GIF });
  return route.continue();
});
// Confirmações do OGMO ("Deseja realmente…?") são sempre recusadas; avisos (alert) são lidos e fechados.
let lastAlert = null;
page.on("dialog", dialog => { if (dialog.type() === "alert") lastAlert = dialog.message(); dialog.dismiss().catch(() => {}); });

/** A tela do IntraWeb está pronta para clicar: funções carregadas e inicialização da página feita (GActivateLock). */
const ready = (timeout = 60000) => page.waitForFunction(() => typeof window.SubmitClickConfirm === "function" && typeof window.GActivateLock !== "undefined" && document.querySelector("input[name=IW_TrackID_]"), null, { timeout });

/**
 * Executa uma ação que recarrega a página do IntraWeb e espera a nova página ficar utilizável (formulário e funções
 * da tela prontos). Não espera o "load" completo: o servidor do OGMO às vezes demora a entregar imagens.
 */
async function act(run, { optional = false, timeout = 45000 } = {}) {
  blocked = null;
  try {
    await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: optional ? 6000 : timeout }), run()]);
    await ready();
  } catch (error) {
    if (blocked) throw new Error(`Ação bloqueada pela trava de segurança: ${blocked}`);
    if (!optional) throw error;
  }
  if (blocked) throw new Error(`Ação bloqueada pela trava de segurança: ${blocked}`);
  await pause(400);
}
const submit = (name, param = "") => page.evaluate(([n, p]) => window.SubmitClickConfirm(n, p, true, ""), [name, param]);
const formName = () => page.$eval("input[name=IW_FormName]", input => input.value).catch(() => "");

async function login() {
  await page.goto(OGMO, { waitUntil: "domcontentloaded", timeout: 45000 });
  // A página inicial do OGMO se redireciona ao abrir: espera o formulário de login aparecer.
  try {
    await page.waitForSelector("input[name=EDTEMPRESA]", { timeout: 45000 });
  } catch {
    const html = await page.content().catch(() => "");
    throw new Error(/Device not supported/i.test(html) ? "O OGMO recusou o navegador (Device not supported)." : "A tela de login do OGMO não apareceu.");
  }
  await page.fill("input[name=EDTEMPRESA]", env.OGMO_EMPRESA);
  await page.fill("input[name=EDTUSUARIO]", env.OGMO_USUARIO);
  await page.fill("input[name=EDTSENHA]", env.OGMO_SENHA);
  await act(() => page.click("input[name=BTENTRAR]"));
  if (!(await page.$("#IWMENU1_submenu5"))) throw new Error(`Não entrou no OGMO${lastAlert ? `: ${lastAlert}` : " (login, senha ou empresa recusados?)"}.`);
  log("Entrou no OGMO.");
}

async function openRegistro() {
  await act(() => page.evaluate(([menu, item]) => window.SubmitClick(menu, item, false), MENU_REGISTRO));
  if ((await formName()) !== "FrmCadRequisicao") throw new Error(`Não abriu o Registro de Requisições (tela ${await formName()}).`);
}

/** Pesquisa um dia: porto Rio de Janeiro, todos os períodos. Devolve as linhas da grade. */
async function search(date) {
  const dateField = "input[name=IWDTOPERACAO]:not([type=hidden])";
  await page.fill(dateField, brDate(date));
  if ((await page.$eval("select[name=DBLPORTO]", s => s.value)) !== "0") await act(() => page.selectOption("select[name=DBLPORTO]", "0"));
  await page.fill(dateField, brDate(date));
  if ((await page.$eval("select[name=DBLPESQPERIODO]", s => s.value)) !== "0") await act(() => page.selectOption("select[name=DBLPESQPERIODO]", "0"), { optional: true });
  await page.fill(dateField, brDate(date));
  await act(() => submit("IWBUSCAR"));
  const rows = await page.$$eval("table", tables => {
    const grid = tables.find(t => !t.querySelector("table") && t.rows.length && /Requisi/.test(t.rows[0].innerText) && /Navio/.test(t.rows[0].innerText));
    return grid ? [...grid.rows].slice(1).map(row => ({ cells: [...row.cells].map(cell => cell.innerText.trim()), onclick: row.getAttribute("onclick") || "" })) : [];
  });
  return parseGrid(rows, date);
}

async function pdfText(bytes) {
  const { text } = await extractText(await getDocumentProxy(new Uint8Array(bytes)), { mergePages: true });
  return text;
}

/**
 * O IntraWeb marca "enviando" (GSubmitting) e trava a tela (ActivateLock) a cada clique e só solta quando a página
 * recarrega. O PDF vem como download, a página não recarrega e os próximos cliques seriam ignorados: solta aqui.
 */
const unlock = () => page.evaluate(() => {
  window.GSubmitting = false;
  if (typeof window.ReleaseLock === "function") try { window.ReleaseLock(); } catch { /* sem o cadeado na tela */ }
  if (typeof window.SetBusy === "function") try { window.SetBusy(false); } catch { /* sem o cursor de espera */ }
}).catch(() => {});

/** Seleciona a requisição na grade (os botões de PDF valem para a linha selecionada). */
async function select(row) {
  if (!row.param) throw new Error(`Requisição ${row.number} sem parâmetro de seleção na grade.`);
  try {
    await act(() => submit("IWDBGRID1", row.param), { timeout: 15000 });
  } catch (error) {
    if (blocked) throw error;
    // A tela não respondeu (OGMO lento ou travado depois do PDF anterior): espera a página assentar,
    // pesquisa o dia de novo e tenta selecionar outra vez.
    log(`Seleção de ${row.number} sem resposta em 15 s; pesquisando ${brDate(row.date)} de novo.`);
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    await ready(45000).catch(() => {});
    await unlock();
    await search(row.date);
    await act(() => submit("IWDBGRID1", row.param), { timeout: 45000 });
  }
}

/** Clica no botão e devolve o PDF baixado, se for da requisição e do tipo esperado (DA9 ou "Visualiza"); senão null. */
async function pdfFrom(button, row, { da9 = false } = {}) {
  try {
    const [download] = await Promise.all([page.waitForEvent("download", { timeout: 25000 }), submit(button)]);
    const bytes = await readFile(await download.path());
    await unlock();
    if (String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") return null;
    const text = await pdfText(bytes);
    if (!pdfMatches(text, row.number) || isDa9(text) !== da9) { log(`Botão ${button}: o PDF não é ${da9 ? "o DA9" : "o Visualiza"} da requisição ${row.number}.`); return null; }
    return bytes;
  } catch (error) {
    if (blocked) throw error;
    await unlock();
    log(`Botão ${button}: sem PDF (${error.message.split("\n")[0]}).`);
    return null;
  }
}

let pdfButton = env.OGMO_BOTAO_PDF || null;
/** Baixa o "Visualiza" da requisição selecionada. Descobre (e lembra) qual botão gera o PDF da requisição. */
async function downloadPdf(row) {
  for (const button of pdfButton ? [pdfButton] : PDF_BUTTONS) {
    const bytes = await pdfFrom(button, row);
    if (!bytes) continue;
    if (!pdfButton) log(`Botão do PDF: ${button}.`);
    pdfButton = button;
    return bytes;
  }
  throw new Error(`Não consegui baixar o PDF da requisição ${row.number}.`);
}

/** Baixa e manda ao painel o DA9 da requisição selecionada (já escalada). Falha no DA9 não derruba a rodada. */
async function sendDa9(row) {
  const bytes = await pdfFrom(DA9_BUTTON, row, { da9: true });
  if (!bytes) { log(`  ${row.number}: DA9 indisponível agora.`); return; }
  await panel("/da9", { method: "POST", body: bytes, headers: { "Content-Type": "application/pdf", "X-Requisicao": row.number, "X-Data": row.date } });
  log(`  ${row.number}: DA9 guardado.`);
}

async function run() {
  const startedAt = new Date().toISOString();
  await login();
  await openRegistro();
  const dates = DIAGNOSTIC ? [datesAround()[1]] : REQUEST ? datesBetween(env.OGMO_DATAS) : datesAround();
  if (!dates.length) throw new Error(`Período da busca inválido: ${env.OGMO_DATAS || "(vazio)"}.`);
  const known = DIAGNOSTIC ? {} : (await panel(`/conhecidas?datas=${dates.join(",")}`)).known;
  const all = [];
  for (const [index, date] of dates.entries()) {
    const rows = await search(date);
    log(`${brDate(date)}: ${rows.length} requisições (${rows.filter(r => r.cancelled).length} canceladas).`);
    all.push(...rows);
    for (const row of rows.filter(r => !r.cancelled)) {
      if (DIAGNOSTIC) { log(`  ${row.number} · ${row.period} · ${row.vessel} · ${row.local}${row.scaled ? " · escalada" : ""}`); continue; }
      const stored = known[row.number];
      const needPdf = !(stored?.scaled && row.scaled); // já escalada e guardada: não muda mais
      const needDa9 = row.scaled && !stored?.da9;
      if (!needPdf && !needDa9) continue;
      await select(row);
      if (needPdf) {
        const bytes = await downloadPdf(row);
        const result = await panel("/pdf", { method: "POST", body: bytes, headers: { "Content-Type": "application/pdf", "X-Arquivo": encodeURIComponent(`${row.number}.pdf`), "X-Escalada": row.scaled ? "1" : "0" } });
        if (result.number && result.number !== row.number) log(`Atenção: o PDF de ${row.number} veio como ${result.number}.`);
        log(`  ${row.number} ${row.period} ${row.vessel}: ${result.unchanged ? "sem mudança" : result.status}`);
      }
      if (needDa9) await sendDa9(row);
      await pause(600);
    }
    if (DIAGNOSTIC) {
      const first = rows.find(r => !r.cancelled);
      if (first) { await select(first); const bytes = await downloadPdf(first); log(`PDF de teste da requisição ${first.number}: ${bytes.byteLength} bytes; botão ${pdfButton}.`); }
    }
    // Busca sob demanda: manda a lista dia a dia (o painel reconfere por partes e mostra o andamento).
    if (REQUEST) {
      const part = await panel("/lista", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ startedAt, dates: [date], rows: rows.map(({ param, ...row }) => row), pedido: REQUEST, dia: index + 1, dias: dates.length }) });
      log(`Busca: ${part.days} de ${dates.length} dias lidos.`);
    }
  }
  if (DIAGNOSTIC) { log("Diagnóstico concluído: nada foi enviado ao painel."); return; }
  if (REQUEST) { log("Busca concluída."); return; }
  const status = await panel("/lista", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ startedAt, dates, rows: all.map(({ param, ...row }) => row) }) });
  log(`Rodada registrada: ${status.active} ativas, ${status.cancelled} canceladas, ${status.missing.length} faltando.`);
}

/** Até 2 tentativas: o servidor do OGMO às vezes demora. Trava de segurança e login recusado não se repetem. */
async function runWithRetry() {
  for (let attempt = 1; ; attempt++) {
    try { return await run(); }
    catch (error) {
      if (attempt >= 2 || /trava de segurança|Não entrou no OGMO|recusou o navegador/.test(error.message)) throw error;
      log(`Tentativa ${attempt} falhou (${error.message.split("\n")[0]}); entrando de novo em 10 s.`);
      await pause(10000);
    }
  }
}

try {
  await runWithRetry();
} catch (error) {
  console.error("Falha:", error.message);
  await page.screenshot({ path: "falha.png", fullPage: true }).catch(() => {});
  if (!DIAGNOSTIC) await panel("/erro", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: error.message, ...(REQUEST ? { pedido: REQUEST } : {}) }) }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
