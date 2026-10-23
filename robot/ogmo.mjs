/* Robô de consulta do OGMO-RJ (GitHub Actions: .github/workflows/ogmo.yml).
   Entra no sistema de requisições do OGMO com o login da empresa (segredos do GitHub), lê a lista de requisições
   de ontem, hoje e amanhã, baixa o PDF ("Visualiza") das ativas e manda para o painel conferir.
   SÓ CONSULTA: as ações permitidas estão em ogmo-lib.mjs; qualquer outro envio ao OGMO é bloqueado antes de sair,
   e toda caixa de confirmação do OGMO é recusada.
   Modo diagnóstico (OGMO_MODO=diagnostico): só lista as requisições de hoje e testa o botão do PDF, sem mandar nada ao painel. */
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { extractText, getDocumentProxy } from "unpdf";
import { isAllowed, actionOf, MENU_REGISTRO, PDF_BUTTONS, datesAround, brDate, parseGrid, pdfMatches } from "./ogmo-lib.mjs";

const OGMO = "https://www.ogmorj.com.br/weboperador/WEBOPERADOR12081830.dll";
const env = process.env;
const DIAGNOSTIC = env.OGMO_MODO === "diagnostico";
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

const browser = await chromium.launch();
const context = await browser.newContext({ acceptDownloads: true, locale: "pt-BR", timezoneId: "America/Sao_Paulo", viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
page.setDefaultTimeout(30000);

// Trava de segurança: nenhum envio ao OGMO fora das ações de consulta.
let blocked = null;
await page.route("**/*", route => {
  const request = route.request();
  if (request.method() === "POST" && /\/EXEC$/i.test(request.url()) && !isAllowed(request.postData())) {
    blocked = actionOf(request.postData()) || "(sem ação)";
    return route.abort();
  }
  return route.continue();
});
// Confirmações do OGMO ("Deseja realmente…?") são sempre recusadas; avisos (alert) são lidos e fechados.
let lastAlert = null;
page.on("dialog", dialog => { if (dialog.type() === "alert") lastAlert = dialog.message(); dialog.dismiss().catch(() => {}); });

/** Executa uma ação que recarrega a página do IntraWeb e espera a nova página. */
async function act(run, { optional = false } = {}) {
  blocked = null;
  try {
    await Promise.all([page.waitForNavigation({ waitUntil: "load", timeout: optional ? 6000 : 30000 }), run()]);
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
  await page.goto(OGMO, { waitUntil: "load" });
  if (/Device not supported/i.test(await page.content())) throw new Error("O OGMO recusou o navegador (Device not supported).");
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

let pdfButton = env.OGMO_BOTAO_PDF || null;
/** Seleciona a requisição e baixa o "Visualiza". Descobre (e lembra) qual botão gera o PDF da requisição. */
async function downloadPdf(row) {
  if (!row.param) throw new Error(`Requisição ${row.number} sem parâmetro de seleção na grade.`);
  await act(() => submit("IWDBGRID1", row.param));
  for (const button of pdfButton ? [pdfButton] : PDF_BUTTONS) {
    try {
      const [download] = await Promise.all([page.waitForEvent("download", { timeout: 25000 }), submit(button)]);
      const bytes = await readFile(await download.path());
      if (String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") continue;
      if (!pdfMatches(await pdfText(bytes), row.number)) { log(`Botão ${button}: PDF não é da requisição ${row.number}.`); continue; }
      if (!pdfButton) log(`Botão do PDF: ${button}.`);
      pdfButton = button;
      return bytes;
    } catch (error) {
      if (blocked) throw error;
      log(`Botão ${button}: sem PDF (${error.message.split("\n")[0]}).`);
    }
  }
  throw new Error(`Não consegui baixar o PDF da requisição ${row.number}.`);
}

async function run() {
  const startedAt = new Date().toISOString();
  await login();
  await openRegistro();
  const dates = DIAGNOSTIC ? [datesAround()[1]] : datesAround();
  const known = DIAGNOSTIC ? {} : (await panel(`/conhecidas?datas=${dates.join(",")}`)).known;
  const all = [];
  for (const date of dates) {
    const rows = await search(date);
    log(`${brDate(date)}: ${rows.length} requisições (${rows.filter(r => r.cancelled).length} canceladas).`);
    all.push(...rows);
    for (const row of rows.filter(r => !r.cancelled)) {
      if (DIAGNOSTIC) { log(`  ${row.number} · ${row.period} · ${row.vessel} · ${row.local}${row.scaled ? " · escalada" : ""}`); continue; }
      if (known[row.number]?.scaled && row.scaled) continue; // já escalada e guardada: não muda mais
      const bytes = await downloadPdf(row);
      const result = await panel("/pdf", { method: "POST", body: bytes, headers: { "Content-Type": "application/pdf", "X-Arquivo": encodeURIComponent(`${row.number}.pdf`), "X-Escalada": row.scaled ? "1" : "0" } });
      if (result.number && result.number !== row.number) log(`Atenção: o PDF de ${row.number} veio como ${result.number}.`);
      log(`  ${row.number} ${row.period} ${row.vessel}: ${result.unchanged ? "sem mudança" : result.status}`);
      await pause(600);
    }
    if (DIAGNOSTIC) {
      const first = rows.find(r => !r.cancelled);
      if (first) { const bytes = await downloadPdf(first); log(`PDF de teste da requisição ${first.number}: ${bytes.byteLength} bytes; botão ${pdfButton}.`); }
    }
  }
  if (DIAGNOSTIC) { log("Diagnóstico concluído: nada foi enviado ao painel."); return; }
  const status = await panel("/lista", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ startedAt, dates, rows: all.map(({ param, ...row }) => row) }) });
  log(`Rodada registrada: ${status.active} ativas, ${status.cancelled} canceladas, ${status.missing.length} faltando.`);
}

try {
  await run();
} catch (error) {
  console.error("Falha:", error.message);
  await page.screenshot({ path: "falha.png", fullPage: true }).catch(() => {});
  if (!DIAGNOSTIC) await panel("/erro", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: error.message }) }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
