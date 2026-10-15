import assert from "node:assert/strict";
import { test } from "node:test";
import { XLSX } from "../netlify/lib/parsers.mjs";
import { parseTeamWorkbook, normalizeName, matriculaIn, peopleIndex, cellDate, serialToIso, datesInText, participantStatus, certificateStatus } from "../netlify/lib/team-parsers.mjs";
import { diffTeam } from "../netlify/lib/changes.mjs";

/* Planilha de exemplo com os formatos reais (nomes fictícios). */
const serial = iso => Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000);
const cadastro = [
  ["Matrícula", "Nome", "Função", "Categoria", "Equipe", "Turno", "Horário", "Escala", "Status", "Observação", "seq", "chave_grade"],
  [1001, "Ana Paula de Souza", "Conferente", "Operação", "A", "Diurno", "07:00 às 19:00", "2x2", "Ativo", "", 1, "x"],
  [1002, "Bruno Costa Lima", "Operador de Movimentação de Carga", "Operação", "A", "Diurno", "07:00 às 19:00", "2x2", "Ativo (em transferência)", "Vai para Capatazia Dia", 1, "x"],
  [1003, "Carlos Eduardo Santos", "Conferente", "Operação", "C", "Noturno", "19:00 às 07:00", "2x2", "Afastado (INSS)", "", 1, "x"],
  [1004, "Netzer Cardel Schmidt", "Operador de Movimentação de Carga", "Operação", "B", "Diurno", "07:00 às 19:00", "2x2", "Ativo", "Vespertino", 1, "x"],
  [1005, "Diego Ramos da Silva", "Estivador", "Operação", "D", "Noturno", "19:00 às 07:00", "2x2", "Ativo", "Fez 12x36 em 2025", 1, "x"],
  [1006, "Rodrigo Santos Rocha", "Trabalhador de Capatazia", "Operação", "Capatazia Dia", "Diurno", "07:00 às 16:48", "5x2", "Ativo", "", 1, "x"]
];
const listas = [
  ["Funções", "Categoria", "", "Equipe", "Turno", "Horário", "Escala", "Bloco no quadro", "", "Status"],
  ["Conferente", "Operação", "", "A", "Diurno", "07:00 às 19:00", "2x2", "A", "", "Ativo"],
  ["Estivador", "Operação", "", "Capatazia Dia", "Diurno", "07:00 às 16:48", "5x2", "Capatazia Dia", "", "Afastado (INSS)"]
];
const ferias = [
  ["FÉRIAS JANEIRO 2026 - DOCUMENTAÇÃO COM CGP - NO 30"],
  ["Matrícula", "Nome", null, null, null, "Equipe", "Inicio", "Término"],
  [1001, "ANA PAULA DE SOUZA / ", null, null, null, "Equipe A", serial("2026-01-05"), serial("2026-02-03")],
  [9999, "CARLOS EDUARDO SANTOS", null, null, null, "Equipe C", serial("2026-01-10"), "31//01/2026"],
  ["FÉRIAS JULHO 2026"],
  ["Matrícula", "Nome", "FUNÇÃO", "Equipe", "Inicio", "Término", "Retorno", "CHAPA", "NOME", "FUNÇÃO"],
  [1003, "CARLOS EDUARDO SANTOS", "CONFERENTE", "C", serial("2026-07-01"), serial("2026-07-31"), "AFASTAMENTO", 1004, "NETZER CARDEL SCHMIDT - B", "OPMC"],
  ["CHAPA", "NOME", "FUNÇÃO", "DATAINICIO", "DATAFIM", "AVISADO DO AVISO E RECIBO", "QUEM VAI COBRIR"],
  [1005, "DIEGO RAMOS DA SILVA", "ESTIVADOR", serial("2026-08-02"), serial("2026-08-31"), "SIM", "RETORNA EM 03/09/26"],
  ["COBERTURA DE FÉRIAS AGOSTO / 2026"],
  ["CHAPA", "NOME", "FUNÇÃO", "SETOR", "MOTIVO", "PERIODO INICIO", "PERIODO FIM", "CHAPA", "NOME - IT'S", "FUNÇÃO", "avaliação feita"],
  [1005, "DIEGO RAMOS DA SILVA", "ESTIVADOR", "TPS", "FÉRIAS", serial("2026-08-02"), serial("2026-08-31"), 1001, "ANA PAULA DE SOUZA - A", "CONFERENTE", "OK"],
  ["PLANILHA DE FÉRIAS E COBERTURA NO TPS OUTUBRO - ENVIAR EM 21/09/2026"],
  ["MATRIC.", "NOME", "FUNÇÃO", "INICIO", "TÉRMINO", "RETORNA", "COBERTURA"],
  [1001, "ANA PAULA DE SOUZA - A - AVISADO", "CONFERENTE", serial("2026-10-03"), serial("2026-10-22"), serial("2026-10-23"), " NETZER CARDEL SCHDMIT - 1004 ", "NÃO PODE COBRIR - MAIS DE 3 VEZES"],
  [1006, "RODRIGO SANTOS DA ROCHA - CAPATAZIA DIA", "TRABALHADOR DE CAPATAZIA", serial("2026-10-01"), serial("2026-10-30"), serial("2026-11-02"), "Sem Cobertura"],
  [7777, "FULANO DE TAL - NÃO É TPS", "OPERADOR DE GUINDASTE", serial("2026-10-17"), serial("2026-11-05"), null, null]
];
const treinamentos = [
  [null, "NOMES PARA CURSO DE NR35 E PTA"],
  [null, "EQUIPE A - Das 7h às 19h", "MELHOR DIA DO ASO"],
  [null, "1001 - Ana Paula de Souza", serial("2025-11-11"), null, null, "Realizou O ASO"],
  [null, "EQUIPE B - Das 7h às 19h", "MELHOR DIA DO ASO"],
  [null, "1004 - Netzer Cardel Schmidt", serial("2025-11-12"), null, null, "Realizou O ASO"],
  [null, "DESISTÊNCIAS"],
  [null, "8888 - Pessoa Que Saiu"],
  [null, "TREINAMENTO BRIGADA DE INCÊNDIO VOLUNTÁRIA - DIAS 15 e 16/07/2026"],
  [null, "NOME COMPLETO", "MATRÍCULA", "EQUIPE - Controle TPS"],
  [null, "Bruno Costa Lima - mensagem enviada pedindo o certificado para a Joycy", "(OPMC) 1002 - DIAS 15 e 16/07 - 8:30 às 17h", "A - Cartão HE 100%- Fulano Gestor", "CANCELADO os dias 07 e 08/07/26 - FOI PARA 15 e 16/07/2026"],
  [null, "O treinamento ocorrerá na Rua Exemplo, n° 1, na empresa Top Fire."],
  [null, "Diego Ramos da Silva - NÃO QUIS", "(ESTIVADOR) 1005"],
  ["MATRICULA", "NOME - DIA 11/09/2026 - CURSO NR35", "FUNÇÃO"],
  [1001, "ANA PAULA DE SOUZA - A - Não quis PTA", "CONFERENTE - CERTIFICADO"],
  [1004, "NETZER CARDEL SCHDMIT - B", "OPMC - 24/09/2026 ASO NR35 - AVISADO"]
];
function workbook({ withTrainings = true } = {}) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(cadastro), "Cadastro");
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(listas), "Listas");
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(ferias), "Férias");
  if (withTrainings) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(treinamentos), "NOVOS TREINAMENTOS");
  return book;
}
const data = parseTeamWorkbook(workbook());
const person = id => data.people.find(item => item.id === id);
const messages = pattern => data.report.filter(item => pattern.test(item.message));

test("datas: número de série do Excel e texto torto", () => {
  assert.equal(serialToIso(46310), "2026-10-15");
  assert.deepEqual(cellDate("31//01/2026"), { date: "2026-01-31", typed: true });
  assert.deepEqual(cellDate(serial("2026-07-01")), { date: "2026-07-01", typed: false });
  assert.deepEqual(datesInText("DIAS 15 e 16/07/2026 - 23 e 24/07/2026"), ["2026-07-15", "2026-07-16", "2026-07-23", "2026-07-24"]);
});

test("nomes: sem acento, caixa, matrícula e sufixos da planilha", () => {
  assert.equal(normalizeName("ANA PAULA DE SOUZA - A - AVISADO"), "ANA PAULA DE SOUZA");
  assert.equal(normalizeName("8935 - Ramon da Silva Machado"), "RAMON DA SILVA MACHADO");
  assert.equal(normalizeName("(OPMC) 8428 - DIAS 23 e 24/07"), "");
  assert.equal(normalizeName("CARLOS ALBERTO RIBEIRO PEREIRA  ( CARLINHOS ) - MATERIAIS"), "CARLOS ALBERTO RIBEIRO PEREIRA");
  assert.equal(normalizeName("MATEUS FELIPE MARINHO DA SILVA avisado - app meu RH"), "MATEUS FELIPE MARINHO DA SILVA");
  assert.equal(normalizeName("José Luíz Rosa Martins"), "JOSE LUIZ ROSA MARTINS");
  assert.equal(matriculaIn("NETZER CARDEL SCHMIDT - 7020"), "7020");
  assert.equal(matriculaIn("DIAS 23 e 24/07 - 8:30 às 17h"), null, "datas e horários não são matrícula");
});

test("vínculo de pessoas: matrícula, nome, aproximação, conflito e externos", () => {
  const index = peopleIndex(data.people);
  assert.deepEqual(index.resolve({ matricula: "1001" }), { id: "1001", how: "matricula" });
  assert.deepEqual(index.resolve({ name: "BRUNO COSTA LIMA - A" }), { id: "1002", how: "nome" });
  assert.deepEqual(index.resolve({ name: "NETZER CARDEL SCHDMIT" }), { id: "1004", how: "aproximado" }, "erro de digitação");
  assert.deepEqual(index.resolve({ name: "RODRIGO SANTOS DA ROCHA" }), { id: "1006", how: "aproximado" }, "com e sem 'DA'");
  const conflict = index.resolve({ matricula: "1001", name: "CARLOS EDUARDO SANTOS" });
  assert.equal(conflict.id, "1003", "o nome tem prioridade quando a matrícula é de outra pessoa");
  assert.match(conflict.conflict, /no Cadastro 1001 é Ana Paula de Souza/);
  assert.deepEqual(index.resolve({ matricula: "5555", name: "NINGUEM CONHECIDO" }), { external: true });
});

test("cadastro: status, transferência com destino e escala diferenciada", () => {
  assert.equal(data.people.length, 6);
  assert.equal(person("1002").transferTo, "Capatazia Dia");
  assert.equal(person("1004").customSchedule, true, "Vespertino");
  assert.equal(person("1001").customSchedule, false);
  assert.equal(person("1003").status, "Afastado (INSS)");
  assert.deepEqual(data.lists.roles.map(item => item.role), ["Conferente", "Estivador"]);
});

test("férias: blocos com títulos e cabeçalhos diferentes viram ausências normalizadas", () => {
  const ana = data.absences.filter(item => item.person.id === "1001");
  assert.deepEqual(ana.map(item => [item.start, item.end]), [["2026-01-05", "2026-02-03"], ["2026-10-03", "2026-10-22"]]);
  const october = ana[1];
  assert.deepEqual([october.returnDate, october.cover?.id, october.coverStatus], ["2026-10-23", "1004", "com cobertura"]);
  assert.ok(october.notes.includes("avisado") && october.notes.includes("NÃO PODE COBRIR - MAIS DE 3 VEZES"), JSON.stringify(october.notes));
  const carlosJan = data.absences.find(item => item.person.id === "1003" && item.start === "2026-01-10");
  assert.equal(carlosJan.end, "2026-01-31", "data digitada como texto");
  const carlosJul = data.absences.find(item => item.person.id === "1003" && item.start === "2026-07-01");
  assert.deepEqual([carlosJul.motive, carlosJul.cover.id], ["Afastamento", "1004"], "motivo no campo de retorno; cobertura no 2º par CHAPA/NOME");
  const rodrigo = data.absences.find(item => item.person.id === "1006");
  assert.equal(rodrigo.coverStatus, "sem cobertura");
  const external = data.absences.find(item => item.person.external);
  assert.deepEqual([external.person.id, external.notes], ["7777", ["não é TPS"]]);
});

test("férias: a mesma ausência em dois blocos vira um registro só, com a cobertura de um deles", () => {
  const diego = data.absences.filter(item => item.person.id === "1005");
  assert.equal(diego.length, 1);
  assert.deepEqual([diego[0].cover.id, diego[0].blocks.length, diego[0].evaluation], ["1001", 2, "OK"]);
  assert.ok(diego[0].notes.includes("retorna em 03/09/26"));
  assert.equal(diego[0].block, "Bloco sem título (depois de “FÉRIAS JULHO 2026”)");
});

test("relatório de importação: conflitos, datas em texto, externos, bloco sem título e 12x36", () => {
  assert.ok(messages(/Vínculo com conflito/).some(item => /matrícula 9999/.test(item.message)));
  assert.equal(messages(/digitada como texto/).length, 1);
  assert.ok(messages(/fora do Cadastro/).some(item => /FULANO/.test(item.text)));
  assert.equal(messages(/Cabeçalho sem título/).length, 1);
  assert.ok(messages(/12x36/).some(item => item.sheet === "Cadastro"));
});

test("treinamentos: blocos, equipes, situação, certificado e local", () => {
  const nr35 = data.trainings.find(item => /NOMES PARA CURSO/.test(item.title));
  assert.deepEqual(nr35.participants.map(item => [item.person.id, item.team, item.status]), [["1001", "A", "realizado"], ["1004", "B", "realizado"], ["8888", null, "desistiu"]]);
  assert.equal(nr35.participants[2].person.external, true);
  const brigada = data.trainings.find(item => item.type === "Brigada de Incêndio");
  assert.equal(brigada.location, "Rua Exemplo, n° 1, na empresa Top Fire");
  assert.deepEqual(brigada.participants.map(item => [item.person.id, item.status, item.certificate]), [["1002", "realizado", "pedido"], ["1005", "não quis", null]]);
  assert.ok(!brigada.participants.some(item => /GESTOR|CANCELADO/.test(item.person.name)), "colunas de apoio não viram participantes");
  const course = data.trainings.find(item => /11\/09\/2026/.test(item.title));
  assert.deepEqual(course.dates, ["2026-09-11"]);
  assert.deepEqual(course.participants.map(item => [item.person.id, item.status, item.certificate]), [["1001", "realizado", "recebido"], ["1004", "agendado", null]]);
});

test("situação e certificado pelas palavras do texto", () => {
  assert.equal(participantStatus("CANCELADO os dias 07 e 08/07 - FOI PARA 23 e 24/07"), "agendado");
  assert.equal(participantStatus("CANCELADO"), "cancelado");
  assert.equal(participantStatus("TIAGO - FALTOU"), "faltou");
  assert.equal(participantStatus("Não quis PTA · OPMC - CERTIFICADO"), "realizado");
  assert.equal(participantStatus("Não quis"), "não quis");
  assert.equal(certificateStatus("mensagem enviada pedindo o certificado para a Joycy - ENVIADO"), "recebido");
  assert.equal(certificateStatus("pedindo o certificado"), "pedido");
});

test("planilha sem a aba de treinamentos: segue e avisa no relatório", () => {
  const partial = parseTeamWorkbook(workbook({ withTrainings: false }));
  assert.deepEqual(partial.trainings, []);
  assert.ok(partial.report.some(item => item.sheet === "NOVOS TREINAMENTOS" && /não encontrada/.test(item.message)));
});

test("o que mudou na planilha da equipe: cadastro, ausências e treinamentos", () => {
  const before = parseTeamWorkbook(workbook());
  const after = structuredClone(before);
  after.people.find(item => item.id === "1001").team = "B";
  after.people.push({ id: "1010", name: "Nova Pessoa", role: "Conferente", team: "D", status: "Ativo", note: "" });
  after.absences = after.absences.filter(item => item.person.id !== "1006");
  after.trainings[0].participants[0].status = "faltou";
  const sections = Object.fromEntries(diffTeam(before, after).map(section => [section.title, section.items]));
  assert.deepEqual(sections["Mudanças no Cadastro"], ["Ana Paula de Souza (1001): equipe A → B"]);
  assert.match(sections["Incluídos no Cadastro"][0], /^Nova Pessoa \(1010\)/);
  assert.equal(sections["Férias e ausências retiradas"].length, 1);
  assert.match(sections.Treinamentos[0], /situação realizado → faltou/);
});
