# Régua de retorno: um veículo por classe de acontecimento

> **Status:** rascunho de 2026-10-30, para leitura. Quando o Daniel aceitar, as etapas 6 (camada de
> retorno) e 7 (acontecimentos) do plano de UX seguem daqui, uma issue por tela.
> **O que é:** a regra que decide **como** o produto conta à pessoa o que aconteceu. A classe do
> acontecimento escolhe o veículo; a tela nunca escolhe.
> **O que não é:** não muda o caminho do dinheiro nem as mensagens inline que ele já tem. Não toca os
> arquivos do Daniel; a régua vale para eles também, e as mudanças lá são dele.
>
> **De onde vem:** as três queixas da avaliação do dono ([REDESENHO_UX.md](REDESENHO_UX.md) E1, E2,
> E3) são o mesmo erro visto três vezes: o veículo é escolhido tela a tela, então o mesmo
> acontecimento aparece de um jeito numa tela, de outro na seguinte, e em silêncio na terceira.
> O inventário abaixo foi conferido no código em 2026-10-30 (`ui/src`, staging `c0be197`).

---

## 0. A régua em uma página

| # | Classe | Veículo | Exemplo | Nunca |
|---|---|---|---|---|
| 1 | **Resultado de uma ação sua** | aviso passageiro (toast) | "Aprovação registrada", "Copiado", "Importado" | carregar algo que a pessoa precisa fazer; uma falha de dinheiro só num aviso que some |
| 2 | **Coisa que aconteceu longe de você** (outro membro aprovou, um pagamento foi enviado, uma proposta expirou) | contador e lista "desde a última vez" | "3 novidades: Bob aprovou o aluguel; a folha de outubro foi enviada; 1 proposta expirou" | toast (você não estava lá; o aviso some antes de ser lido) |
| 3 | **Condição que dura** (cofre sem proteção, serviço fora do alcance, atualização da rede a caminho) | faixa fixa | "Cofre aberto: quem tiver o link lê este cofre"; "Sem ligação com o servidor do cofre desde 14:02" | sumir enquanto a condição dura; aparecer sem a próxima ação |
| 4 | **Carregando** | esqueleto na forma do conteúdo que vem, e a barra de progresso no topo | linhas cinzas no lugar das linhas do livro | tela vazia; spinner genérico no lugar de conteúdo; esqueleto para sempre |
| 5 | **Não consegui ler** | estado próprio, dito, com "Tentar de novo" | "Não deu para ler os membros. O cofre e a sua parte continuam neste aparelho." | lista vazia no lugar de uma leitura que falhou; esqueleto que nunca termina |
| 6 | **Falhou o que você pediu** | mensagem inline, no lugar da ação, com o que fazer | "Endereço inválido: o cofre paga só endereço blindado (u1...)" | só o toast; código de erro; pilha |
| 7 | **Precisa de você** | a mesa do Painel (faixas por urgência) e o contador da classe 2 | "Assinar: 1", "Aprovar: 2" | notificação solta sem lugar para agir |
| 8 | **Travado ou indisponível neste caminho** | véu de desbloqueio; "Em breve" com o motivo | "Importar CSV ainda roda só na versão local" | botão morto sem explicação |
| 9 | **Quebrou** | tela de erro na língua da pessoa, com saída | "Algo quebrou nesta tela. Voltar ao início." | tela branca; inglês para quem usa português |

---

## 1. Por que uma régua

- **E1** (propor pagamento sem confirmação), **E2** (enviar para aprovação sem notificação) e **E3**
  (erros sem aviso) nascem da mesma falta: não há regra que diga qual veículo cada classe usa.
- Com a régua, uma tela nova não escolhe: olha a classe, usa o veículo. E uma tela antiga que foge da
  régua é um defeito nomeável, não uma opinião.
- A régua é testável: "toda tela que lê tem o estado 5" vira uma varredura de código, como as que o
  projeto já usa para outras regras.

---

## 2. Os veículos que já existem

Tudo abaixo está no código hoje. A régua não cria veículo novo; ela diz quando cada um entra.

| Veículo | Onde | O que já faz |
|---|---|---|
| Toast | `ui/src/toast.tsx` | quatro tipos (ok, info, aviso, erro); dura 3,5 s, 3,5 s, 6 s e 9 s; no máximo 3 na pilha; repetido substitui em vez de empilhar; passar o mouse ou o foco segura o relógio; Esc fecha o mais novo; aviso e erro são anunciados com urgência ao leitor de tela; cor nunca sozinha (cada tipo tem sinal) |
| Esqueleto | `ui/src/skeleton.tsx` | `Skeleton`, `SkeletonStat`, `SkeletonRows`; anuncia "Carregando" uma vez |
| Barra de progresso | `ui/src/loading.tsx` | barra fina no topo enquanto alguma tela busca; cada tela segura o conteúdo até `ready` |
| Faixa fixa | `BannerWarn` em `ui/src/components.tsx` | usada no Painel (cofre aberto) e em Receber (endereço diferente do cadastrado) |
| "Em breve" com motivo | `Soon` em `ui/src/components.tsx` | usado em Intro (2), Razão (exportar CSV na web) e Nova folha (importar CSV na web) |
| Estado "não consegui ler" | `ui/src/screens/Members.tsx` (#315) | título, uma linha, "Tentar de novo"; o foco vai para a mensagem quando ela volta; diz que o cofre e a parte continuam no aparelho |
| Spinner genérico | `Loading` em `ui/src/components.tsx` | anel com "Carregando"; é o veículo que a régua aposenta onde houver conteúdo com forma |
| Véu de desbloqueio | `ui/src/LockOverlay.tsx` | pede a senha no lugar, sem mandar a pessoa para a lista |
| Tela de erro e 404 | `ui/src/ErrorBoundary.tsx`, `screens/NotFound.tsx` | na língua da pessoa, lendo o dicionário direto (#318) |
| Aviso de versão nova | `ui/src/UpdatePrompt.tsx` | diz que há uma versão nova e oferece recarregar |

---

## 3. Onde cada classe está hoje, tela a tela

Contagens de 2026-10-30. "0" não significa defeito por si: significa que a tela não tem ação daquela
classe, ou que falta o veículo. A última coluna diz qual dos dois.

| Tela | Toast (1) | Esqueleto (4) | Spinner genérico | Estado 5 | Situação |
|---|---|---|---|---|---|
| Painel (`Dashboard`) | 0 | 3 | 2 | a conferir | arquivo do Daniel; tem faixa (cofre aberto, atualização da rede) |
| Razão (`Ledger`) | 0 | 2 | 0 | **não** | uma leitura que falha deixa o esqueleto para sempre (`rows` fica `null`) |
| Propostas (`Proposals`) | 0 | 2 | 0 | **não** | uma leitura que falha vira lista vazia ("nenhuma proposta"), que é mentira |
| Proposta (`Proposal`) | 5 | 0 | 1 | a conferir | tem toast de aprovar e recusar |
| Novo pagamento (`NewPayment`) | 4 | 0 | 1 | a conferir | tem toast de enviado e de erro |
| Nova folha (`NewPayroll`) | 6 | 0 | 1 | a conferir | tem toast de importado, parcial e enviado |
| Membros (`Members`) | 0 | 0 | 1 | **sim** (#315) | o modelo da classe 5 |
| Pessoas (`People`) | 0 | 0 | 1 | a conferir | salvar e editar sem aviso: a conferir se é classe 1 sem veículo |
| Receber (`Receive`) | 0 | 0 | 2 | a conferir | "Copiado" anunciado por região viva (#320); tem faixa |
| Ajustes (`Settings`) | 0 | 6 | 1 | a conferir | renomear, trocar senha, exportar: a conferir se há aviso |
| Cofres (`Vaults`) | 0 | 0 | 0 | a conferir | importar e remover: a conferir |
| Evidência (`Ceremonies`) | 0 | 0 | 1 | a conferir | lista de assinaturas |
| Atividade (`Activity`) | 0 | 0 | 0 | a conferir | é o lugar natural da classe 2 (contador e lista) |
| Painel de assinatura (`SigningPanel`) | 8 | 0 | 0 | sim (próprio) | arquivo do Daniel; caminho do dinheiro |

Fatos conferidos: `Ledger.tsx:43` só guarda as linhas quando a leitura deu certo, então uma falha
deixa o esqueleto; `Proposals.tsx:35` grava `[]` quando a leitura falha. Nove telas ainda usam o
spinner genérico em algum ponto. Só Membros tem o estado "não consegui ler".

---

## 4. As regras de cada veículo

**Toast (classe 1).** Uma frase, no passado, curta ("Aprovação registrada"). Nunca um link que a
pessoa precise clicar. Nunca o único lugar de uma falha no caminho do dinheiro: ali a mensagem fica
inline (classe 6) e o toast só repete. Dois cliques iguais mostram um aviso, não dois.

**Contador e lista (classe 2).** Por cofre. Conta o que aconteceu desde a última vez que a pessoa viu
a tela, por tipo (aprovações, envios, confirmações, expirações, recusas). A lista diz quem, o quê e
quando, em uma linha por acontecimento, e some ao ser vista. Nada de toast para o que aconteceu longe.

**Faixa fixa (classe 3).** Diz a condição, a consequência e a próxima ação, nessa ordem. Fica
enquanto a condição dura e sai sozinha quando ela acaba. Uma faixa por condição; se houver duas, a
mais grave em cima. Nunca uma faixa para resultado de ação (isso é classe 1).

**Esqueleto (classe 4).** Com a forma do conteúdo que vem: linhas para lista, blocos para números,
pílulas para chips. A barra do topo acompanha. Um esqueleto tem prazo: se nada chegou, vira classe 5.
Nunca spinner onde o conteúdo tem forma conhecida.

**Não consegui ler (classe 5).** Um título, uma linha honesta e "Tentar de novo". O foco vai para a
mensagem quando ela volta. Diz o que continua valendo ("o cofre e a sua parte continuam neste
aparelho"). Nunca lista vazia no lugar de uma leitura que falhou: vazio é um fato ("nenhuma
proposta"), falha é outro.

**Falhou o que você pediu (classe 6).** No lugar da ação, na língua da pessoa, uma frase com o que
fazer. Sem código, sem pilha. O caminho do dinheiro já faz isso e não muda.

**Precisa de você (classe 7).** Tem lugar: a mesa do Painel, por urgência. O contador da classe 2
aponta para lá. Nunca um aviso solto sem onde agir.

**Travado ou indisponível (classe 8).** Desbloqueio no lugar, sem mandar a pessoa para a lista.
Recurso que só existe num caminho aparece com "Em breve" e o motivo, nunca como botão morto.

**Quebrou (classe 9).** Tela própria, na língua da pessoa, com uma saída. Já existe (#318).

---

## 5. Acessibilidade que já está no código, e fica

- `role="status"` para carregando e para avisos tranquilos; `role="alert"` e anúncio urgente para
  aviso e erro.
- O foco vai para a mensagem de "não consegui ler" quando ela volta; Esc fecha o aviso mais novo;
  passar o mouse ou o foco segura o relógio do toast.
- Cor nunca sozinha: sinal e palavra em todo estado.
- Alvo de toque de pelo menos 24 por 24 no botão de fechar (#320).

---

## 6. O que a régua pede ao plano

- **6.1, a raiz:** um componente só para a classe 5 (`ReadState` ou nome parecido), usado por Razão,
  Propostas, Pessoas e Evidência, com o esqueleto que vira "não consegui ler" quando o prazo passa.
  Uma varredura de código garante que toda tela que lê o usa.
- **6.2 a 6.4:** trocar o spinner genérico pelo esqueleto onde o conteúdo tem forma; dar aviso
  (classe 1) às ações que hoje terminam em silêncio, depois de conferir cada uma; faixa para "sem
  ligação com o servidor do cofre".
- **7.1 a 7.3:** o contador e a lista "desde a última vez" (classe 2), por cofre, na Atividade e no
  Painel quando o Daniel liberar o arquivo.
- Cada item vira uma issue neutra, com o nome da tela ou do defeito, quando o trabalho começa.

---

## 7. O que a régua não decide

- Como o caminho do dinheiro fala: as mensagens inline da assinatura e do envio são do Daniel.
- O texto de cada aviso: isso é do guia de vocabulário ([VOCABULARIO_E_COPY.md](VOCABULARIO_E_COPY.md)).
- A cara dos veículos: tokens, sombra, movimento são da etapa 8 (visual). Aqui só a regra de quando.
