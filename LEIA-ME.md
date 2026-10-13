# Painel Triunfo · Netlify + Firestore

Este pacote contém o site em `public/` e a função de leitura em `netlify/functions/`. A visualização é pública.

## De onde vêm os dados

O painel lê as duas bases **direto do Google Drive** a cada acesso. Não existe mais upload de planilha nem PIN.

| Base | Arquivo no Drive | Usada em |
|---|---|---|
| Navios | `dados_navios_dinamico_triunfo.xlsm` (ID `1nPBFECVbRr7cYxxmGRXdT3F9f0zT_wWm`) | Operacional, Ocupação, Ferro gusa |
| Lineup | Aba `LINEUP` da planilha de produção "outras" (Google Planilhas, ID `1KDStqZVY5vBG4LwByytYa2QSyNcjg9KQJXlV1rN43PU`) | Lineup e peso previsto dos navios atracados |
| Indicadores | `Base - Indicadores Operacionais TPS.xlsx` (ID `12ionZt6pJ7yeX59EUX-rppOCugcvp9F7`) | Descarga e Pesagem |

- As planilhas precisam estar compartilhadas como **"Qualquer pessoa com o link – Leitor"**.
- O site guarda a última leitura das duas planilhas no Netlify Blobs e entrega essa cópia a quem abre o painel, sem esperar o download do Drive.
- A cópia é renovada automaticamente a cada 6 horas pela função agendada `refresh-scheduled` (00h, 06h, 12h e 18h UTC, ou seja, 21h, 03h, 09h e 15h em Brasília). Funções agendadas só rodam no site publicado; numa prévia, use **Run now** em Functions no Netlify.
- O botão **Atualizar dados**, no cabeçalho, relê as planilhas na hora (cerca de 20 s) e recarrega o painel. Se a última leitura tiver menos de 5 minutos, ele só avisa e não lê de novo.
- Clicar no selo **"Dados até…"** abre o painel **O que mudou nas planilhas**. Cada leitura nova é comparada com a anterior: navios incluídos, encerrados ou corrigidos, volume parcial, lineup, ferro gusa, dias de descarga, plano mensal, ocorrências e pesagens. O histórico guarda as 15 últimas leituras em que houve alteração e começa a ser montado a partir da primeira leitura depois da publicação.
- Se a cópia passar de 12 horas (por exemplo, se a rotina agendada falhar), o primeiro acesso relê a planilha sozinho.
- Os nomes das abas e a posição das colunas precisam continuar iguais. Se uma aba obrigatória sumir, o painel mostra a última base salva com um aviso.
- Para trocar de arquivo sem alterar o código, crie no Netlify as variáveis `TPS_SHEET_OPERATIONS`, `TPS_SHEET_LINEUP` e/ou `TPS_SHEET_DISCHARGE` com o link do novo arquivo.
- Se o Google estiver indisponível, o painel abre com a última base salva no Firestore (ou com a cópia inicial do pacote) e mostra o aviso "planilha indisponível" no topo.

## Antes de publicar

`FIREBASE_SERVICE_ACCOUNT_JSON` é opcional: só serve como reserva, caso o Google esteja indisponível. A variável `TPS_IMPORT_PIN` não é mais usada e pode ser apagada no Netlify.

## Publicação

**Não use Netlify Drop (arrastar e soltar) para esta versão:** essa modalidade não executa build, e as funções que conectam o Firestore não seriam publicadas. O ZIP é o código-fonte completo, não um ZIP para arrastar diretamente na página.

Para manter o mesmo endereço do site, use uma destas opções:

- **Git (recomendado):** extraia o ZIP, coloque seu conteúdo em um repositório privado no GitHub, conecte esse repositório ao projeto Netlify existente e configure `public` como diretório de publicação. O arquivo `netlify.toml` já declara a pasta das funções. O Netlify instalará `firebase-admin` e publicará a função `api` em cada implantação.
- **Netlify CLI:** instale o Node.js 22 (com npm), extraia o ZIP e abra um terminal na pasta extraída. Execute `npm install`, `npm install -g netlify-cli`, `netlify login`, `netlify link` (escolha o site Netlify já criado) e `netlify deploy --prod`. O `netlify.toml` informa as pastas corretas; não envie apenas `public/`.

Após publicar, abra no navegador:

- `https://SEU-SITE.netlify.app/api/data`
- `https://SEU-SITE.netlify.app/api/discharge`

Ambos devem retornar JSON. No JSON de `/api/data` e `/api/discharge`, o campo `"origin"` deve ser `"google-sheets"`. Se aparecer `"fallback"`, o campo `"fallbackReason"` explica o motivo (geralmente o compartilhamento da planilha). A produção continua consultando as duas planilhas Google próprias dela.

## Segurança

Qualquer pessoa com o endereço do site pode visualizar os indicadores e acessar os dados retornados pelos endpoints públicos. Qualquer pessoa com o link das planilhas também consegue abri-las. Não publique o site se esses dados não puderem ser compartilhados. Para controle de acesso completo, será preciso acrescentar autenticação depois.

O segredo da conta de serviço fica exclusivamente nas variáveis do Netlify. Nunca adicione esse valor ao ZIP, ao JavaScript do navegador ou ao Git. Se alguém obtiver acesso a ele, revogue a chave da conta de serviço no Firebase.
