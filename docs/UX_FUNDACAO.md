# Konclave — Fundação de UX (Etapas 1–3)

> Persona, arquitetura de informação e os 4 fluxos que importam. O alicerce barato que
> faz o modelo fiel nascer certo. Segue a [ROTA_UX.md](ROTA_UX.md).

---

## Etapa 1 — Persona + tarefas (jobs-to-be-done)

### Primária — Marina, a tesoureira do coletivo
- **Quem:** lidera as operações de uma DAO / comunidade Web3 / pequeno coletivo (ou dona
  de um negócio que administra um fundo comum). Cuida do dinheiro de todos.
- **Nível técnico:** **não-técnica.** Vive de planilha e app de banco. Não entende — nem
  quer entender — criptografia.
- **Metas:** pagar contribuidores de forma justa e privada; **não ser o ponto único de
  falha**; conseguir **justificar cada gasto** ao grupo e ao contador; fazer rápido, sem
  ajuda de ninguém.
- **Dores de hoje:** as opções são ruins — uma pessoa segura a chave (risco), chave
  compartilhada (inseguro), multisig transparente (vaza tudo on-chain). FROST no terminal
  é impossível pra ela.
- **Vitória:** *"Paguei a equipe, de forma privada, com duas aprovações, e entrego ao meu
  contador um relatório limpo."*

### Secundária — os co-signatários (Bruno, Carla)
Membros que detêm uma parte da chave. Querem só **aprovar/recusar com um toque** quando
algo precisa deles. Baixo engajamento, esforço mínimo. Não operam o dia a dia.

### Terciária — Sr. Oliveira, o contador
Fecha livros e impostos. **Não opera o app** (ou tem uma **visão só-leitura** — o
"Observador via UFVK", roadmap). Precisa de **registros limpos e exportáveis**: datas,
valores, contraparte (quando conhecida), **quem aprovou**. Trabalha em planilha/PDF.

### Nota de enquadramento (importante)
A **função principal** é o **cofre coletivo com pagamentos aprovados por quórum**.
**Pagamento avulso (1 destino)** e **folha (N destinos)** são **duas opções do MESMO
mecanismo** — a folha **não é o rosto principal**, é *uma* forma de pagar. Um pagamento
avulso é, no fundo, uma "folha de 1 linha". A UI trata os dois como **opções paralelas**
(nunca a folha dominando).

### Tarefas priorizadas (nas palavras da Marina)
1. "Montar um cofre onde **ninguém sozinho** manda no dinheiro."
2. "Ter **um endereço privado** para receber contribuições."
3. "**Pagar** um contribuidor/fornecedor com **aprovação do grupo**, sem vazar."
4. "Pagar **todo mundo de uma vez**, conforme contribuição (folha/split), com **uma**
   aprovação."
5. "Ao abrir, ver **quanto tem** e **o que espera minha aprovação**."
6. "Mostrar ao grupo e ao contador **o que aconteceu — quem propôs e quem aprovou — e
   exportar**." ← elevado pelo track de Accounting.
7. "Fazer tudo isso **sem lidar com criptografia**."

---

## Etapa 2 — Arquitetura de informação

### Mapa de navegação (com a lente de contabilidade)

```
                 ┌───────────────┐
                 │   ABERTURA     │  sem cofre ainda
                 └───────┬───────┘
             Criar cofre │ Entrar num cofre
                 ┌───────▼───────┐
                 │   CERIMÔNIA    │  DKG passo a passo (parece "montar um grupo")
                 └───────┬───────┘
                 ┌───────▼─────────────────────────────────────┐
                 │                 PAINEL (home)                │◄────────┐
                 │  saldo (tarja) · o que precisa de mim · atalhos       │
                 └──┬─────────┬──────────┬───────────┬──────────┬────────┘
        Novo pagamento   Nova folha   Propostas   RAZÃO/          Membros /
             │              │         pendentes   PRESTAÇÃO       Modelo de
             └──────┬───────┘             │       DE CONTAS       confiança
                    ▼                     ▼          │  (filtrar,       │
             ┌─────────────┐      ┌──────────────┐   │   exportar) ─────┘
             │  PROPOSTA    │◄─────┤  (detalhe)   │   │
             │  aprovar /   │      └──────────────┘   ▼
             │  acompanhar  │                    (stretch) OBSERVADOR
             └──────┬───────┘                    só-leitura p/ contador
                    ▼
             ┌─────────────┐
             │   ENVIADO    │  confirmação + link do explorador
             └─────────────┘
```

### O que cada tela responde (e a ação primária)

| Tela | Responde | Ação primária |
|---|---|---|
| **Abertura** | "Tenho um cofre?" | Criar / Entrar |
| **Cerimônia** | "Como nasce o cofre com segurança?" | Convidar + criar juntos |
| **Painel** | "Quanto tem? Precisa de mim? O que houve?" | Aprovar o pendente |
| **Novo pagamento** | "Como pago um destino?" | Propor |
| **Nova folha** | "Como pago vários conforme contribuição?" | Montar/importar → Propor |
| **Proposta (detalhe)** | "Autorizo este gasto?" | Aprovar / Recusar |
| **Enviado** | "Saiu mesmo? Como provo?" | Ver no explorador |
| **Razão / Prestação de contas** | "O que aconteceu? Como entrego ao contador?" | Filtrar → **Exportar** |
| **Membros** | "Quem controla? Dá pra confiar?" | Ver modelo de confiança |
| **Observador** (stretch) | (contador) "O que registrar?" | Só-leitura / export |

**Mudança-chave da IA:** o histórico vira **Razão/Prestação de contas** — uma superfície
de trabalho contábil (filtro por período/membro/tipo, export CSV/PDF), não três linhas
decorativas.

---

## Etapa 3 — Os 4 fluxos que importam

> Formato: passos humanos · *(o que roda escondido)* · ramos de erro.

### Fluxo 1 — Nascer (criar o cofre)
O onboarding mais delicado. Meta: parecer **"montar um grupo"**, não "rodar um protocolo".
1. Marina define **nome do cofre** e a **regra** em linguagem humana: *"Quantas pessoas
   precisam aprovar cada pagamento?"* → **2 de 3**. Microcopy: "Ninguém sozinho controla."
2. **Convida os membros** (link/QR). Lista preenche conforme entram. *"Aguardando 2 de 3…"*
3. Todos online → botão único **"Criar cofre agora"**. *(roda o DKG via frostd; cada um
   guarda sua parte localmente, cifrada — nunca remontada.)* Tela: "Gerando as chaves…
   (acontece uma vez)".
4. **Endereço pronto** (Orchard + UFVK). *"Este é o endereço para receber. **Só Orchard.**"*
- **Erros:** membro cai no meio → "A criação parou porque [nome] saiu. Recomece quando
  todos estiverem prontos." · `frostd` fora → fallback QR/copy-paste.

### Fluxo 2 — Pagar com aprovação (o laço central)
1. Marina abre **Novo pagamento**: destino, valor, **memo opcional** (holerite privado).
   *Validação ao vivo:* endereço válido? saldo suficiente (valor + taxa)?
2. **Preview + confirmação:** "Você vai propor 0,5 ZEC → zs1… Precisa de 2 aprovações
   (incluindo a sua)." Botão **"Propor pagamento"** (não "enviar" — ainda não envia).
   *(monta o plano → PCZT → extrai o que assinar; a proponente já conta como 1 aprovação.)*
3. **A proposta viaja.** Bruno vê no Painel, abre a **Proposta**, lê quem propôs/destino/
   valor/memo, e **Aprova** com um toque. Microcopy: "Ao aprovar, você autoriza com a sua
   parte da chave." *(cerimônia FROST via frostd; ao bater 2 de 3, injeta a assinatura.)*
4. **Enviado** → confirmação + **link do explorador** (prova on-chain). O Razão registra
   **quem propôs e quem aprovou**.
- **Erros/estados:** recusa que inviabiliza o quórum → "Recusada por [nome]." · expira →
  "Expirou; reproponha." · falha de rede → "A proposta segue válida; tente reenviar."

### Fluxo 3 — Folha por contribuição (o segundo rosto)
Mesma aprovação, entrada de **N destinos**.
1. **Montar a folha:** tabela editável (rótulo, endereço, valor, memo/holerite) **ou
   importar CSV** (o tesoureiro vive em planilha). *Rodapé vivo:* total + **taxa estimada**
   (cresce com nº de destinos, sem surpresa) + saldo após.
2. **Import CSV** → relatório: linhas aceitas, linhas com erro (motivo + nº da linha).
   Import parcial permitido.
3. **Revisar:** "Folha de maio — 8 pagamentos, total 4,2 ZEC. Precisa de 2 aprovações."
4. **Propor → aprovar → enviado** (idêntico ao Fluxo 2), mas **uma transação, N saídas,
   uma aprovação** cobre tudo. Cada um recebe seu valor e seu holerite cifrado.

### Fluxo 4 — Fechar as contas (o pedido do contador)
O que o track de Accounting exige.
1. Marina abre o **Razão**: lista completa, entradas e saídas.
2. **Filtra** por período (mês/trimestre), membro, tipo (pagamento/folha/entrada).
3. Cada saída mostra **quem propôs e quem aprovou** + status + link do explorador.
4. **Exporta** (CSV/PDF) — gerado **localmente**, nunca enviado a servidor — e **entrega
   ao contador**. *(read-only via UFVK; mostra sem poder gastar.)*
- **Privacidade:** tudo isto é **transparência interna**; a blockchain pública nada revela.
  Valores sob a **tarja** por padrão; revelar é gesto.

---

## O que isto trava para o modelo fiel
- A **ação primária** de cada tela (o que o não-técnico faz sem pensar).
- O **Razão/Prestação de contas** como superfície contábil de primeira classe (filtro +
  export) — a resposta ao track de Accounting.
- Onde **preview + confirmação** são obrigatórios (tudo que move fundos).
- Onde a **tarja** e o **guia/microcopy** carregam a confiança sem jargão.
