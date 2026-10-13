# Painel Triunfo · Netlify + Firestore

Este pacote contém o site em `public/` e a função de leitura em `netlify/functions/`. A visualização é pública.

## De onde vêm os dados

O painel lê as duas bases **direto do Google Drive** a cada acesso. Não existe mais upload de planilha nem PIN.

| Base | Arquivo no Drive | Usada em |
|---|---|---|
| Navios | `dados_navios_dinamico_triunfo.xlsm` (ID `1nPBFECVbRr7cYxxmGRXdT3F9f0zT_wWm`) | Operacional, Ocupação, Ferro gusa, Lineup |
| Indicadores | `Base - Indicadores Operacionais TPS.xlsx` (ID `12ionZt6pJ7yeX59EUX-rppOCugcvp9F7`) | Descarga e Pesagem |

- As duas planilhas precisam estar compartilhadas como **"Qualquer pessoa com o link – Leitor"**.
- Para atualizar o painel, basta salvar a planilha no Drive. A nova versão aparece em até 2 minutos: a resposta fica guardada no CDN do Netlify por 2 minutos para não consultar o Google a cada acesso.
- Os nomes das abas e a posição das colunas precisam continuar iguais. Se uma aba obrigatória sumir, o painel mostra a última base salva com um aviso.
- Para trocar de arquivo sem alterar o código, crie no Netlify as variáveis `TPS_SHEET_OPERATIONS` e/ou `TPS_SHEET_DISCHARGE` com o link do novo arquivo.
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
