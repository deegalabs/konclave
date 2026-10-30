# Vocabulário e copy do Konclave

> **Status:** rascunho de 2026-10-30, para leitura. Vale como referência quando o Daniel aceitar.
> **O que é:** as palavras que o produto usa na tela, de onde elas vêm e o que fica fora da tela.
> **O que não é:** não muda o motor, não cria tela, não decide campo novo. Onde uma palavra depende
> de um campo que ainda não existe (categoria, compromisso), está dito.
>
> **Fontes:** o princípio de UX do projeto (CLAUDE.md §7: esconde a criptografia, expõe a confiança),
> as regras de honestidade (CLAUDE.md §6.13 a §6.15), a copy honesta e ativa de
> [UX_E_FLUXOS.md](UX_E_FLUXOS.md), o pt-BR da ZecHub Brasil, os rótulos da carteira Zodl, os termos
> da Zcash Foundation para FROST (ZIP 312, `frost-client`) e a prática da planilha pública de
> tesouraria da comunidade (categoria e status vêm de listas; a cor segue o status).

---

## 0. Em uma página

1. **A pessoa vê cofre, membros, aprovação, pagamento.** Nunca FROST, DKG, sighash, nonce, round.
2. **Uma coisa, um nome.** O menu, o título da tela e a aba dizem a mesma palavra, nas duas línguas.
3. **A palavra da comunidade antes da nossa.** Se a carteira que a pessoa já usa chama de "blindado",
   o Konclave chama de "blindado".
4. **A engrenagem fica nos docs e no painel de confiança**, com o nome técnico entre parênteses uma
   vez, onde a pessoa foi procurar por ele.
5. **O botão diz o que acontece.** Propor pagamento, Aprovar, Assinar e enviar, Enviado.
6. **Trava de produto não se veste de garantia criptográfica.** "2 de 3 precisam aprovar" é a
   assinatura; "saldo reservado" é o Konclave. A copy diz qual é qual.

---

## 1. Termos: EN, pt-BR e onde a pessoa já viu

| EN | pt-BR (como a comunidade escreve) | Onde a pessoa já viu | No Konclave |
|---|---|---|---|
| shielded / transparent | **blindado / transparente** | Zodl: "always use shielded address" | usa (#127: as telas dizem "blindado" e "blindado antigo (Sapling)") |
| shield | **blindar** | Zodl: Shield, Shielding, Shielded | não se aplica (o cofre só recebe blindado) |
| Total / Spendable / Pending | total / disponível / pendente | Zodl, três linhas | usa; a **reserva** de propostas é uma quarta linha, dita como reserva do Konclave, nunca como "pendente" |
| Unified Address (UA) | **endereço unificado**, "começa com u1" | Zodl mostra só "Shielded Address" | usa "endereço do cofre"; "unificado" só no detalhe |
| memo | **memo** (memorando criptografado) | Zodl: "Write encrypted message here" | usa "memo"; o campo diz que é cifrado e que transparente não tem memo |
| viewing key (Incoming / Full) | **chave de visualização** | Zodl: Export Viewing Key, "cannot be undone" | usa "chave de visualização" (Ajustes, exportação); hoje o cofre tem uma só; Incoming/Full não se aplica |
| view-only | **somente leitura** | Zodl: View Only Account | **a conferir**: o produto lê sem desbloquear; o nome "somente leitura" ainda não aparece |
| payment request (ZIP 321) | **pedido de pagamento** | Zodl: Receive, Request, "What's this for?" | usa em Receber; "ZIP 321" só no detalhe |
| server / lightwalletd | **servidor** | Zodl: Choose a Server, host:porta | o Konclave não escolhe servidor; "servidor do cofre" é o nome na tela para o coordenador (§3) |
| seed + wallet birthday | **frase + altura** | Zodl: "Estimate my block height" | a exportação já carrega a chave de visualização e o aniversário juntos (#447, #480) |
| sync | **sincronizar** | Zodl: Syncing 42%, Synced | **falta**: a tela não diz quando ainda não leu a cadeia (vira régua de retorno, classe 5) |
| send flow | Revisar, Confirmar, Enviando, Enviado | Zodl | usa: prévia, confirmar, Enviado |
| threshold / participants / coordinator | **quórum (2 de 3)**, membros, coordenador | Zcash Foundation (`frost-client`, ZIP 312) | "quórum" e "membros" na tela; "coordenador" só nos docs e no painel de confiança |
| key share | **sua parte** (da chave do cofre) | Zcash Foundation | usa "sua parte"; nunca "share", "fragmento", "chave parcial" |
| group viewing key | chave de visualização do cofre | Zcash Foundation | usa |
| DKG | **criação do cofre** | Zcash Foundation | "DKG" só nos docs e na landing, como crédito à Fundação |
| multisig | múltiplas assinaturas (= transparente, no imaginário) | ZecHub | **nunca** para o Konclave; nos docs, "assinatura de limiar (FROST)" |
| treasurer / contributors / reviewers | tesoureiro, contribuidores, revisores | ZecHub | "tesoureiro" é quem opera; não vira papel com permissão (não existe) |
| coinholder / snapshot / quorum | detentor de ZEC | consultas da comunidade | não se aplica à tela; "quórum" no Konclave é o do cofre |
| grantee / milestone / tranche | beneficiário, marco, parcela | modelo de grants | "marco" e "parcela" esperam o compromisso (3b); "beneficiário" já é o nome |

---

## 2. As quinze convenções da comunidade, e onde o Konclave está

| # | Convenção | No Konclave |
|---|---|---|
| 1 | Eixo blindado × transparente na tela; pools só no detalhe | já (#127) |
| 2 | Saldo em três linhas; a reserva do produto é uma quarta linha explícita | a conferir no Painel |
| 3 | Duas chaves de visualização (Incoming para contador, Full para auditoria) | não se aplica hoje; uma chave só |
| 4 | "Somente leitura" é o nome do modo de leitura | falta o nome |
| 5 | Seletor de servidor igual ao das carteiras | não se aplica; o painel de confiança diz o que cada serviço vê |
| 6 | Pedido de pagamento = ZIP 321 ("Pedir ZEC", "Para que é?") | já em Receber |
| 7 | Memo: placeholder, limite, "transparente não tem memo" | a conferir nos campos de memo |
| 8 | Backup = frase + altura, juntas; a parte é tratada como uma seed | a exportação já junta; o aviso sobre a parte, a conferir |
| 9 | Sync visível e honesto | falta (régua de retorno, classe 5) |
| 10 | Envio em quatro estados | já; os nomes do Konclave são Propor, Aprovar, Assinar e enviar, Enviado |
| 11 | Vocabulário FROST nos docs, não na tela | regra deste guia (§3) |
| 12 | "Multisig" não é FROST | já nos docs; na tela não aparece nenhum dos dois |
| 13 | Papéis de tesouraria com os nomes da ZecHub | "tesoureiro" só em texto; não vira permissão |
| 14 | Prova on-chain e dados antes de adjetivos | já (PROOF.md, tela de evidência) |
| 15 | Estilo ZecHub: curto, o mais importante primeiro, como se fala | este guia segue |

---

## 3. Palavras da engrenagem: fora da tela do dia a dia

Onde está hoje = prefixos do dicionário pt-BR em 2026-10-30. Substituto = o que a tela diz no lugar.
Onde pode aparecer = o lugar em que a pessoa foi procurar pelo nome técnico.

| Palavra | Onde está hoje | Substituto na tela | Onde pode aparecer |
|---|---|---|---|
| FROST, DKG | landing, net, ceremony | "assinatura em grupo", "criação do cofre" | docs; landing, uma vez, como crédito à Fundação |
| relay | net (6), settings (5), dashboard (2) | "a ligação entre os aparelhos"; em erro: "não deu para alcançar os outros aparelhos" | painel de confiança: "serviço de mensagens (relay): vê só material público" |
| coordenador | signing (8), error (5), registration (4), net (3) | "o servidor do cofre" | painel de confiança e docs, com o que ele vê e o que não vê |
| assento | net (4), error (2), dashboard (2), vaults (1) | "membro" (a pessoa); "aparelho do membro" (o lugar) | docs |
| cerimônia | proposal, net, ceremonies, signing | "assinatura" (de um pagamento); "criação do cofre" | a tela de evidência pode chamar-se "Assinaturas" em vez de "Registro de cerimônias" (proposta; tela a confirmar com o Daniel) |
| parte da chave, share | 31 ocorrências como "sua parte" | **"sua parte"** fica, como único nome, definida uma vez na tela de backup | nunca "share", "fragmento", "chave parcial" |
| Orchard, Sapling, Ironwood (pools) | landing, signer, error, dashboard | "blindado"; "blindado antigo (Sapling)" (#127) | detalhe técnico e docs |
| sighash | ceremonies (2), net (1) | nada no dia a dia | evidência: "resumo assinado (sighash)" (#127) |
| ZIP 321 | 1 ocorrência | "pedido de pagamento" | detalhe de Receber |
| mainnet | proposal (4), error (1) | "a rede Zcash"; nos avisos de dinheiro, "ZEC de verdade" | docs, PROOF |
| nonce, round 1 e 2, package, randomizer | nenhuma | nunca | docs |

**Fica como está:** "quórum" (42 ocorrências) é a palavra da comunidade e do produto. Sempre com o
número: "2 de 3 aprovações", nunca "quórum atingido" sozinho.

---

## 4. Listas controladas

A planilha que a comunidade usa tem duas regras que valem copiar: **categoria e status vêm de
listas**, nunca de texto livre; e **a cor segue o status**, nunca o contrário.

### 4.1 Categorias de um cofre

Lista **editável por cofre**, com uma lista padrão no primeiro preenchimento. Uma categoria por
proposta (e por linha de folha, quando a folha mistura). Padrão proposto, sete entradas:

| Categoria | É para |
|---|---|
| Grant | marco de um projeto aprovado |
| Contrato | entregável mensal de alguém contratado |
| Bolsa | valor fixo e recorrente (stipend) |
| Reembolso | despesa adiantada por alguém |
| Patrocínio | evento, viagem, comunidade |
| Operação | infraestrutura, taxas, serviços |
| Outro | o que não cabe acima, para nada ser forçado |

Regras: uma categoria em uso não se apaga, só se renomeia; "Outro" existe sempre; a lista é do cofre,
não do aparelho. **Depende do campo de categoria na proposta (pacote de campos do Daniel, 4.7).**

### 4.2 Estados da proposta (fixos)

Os estados já existem no produto. O que este guia fixa é o **agrupamento, a cor e a palavra**, iguais
na tela, na lista e na planilha exportada.

| Grupo | Estados | Cor (semântica) | A tela diz |
|---|---|---|---|
| Precisa de alguém | aguardando, pronta | ação | "aguarda 1 de 2", "pronta para assinar" |
| A caminho | enviada | neutra | "enviada, aguardando confirmação" |
| Liquidada | confirmada | ok | "confirmada" |
| Encerrada sem pagamento | recusada, expirada, cancelada, invalidada | apagada | o próprio estado, fora das somas |

A cor nunca vai sozinha: todo estado tem a palavra e, onde couber, o sinal (como os avisos já fazem).

### 4.3 Estados de compromisso (futuro, 3b)

Quando o compromisso existir como objeto, os estados são fixos e poucos, como na planilha:

| Estado | Quando | Cor |
|---|---|---|
| previsto | tem valor e data prevista, sem pagamento | neutra |
| vencido | a data prevista passou e não foi pago | atenção |
| pago | liquidado: data, ZEC e taxa implícita (valor ÷ ZEC) | ok |
| cancelado | não será pago | apagada |

"Passivo em aberto" é só a soma do que está previsto ou vencido. Sem cotação histórica em lugar
nenhum: a taxa de cada linha nasce na liquidação e não se consulta depois.

### 4.4 Onde cada lista vive

- Categorias: dado do cofre (campo no coordenador; decisão do Daniel, com #567 e #290).
- Estados: código do produto, **uma implementação**, lida pela tela e pela exportação.
- Cores: tokens da camada visual (etapa 8 do plano), nunca cor solta em componente.

---

## 5. Regras de copy

1. **O botão diz o que acontece.** "Propor pagamento", "Aprovar", "Assinar e enviar". Nunca "OK",
   "Enviar" sozinho, "Continuar" num passo que move dinheiro.
2. **Dinheiro nunca sai num clique.** Prévia e confirmação; a confirmação diz valor, para quem e o
   que acontece depois ("Ao aprovar, você autoriza este pagamento com sua parte").
3. **Garantia e trava, cada uma com seu nome.** O que é da assinatura ("2 de 3 precisam aprovar") e o
   que é do Konclave ("o saldo desta proposta fica reservado"). Nunca "a rede impede" para uma
   trava de produto.
4. **Erro diz o que fazer.** Uma frase com a próxima ação; sem código, sem pilha; "Tentar de novo"
   quando faz sentido; em caminho de dinheiro, a falha fica na tela, nunca só num aviso que some.
5. **Um nome por coisa.** Cofre, membro, sua parte, quórum, proposta, pagamento, folha, beneficiário,
   razão, evidência. Nem sinônimo, nem apelido.
6. **Número com unidade e contexto.** "0,25 ZEC", nunca "0,25"; valor em USD só como referência
   rotulada ("ref. USD"), nunca como cotação histórica.
7. **Curto, o mais importante primeiro, como se fala.** Sem travessão em texto público; frases de
   uma ideia.
8. **A privacidade decide o que aparece.** Nunca o id inteiro de um cofre, nunca uma chave de
   visualização numa captura, memo tratado como dado sensível.

---

## 6. Glossário mínimo do produto

- **Cofre:** o fundo coletivo; um endereço blindado, vários membros, um quórum.
- **Membro:** quem tem uma parte da chave do cofre num aparelho e pode aprovar.
- **Sua parte:** a parte da chave que fica só no seu aparelho; nunca sai dele.
- **Quórum:** quantas aprovações um pagamento precisa, dito como "2 de 3".
- **Proposta:** um pagamento ou uma folha à espera de aprovações.
- **Pagamento:** uma saída para um endereço; **folha:** várias saídas numa transação só.
- **Beneficiário:** quem recebe; o cadastro de pessoas guarda nome e endereço.
- **Razão:** o livro do cofre: tudo que foi proposto, aprovado, enviado e confirmado.
- **Evidência:** a prova de cada assinatura, com o txid na cadeia.
- **Painel de confiança:** o que cada serviço vê e o que não vê, em texto simples.
- **Compromisso** e **categoria:** futuros; dependem do pacote de campos.

---

## 7. O que este guia não decide

- O pacote de campos (3.4, 3.6, 4.7, 3b.2) e qualquer coisa que mude o que um aparelho assina.
- O título das telas que são do Daniel (Painel, assinatura, cerimônia). O guia propõe; ele decide.
- Os tokens de cor (etapa 8). Aqui só o significado de cada cor.
