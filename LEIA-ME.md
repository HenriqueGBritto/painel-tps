# Painel Triunfo · Netlify + Firestore

Este pacote contém o site em `public/` e a função de leitura em `netlify/functions/`. A visualização é pública.

## De onde vêm os dados

O painel lê as duas bases **direto do Google Drive** a cada acesso. Não existe mais upload de planilha nem PIN.

| Base | Arquivo no Drive | Usada em |
|---|---|---|
| Navios | `dados_navios_dinamico_triunfo.xlsm` (ID `1nPBFECVbRr7cYxxmGRXdT3F9f0zT_wWm`) | Operacional, Ocupação, Ferro gusa |
| Lineup | Aba `LINEUP` da planilha de produção "outras" (Google Planilhas, ID `1KDStqZVY5vBG4LwByytYa2QSyNcjg9KQJXlV1rN43PU`) | Lineup e peso previsto dos navios atracados |
| Indicadores | `Base - Indicadores Operacionais TPS.xlsx` (ID `12ionZt6pJ7yeX59EUX-rppOCugcvp9F7`) | Descarga e Pesagem |
| Equipe | Planilha da equipe TPS (arquivo .xlsx no Drive, ID `1qeQgIOmbg9jW1l0id6Sgt39y657PTzbM`) | Aba Equipe (somente leitura) |

- As planilhas precisam estar compartilhadas como **"Qualquer pessoa com o link – Leitor"**.
- O site guarda a última leitura das duas planilhas no Netlify Blobs e entrega essa cópia a quem abre o painel, sem esperar o download do Drive.
- A planilha da equipe é relida só 1 vez por dia (na rodada das 03h de Brasília) ou pelo botão **Atualizar dados** com a aba Equipe aberta; nas outras abas, o botão relê navios e indicadores.
- A cópia é renovada automaticamente a cada 6 horas pela função agendada `refresh-scheduled` (00h, 06h, 12h e 18h UTC, ou seja, 21h, 03h, 09h e 15h em Brasília). Funções agendadas só rodam no site publicado; numa prévia, use **Run now** em Functions no Netlify.
- O botão **Atualizar dados**, no cabeçalho, relê as planilhas na hora (cerca de 20 s) e recarrega o painel. Se a última leitura tiver menos de 5 minutos, ele só avisa e não lê de novo.
- Clicar no selo **"Dados até…"** abre o painel **O que mudou nas planilhas**. Cada leitura nova é comparada com a anterior: navios incluídos, encerrados ou corrigidos, volume parcial, lineup, ferro gusa, dias de descarga, plano mensal, ocorrências e pesagens. O histórico guarda as 15 últimas leituras em que houve alteração e começa a ser montado a partir da primeira leitura depois da publicação.
- Se a cópia passar de 12 horas (por exemplo, se a rotina agendada falhar), o primeiro acesso relê a planilha sozinho.
- Os nomes das abas e a posição das colunas precisam continuar iguais. Se uma aba obrigatória sumir, o painel mostra a última base salva com um aviso.
- Para trocar de arquivo sem alterar o código, crie no Netlify as variáveis `TPS_SHEET_OPERATIONS`, `TPS_SHEET_LINEUP`, `TPS_SHEET_DISCHARGE` e/ou `TPS_SHEET_TEAM` com o link do novo arquivo.
- Se o Google estiver indisponível, o painel abre com a última base salva no Firestore (ou com a cópia inicial do pacote) e mostra o aviso "planilha indisponível" no topo.

## Alertas (sino no cabeçalho)

O sino mostra alertas calculados na hora, a partir do que o painel já tem guardado. Cada pessoa só vê os alertas das telas liberadas para ela. O número no sino conta os alertas ainda não vistos naquele navegador. O painel confere ao abrir, a cada 5 minutos e quando a aba volta a ficar visível. Clicar num alerta abre a tela dele.

- **Planilha de navios** (Indicadores ou Lineup): nenhuma alteração encontrada nas leituras das últimas 24 horas, ou planilha que não pôde ser lida (cópia de reserva).
- **Planilha de indicadores** (Indicadores): nenhuma descarga FINALIZADO há mais de 2 dias, ou planilha que não pôde ser lida.
- **Descarga abaixo do ritmo** (Indicadores): a previsão do mês, no ritmo atual, não alcança o plano. O alerta mostra quanto falta por dia.
- **Atividades atrasadas** (Atividades): atividades pendentes com o horário vencido no turno atual.
- **Passagem não recebida** (Atividades): o turno atual começou há mais de 30 minutos e ninguém confirmou o recebimento.

Os limites ficam em `LIMITS`, em `netlify/lib/alerts.mjs`. Por enquanto os alertas aparecem só no painel; envio por e-mail precisa de um serviço de e-mail configurado.

## Aba Descarga

- **Meta diária:** plano do mês ÷ dias do mês, mostrada na linha tracejada do gráfico e no card.
- **Gráfico:** mostra peso, vagões ou os dois; clicar num dia mostra as ocorrências dele.
- **Desempenho da semana:** aparece no filtro "Últimos 7 dias", com os dias abaixo da meta e as principais ocorrências de cada um.
- **Previsão do mês** (quadro Plano de descarga): sempre do mês atual. Mostra o realizado até a última descarga registrada e o ritmo por dia corrido (dias sem descarga contam como zero). Com isso, estima o fechamento no ritmo atual e quanto falta por dia para alcançar o plano e o desafio.

## Aba Atividades (turnos dos assistentes)

Rastreio das atividades de cada turno e passagem de serviço. Os dados ficam no Firestore e só a API (`/api/atividades/…`) acessa.

- **Turnos:** Diurno 07:00–19:00 e Noturno 19:00–07:00, horário de Brasília. O turno é identificado pela data em que começa: uma atividade às 02:00 do dia 15 pertence ao Noturno do dia 14.
- **Escala dos assistentes:** segue a aba Equipe. O escalado de cada turno é o assistente cadastrado da equipe de plantão (dia: A ou B; noite: C ou D), ligado pela matrícula do Cadastro (Roger 9019, Hélio 7343, Andrés 7144, Matheus 8940). Se ele estiver de férias ou afastado na aba Férias, entra quem cobre, quando for um dos assistentes; sem cobertura, o turno mostra o aviso. Ajustes pontuais (trocas, faltas, coberturas) têm prioridade. O rodízio em **Atividades → Configuração** é só a reserva, usada se a planilha da equipe estiver indisponível ou antes de 01/06/2026. A virada agendada (07:02 e 19:02) atualiza o escalado dos turnos já criados.
- **Lista do turno:** gerada a partir dos modelos (atividades fixas) no primeiro acesso ao turno, mais as atividades incluídas pelo "+" no fim da lista e as pendências herdadas. Modelo incluído ou alterado vale a partir do turno atual; turnos encerrados não mudam.
- **Atividades fixas iniciais:** no primeiro uso o painel cadastra a lista da operação.
  - **Sem horário, nos dois turnos:** atualizar SOF, GEPORT e lineup, dobra de TPA, produção do navio.
  - **Com prazo, no turno em que o prazo cai:** pagamento de estiva (08:30), operadores do plano B (16:00), requisições de estiva por período (03:30, 09:00, 15:30 e 18:30, com lembrete 30 min antes), DA9 por período (05:15, 11:15, 17:15 e 20:15).
  - Tudo pode ser editado em Configuração.
- **Em cada atividade:**
  - a caixa de seleção marca como concluída (quem e quando ficam registrados);
  - "Não feita" pede o motivo;
  - "Observação" guarda um comentário;
  - "Atribuir" passa para outra pessoa.
- **Responsável:** por padrão é o escalado do turno. Um modelo pode ter responsável fixo; se essa pessoa não estiver no turno, a atividade mostra o aviso para atribuir a outra.
- **Ordem da lista:** arraste a atividade pela alça de seis pontinhos à esquerda, com mouse ou dedo (ou use as setas do teclado com a alça selecionada). Só aparece em turnos ainda não encerrados. A ordem vale para o turno, e as atividades fixas passam a nascer nessa ordem nos turnos seguintes.
- **Anexos nas observações:** em cada atividade, "Observação / anexo" aceita texto e arquivos: fotos, PDF, Word, Excel ou texto, até 5 MB cada e 8 por atividade. Fotos grandes são reduzidas no navegador antes do envio. Se a atividade passar para o turno seguinte, os anexos vão junto. Os arquivos ficam no Netlify Blobs (loja `painel-tps-anexos`); o Firestore guarda só a lista.
- **Calendário:** no cabeçalho do turno, "Ver o dia" e "Turno" abrem qualquer turno. Além disso, o Acompanhamento mostra vários dias de uma vez.
- **Baixar o período em Excel:** no Acompanhamento, depois de filtrar, "Baixar Excel" gera uma planilha com duas abas. A aba Turnos traz escalado, totais, passagem e recebimento; a aba Atividades traz uma linha por atividade, com situação, quem registrou, quando, motivo e observação.
- **Baixar a passagem:** turnos encerrados têm os botões PDF e JPG, na tela do turno e no Acompanhamento. O arquivo traz:
  - cabeçalho com a marca;
  - quem encerrou e quem recebeu;
  - observações da passagem;
  - a lista com a situação, o responsável e a observação de cada atividade (documentos pelo nome);
  - no fim, as imagens anexadas, com o nome da atividade.
- **Atividade fixa que se repete:** se ficar pendente (ex.: "Atualizar SOF"), ela não é duplicada no turno seguinte. A de lá ganha a marca "ficou pendente também no turno anterior".
- **Passagem de serviço:** "Encerrar turno" grava as observações e leva as pendências para o turno seguinte. Se ninguém encerrar, a função agendada `atividades-scheduled` (07:02 e 19:02) leva as pendências mesmo assim, marcadas "sem passagem registrada". Quem assume confirma o recebimento.
- **Alertas:** o botão "Ativar alertas" pede permissão ao navegador. Atividades com horário avisam no horário e, se o modelo pedir, X minutos antes (ex.: 30 min para pedidos de estiva). Só funcionam com o painel aberto em alguma aba. Com várias abas abertas, só uma avisa.
- **Quem registra:** a pessoa logada. Toda gravação guarda quem fez e quando; o servidor grava o autor pelo login, não pelo que a página manda. Se o acesso estiver ligado a um assistente (tela Acessos), o registro sai no nome desse assistente.
- **Acesso:** marcar atividades exige o acesso "Atividades"; escala, ajustes e modelos exigem "Configuração das Atividades".

Coleções no Firestore: `shiftAssistants`, `shiftConfig`, `shiftOverrides`, `taskTemplates`, `shifts` e `shifts/{turno}/tasks`.

Para conferir se o Firestore está ligado, abra `https://SEU-SITE.netlify.app/api/atividades/status`. A resposta deve trazer `"storage":"firestore"`. Se vier erro 503, falta configurar `FIREBASE_SERVICE_ACCOUNT_JSON`.

## Aba Requisições (estiva do OGMO)

O assistente envia o PDF da requisição de estiva impresso pelo sistema do OGMO, um arquivo por requisição com todos os ternos. Dá para arrastar vários de uma vez. O painel lê o PDF e confere pela instrução de trabalho (IT "Requisição de estiva").

- **Resultado:**
  - **Reprovada:** tem algum erro.
  - **Confirmar:** só tem pontos a verificar.
  - **Aprovada:** nada a apontar.

  Cada item mostra o motivo e a seção da IT. Qualquer pessoa com acesso pode **aprovar com justificativa** uma reprovada ou uma para confirmar; ela passa a aparecer como **Justificada**, e fica registrado quem aprovou, quando e o motivo.
- **O que é conferido:**
  - porto Rio de Janeiro e Longo Curso;
  - frase do EPI, aceitando variações;
  - Atracado/Ao Largo coerente com o local;
  - padrão do nome: `BALSA XX (AT. NAVIO)`, `NAVIO (AL)`, `(REF.dd/mm/aaaa)`;
  - faina;
  - observação de cada terno com a operação e o produto;
  - funções que só vão no 1º terno (CFC, CSC, ENB, BLM).
- **Composição de ferro gusa** (seções 5.2 a 5.7), terno a terno:
  - **CMP** é o padrão; **CMA** é aceito no lugar dele (pedido do especialista).
  - Navio de gusa **não leva EE**.
  - A balsa ao largo leva só **CFC**, sem CFP.
  - **Capatazia (PE):** 2 em dia útil (2 nossos + 2 do OGMO); 4 em sábado, domingo e feriado, contados pela data da operação. Operação ao largo não leva capatazia.
  - EEM com 0 vagas (reoferta) não conta.
- **Composição das outras cargas**, pelos exemplos da IT. Nelas o contra mestre pode ser CMA ou CMP, e a capatazia é 4.

  | Carga | Composição | Seção |
  |---|---|---|
  | Tubos soltos (embarque) | GC, ESI, EE 4 (6 com alavanca), CFC, CFP, BLE 4, PE 4, sem consertador | 6.1 |
  | Tubos amarrados ou mistos (embarque) | tubos soltos + CSC e CBD | 6.2 e 6.3 |
  | Tubos (desembarque) | no bloco, ENB, BLM e BLC no lugar do BLE (BLP 2 se precisar) | 6.2 |
  | Carga geral (navio) | GC, ESI, EE 4, CFC, CFP, CSC, CBD, ENB, BLP 2 e PE 4. Carretel vazio vai sem consertador. Com balsa, sem capatazia. | 7.1 a 7.4 |
  | Balsa de carga geral ou de amarras | contra mestre e EE 4 | 7.3 e 7.4 |
  | Granéis (potássio, gesso, espodumênio, magnetita…) | GC, ESI, EE 1 (4 com varredura escrita na observação), CFC e CFP; tratorista a partir do 2º período. A capatazia vai numa requisição separada, `NAVIO (ENLONAMENTO)`, só com PE. | 8.1 |
  | Big bag | como a carga geral | 9.1 |
  | Amarras | como a carga geral; PE 4 só se descarregar no chão | 9.2 |
  | Dormentes | carga geral + EEM 1. A observação precisa citar o macacão Tyvek, e os outros ternos do mesmo navio e período também. | 9.3 |
  | Container | GC, ESI, EE 4, CFC, CFP, ENB, BLP 2 e PE 4 | 9.4 |

  - Estivador guia (EGU 2) e empilhador são aceitos e aparecem como observação: a IT manda perguntar ao responsável.
  - Terno só de bloco (6.1 Nota 3) é aceito.
  - Operação que não está na IT (por exemplo, carga geral ao largo) fica para confirmar.
- **Retroativo:** mostra o dia e o período do trabalho original e os do pedido, para conferir se o custo é o mesmo (seção 10).
- **Ao largo:** a balsa e o navio do mesmo período são conferidos juntos (mesmo número de ternos; com mais de uma balsa, CFC em só uma). Até chegar a segunda requisição, a primeira fica "confirmar".
- **Lineup:** o navio (o de "(AT. …)", no caso da balsa) precisa estar no Lineup e o local precisa combinar com o berço. Nome parecido mas diferente (ex.: SMOKER × SKOMER) ou local diferente ficam para confirmar.
- **Horário:** a hora do pedido não é conferida. O PDF só traz a hora da impressão, e ela não importa.
- **Tela:** uma linha por requisição, com situação, período, navio e número. Ao clicar, abre só o que precisa corrigir (o mesmo erro em vários ternos aparece numa linha só), com Abrir PDF, Aprovar com justificativa e Ver detalhes (itens conferidos, composição lida e envios anteriores).
- **Reenvio:** a mesma requisição corrigida no OGMO e enviada de novo substitui a conferência; os envios anteriores ficam no histórico, com o PDF.
- **Atividades:** requisição aprovada (direto ou com justificativa) marca como feita a atividade "Requisição de estiva · período" do turno e anexa o PDF à observação dela. Se o turno já foi encerrado, a requisição avisa e não mexe nele.
- **Feriados:** lista inicial com feriados nacionais, do estado e da cidade do Rio, Carnaval e Corpus Christi. Quem tem "Configuração das Atividades" ou é administrador edita a lista na própria aba.
- **Alertas:** requisições de ontem a amanhã reprovadas ou para confirmar aparecem no sino.
- **Vigia:** requisições só com funções de vigia (por exemplo, VPL, Vigia de Portaló) não são feitas pela Triunfo. Aparecem na lista com a etiqueta cinza "Vigia", só para informação: não são conferidas, não contam como reprovadas, não vão para o sino e não entram no aviso de requisição faltando.
- **CCT CAPATAZIA:** é criada pelo OGMO junto com toda requisição nossa com capatazia. Se, no mesmo período, não sobrar nenhuma frente nossa com capatazia ativa, a CCT CAPATAZIA ainda ativa é apontada como erro: ela deve ser cancelada.

### Verificação automática no OGMO

Um robô entra no sistema de requisições do OGMO com o login da empresa e confere as requisições sem ninguém precisar enviar PDF.

- **Onde roda:** no GitHub Actions (`.github/workflows/ogmo.yml`; o robô fica em `robot/ogmo.mjs`). Quem dá a largada é uma tarefa agendada do Netlify (`netlify/functions/ogmo-scheduled.mjs`), porque o agendamento do próprio GitHub pulava e atrasava rodadas: rodou 8 a 10 vezes por dia em vez de 28.
- **Quando:** de hora em hora (no minuto 7), e também 1 hora antes de cada limite: 02:45, 08:45, 14:45 e 17:45. Cada rodada leva cerca de 1 minuto.
- **O que faz:**
  1. Lê a lista de requisições de ontem, hoje e amanhã (Registro de Requisições, porto Rio de Janeiro, todos os períodos).
  2. Baixa o PDF ("Visualiza") das requisições ativas. As já escaladas e já guardadas não são baixadas de novo.
  3. Das já escaladas, baixa uma vez o **DA9** (botão verde do OGMO, com os trabalhadores escalados). Ele aparece como "Abrir DA9" ao lado de "Abrir PDF". O OGMO só gera o DA9 depois de escalar a requisição.
  4. Manda tudo para o painel, que confere cada PDF pela IT, marca as canceladas no OGMO e reconfere o período delas (por exemplo, a CCT CAPATAZIA).
- **Buscar no OGMO (sob demanda):** na aba, escolha **Período** (até 8 dias) ou **Um dia** e clique em **Buscar no OGMO**. O painel aciona o robô só para esses dias (até amanhã): ele lê a lista, confere e guarda o PDF e o DA9 das requisições que ainda não tem. Leva cerca de 1 minuto para começar; o andamento aparece embaixo dos filtros e a lista se atualiza sozinha. Uma busca por vez; se o robô não terminar em 45 minutos, a busca conta como falha e libera outra. A busca não mexe no aviso do que falta pedir, que é da rodada automática.
- **O que falta pedir:** a cada rodada o painel calcula o que falta nos períodos com limite nos próximos 80 minutos: navio ou balsa que teve requisição no período anterior e ainda não tem a do próximo, e navio em operação no Lineup sem nenhuma requisição no dia. Isso aparece no topo da aba e no sino.
- **Só consulta:** o robô só pode disparar entrar, abrir o Registro de Requisições, escolher porto e período, pesquisar, selecionar, visualizar e gerar o DA9. Qualquer outro envio ao OGMO (Nova Requisição, Inclusão, Alteração, Exclusão, Modifica, Cancela, Duplica, Sair) é bloqueado antes de sair do navegador, e toda caixa de confirmação do OGMO é recusada. O PDF e o DA9 só são aceitos se trouxerem o número da requisição selecionada.
- **Configuração:**
  - Segredos no GitHub (Settings → Secrets and variables → Actions): `OGMO_EMPRESA`, `OGMO_USUARIO`, `OGMO_SENHA` e `OGMO_SYNC_TOKEN`.
  - No Netlify, a variável `OGMO_SYNC_TOKEN` com o mesmo valor. É ela que deixa o robô entregar os dados ao painel; sem ela, as rotas do robô respondem 503.
  - No Netlify, a variável `GITHUB_DISPATCH_TOKEN`: um token do GitHub (fine-grained) só com a permissão **Actions: Read and write** neste repositório, para a largada. Quando ele vence, aparece "O GitHub recusou acionar o robô" na aba e no sino; é só gerar outro e trocar a variável.
  - No log do GitHub, os números das requisições aparecem como `***53316-1`, porque o GitHub esconde o valor do segredo OGMO_EMPRESA ("250") onde ele aparecer. O painel recebe os números completos.
- **Testar:** Actions → Verificação OGMO → Run workflow → modo **diagnostico**. Ele lista as requisições de hoje e testa o PDF de uma, sem mandar nada ao painel.
- **Se parar:** com a rodada falhando ou sem rodar há mais de 2 horas, aparece um aviso na aba e no sino. Quando o robô falha, ele guarda a imagem da tela por 3 dias, para ver onde parou.
- **Cota do GitHub:** o repositório privado tem 2.000 minutos por mês. São 28 rodadas por dia de cerca de 1 minuto, mas o GitHub cobra cada rodada arredondando para cima; o uso fica em torno de 1.700 minutos por mês. Cada **Buscar no OGMO** gasta mais alguns minutos (de 2 a 15, conforme os dias e o que ainda não foi baixado): use com moderação perto do fim do mês.
- **Onde fica:** Firestore `requisitions` (feriados em `requisitionConfig`); o PDF e o DA9 ficam no Netlify Blobs, junto dos anexos (o DA9 tem nome e matrícula dos trabalhadores escalados e só abre para quem tem a aba Requisições). A leitura do PDF usa a biblioteca `unpdf`. As regras ficam em `netlify/lib/requisition-rules.mjs`, e os testes usam o texto de dois PDFs reais (`tests/fixtures/requisicoes`).

## Aba Equipe (quadro de pessoal)

Somente leitura: a planilha da equipe é a fonte da verdade e o painel só lê dela, pela rota `/api/equipe` (com ponto único de permissão em `netlify/lib/access.mjs`, hoje liberado).

- **Abas lidas:**
  - **Cadastro:** pessoas, com a matrícula como chave. As colunas são encontradas pelo nome do cabeçalho; as auxiliares (seq, chave_grade…) são ignoradas.
  - **Listas:** funções → categoria e equipes → turno, horário e escala.
  - **Férias:** blocos mensais em formatos diferentes, inclusive bloco sem título, coluna MOTIVO (férias, afastamento, mobilidade, cargo vago) e cobertura em coluna própria ou no segundo par CHAPA/NOME. A mesma ausência repetida em dois blocos vira um registro só.
  - **NOVOS TREINAMENTOS:** texto livre, organizado em treinamento e participantes, com situação, certificado e datas. O texto que não dá para estruturar fica guardado como observação.
- **Abas ignoradas:** Resumo, Escala e DATAS 02X02. O painel recalcula o que elas mostram.
- **Vínculo de pessoas:** pela matrícula. Sem ela, ou quando a matrícula é de outra pessoa, vale o nome sem acento, caixa e sufixos (" - A", "(OPMC)", "- AVISADO"…), com tolerância a pequenos erros de digitação. Quem não está no Cadastro (ex.: "NÃO É TPS") entra como externo.
- **Relatório de importação** (subaba Importação): o que não foi interpretado ou vinculado. Inclui matrícula trocada, data digitada como texto, férias longas demais, externos, bloco sem título e menções a 12x36.
- **Escalas** (`public/team-schedule.js`):
  - **2x2 desde 01/06/2026:** 15–16/10/2026 = A (dia) + C (noite), 17–18/10/2026 = B + D, e assim por diante. Antes de 01/06/2026, as equipes A–D não são calculadas.
  - **Intermediária:** um dia adiantada (16/10/2026 = 1º dia).
  - **Capatazia Dia** 09:00–18:48 e **Capatazia Noite** 21:00–06:48, de segunda a sexta.
  - **Administrativo:** de segunda a sexta. **Gestão:** sem escala.
  - **Plantão noturno:** pertence à data em que começou.
- **Subabas:**
  - Resumo: mesma lógica da aba Resumo da planilha, mais as transferências.
  - De serviço.
  - Calendário.
  - Pessoas: com a ficha de cada pessoa.
  - Férias e coberturas: com os alertas de conflito.
  - Treinamentos.
  - Importação.
- **Escala diferenciada:** observações que citam escala, horário, folga, vespertino ou noite aparecem destacadas, sem interpretação do texto.

## Login e acessos

- **Quem entra:** só quem o administrador cadastrou na tela **Administração → Acessos**, com e-mail, nome e senha provisória. Não existe cadastro pelo próprio site.
- **Primeiro acesso:** a pessoa entra com a senha provisória e é obrigada a criar uma senha própria (pelo menos 8 caracteres, com letras e números, diferente da provisória). Até trocar, o servidor não entrega nenhum dado.
- **Manter conectado:** marcado, a sessão dura 14 dias naquele navegador. Sem marcar, termina ao fechar o navegador (e em no máximo 12 horas).
- **O que cada pessoa vê:** o administrador marca as telas de cada pessoa: Indicadores, Lineup, Produção, Atividades (registrar no turno), Requisições de estiva, Configuração das Atividades, Equipe (RH) e Administrador. Atalhos: **Assistente** (Indicadores, Lineup, Produção, Atividades e Requisições) e **Gestão** (tudo, menos Administrador). Menus sem acesso somem, e o servidor recusa os dados também (não basta esconder o botão). Mudanças valem em até 30 segundos.
- **Esqueceu a senha:** o administrador define uma senha provisória nova em Acessos → Editar. As sessões abertas da pessoa terminam e ela troca a senha no próximo acesso.
- **Bloquear:** Acessos → Editar → Bloquear acesso. As sessões abertas terminam na hora.
- **Histórico:** criações, mudanças de acesso, bloqueios e senhas redefinidas ficam registrados (quem e quando), sem guardar senhas.
- **Entradas no painel:** a tela Acessos mostra os logins dos últimos 30 dias e as tentativas recusadas (senha errada, e-mail desconhecido ou acesso bloqueado). Muitas tentativas recusadas seguidas para o mesmo e-mail merecem atenção. Firestore: `panelLoginLog`.
- **Sem nenhuma tela liberada:** a pessoa vê um aviso para pedir acesso ao administrador.
- **Abertura:** a planilha de navios é lida em paralelo. Descarga, Produção, Atividades, Equipe e Acessos abrem sem esperar por ela.
- **Administrador inicial:** o e-mail em `TPS_ADMIN_EMAILS` (variável do Netlify, separados por vírgula; padrão henrique.goncalves@triunfologistica.com.br) sempre tem todos os acessos. A conta dele é criada uma vez no console do Firebase (Authentication → Usuários → Adicionar usuário); no primeiro login o perfil completo é criado sozinho.
- **Como funciona:** as contas ficam no Firebase Authentication (projeto painel-tps) e os acessos no Firestore (`panelUsers`, histórico em `panelAccessLog`). A senha nunca fica no navegador: o servidor confere com o Firebase e devolve a sessão num cookie que o JavaScript da página não consegue ler. Toda rota passa por `authorize()` em `netlify/lib/access.mjs`.

## Testar no computador

Com o Node.js 22 instalado, na pasta do projeto:

1. `npm install` (só na primeira vez)
2. `npm test` roda os testes.
3. `npm run dev` abre o painel em `http://localhost:8888`. A aba Atividades guarda os dados em memória, e eles somem ao parar o servidor (Ctrl+C). Os indicadores leem as planilhas reais no Google.
4. Login local: use as contas de teste de `scripts/dev-users.json` (administrador, assistente e um acesso novo que precisa trocar a senha). Elas só existem em memória no servidor local e não valem no site publicado.

## Antes de publicar

`FIREBASE_SERVICE_ACCOUNT_JSON` é **obrigatório para o login e para a aba Atividades**. Para o resto do painel ele só serve como reserva, caso o Google esteja indisponível. A variável `TPS_IMPORT_PIN` não é mais usada e pode ser apagada no Netlify.

## Publicação

**Testes antes de publicar:** o Netlify roda `npm test` antes de cada publicação (`netlify.toml`). Se algum teste falhar, a publicação é cancelada e o site continua na versão anterior; o motivo aparece no log da publicação no Netlify. O GitHub também roda os testes a cada envio (`.github/workflows/testes.yml`) e marca cada commit com ✓ ou ✗.

**Não use Netlify Drop (arrastar e soltar) para esta versão:** essa modalidade não executa build, e as funções que conectam o Firestore não seriam publicadas. O ZIP é o código-fonte completo, não um ZIP para arrastar diretamente na página.

Para manter o mesmo endereço do site, use uma destas opções:

- **Git (recomendado):** extraia o ZIP, coloque seu conteúdo em um repositório privado no GitHub, conecte esse repositório ao projeto Netlify existente e configure `public` como diretório de publicação. O arquivo `netlify.toml` já declara a pasta das funções. O Netlify instalará `firebase-admin` e publicará a função `api` em cada implantação.
- **Netlify CLI:** instale o Node.js 22 (com npm), extraia o ZIP e abra um terminal na pasta extraída. Execute `npm install`, `npm install -g netlify-cli`, `netlify login`, `netlify link` (escolha o site Netlify já criado) e `netlify deploy --prod`. O `netlify.toml` informa as pastas corretas; não envie apenas `public/`.

Após publicar, entre no painel e abra no mesmo navegador (com login):

- `https://SEU-SITE.netlify.app/api/data`
- `https://SEU-SITE.netlify.app/api/discharge`

Ambos devem retornar JSON (sem login, respondem 401). No JSON de `/api/data` e `/api/discharge`, o campo `"origin"` deve ser `"google-sheets"`. Se aparecer `"fallback"`, o campo `"fallbackReason"` explica o motivo (geralmente o compartilhamento da planilha). A produção continua consultando as duas planilhas Google próprias dela.

## Segurança

Os dados do painel só saem do servidor para quem está logado e tem o acesso da tela (ver **Login e acessos**). As páginas (HTML, CSS e JavaScript) continuam públicas, mas sem dados. Atenção: qualquer pessoa com o link das planilhas no Google continua conseguindo abri-las; o login do painel não muda o compartilhamento das planilhas.

O segredo da conta de serviço fica exclusivamente nas variáveis do Netlify. Nunca adicione esse valor ao ZIP, ao JavaScript do navegador ou ao Git. Se alguém obtiver acesso a ele, revogue a chave da conta de serviço no Firebase.
