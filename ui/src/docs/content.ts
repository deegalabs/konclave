// Bilingual content for the in-app documentation site (/docs). Kept as a local module,
// keyed by locale, so the docs respect the language toggle without inflating the global
// i18n dictionary. Content is drawn from the cleaned public docs (README, ARCHITECTURE,
// SUBMISSION) and stays honest about what is proven vs pending.

export type Locale = 'pt-BR' | 'en'
type L = { 'pt-BR': string; en: string }

export type Block =
  | { k: 'p'; t: L }
  | { k: 'h'; t: L }
  | { k: 'ul'; items: L[] }
  | { k: 'code'; t: string }
  | { k: 'note'; t: L }
  | { k: 'img'; src: string; alt: L }

export type Section = {
  id: string
  nav: L
  title: L
  lead: L
  blocks: Block[]
}

export const SECTIONS: Section[] = [
  {
    id: 'introduction',
    nav: { 'pt-BR': 'Introdução', en: 'Introduction' },
    title: { 'pt-BR': 'O que é o Konclave', en: 'What Konclave is' },
    lead: {
      'pt-BR':
        'Cofres coletivos, privados e à prova de uma pessoa só, na Zcash, usando assinaturas de limiar (FROST). A criptografia é da Zcash Foundation; o Konclave é a **camada humana** por cima.',
      en:
        'Private, collective, single-person-proof fund vaults on Zcash, using threshold signatures (FROST). The cryptography is the Zcash Foundation’s; Konclave is the **human layer** on top.',
    },
    blocks: [
      { k: 'h', t: { 'pt-BR': 'O problema', en: 'The problem' } },
      {
        k: 'p',
        t: {
          'pt-BR':
            'Um grupo que guarda dinheiro junto enfrenta dois problemas inescapáveis. **Um:** se uma chave única é perdida ou roubada, o tesouro se vai. **Dois:** numa blockchain comum, todos veem os salários, os doadores e a estrutura inteira. Zcash e FROST resolvem ambos, criptograficamente, mas hoje só um criptógrafo consegue usá-los.',
          en:
            'A group that holds money together faces two problems it cannot escape. **One:** if a single key is lost or stolen, the treasury is gone. **Two:** on a normal blockchain, everyone can see the salaries, the donors, and the whole structure. Zcash and FROST solve both, cryptographically, but today only a cryptographer can use them.',
        },
      },
      { k: 'h', t: { 'pt-BR': 'A solução', en: 'The solution' } },
      {
        k: 'p',
        t: {
          'pt-BR':
            'O Konclave divide a autoridade de gasto Orchard de um cofre em **`t`-de-`n` shares FROST** entre os membros, por **Geração Distribuída de Chave (DKG)** real. A chave inteira **nunca é reconstituída**, nem na criação nem na assinatura, e cada share **nunca deixa o dispositivo do dono**. Sobre isso vem a camada humana: propor, aprovar até o quórum, assinar, transmitir e prestar contas, em linguagem simples e com confirmação explícita antes de qualquer movimento.',
          en:
            'Konclave splits a vault’s Orchard spend authority into **`t`-of-`n` FROST shares** across the members by real **Distributed Key Generation (DKG)**. The whole key is **never reconstituted**, at creation or at signing, and each share **never leaves its owner’s device**. On top of that comes the human layer: propose, approve to a quorum, sign, broadcast, and account, in plain language with an explicit confirmation before anything moves.',
        },
      },
      {
        k: 'note',
        t: {
          'pt-BR':
            'A regra de design: **esconder a criptografia, expor a confiança.** Você nunca vê "FROST", "DKG" ou "SIGHASH"; você vê cofre, membros, aprovação, pagamento.',
          en:
            'The design rule: **hide the cryptography, expose the trust.** You never see "FROST", "DKG", or "SIGHASH"; you see vault, members, approval, payment.',
        },
      },
      { k: 'h', t: { 'pt-BR': 'Provado na mainnet', en: 'Proven on mainnet' } },
      {
        k: 'p',
        t: {
          'pt-BR':
            'Não é maquete. Um **pagamento por quórum 2-de-3**, proposto e aprovado no app, assinado por uma cerimônia FROST real e transmitido para a **mainnet da Zcash**, com a chave nunca reconstituída:',
          en:
            'This is not a mock. A **2-of-3 quorum payment**, proposed and approved in the app, signed by a real FROST ceremony, and broadcast to **Zcash mainnet**, with the key never reconstituted:',
        },
      },
      { k: 'code', t: 'txid 43433a109d3f2a078c0a9269ccb156392ade7a1f7ac1532981611eda1e59a572' },
    ],
  },
  {
    id: 'explore',
    nav: { 'pt-BR': 'Explorar', en: 'Explore' },
    title: { 'pt-BR': 'Explorar as superfícies vivas', en: 'Explore the live surfaces' },
    lead: {
      'pt-BR':
        'Tudo pra experimentar, num lugar só — o produto rodando, a prova na blockchain, o cofre entre dispositivos e o laboratório da criptografia.',
      en:
        'Everything to try, in one place — the product running, the on-chain proof, the cross-device vault, and the cryptography lab.',
    },
    blocks: [
      {
        k: 'ul',
        items: [
          {
            'pt-BR': '[Abrir o cofre](#/vaults) — o produto rodando: pagamento, folha, aprovações e registro.',
            en: '[Open the vault](#/vaults) — the product running: payment, payroll, approvals and ledger.',
          },
          {
            'pt-BR': '[Comprovação na blockchain](#/proof) — confira você mesmo, no explorador público, as transações reais do Konclave na mainnet.',
            en: '[Proof on the blockchain](#/proof) — check for yourself, on the public explorer, Konclave’s real mainnet transactions.',
          },
          {
            'pt-BR': '[Cofre entre dispositivos](#/net) — crie e opere o mesmo cofre no celular e no computador. Nenhum servidor vê um segredo.',
            en: '[Vault across devices](#/net) — create and run one vault on your phone and your computer. No server ever sees a secret.',
          },
          {
            'pt-BR': '[Laboratório](#/lab) — veja a criptografia acontecer: assinatura no navegador, recuperação e herança, ao vivo.',
            en: '[Laboratory](#/lab) — watch the cryptography happen: browser signing, recovery and inheritance, live.',
          },
        ],
      },
    ],
  },
  {
    id: 'how-it-works',
    nav: { 'pt-BR': 'Como funciona', en: 'How it works' },
    title: { 'pt-BR': 'Como funciona', en: 'How it works' },
    lead: {
      'pt-BR': 'Da proposta ao razão contábil, sem que uma pessoa consiga mover os fundos sozinha.',
      en: 'From proposal to ledger, with no single person ever able to move the funds alone.',
    },
    blocks: [
      { k: 'h', t: { 'pt-BR': 'O fluxo', en: 'The flow' } },
      {
        k: 'code',
        t:
          'propose  ->  approve (quorum M-of-N, with expiry)  ->  sign (FROST,\nonly the shares of whoever approved)  ->  broadcast (Orchard, shielded)  ->  ledger\n                       the key is never reassembled',
      },
      {
        k: 'ul',
        items: [
          {
            'pt-BR': '**Pagamento por quórum:** proponha um pagamento, os membros aprovam e, no quórum, o cofre assina (FROST) e envia uma transação Orchard blindada. Um clique nunca move dinheiro.',
            en: '**Quorum payment:** propose a payment, members approve, and at quorum the vault signs (FROST) and sends a shielded Orchard transaction. One click never moves money.',
          },
          {
            'pt-BR': '**Folha privada:** importe um CSV de beneficiários e gere uma transação Orchard com N saídas, aprovada **uma vez**. Cada contracheque viaja num **memo criptografado** que só o destinatário lê.',
            en: '**Private payroll:** import a CSV of beneficiaries into one shielded Orchard transaction with N outputs, approved **once**. Each payslip rides in an **encrypted memo** only its recipient can read.',
          },
          {
            'pt-BR': '**Contabilidade:** um razão interno completo (quem propôs, quem aprovou, estados, datas) mais uma **exportação CSV itemizada** (uma folha de N vira N lançamentos). Transparente por dentro, privado por fora.',
            en: '**Accounting:** a full internal ledger (who proposed, who approved, states, dates) plus an **itemized CSV export** (a payroll of N becomes N line-items). Transparent inside, private outside.',
          },
        ],
      },
      { k: 'h', t: { 'pt-BR': 'Três camadas', en: 'Three layers' } },
      {
        k: 'p',
        t: {
          'pt-BR': 'Cada camada com um papel claro, e a criptografia **não é reimplementada**.',
          en: 'Each layer has a clear job, and the cryptography is **not reimplemented**.',
        },
      },
      {
        k: 'code',
        t:
          'Layer 3 . UI            Vite + React (vault, members, payment, payroll, proposal, ledger)\nLayer 2 . ORCHESTRATOR  Rust: state machine, validation (ZIP-317, addresses), payroll,\n                        sealed key custody, SQLite/SQLCipher store, the FROST-PCZT bridge\nLayer 1 . ENGINE        official Zcash Foundation tools:\n                        frostd, frost-client, zcash-sign, zcash-devtool, librustzcash',
      },
      { k: 'h', t: { 'pt-BR': 'Diagramas', en: 'Diagrams' } },
      { k: 'img', src: 'diagrams/system-overview.svg', alt: { 'pt-BR': 'Visão geral do sistema em três camadas', en: 'System overview in three layers' } },
      { k: 'img', src: 'diagrams/quorum-payment.svg', alt: { 'pt-BR': 'Fluxo do pagamento por quórum: propor, aprovar, assinar, transmitir', en: 'Quorum payment flow: propose, approve, sign, broadcast' } },
    ],
  },
  {
    id: 'using-it',
    nav: { 'pt-BR': 'Passo a passo', en: 'Step by step' },
    title: { 'pt-BR': 'Usando: passo a passo', en: 'Using it: step by step' },
    lead: {
      'pt-BR': 'O fluxo inteiro, na linguagem do próprio app: esconda a criptografia, exponha a confiança.',
      en: "The whole flow, in the app's own words: hide the cryptography, expose the trust.",
    },
    blocks: [
      {
        k: 'ul',
        items: [
          {
            'pt-BR': '**1. Crie ou entre num cofre** (`/create`, ou `/net` entre dois aparelhos). Escolha os membros e o quórum (ex.: 2 de 3). A chave nasce por **DKG**, dividida entre os dispositivos, e nunca existe inteira em lugar nenhum.',
            en: '**1. Create or join a vault** (`/create`, or `/net` across two devices). Pick the members and the quorum (e.g. 2 of 3). The key is born by a real **DKG**, split across devices, and never exists whole anywhere.',
          },
          {
            'pt-BR': '**2. Financie o cofre** (`/receive`). Compartilhe o **endereço Orchard** blindado do cofre (com QR e link de cobrança ZIP-321) e receba ZEC.',
            en: "**2. Fund it** (`/receive`). Share the vault's shielded **Orchard address** (with a QR and a ZIP-321 payment link) and receive ZEC.",
          },
          {
            'pt-BR': '**3. Proponha um pagamento** (`/pay`). Informe o valor e o destinatário (escolha um beneficiário salvo ou cole um endereço). O Konclave valida o endereço e confere o saldo **antes** de criar qualquer coisa.',
            en: '**3. Propose a payment** (`/pay`). Enter an amount and a recipient (a saved beneficiary or a pasted address). Konclave validates the address and checks the balance *before* anything is created.',
          },
          {
            'pt-BR': '**4. Aprove por quórum** (`/proposals`). Cada membro revisa e aprova ou recusa. Nada se move até o número combinado de aprovações, e as propostas expiram.',
            en: '**4. Approve to quorum** (`/proposals`). Each member reviews and approves or refuses. Nothing moves until the agreed number of approvals is in, and proposals expire.',
          },
          {
            'pt-BR': '**5. Assine e envie.** No quórum, uma cerimônia FROST assina com **apenas as partes de quem aprovou** e transmite uma única transação Orchard blindada. Um preview e uma confirmação explícita protegem o envio: um clique nunca move dinheiro, e a chave nunca é remontada.',
            en: '**5. Sign and send.** At quorum a FROST ceremony signs with **only the shares of whoever approved** and broadcasts one shielded Orchard transaction. A preview and an explicit confirmation guard the broadcast: one click never moves money, and the key is never reassembled.',
          },
          {
            'pt-BR': '**6. Folha de pagamento (opcional)** (`/payroll`). Importe um CSV de beneficiários numa transação com N saídas, aprovada **uma vez**, cada contracheque num memo criptografado que só o destinatário lê.',
            en: '**6. Payroll, optional** (`/payroll`). Import a CSV of beneficiaries into one shielded transaction with N outputs, approved **once**, each payslip in an encrypted memo only its recipient can read.',
          },
          {
            'pt-BR': '**7. Contabilize** (`/ledger`). Cada ação entra no razão interno (quem propôs, quem aprovou, estados, datas), com exportação CSV itemizada para o contador.',
            en: '**7. Account** (`/ledger`). Every action lands in the internal ledger (who proposed, who approved, states, dates), with an itemized CSV export for the accountant.',
          },
        ],
      },
      {
        k: 'note',
        t: {
          'pt-BR': 'Experimente o fluxo com dados de demonstração aqui mesmo na demo hospedada, ou rode de verdade localmente (veja **Rodar localmente**).',
          en: 'Try the flow with demo data right here on the hosted demo, or run it for real locally (see **Run it locally**).',
        },
      },
    ],
  },
  {
    id: 'use-cases',
    nav: { 'pt-BR': 'Casos de uso', en: 'Use cases' },
    title: { 'pt-BR': 'Casos de uso', en: 'Use cases' },
    lead: {
      'pt-BR': 'Tudo que dá para fazer, tela por tela, com a garantia de cada um.',
      en: "Everything you can do, screen by screen, with each one's guarantee.",
    },
    blocks: [
      { k: 'h', t: { 'pt-BR': 'No dia a dia', en: 'Everyday' } },
      {
        k: 'ul',
        items: [
          { 'pt-BR': '**Criar um cofre** (`/create`) — membros + quórum; a chave nasce por DKG, nunca inteira.', en: '**Create a vault** (`/create`) — members + quorum; the key is born by DKG, never whole.' },
          { 'pt-BR': '**Receber** (`/receive`) — endereço Orchard + QR + link ZIP-321; receber não precisa de chave.', en: '**Receive** (`/receive`) — Orchard address + QR + a ZIP-321 link; receiving needs no key.' },
          { 'pt-BR': '**Propor pagamento** (`/pay`) — valor + destino; endereço e saldo validados antes de criar.', en: '**Propose a payment** (`/pay`) — amount + recipient; address and balance validated up front.' },
          { 'pt-BR': '**Aprovar/recusar** (`/proposals`) — quórum real; nada move sem as aprovações, e as propostas expiram. A aprovação vincula a parte que assina.', en: '**Approve/refuse** (`/proposals`) — real quorum; nothing moves without the approvals, and proposals expire. Approval binds the signing share.' },
          { 'pt-BR': '**Assinar e enviar** — cerimônia FROST com as partes de quem aprovou; preview + confirmação; a chave nunca é remontada.', en: "**Sign & send** — a FROST ceremony with the approvers' shares; preview + confirm; the key is never reassembled." },
          { 'pt-BR': '**Folha privada** (`/payroll`) — CSV de N beneficiários numa única transação blindada, aprovada uma vez, cada holerite num memo cifrado.', en: '**Private payroll** (`/payroll`) — a CSV of N beneficiaries in one shielded transaction, approved once, each payslip in an encrypted memo.' },
          { 'pt-BR': '**Razão/contas** (`/ledger`) — livro interno completo + exportação CSV itemizada (folha de N vira N linhas).', en: '**Ledger/accounting** (`/ledger`) — a full internal book + itemized CSV export (payroll of N becomes N rows).' },
        ],
      },
      { k: 'h', t: { 'pt-BR': 'Além do básico', en: 'Beyond the basics' } },
      {
        k: 'ul',
        items: [
          { 'pt-BR': '**Cofre entre dispositivos** (`/net`) — criar e assinar com o celular e o computador por um relay cego; nenhum servidor vê um segredo.', en: '**Vault across devices** (`/net`) — create and sign with phone and computer over a blind relay; no server sees a secret.' },
          { 'pt-BR': '**Recuperação de membro** (`/recovery`) — um quórum reconstrói a parte de quem perdeu acesso (RTS), sem expor a chave.', en: "**Member recovery** (`/recovery`) — a quorum rebuilds a lost member's share (RTS), without exposing the key." },
          { 'pt-BR': '**Herança** (`/inheritance`) — se o responsável some, o quórum libera ao herdeiro como um pagamento comum.', en: '**Inheritance** (`/inheritance`) — if the steward disappears, the quorum releases to an heir as an ordinary payment.' },
          { 'pt-BR': '**Assinar no navegador** (`/signer`) — uma cerimônia FROST 2-de-3 inteira em WebAssembly.', en: '**Sign in the browser** (`/signer`) — a full 2-of-3 FROST ceremony entirely in WebAssembly.' },
          { 'pt-BR': '**Membros** (`/members`) e **beneficiários** (`/people`) — quem assina e quem recebe.', en: '**Members** (`/members`) and **beneficiaries** (`/people`) — who signs and who gets paid.' },
        ],
      },
      {
        k: 'note',
        t: {
          'pt-BR': 'Catálogo detalhado (ator, pré-condição, fluxo, limites honestos) no [guia completo](https://github.com/deegalabs/konclave/blob/main/docs/GUIDE.md).',
          en: 'The detailed catalog (actor, precondition, flow, honest limits) is in the [complete guide](https://github.com/deegalabs/konclave/blob/main/docs/GUIDE.md).',
        },
      },
    ],
  },
  {
    id: 'under-the-hood',
    nav: { 'pt-BR': 'Por dentro', en: 'Under the hood' },
    title: { 'pt-BR': 'Por dentro: estados, processos e dicas', en: 'Under the hood: states, processes & tips' },
    lead: {
      'pt-BR': 'A máquina de estados das propostas e os processos-chave que a sustentam.',
      en: 'The proposal state machine and the key processes behind it.',
    },
    blocks: [
      { k: 'h', t: { 'pt-BR': 'Ciclo de vida da proposta', en: 'Proposal lifecycle' } },
      { k: 'img', src: 'diagrams/proposal-states.svg', alt: { 'pt-BR': 'Máquina de estados da proposta: rascunho, aguardando, pronta, enviada, confirmada, e os terminais', en: 'Proposal state machine: draft, awaiting, ready, sent, confirmed, and the terminal states' } },
      { k: 'p', t: { 'pt-BR': '9 estados, cada transição guardada. `Superseded` (invalidada) é o único que não vem dos métodos da proposta — é aplicado pela reconciliação quando a cadeia não pode mais financiar a reserva.', en: "9 states, every transition guarded. `Superseded` is the only one not reachable from the proposal's own methods — reconciliation applies it when the chain can no longer fund the reservation." } },
      { k: 'h', t: { 'pt-BR': 'Processos-chave', en: 'Key processes' } },
      {
        k: 'ul',
        items: [
          { 'pt-BR': '**Bridge FROST↔PCZT** — o FROST assina um *sighash*; o gasto vive numa *PCZT*. O `konclave-signer` extrai o sighash + randomizers e injeta as assinaturas de volta, verificando cada uma.', en: '**FROST↔PCZT bridge** — FROST signs a *sighash*; the spend lives in a *PCZT*. `konclave-signer` extracts the sighash + randomizers and injects the signatures back, verifying each.' },
          { 'pt-BR': '**Custódia selada** — a parte nunca fica em claro no disco: selada com XChaCha20-Poly1305, aberta só num arquivo 0600 efêmero em tmpfs durante a cerimônia.', en: '**Sealed custody** — a share never sits in the clear on disk: sealed with XChaCha20-Poly1305, unsealed only into an ephemeral 0600 tmpfs file during the ceremony.' },
          { 'pt-BR': '**Relay cego** — carrega só bytes opacos (pacotes públicos de DKG ou já cifrados); não consegue ler o que transporta.', en: '**Blind relay** — carries only opaque bytes (public DKG packages or already-encrypted ones); it cannot read what it carries.' },
          { 'pt-BR': '**Reconciliação** — motor puro "a cadeia manda": promove Enviada para Confirmada pelos txids minerados e invalida reservas que a cadeia não financia mais.', en: '**Reconciliation** — a pure "on-chain wins" engine: promotes Sent to Confirmed by mined txids and invalidates reservations the chain can no longer fund.' },
        ],
      },
      { k: 'h', t: { 'pt-BR': 'Dicas', en: 'Tips' } },
      {
        k: 'ul',
        items: [
          { 'pt-BR': '**Sapling ≠ Orchard** — um destino só-Sapling pode travar fundos; o app decodifica o endereço e bloqueia com um aviso claro.', en: '**Sapling ≠ Orchard** — a Sapling-only destination can lock funds; the app decodes the address and blocks it with a clear warning.' },
          { 'pt-BR': '**Memo é só Orchard** — destinos transparentes (públicos) não levam memo, e o pagamento é marcado como público na cadeia.', en: '**Memos are Orchard-only** — transparent (public) destinations carry no memo, and the payment is flagged public on-chain.' },
          { 'pt-BR': '**Faça o dry-run** — o envio tem um ensaio que roda a cerimônia inteira e para *antes* de transmitir, sem mover fundos.', en: '**Dry-run first** — the send path has a rehearsal that runs the whole ceremony and stops *before* broadcast, with no funds moved.' },
          { 'pt-BR': '**A cerimônia leva 30–60s** — o `frostd` sobe na hora e é encerrado ao fim; deixe concluir.', en: '**The ceremony takes 30–60s** — `frostd` starts fresh and is killed on drop; let it finish.' },
        ],
      },
    ],
  },
  {
    id: 'multi-device',
    nav: { 'pt-BR': 'Multi-dispositivo', en: 'Multi-device' },
    title: { 'pt-BR': 'FROST multi-dispositivo no navegador', en: 'Multi-device FROST in the browser' },
    lead: {
      'pt-BR': 'A resposta para "dá pra usar no meu celular?": a pilha de limiar inteira roda no navegador, ao vivo pela internet, sem servidor algum ver um segredo.',
      en: 'The answer to "can I just use it on my phone?": the whole threshold stack runs in the browser, live over the internet, with no server ever seeing a secret.',
    },
    blocks: [
      {
        k: 'note',
        t: {
          'pt-BR': '**Experimente ao vivo:** a [rede multi-dispositivo](#/net) em duas abas, a [assinatura FROST no navegador](#/signer), a [recuperação social](#/recovery), a [herança](#/inheritance), e [confira nossos txids na mainnet](#/proof).',
          en: '**Try it live:** the [multi-device network](#/net) in two tabs, the [browser FROST signer](#/signer), [social recovery](#/recovery), [inheritance](#/inheritance), and [verify our mainnet txids](#/proof).',
        },
      },
      {
        k: 'p',
        t: {
          'pt-BR':
            'O crate `konclave-wasm` compila FROST rerandomized-redpallas (Orchard) para WebAssembly. Duas abas de navegador **criam um cofre por DKG real** e depois **assinam juntas** uma transação real, cada uma guardando só o próprio share, através de um **relay cego hospedado** (`relay-server`, na Railway) que carrega apenas material público ou já criptografado. Limite honesto: até agora foram **duas abas numa máquina só** — o broadcast entre **dispositivos separados** é o marco em aberto.',
          en:
            'The `konclave-wasm` crate compiles rerandomized-redpallas (Orchard) FROST to WebAssembly. Two browser tabs **create one vault by a real DKG** and then **sign a real transaction together**, each keeping only its own share, through a **hosted blind relay** (`relay-server`, on Railway) that carries only public or already-encrypted bytes. Honest limit: so far this has been **two tabs on one machine** — a broadcast across **separate devices** is the open milestone.',
        },
      },
      {
        k: 'p',
        t: {
          'pt-BR':
            'O único pedaço secreto do DKG (os pacotes da rodada 2) é **lacrado ponta a ponta** (X25519, HKDF-SHA256, XChaCha20-Poly1305), então o relay permanece cego. Abra o `/#/net` em duas abas: uma cria o cofre e mostra um código de convite, a outra entra, e juntas rodam um DKG real e assinam como quórum.',
          en:
            'The one secret piece of the DKG (the round-2 packages) is **sealed end-to-end** (X25519, HKDF-SHA256, XChaCha20-Poly1305), so the relay stays blind. Open `/#/net` in two tabs: one creates the vault and shows an invite code, the other joins, and together they run a real DKG and sign as a quorum.',
        },
      },
      { k: 'h', t: { 'pt-BR': 'Recuperação e herança', en: 'Recovery and inheritance' } },
      {
        k: 'ul',
        items: [
          {
            'pt-BR': '**Recuperação social:** quando um membro perde o dispositivo, um **quórum reconstrói o share** dele (Repairable Threshold Scheme). A chave de grupo nunca é tocada, nenhum share é revelado, e o share reparado é idêntico byte a byte ao perdido.',
            en: '**Social recovery:** when a member loses their device, a **quorum rebuilds that member’s share** (the Repairable Threshold Scheme). The group key is never touched, no share is revealed, and the repaired share is byte-identical to the lost one.',
          },
          {
            'pt-BR': '**Herança / dead-man’s-switch:** o dono envia provas de vida assinadas; se elas cessam além de uma janela (mais um período de graça cancelável), o quórum fica autorizado a **liberar** o cofre para um herdeiro nomeado. A liberação é um pagamento comum assinado por quórum.',
            en: '**Inheritance / dead-man’s-switch:** the owner sends signed proof-of-life heartbeats; if they lapse past a window (plus a cancellable grace period), the quorum is authorized to **release** the vault to a named heir. The release is an ordinary quorum-signed payment.',
          },
        ],
      },
      {
        k: 'note',
        t: {
          'pt-BR': 'Dois caminhos, não confundir. O **`/net`** assina a PCZT real do **próprio cofre** (sob o alpha da transação) e **foi transmitido na mainnet** — txid `3022420a…`, porém com **duas abas numa máquina só**; o broadcast entre **dispositivos separados** é o marco em aberto, e o **multi-nota ao vivo** ainda é só testado em unidade. O **`/signer`** é uma **demonstração**: assina o sighash real de uma tx de exemplo (`aab00f90…`) para mostrar a mecânica, mas essa PCZT é de outro cofre, então **não é transmitível**.',
          en: 'Two paths, not to be conflated. **`/net`** signs the real PCZT of the **vault’s own** address (under the transaction’s alpha) and **was broadcast on mainnet** — txid `3022420a…`, but with **two tabs on one machine**; a broadcast across **separate devices** is the open milestone, and **live multi-note** is still only unit-tested. **`/signer`** is a **demo**: it signs the real sighash of a sample tx (`aab00f90…`) to show the mechanics, but that PCZT belongs to another vault, so it is **not broadcastable**.',
        },
      },
      { k: 'img', src: 'diagrams/multi-device.svg', alt: { 'pt-BR': 'Fluxo multi-dispositivo pelo relay cego: DKG e assinatura entre abas', en: 'Multi-device flow over the blind relay: DKG and signing across tabs' } },
    ],
  },
  {
    id: 'security',
    nav: { 'pt-BR': 'Segurança e confiança', en: 'Security and trust' },
    title: { 'pt-BR': 'Modelo de confiança e limites honestos', en: 'Trust model and honest limits' },
    lead: {
      'pt-BR': 'Distinguimos **o que a criptografia garante** do **que o produto impõe**, e não prometemos o que não entregamos.',
      en: 'We distinguish **what the cryptography guarantees** from **what the product enforces**, and we do not promise what we do not deliver.',
    },
    blocks: [
      {
        k: 'ul',
        items: [
          {
            'pt-BR': '**Garantido pelo protocolo:** a chave nunca é reconstituída; uma assinatura de quórum é obrigatória para gastar; o servidor de coordenação (`frostd` e o relay cego) é **cego**, só material público o atravessa; seu share nunca deixa seu dispositivo.',
            en: '**Guaranteed by the protocol:** the key is never reconstituted; a quorum signature is required to spend; the coordination server (`frostd`, and the blind relay) is **blind**, only public material crosses it; your share never leaves your device.',
          },
          {
            'pt-BR': '**Imposto pelo produto (não pela cadeia):** quórum por valor, reserva de saldo e expiração de proposta são política da aplicação, não regras impostas on-chain. Dizemos isso claramente.',
            en: '**Enforced by the product (not the chain):** quorum-by-value, balance reservation, and proposal expiry are application policy, not on-chain-enforced rules. We say so plainly.',
          },
          {
            'pt-BR': '**Postura de segurança:** shares são lacrados em repouso (XChaCha20-Poly1305, chave derivada por Argon2id, guardada no keychain do SO) e abertos só em arquivos `0600` efêmeros em tmpfs durante a assinatura; o bridge local é protegido contra CSRF/DNS-rebinding; material secreto é zerado na memória; destinos são validados por um decode autoritativo de `zcash_address` antes de qualquer envio.',
            en: '**Security posture:** shares are sealed at rest (XChaCha20-Poly1305, Argon2id-derived key, held in the OS keychain) and unsealed only to ephemeral `0600` files in tmpfs during signing; the local bridge is guarded against CSRF/DNS-rebinding; secret material is zeroized in memory; destinations are validated with an authoritative `zcash_address` decode before any send.',
          },
        ],
      },
      { k: 'h', t: { 'pt-BR': 'Provado vs pendente', en: 'Proven vs pending' } },
      {
        k: 'ul',
        items: [
          {
            'pt-BR': '**Na mainnet, 8 txids verificáveis** (`node scripts/verify-proof.mjs` ou a tela /proof): um pagamento por quórum 2-de-3 (proposto/aprovado no app, assinado por FROST, shares lacrados em repouso); uma folha privada (uma tx Orchard blindada com 3 saídas, cada uma com memo criptografado, 2-de-3 FROST); um pagamento reproduzido ponta a ponta de um cofre criado e financiado do zero; um **envio a partir de um cofre gerado por DKG real** (cerimônia DKG de 3 participantes, chave nunca reconstituída), financiado e gasto por FROST; no dia da ativação do NU6.3/Ironwood, uma **migração Orchard→Ironwood** mais o **primeiro gasto DO pool Ironwood** (ambas V6/NU6.3, 2-de-3 FROST); e o **primeiro broadcast assinado NO NAVEGADOR** — um cofre 2-de-2 nascido de DKG no navegador, cada dispositivo assinando com só o seu share pelo relay cego (Arquitetura B), e transmitido. Nota honesta: o pagamento por quórum, a folha e o cofre-novo usaram trusted-dealer; o envio do cofre DKG e o broadcast assinado-no-navegador vieram de chaves nascidas por DKG real.',
            en: '**On mainnet, 8 verifiable txids** (`node scripts/verify-proof.mjs` or the /proof page): a 2-of-3 quorum payment (proposed/approved in the app, FROST-signed, shares sealed at rest); a private payroll (one shielded Orchard tx with 3 outputs, each with an encrypted memo, 2-of-3 FROST); a payment reproduced end to end from a freshly created and funded vault; a **send from a real DKG-generated vault** (three-participant DKG ceremony, key never reconstituted), funded and spent by FROST; on NU6.3/Ironwood activation day, an **Orchard→Ironwood migration** plus the **first spend FROM the Ironwood pool** (both V6/NU6.3, 2-of-3 FROST); and the **first browser-signed broadcast** — a browser-DKG 2-of-2 vault, each device signing IN THE BROWSER with only its own share over the blind relay (Architecture B), then broadcast. Honest note: the quorum payment, payroll, and fresh vault used trusted-dealer; the DKG-vault send and the browser-signed broadcast came from keys born by real DKG.',
          },
          {
            'pt-BR': '**Por dry-run** (assina, ainda não transmite): o caminho de assinatura totalmente lacrado (configs abertos só em tmpfs).',
            en: '**By dry-run** (it signs, it does not yet broadcast): the fully-sealed signing path (configs unsealed only to tmpfs).',
          },
          {
            'pt-BR': '**No navegador, ao vivo:** DKG multi-dispositivo e assinatura FROST por um relay cego hospedado, sobre um **sighash Orchard real** **sob o alpha da própria transação** (o mecanismo Orchard correto, `ak+alpha`), com verificação `describeOutputs` em cada dispositivo. Falta uma PCZT para o endereço deste cofre e o broadcast.',
            en: '**In the browser, live:** multi-device DKG and FROST signing over a hosted blind relay, over a **real Orchard sighash** **under the transaction’s own alpha** (the correct Orchard mechanism, `ak+alpha`), with per-device `describeOutputs` verification. A PCZT for this vault’s address and the broadcast still remain.',
          },
          {
            'pt-BR': '**Provado por teste:** recuperação social (reparo de share RTS) e o motor de política de herança.',
            en: '**Proven by test:** social recovery (RTS share repair) and the inheritance policy engine.',
          },
          {
            'pt-BR': '**Roadmap, não entregue:** o **broadcast** de uma transação real a partir do navegador (a assinatura de um sighash Orchard real já funciona; falta financiar o cofre + operador criar/provar a PCZT), persistência completa do share no dispositivo (restaura; assinar-após-restore pendente), e o binário desktop único instalável (Tauri).',
            en: '**Roadmap, not shipped:** the **broadcast** of a real transaction from the browser (signing a real Orchard sighash already works; it needs the vault funded + the operator to create/prove the PCZT), full on-device share persistence (restore works; signing-after-restore pending), and the single installable desktop binary (Tauri).',
          },
        ],
      },
      { k: 'img', src: 'diagrams/trust-boundary.svg', alt: { 'pt-BR': 'Fronteira de confiança: o que nunca sai do dispositivo, o que o relay vê, o que a rede vê', en: 'Trust boundary: what never leaves the device, what the relay sees, what the chain sees' } },
    ],
  },
  {
    id: 'run-it',
    nav: { 'pt-BR': 'Rodar localmente', en: 'Run it' },
    title: { 'pt-BR': 'Rodar localmente', en: 'Run it locally' },
    lead: {
      'pt-BR': 'Sem engine, sem fundos, sem setup: um passo a passo de console de cada caso de uso contra o backend real (em processo, sem servidor).',
      en: 'No engine, no funds, no setup: a console walkthrough of every use case against the real backend (in-process, no server).',
    },
    blocks: [
      { k: 'code', t: 'cargo run --manifest-path orchestrator/Cargo.toml --example simulate' },
      {
        k: 'p',
        t: {
          'pt-BR': 'Ele imprime o fluxo inteiro: o cofre, a segurança autoritativa de endereço, propor e aprovar até o quórum, uma recusa, uma folha privada (N beneficiários) e o razão/CSV itemizado.',
          en: 'It prints the whole flow: the vault, authoritative address safety, propose and approve to quorum, a refusal, a private payroll (N beneficiaries), and the itemized ledger/CSV.',
        },
      },
      { k: 'h', t: { 'pt-BR': 'O app completo', en: 'The full app' } },
      {
        k: 'p',
        t: {
          'pt-BR': 'Rode o app no navegador por um bridge local (saldo/assinatura ao vivo exigem os binários do engine da Zcash Foundation, compilados conforme `engine/versions.lock`):',
          en: 'Run the app in the browser via a local bridge (live balance/signing needs the Zcash Foundation engine binaries built per `engine/versions.lock`):',
        },
      },
      {
        k: 'code',
        t: 'npm --prefix ui ci && npm --prefix ui run build\ncargo run --manifest-path orchestrator/Cargo.toml --bin konclave -- serve --web ui/dist --demo\n# then open the printed http://127.0.0.1:4762',
      },
      {
        k: 'note',
        t: {
          'pt-BR': 'A rede multi-dispositivo (duas abas fazem um cofre e assinam) roda contra o servidor local em `http://127.0.0.1:4762/#/net`, ou ao vivo no demo hospedado.',
          en: 'The multi-device network (two tabs make one vault, then sign) works against the local server at `http://127.0.0.1:4762/#/net`, or live at the hosted demo.',
        },
      },
    ],
  },
  {
    id: 'sdk',
    nav: { 'pt-BR': 'SDK', en: 'SDK' },
    title: { 'pt-BR': 'SDK: @konclave/frost', en: 'SDK: @konclave/frost' },
    lead: {
      'pt-BR':
        'A mesma engine WASM que roda no `/net` do Konclave, empacotada como uma primitiva reutilizável de navegador para FROST na Zcash Orchard, com o share secreto **nunca saindo do dispositivo**.',
      en:
        'The same WASM engine that powers Konclave’s `/net`, packaged as a reusable browser primitive for FROST on Zcash Orchard, with the secret share **never leaving the device**.',
    },
    blocks: [
      { k: 'h', t: { 'pt-BR': 'O que é', en: 'What it is' } },
      {
        k: 'p',
        t: {
          'pt-BR':
            '`@konclave/frost` (pasta `sdk/`) é um wrapper fino e tipado sobre o núcleo `konclave-wasm`. Ele expõe as quatro operações que o Konclave usa por dentro, para você montar seu próprio produto de custódia compartilhada sem reimplementar criptografia: **DKG real** (geração distribuída de chave), **assinatura de grupo** (FROST redpallas rerandomizado, compatível com Orchard), **selagem ECIES** (X25519 → HKDF-SHA256 → XChaCha20-Poly1305 para os pacotes secretos da rodada 2 do DKG) e **recuperação social RTS** (Repairable Threshold Scheme).',
          en:
            '`@konclave/frost` (the `sdk/` folder) is a thin, typed wrapper over the `konclave-wasm` core. It exposes the four operations Konclave uses internally, so you can build your own shared-custody product without reimplementing cryptography: **real DKG** (distributed key generation), **group signing** (rerandomized FROST redpallas, Orchard-compatible), **ECIES sealing** (X25519 → HKDF-SHA256 → XChaCha20-Poly1305 for the DKG round-2 secret packages), and **RTS social recovery** (Repairable Threshold Scheme).',
        },
      },
      { k: 'h', t: { 'pt-BR': 'Instalação', en: 'Install' } },
      {
        k: 'p',
        t: {
          'pt-BR': 'O binário `.wasm` (grande) **não** é embutido no pacote. Instale o núcleo `konclave-wasm` ao lado e aponte o `init()` para a URL do `.wasm`:',
          en: 'The large `.wasm` binary is **not** bundled in the package. Install the `konclave-wasm` core alongside it and point `init()` at the `.wasm` URL:',
        },
      },
      { k: 'code', t: 'npm install @konclave/frost konclave-wasm' },
      {
        k: 'code',
        t:
          "import { init, DkgSession } from '@konclave/frost'\n\n// Point at the wasm artifact you serve (from konclave-wasm / ui/src/wasm-pkg).\nawait init(new URL('konclave_wasm_bg.wasm', import.meta.url))\n\n// Drive a t-of-n DKG over any transport; the secret share stays in WASM,\n// it never crosses into JS. Move only the public/sealed bytes over your relay.\nconst session = new DkgSession(/* threshold */ 2, /* participants */ 3, myTag)",
      },
      {
        k: 'note',
        t: {
          'pt-BR':
            'Limite honesto: o SDK é a **camada de assinatura**, não um construtor de transações Zcash. Ele produz uma assinatura de grupo FROST que verifica; ligar isso a uma transação Orchard transmitida ainda exige a ponte PCZT (`konclave-signer`) do lado nativo. Licença Apache-2.0 / MIT.',
          en:
            'Honest limit: the SDK is the **signing layer**, not a Zcash transaction builder. It produces a verifying FROST group signature; wiring that to a broadcast Orchard transaction still needs the native-side PCZT bridge (`konclave-signer`). Licensed Apache-2.0 / MIT.',
        },
      },
    ],
  },
  {
    id: 'mcp',
    nav: { 'pt-BR': 'MCP', en: 'MCP' },
    title: { 'pt-BR': 'Servidor MCP: um tesoureiro de IA', en: 'MCP server: an AI treasurer' },
    lead: {
      'pt-BR':
        'Um servidor Model Context Protocol que deixa um agente de IA **ler o cofre e propor** pagamentos, mas **nunca assinar nem enviar**. À prova de agente único: mesmo uma IA não move fundos sozinha.',
      en:
        'A Model Context Protocol server that lets an AI agent **read the vault and propose** payments, but **never sign or send**. Single-agent-proof: even an AI cannot move funds alone.',
    },
    blocks: [
      { k: 'h', t: { 'pt-BR': 'A ideia', en: 'The idea' } },
      {
        k: 'p',
        t: {
          'pt-BR':
            'A pasta `mcp-server/` expõe o cofre a um assistente de IA (Claude e outros clientes MCP) pela API do bridge local. A escolha de design é o ponto todo: as ferramentas de **leitura** (saldo, propostas, razão, membros) e de **proposta** existem; as ferramentas de **assinar** e **transmitir** foram deixadas de fora **de propósito**.',
          en:
            'The `mcp-server/` folder exposes the vault to an AI assistant (Claude and other MCP clients) via the local bridge API. The design choice is the whole point: **read** tools (balance, proposals, ledger, members) and a **propose** tool exist; the **sign** and **broadcast** tools were deliberately left out.',
        },
      },
      { k: 'h', t: { 'pt-BR': 'Por que isso importa', en: 'Why it matters' } },
      {
        k: 'p',
        t: {
          'pt-BR':
            'O mesmo princípio que protege o cofre de uma pessoa comprometida protege-o de um agente comprometido. Um assistente pode redigir a folha do mês e propô-la; a autoridade de gasto continua sendo **o quórum de humanos aprovando com seus próprios shares**. A IA participa da parte trabalhosa (contas, rascunhos) sem jamais tocar na autoridade que move dinheiro.',
          en:
            'The same principle that protects the vault from a compromised person protects it from a compromised agent. An assistant can draft the month’s payroll and propose it; the spend authority remains **the human quorum approving with their own shares**. The AI does the tedious part (accounting, drafts) without ever touching the money-moving authority.',
        },
      },
      {
        k: 'code',
        t:
          'tools exposed:   get_balance · list_proposals · get_ledger · list_members · propose_payment\ntools withheld:  (none for sign) · (none for send)   <-  by design',
      },
      {
        k: 'note',
        t: {
          'pt-BR': 'Aponte seu cliente MCP para o `mcp-server/` com a URL do bridge local (`konclave serve`) rodando. É um leitor + propositor, nunca um signatário.',
          en: 'Point your MCP client at `mcp-server/` with the local bridge (`konclave serve`) running. It is a reader + proposer, never a signer.',
        },
      },
    ],
  },
]
