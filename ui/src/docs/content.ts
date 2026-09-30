// Bilingual content for the in-app documentation site (/docs). Kept as a local module,
// keyed by locale, so the docs respect the language toggle without inflating the global
// i18n dictionary. Content is drawn from the cleaned public docs (README, ARCHITECTURE,
// SUBMISSION) and stays honest about what is proven vs pending.

import { PROOF_TXS, proofOriginCounts } from '../proof-record'

export type Locale = 'pt-BR' | 'en'
type L = { 'pt-BR': string; en: string }

// How many mainnet transactions the record holds, and how many came from each kind of vault.
// Read from the list the /proof screen renders, which a test holds to docs/PROOF.md. These docs
// stated the count in words of their own, and it stayed at eight while the record grew to
// nineteen. So the number is no longer written here: it is counted.
const PROOF_COUNT = PROOF_TXS.length
const PROOF_ORIGINS = proofOriginCounts()

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
            'O Konclave divide a autoridade de gasto blindado de um cofre em **`t`-de-`n` shares FROST** entre os membros, por **Geração Distribuída de Chave (DKG)** real. A chave inteira **nunca é reconstituída**, nem na criação nem na assinatura, e cada share **nunca deixa o dispositivo do dono**. Sobre isso vem a camada humana: propor, aprovar até o quórum, assinar, transmitir e prestar contas, em linguagem simples e com confirmação explícita antes de qualquer movimento.',
          en:
            'Konclave splits a vault’s shielded spend authority into **`t`-of-`n` FROST shares** across the members by real **Distributed Key Generation (DKG)**. The whole key is **never reconstituted**, at creation or at signing, and each share **never leaves its owner’s device**. On top of that comes the human layer: propose, approve to a quorum, sign, broadcast, and account, in plain language with an explicit confirmation before anything moves.',
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
            'Não é maquete. Um **pagamento por quórum 2-de-3**, proposto e aprovado no app, assinado por uma cerimônia FROST real e transmitido para a **mainnet da Zcash**. O cofre dele foi dividido por um trusted dealer, como os primeiros foram: a chave existiu inteira na criação. Os cofres que o app cria hoje nascem por DKG, e neles a chave nunca existe inteira. A transação:',
          en:
            'This is not a mock. A **2-of-3 quorum payment**, proposed and approved in the app, signed by a real FROST ceremony, and broadcast to **Zcash mainnet**. Its vault was split by a trusted dealer, as the first ones were: the whole key existed at creation. The vaults the app creates today are born by DKG, and in those the key is never whole. The transaction:',
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
        'Tudo pra experimentar, num lugar só - o produto rodando, a prova na blockchain, o cofre entre dispositivos e o laboratório da criptografia.',
      en:
        'Everything to try, in one place - the product running, the on-chain proof, the cross-device vault, and the cryptography lab.',
    },
    blocks: [
      {
        k: 'ul',
        items: [
          {
            'pt-BR': '[Abrir o cofre](#/vaults) - o produto rodando: pagamento, folha, aprovações e registro.',
            en: '[Open the vault](#/vaults) - the product running: payment, payroll, approvals and ledger.',
          },
          {
            'pt-BR': '[Comprovação na blockchain](#/proof) - confira você mesmo, no explorador público, as transações reais do Konclave na mainnet.',
            en: '[Proof on the blockchain](#/proof) - check for yourself, on the public explorer, Konclave’s real mainnet transactions.',
          },
          {
            'pt-BR': '[Seus cofres](#/vaults) - crie um cofre com outras pessoas, ou entre por convite, no celular ou no computador. Nenhum servidor guarda o seu pedaço da chave.',
            en: '[Your vaults](#/vaults) - create a vault with other people, or join one by invite, from a phone or a computer. No server ever holds your part of the key.',
          },
          {
            'pt-BR': '[Laboratório](#/lab) - veja a criptografia acontecer: assinatura no navegador, e demonstrações de recuperação e herança num cofre descartável.',
            en: '[Laboratory](#/lab) - watch the cryptography happen: browser signing, plus demos of recovery and inheritance on a throwaway vault.',
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
          'propose  ->  approve (quorum M-of-N, with expiry)  ->  sign (FROST,\nonly the shares of whoever approved)  ->  broadcast (shielded)  ->  ledger\n                       the key is never reassembled',
      },
      {
        k: 'ul',
        items: [
          {
            'pt-BR': '**Pagamento por quórum:** proponha um pagamento, os membros aprovam e, no quórum, o cofre assina (FROST) e envia uma transação blindada (o pool Ironwood, desde o NU6.3). Um clique nunca move dinheiro.',
            en: '**Quorum payment:** propose a payment, members approve, and at quorum the vault signs (FROST) and sends a shielded transaction (the Ironwood pool, since NU6.3). One click never moves money.',
          },
          {
            'pt-BR': '**Folha privada:** digite os beneficiários na tabela, ou escolha da sua lista salva, numa única transação blindada com N saídas, aprovada **uma vez** (importar CSV por enquanto só funciona na versão local). Cada contracheque viaja num **memo cifrado**: quem está de fora e a blockchain não leem; o destinatário, os membros do cofre e o coordenador que monta o pagamento leem.',
            en: '**Private payroll:** type the beneficiaries in the table, or pick them from your saved list, into one shielded transaction with N outputs, approved **once** (importing a CSV works only in the local build for now). Each payslip rides in an **encrypted memo**: outsiders and the blockchain cannot read it; the recipient, the vault’s members and the coordinator that builds the payment can.',
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
            'pt-BR': '**1. Crie ou entre num cofre** (Seus cofres → Criar cofre, ou Entrar por convite). Escolha quantos membros e quantos precisam aprovar (2 de 3 por padrão). O aparelho de cada membro gera o seu pedaço da chave; a chave inteira nunca existe em lugar nenhum.',
            en: '**1. Create or join a vault** (Your vaults → Create a vault, or Join by invite). Pick how many members and how many must approve (2 of 3 by default). Each member’s device makes its own part of the key; the whole key never exists anywhere.',
          },
          {
            'pt-BR': '**2. Financie o cofre** (`/receive`). Compartilhe o **endereço blindado** do cofre (u1…, com QR e link de cobrança ZIP-321) e receba ZEC.',
            en: "**2. Fund it** (`/receive`). Share the vault's **shielded address** (u1…, with a QR and a ZIP-321 payment link) and receive ZEC.",
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
            'pt-BR': '**5. Assine e envie.** No quórum, uma cerimônia FROST assina com **apenas as partes de quem aprovou** e transmite uma única transação blindada (o pool Ironwood, desde o NU6.3). Um preview e uma confirmação explícita protegem o envio: um clique nunca move dinheiro, e a chave nunca é remontada.',
            en: '**5. Sign and send.** At quorum a FROST ceremony signs with **only the shares of whoever approved** and broadcasts one shielded transaction (the Ironwood pool, since NU6.3). A preview and an explicit confirmation guard the broadcast: one click never moves money, and the key is never reassembled.',
          },
          {
            'pt-BR': '**6. Folha de pagamento, opcional** (Folha). Digite os beneficiários na tabela, ou escolha da sua lista salva, numa única transação blindada com N saídas, aprovada **uma vez**. Importar CSV por enquanto só funciona na versão local. Cada contracheque vai num memo cifrado, que o destinatário, os membros do cofre e o coordenador leem, e ninguém de fora lê.',
            en: '**6. Payroll, optional** (Payroll). Type the beneficiaries in the table, or pick them from your saved list, into one shielded transaction with N outputs, approved **once**. Importing a CSV works only in the local build for now. Each payslip goes in an encrypted memo that the recipient, the vault’s members and the coordinator can read, and no outsider can.',
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
          'pt-BR': 'Não há dados de exemplo: para experimentar o fluxo, crie um cofre de verdade (na web ou localmente, veja **Rodar localmente**).',
          en: 'There is no sample data: to try the flow, create a real vault (on the web or locally, see **Run it locally**).',
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
          { 'pt-BR': '**Criar um cofre** (Seus cofres → Criar cofre) - membros + quórum; a chave nasce por DKG, nunca inteira.', en: '**Create a vault** (Your vaults → Create a vault) - members + quorum; the key is born by DKG, never whole.' },
          { 'pt-BR': '**Receber** (`/receive`) - endereço blindado (u1…) + QR + link ZIP-321; receber não precisa de chave.', en: '**Receive** (`/receive`) - shielded address (u1…) + QR + a ZIP-321 link; receiving needs no key.' },
          { 'pt-BR': '**Propor pagamento** (`/pay`) - valor + destino; endereço e saldo validados antes de criar.', en: '**Propose a payment** (`/pay`) - amount + recipient; address and balance validated up front.' },
          { 'pt-BR': '**Aprovar/recusar** (`/proposals`) - quórum real; nada move sem as aprovações, e as propostas expiram. A aprovação vincula a parte que assina.', en: '**Approve/refuse** (`/proposals`) - real quorum; nothing moves without the approvals, and proposals expire. Approval binds the signing share.' },
          { 'pt-BR': '**Assinar e enviar** - cerimônia FROST com as partes de quem aprovou; preview + confirmação; a chave nunca é remontada.', en: "**Sign & send** - a FROST ceremony with the approvers' shares; preview + confirm; the key is never reassembled." },
          { 'pt-BR': '**Folha privada** (`/payroll`) - N beneficiários numa única transação blindada, aprovada uma vez, cada holerite num memo cifrado (CSV só na versão local).', en: '**Private payroll** (`/payroll`) - N beneficiaries in one shielded transaction, approved once, each payslip in an encrypted memo (CSV import in the local build only).' },
          { 'pt-BR': '**Razão/contas** (`/ledger`) - livro interno completo + exportação CSV itemizada (folha de N vira N linhas).', en: '**Ledger/accounting** (`/ledger`) - a full internal book + itemized CSV export (payroll of N becomes N rows).' },
        ],
      },
      { k: 'h', t: { 'pt-BR': 'Além do básico', en: 'Beyond the basics' } },
      {
        k: 'ul',
        items: [
          { 'pt-BR': '**Cofre entre dispositivos** (Seus cofres) - criar e assinar com o celular e o computador por um relay cego; nenhum servidor guarda o seu pedaço da chave.', en: '**Vault across devices** (Your vaults) - create and sign with phone and computer over a blind relay; no server holds your part of the key.' },
          { 'pt-BR': '**Recuperação de membro, só demonstração** (`/recovery`) - mostra como um quórum poderia reconstruir o pedaço da chave de quem perdeu o aparelho, num cofre descartável criado no seu navegador. Ainda não dá para rodar no seu cofre (#58).', en: "**Member recovery, demo only** (`/recovery`) - shows how a quorum could rebuild a lost member's part of the key, on a throwaway vault made in your browser. It cannot be run on your own vault yet (#58)." },
          { 'pt-BR': '**Herança, só demonstração** (`/inheritance`) - uma simulação da regra que liberaria um cofre para um herdeiro. Não está ligada a cofres reais (#58).', en: '**Inheritance, demo only** (`/inheritance`) - a simulation of the rule that would release a vault to an heir. Not connected to real vaults (#58).' },
          { 'pt-BR': '**Assinar no navegador** (`/signer`) - uma cerimônia FROST 2-de-3 inteira em WebAssembly.', en: '**Sign in the browser** (`/signer`) - a full 2-of-3 FROST ceremony entirely in WebAssembly.' },
          { 'pt-BR': '**Membros** (`/members`) e **beneficiários** (`/people`) - quem assina e quem recebe.', en: '**Members** (`/members`) and **beneficiaries** (`/people`) - who signs and who gets paid.' },
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
      { k: 'p', t: { 'pt-BR': '9 estados, cada transição guardada. `Superseded` (invalidada) é o único que não vem dos métodos da proposta - é aplicado pela reconciliação quando a cadeia não pode mais financiar a reserva.', en: "9 states, every transition guarded. `Superseded` is the only one not reachable from the proposal's own methods - reconciliation applies it when the chain can no longer fund the reservation." } },
      { k: 'h', t: { 'pt-BR': 'Processos-chave', en: 'Key processes' } },
      {
        k: 'ul',
        items: [
          { 'pt-BR': '**Bridge FROST↔PCZT** - o FROST assina um *sighash*; o gasto vive numa *PCZT*. O `konclave-signer` extrai o sighash + randomizers e injeta as assinaturas de volta, verificando cada uma.', en: '**FROST↔PCZT bridge** - FROST signs a *sighash*; the spend lives in a *PCZT*. `konclave-signer` extracts the sighash + randomizers and injects the signatures back, verifying each.' },
          { 'pt-BR': '**Custódia selada (app de mesa e versão local)** - a parte nunca fica em claro no disco: selada com XChaCha20-Poly1305, aberta só num arquivo 0600 efêmero em tmpfs durante a cerimônia. No navegador ela fica cifrada com AES-256-GCM sob a sua frase-senha e só é decifrada na memória.', en: '**Sealed custody (desktop and local build)** - a share never sits in the clear on disk: sealed with XChaCha20-Poly1305, unsealed only into an ephemeral 0600 tmpfs file during the ceremony. In the browser it is stored encrypted with AES-256-GCM under your passphrase and decrypted only in memory.' },
          { 'pt-BR': '**Relay cego** - carrega só bytes opacos (pacotes públicos de DKG ou já cifrados); não consegue ler o que transporta.', en: '**Blind relay** - carries only opaque bytes (public DKG packages or already-encrypted ones); it cannot read what it carries.' },
          { 'pt-BR': '**Reconciliação** - motor puro "a cadeia manda": promove Enviada para Confirmada pelos txids minerados e invalida reservas que a cadeia não financia mais.', en: '**Reconciliation** - a pure "on-chain wins" engine: promotes Sent to Confirmed by mined txids and invalidates reservations the chain can no longer fund.' },
        ],
      },
      { k: 'h', t: { 'pt-BR': 'Dicas', en: 'Tips' } },
      {
        k: 'ul',
        items: [
          { 'pt-BR': '**Sapling ≠ Orchard** - um destino só-Sapling pode travar fundos; o app decodifica o endereço e bloqueia com um aviso claro.', en: '**Sapling ≠ Orchard** - a Sapling-only destination can lock funds; the app decodes the address and blocks it with a clear warning.' },
          { 'pt-BR': '**Memo só vai para destino blindado** - destinos transparentes (públicos) não levam memo, e o pagamento é marcado como público na cadeia.', en: '**Memos need a shielded destination** - transparent (public) destinations carry no memo, and the payment is flagged public on-chain.' },
          { 'pt-BR': '**Faça o dry-run (só na versão local)** - o envio local tem um ensaio que roda a cerimônia inteira e para *antes* de transmitir. O app web não tem ensaio: a proteção dele é o preview, a confirmação explícita e cada aparelho conferindo o pagamento antes de assinar.', en: '**Dry-run first (local build only)** - the local send path has a rehearsal that runs the whole ceremony and stops *before* broadcast. The web app has no rehearsal: its safeguard is the preview, the explicit confirmation, and each device checking the payment before it signs.' },
          { 'pt-BR': '**Assinar leva segundos quando os signatários estão on-line** - no web cada signatário abre o pagamento e toca em "Assinar este pagamento"; na versão local o `frostd` sobe na hora e a cerimônia leva de 30 a 60 s.', en: '**Signing takes seconds once the signers are online** - on the web each signer opens the payment and presses "Sign this payment"; in the local build `frostd` starts fresh and the ceremony takes 30-60s.' },
        ],
      },
    ],
  },
  {
    id: 'multi-device',
    nav: { 'pt-BR': 'Multi-dispositivo', en: 'Multi-device' },
    title: { 'pt-BR': 'FROST multi-dispositivo no navegador', en: 'Multi-device FROST in the browser' },
    lead: {
      'pt-BR': 'A resposta para "dá pra usar no meu celular?": a pilha de limiar inteira roda no navegador, ao vivo pela internet, sem servidor algum guardar o pedaço da chave de ninguém.',
      en: 'The answer to "can I just use it on my phone?": the whole threshold stack runs in the browser, live over the internet, with no server ever holding anyone’s part of the key.',
    },
    blocks: [
      {
        k: 'note',
        t: {
          'pt-BR': '**Experimente ao vivo:** [crie um cofre](#/vaults) e entre nele de um segundo aparelho, a [assinatura FROST no navegador](#/signer), as demonstrações de [recuperação social](#/recovery) e de [herança](#/inheritance) num cofre descartável, e [confira nossos txids na mainnet](#/proof).',
          en: '**Try it live:** [create a vault](#/vaults) and join it from a second device, the [browser FROST signer](#/signer), the [social recovery](#/recovery) and [inheritance](#/inheritance) demos on a throwaway vault, and [verify our mainnet txids](#/proof).',
        },
      },
      {
        k: 'p',
        t: {
          'pt-BR':
            'O crate `konclave-wasm` compila FROST rerandomized-redpallas (Orchard) para WebAssembly. Duas abas de navegador **criam um cofre por DKG real** e depois **assinam juntas** uma transação real, cada uma guardando só o próprio share, através de um **relay cego hospedado** (`relay-server`, na Railway) que carrega apenas material público ou já criptografado. Foi provado primeiro com duas abas numa máquina, depois entre máquinas físicas separadas pela internet e a partir de um celular (veja [/proof](#/proof)).',
          en:
            'The `konclave-wasm` crate compiles rerandomized-redpallas (Orchard) FROST to WebAssembly. Two browser tabs **create one vault by a real DKG** and then **sign a real transaction together**, each keeping only its own share, through a **hosted blind relay** (`relay-server`, on Railway) that carries only public or already-encrypted bytes. It was first proven with two tabs on one machine, then across separate physical machines over the internet and from a phone (see [/proof](#/proof)).',
        },
      },
      {
        k: 'p',
        t: {
          'pt-BR':
            'O único pedaço secreto do DKG (os pacotes da rodada 2) é **lacrado ponta a ponta** (X25519, HKDF-SHA256, XChaCha20-Poly1305), então o relay permanece cego. Em [Seus cofres](#/vaults), um aparelho cria o cofre e mostra um código de convite, o outro entra com ele, e juntos rodam um DKG real e depois assinam como quórum.',
          en:
            'The one secret piece of the DKG (the round-2 packages) is **sealed end-to-end** (X25519, HKDF-SHA256, XChaCha20-Poly1305), so the relay stays blind. In [Your vaults](#/vaults), one device creates the vault and shows an invite code, the other joins with it, and together they run a real DKG and then sign as a quorum.',
        },
      },
      { k: 'h', t: { 'pt-BR': 'Recuperação e herança: o que é provado, o que não está ligado', en: 'Recovery and inheritance: what is proven, what is not wired' } },
      {
        k: 'ul',
        items: [
          {
            'pt-BR': '**Recuperação social, ainda fora do produto:** a criptografia que deixa um quórum reconstruir o pedaço da chave de um membro sem expor a chave é real e testada, e dá para vê-la num cofre descartável no Laboratório. Ela ainda não está ligada a cofres reais (#58). Hoje, um assento perdido só volta pela exportação do próprio membro.',
            en: '**Social recovery, not yet in the product:** the cryptography that lets a quorum rebuild a lost member’s part of the key without exposing the key is real and tested, and you can watch it on a throwaway vault in the Laboratory. It is not connected to real vaults yet (#58). Today, a lost seat comes back only from that member’s own export.',
          },
          {
            'pt-BR': '**Herança, só o desenho:** a ideia é o quórum poder liberar o cofre para um herdeiro nomeado quando o dono para de dar sinal de vida. Hoje só a regra de decisão existe e é testada; nada é salvo, nenhum cofre é armado, e a página do Laboratório é uma simulação (#58).',
            en: '**Inheritance, design only:** the intended design lets the quorum release the vault to a named heir when the owner stops checking in. Today only the decision rule is built and tested; nothing is saved, no vault is armed, and the page in the Laboratory is a simulation (#58).',
          },
        ],
      },
      {
        k: 'note',
        t: {
          'pt-BR': 'Dois caminhos, não confundir. O **`/net`** assina a PCZT real do **próprio cofre** (sob o alpha da transação) e **foi transmitido na mainnet** - txid `3022420a…`, naquela vez com **duas abas numa máquina só**. O broadcast entre **dispositivos separados** deixou de ser marco em aberto: aconteceu em 29/08 entre máquinas físicas diferentes, pela internet (`aec83baf…`, bloco 3.460.285). O **multi-nota ao vivo** continua só testado em unidade. O **`/signer`** é uma **demonstração**: assina o sighash real de uma tx de exemplo (`aab00f90…`) para mostrar a mecânica, mas essa PCZT é de outro cofre, então **não é transmitível**.',
          en: 'Two paths, not to be conflated. **`/net`** signs the real PCZT of the **vault’s own** address (under the transaction’s alpha) and **was broadcast on mainnet** - txid `3022420a…`, that time with **two tabs on one machine**. A broadcast across **separate devices** is no longer the open milestone: it happened on 2026-08-29 between different physical machines over the internet (`aec83baf…`, block 3,460,285). **Live multi-note** is still only unit-tested. **`/signer`** is a **demo**: it signs the real sighash of a sample tx (`aab00f90…`) to show the mechanics, but that PCZT belongs to another vault, so it is **not broadcastable**.',
        },
      },
      { k: 'img', src: 'diagrams/multi-device.svg', alt: { 'pt-BR': 'Fluxo multi-dispositivo pelo relay cego: DKG e assinatura entre abas', en: 'Multi-device flow over the blind relay: DKG and signing across tabs' } },
    ],
  },
  {
    id: 'coordination',
    nav: { 'pt-BR': 'Coordenação', en: 'Coordination' },
    title: { 'pt-BR': 'Modos de coordenação', en: 'Coordination modes' },
    lead: {
      'pt-BR':
        'No app web as aprovações são coordenadas pelo coordenador hospedado do Konclave. O app de mesa, ainda não validado em hardware real, deixa escolher outro. Em qualquer modo o coordenador nunca recebe um pedaço da chave e não move fundos sem as assinaturas do quórum, mas ele vê os pagamentos do cofre.',
      en:
        'In the web app the approvals are coordinated by Konclave’s hosted coordinator. The desktop app, still unvalidated on real hardware, lets you choose another. In every mode the coordinator never receives a part of the key and cannot move funds without the quorum’s signatures, but it does see the vault’s payments.',
    },
    blocks: [
      {
        k: 'ul',
        items: [
          {
            'pt-BR': '**Nosso coordenador hospedado** - o padrão, e o único no app web. Ele guarda a chave de visualização do cofre, constrói, prova e transmite a transação enquanto os aparelhos assinam pelo relay cego. Nunca recebe o pedaço da chave de ninguém.',
            en: '**Our hosted coordinator** - the default, and the only one in the web app. It holds the vault’s viewing key and builds, proves and broadcasts the transaction while the devices sign over the blind relay. It never receives anyone’s part of the key.',
          },
          {
            'pt-BR': '**Seu próprio coordenador (app de mesa)** - aponte para um coordenador que você mesmo hospeda (uma URL nos Ajustes). Mesma garantia, e quem vê os pagamentos passa a ser você.',
            en: '**Your own coordinator (desktop app)** - point at a coordinator you self-host (a URL in Settings). Same guarantee, and the one who sees the payments is you.',
          },
          {
            'pt-BR': '**Local, sem coordenador (app de mesa e versão local)** - nenhum terceiro. O orquestrador local faz tudo.',
            en: '**Local, no coordinator (desktop and local build)** - no third party at all. The local orchestrator does everything.',
          },
        ],
      },
      {
        k: 'note',
        t: {
          'pt-BR': 'No app de mesa você escolhe o modo antes de criar um cofre, e troca quando quiser nos Ajustes. A segurança do gasto está em **quem assina** (os aparelhos), nunca em quem monta a transação. A privacidade diante do coordenador não: quem monta a transação vê o que ela paga.',
          en: 'On desktop you pick the mode before creating a vault, and switch it any time in Settings. The safety of spending is in **who signs** (the devices), never in who assembles the transaction. Privacy from the coordinator is not: whoever assembles the transaction sees what it pays.',
        },
      },
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
            'pt-BR': '**Garantido pela criptografia:** a chave nunca é reconstituída; gastar exige a assinatura de um quórum; o seu pedaço da chave nunca sai do seu aparelho. **Garantido pela forma como os serviços são feitos (produto, não protocolo):** o relay só carrega mensagens da cerimônia seladas ou públicas; o coordenador nunca recebe o pedaço da chave de ninguém e não consegue gastar, mas guarda a chave de visualização do cofre, então vê o saldo, os pagamentos, os valores, os memos e os nomes dos membros.',
            en: '**Guaranteed by the cryptography:** the key is never reconstituted; a quorum signature is required to spend; your part of the key never leaves your device. **Guaranteed by how the services are built (product, not protocol):** the relay carries only sealed or public ceremony messages; the coordinator never receives anyone’s part of the key and cannot spend, but it holds the vault’s viewing key, so it sees the balance, the payments, the amounts, the memos and the members’ names.',
          },
          {
            'pt-BR': '**Imposto pelo produto (não pela cadeia):** reserva de saldo e expiração de proposta (72 horas) são política da aplicação, não regras na cadeia. Dizemos isso claramente. O quórum é um número só, fixado na criação do cofre; não existe quórum que mude com o valor.',
            en: '**Enforced by the product (not the chain):** balance reservation and proposal expiry (72 hours) are application policy, not on-chain rules. We say so plainly. The quorum is a single number fixed when the vault is created; there is no quorum that changes with the amount.',
          },
          {
            'pt-BR': '**Postura de segurança:** no navegador, o seu pedaço da chave fica guardado cifrado (AES-256-GCM, chave derivada da sua frase-senha com PBKDF2-SHA256, 600.000 rodadas) e só é decifrado na memória; no app de mesa e na versão local ele é selado com XChaCha20-Poly1305 sob uma chave Argon2id guardada no keychain do sistema, e o bridge local é protegido contra CSRF/DNS-rebinding. Os destinos passam por uma decodificação autoritativa de endereço antes de qualquer envio.',
            en: '**Security posture:** in the browser, your part of the key is stored encrypted (AES-256-GCM, key derived from your passphrase with PBKDF2-SHA256, 600,000 rounds) and decrypted only in memory; on the desktop and local build it is sealed with XChaCha20-Poly1305 under an Argon2id key held in the OS keychain, and the local bridge is guarded against CSRF/DNS-rebinding. Destinations are checked by an authoritative address decode before any send.',
          },
          {
            'pt-BR': '**Acesso de leitura protegido, não só o gasto:** os dados on-chain de um cofre são blindados, mas o coordenador guarda a chave de visualização e antes respondia leituras a qualquer um com o link público do cofre. Agora cada membro guarda um segredo por cofre, gerado na criação e enviado aos outros membros selado (nunca em claro); o coordenador protege suas leituras - saldo, histórico, membros, razão - e a sala de assinatura atrás de um token derivado dele. Um link vazado não abre nem os livros nem a sala. A lista de cofres marca cada cofre como Privado ou Aberto. Todo voto, proposta, folha, renomeação e envio é assinado pelo aparelho do membro e conferido pelo coordenador, a partir do momento em que um membro daquele cofre o destrava. Limites honestos: a proteção é por cofre (cofres antigos ficam Abertos até serem recriados; atualizá-los no lugar está planejado, #406), e um link vazado ainda mostra o endereço do cofre, quantos membros ele tem e quantos precisam aprovar.',
            en: '**Read access is gated, not just spending:** a vault’s on-chain data is shielded, but the coordinator holds the viewing key and used to answer reads to anyone holding the public vault link. Now every member holds a per-vault secret, minted at creation and sent to the other members sealed (never in the clear); the coordinator gates its reads - balance, history, members, ledger - and the signing room behind a token derived from it. A leaked link opens neither the books nor the room. The vault list marks each vault Private or Open. Every vote, proposal, payroll, rename and send is signed by the member’s device and checked by the coordinator, from the moment a member of that vault unlocks it. Honest limits: the gate is per vault (older vaults stay Open until re-created; upgrading them in place is planned, #406), and a leaked link still shows the vault’s address, how many members it has and how many must approve.',
          },
          {
            'pt-BR': '**Um backup vazado não revela nada:** a exportação de um cofre é um único blob opaco - metadados, o seu pedaço da chave, o segredo por cofre e os beneficiários, tudo cifrado sob a sua frase-senha, só um envelope não-sensível em claro - então um arquivo de backup roubado não revela nem o id do cofre. Num cofre Privado ela carrega tudo que uma reconstrução precisa: o seu pedaço da chave, o endereço do cofre, a chave de visualização e a altura de onde varrer. Um backup feito enquanto o cofre era Aberto não tem a chave de visualização; faça um novo quando o cofre for Privado.',
            en: '**A leaked backup reveals nothing:** a vault’s export is one opaque blob - metadata, your part of the key, the per-vault secret and the beneficiaries all encrypted under your passphrase, only a non-sensitive envelope in the clear - so a stolen backup file does not even disclose the vault id. On a Private vault it carries everything needed to rebuild: your part of the key, the vault’s address, its viewing key and the height to scan from. A backup made while a vault was Open lacks the viewing key; make a new one once the vault is Private.',
          },
          {
            'pt-BR': '**Sem auditoria:** o Konclave não foi auditado de forma independente. A biblioteca FROST da Zcash Foundation passou por uma auditoria parcial, e ela exclui o FROST rerandomizado, a variante que a Zcash usa. Não guarde valores significativos nele ainda.',
            en: '**Not audited:** Konclave has not been independently audited. The Zcash Foundation’s FROST library was partially audited, and that audit excludes rerandomized FROST, the variant Zcash uses. Do not keep significant funds in it yet.',
          },
        ],
      },
      { k: 'h', t: { 'pt-BR': 'Provado vs pendente', en: 'Proven vs pending' } },
      {
        k: 'ul',
        items: [
          {
            'pt-BR': `**Na mainnet, ${PROOF_COUNT} txids verificáveis** (\`node scripts/verify-proof.mjs\` ou a tela [/proof](#/proof), que lista todos): um pagamento por quórum 2-de-3 (proposto/aprovado no app, assinado por FROST, shares lacrados em repouso); uma folha privada (uma tx Orchard blindada com 3 saídas, cada uma com memo criptografado, 2-de-3 FROST); um pagamento reproduzido ponta a ponta de um cofre criado e financiado do zero; um **envio a partir de um cofre gerado por DKG real** (cerimônia DKG de 3 participantes, chave nunca reconstituída), financiado e gasto por FROST; no dia da ativação do NU6.3/Ironwood, uma **migração Orchard→Ironwood** mais o **primeiro gasto DO pool Ironwood** (ambas V6/NU6.3, 2-de-3 FROST); o **primeiro broadcast assinado NO NAVEGADOR**, de um cofre 2-de-2 nascido de DKG no navegador, duas abas numa máquina só, cada uma assinando com só o seu share pelo relay cego (Arquitetura B); e, depois dele, envios assinados **entre máquinas físicas separadas**, **de um celular** e por um cofre **3-de-4**. Nota honesta: ${PROOF_ORIGINS.dealer} dos ${PROOF_COUNT} usaram um cofre trusted-dealer, em que a chave existiu inteira numa máquina na criação (o pagamento por quórum, a fatia do Gate 1, o cofre-novo, a folha e os dois envios do ciclo Ironwood); os outros ${PROOF_ORIGINS.dkg} vieram de chaves nascidas por DKG real.`,
            en: `**On mainnet, ${PROOF_COUNT} verifiable txids** (\`node scripts/verify-proof.mjs\` or the [/proof](#/proof) page, which lists them all): a 2-of-3 quorum payment (proposed/approved in the app, FROST-signed, shares sealed at rest); a private payroll (one shielded Orchard tx with 3 outputs, each with an encrypted memo, 2-of-3 FROST); a payment reproduced end to end from a freshly created and funded vault; a **send from a real DKG-generated vault** (three-participant DKG ceremony, key never reconstituted), funded and spent by FROST; on NU6.3/Ironwood activation day, an **Orchard→Ironwood migration** plus the **first spend FROM the Ironwood pool** (both V6/NU6.3, 2-of-3 FROST); the **first browser-signed broadcast**, from a browser-DKG 2-of-2 vault, two tabs on one machine, each signing IN THE BROWSER with only its own share over the blind relay (Architecture B); and, after it, sends signed **across separate physical machines**, **from a phone**, and by a **3-of-4** vault. Honest note: ${PROOF_ORIGINS.dealer} of the ${PROOF_COUNT} used a trusted-dealer vault, where the whole key existed on one machine at creation (the quorum payment, the Gate-1 slice, the fresh vault, the payroll, and both sends of the Ironwood cycle); the other ${PROOF_ORIGINS.dkg} came from keys born by real DKG.`,
          },
          {
            'pt-BR': '**Por dry-run** (assina, ainda não transmite): o caminho de assinatura totalmente lacrado (configs abertos só em tmpfs).',
            en: '**By dry-run** (it signs, it does not yet broadcast): the fully-sealed signing path (configs unsealed only to tmpfs).',
          },
          {
            'pt-BR': '**No navegador, ao vivo - broadcast PROVADO na mainnet:** DKG multi-dispositivo e assinatura FROST por um relay cego hospedado, sobre um **sighash real** **sob o alpha da própria transação** (o mecanismo Orchard correto, `ak+alpha`), com verificação `describeOutputs` em cada dispositivo, e então transmitido pelo **coordenador hospedado** (Arquitetura B), que nunca recebe um pedaço da chave. Provado na mainnet primeiro com duas abas numa máquina só (txid `3022420a…`) e depois entre máquinas físicas separadas, pela internet (txid `aec83baf…`), duas pessoas em dois lugares, cada navegador com só o seu share.',
            en: '**In the browser, live - broadcast PROVEN on mainnet:** multi-device DKG and FROST signing over a hosted blind relay, over a **real sighash** **under the transaction’s own alpha** (the correct Orchard mechanism, `ak+alpha`), with per-device `describeOutputs` verification, then broadcast by the **hosted coordinator** (Architecture B), which never receives a part of the key. Proven on mainnet first with two tabs on one machine (txid `3022420a…`), then across separate physical machines over the internet (txid `aec83baf…`), two people in two places, each browser holding only its own share.',
          },
          {
            'pt-BR': '**Provado por teste:** recuperação social (reparo de share RTS) e o motor de política de herança.',
            en: '**Proven by test:** social recovery (RTS share repair) and the inheritance policy engine.',
          },
          {
            'pt-BR': '**Roadmap, não entregue:** o **multi-nota** ao vivo pelo relay; recuperação social e herança ligadas a um cofre vivo (#58); trocar um assento perdido, os membros ou o quórum de um cofre existente (#154); ler a folha de um CSV no app web. Já **entregues** (não são mais roadmap): o broadcast assinado no navegador, o broadcast entre dispositivos físicos separados, a persistência do share no dispositivo com assinatura-após-restore, e o app de mesa (Tauri, última versão **v0.7.0**, uma pré-release; ainda não validado em hardware real, por isso o botão de download do site fica desligado).',
            en: '**Roadmap, not shipped:** live **multi-note** over the relay; social recovery and inheritance wired into a live vault (#58); replacing a lost seat, or changing the members or the quorum of an existing vault (#154); reading a payroll from a CSV in the web app. Already **shipped** (no longer roadmap): the browser-signed broadcast, a broadcast across separate physical devices, on-device share persistence with sign-after-restore, and the desktop app (Tauri, latest **v0.7.0**, a pre-release; not yet validated on real hardware, so the site’s download button stays off).',
          },
        ],
      },
      {
        k: 'note',
        t: {
          'pt-BR': 'O diagrama abaixo mostra o aparelho, o relay e a cadeia. Ele não desenha o coordenador: o coordenador guarda a chave de visualização do cofre, as propostas e os nomes dos membros, e nunca um pedaço da chave.',
          en: 'The diagram below shows the device, the relay and the chain. It does not draw the coordinator: the coordinator holds the vault’s viewing key, the proposals and the members’ names, and never a part of the key.',
        },
      },
      { k: 'img', src: 'diagrams/trust-boundary.svg', alt: { 'pt-BR': 'Fronteira de confiança: o que nunca sai do dispositivo, o que o relay vê, o que a rede vê', en: 'Trust boundary: what never leaves the device, what the relay sees, what the chain sees' } },
    ],
  },
  {
    // #485. Deliberately NOT written as reference: the moment a member needs this, the app that
    // holds it is the thing that is gone. So its job is to get the instructions saved WITH the
    // backup while everything still works, not to be read at the moment of the loss.
    id: 'recovery',
    nav: { 'pt-BR': 'Recuperação', en: 'Recovery' },
    title: { 'pt-BR': 'Se você perder o aparelho', en: 'If you lose your device' },
    lead: {
      'pt-BR': 'A exportação cifrada é a sua única cópia reserva. Vale conferir hoje que ela abre - e guardar junto com ela como abrir, porque no dia em que precisar, este app pode ser exatamente o que sumiu.',
      en: 'The encrypted export is your only spare key. Check today that it opens - and save the instructions with it, because on the day you need it, this app may be exactly what is gone.',
    },
    blocks: [
      {
        k: 'p',
        t: {
          'pt-BR': 'O seu pedaço da chave vive só neste aparelho, cifrado sob a sua frase-senha. Nem o cofre, nem os outros membros, nem o servidor têm uma cópia. Isso é o desenho: ninguém pode gastar por você. E é também o risco: se este aparelho sumir e você não tiver uma exportação, o seu assento acaba ali.',
          en: 'Your share of the key lives on this device alone, encrypted under your passphrase. Not the vault, not the other members, not the server holds a copy. That is the design: nobody can spend for you. It is also the risk: if this device is gone and you have no export, your seat ends there.',
        },
      },
      { k: 'h', t: { 'pt-BR': 'O que a exportação carrega', en: 'What the export carries' } },
      {
        k: 'ul',
        items: [
          {
            'pt-BR': 'O seu pedaço da chave, para voltar a assinar.',
            en: 'Your share of the key, so you can sign again.',
          },
          {
            'pt-BR': 'O endereço do cofre e a chave de visualização, para a carteira reconstruída enxergar o dinheiro. A chave de visualização só vem num cofre marcado Privado: uma exportação feita enquanto o cofre era Aberto não a tem.',
            en: "The vault's address and viewing key, so a rebuilt wallet can see the money. The viewing key comes only with a vault marked Private: an export made while the vault was Open does not have it.",
          },
          {
            'pt-BR': 'A altura de onde varrer. Sem ela a carteira começa a olhar a partir de hoje e não vê nada do que o cofre já tem - e não há como mandar varrer de novo.',
            en: 'The height to scan from. Without it a wallet starts looking from today and sees nothing the vault already holds - and there is no way to make it look again.',
          },
        ],
      },
      {
        k: 'p',
        t: {
          'pt-BR': 'Tudo isso fica dentro de um único bloco cifrado. Um arquivo vazado não revela nem de qual cofre ele é.',
          en: 'All of it sits inside a single encrypted blob. A leaked file does not reveal even which vault it belongs to.',
        },
      },
      { k: 'h', t: { 'pt-BR': 'Confira agora, não depois', en: 'Check it now, not later' } },
      {
        k: 'p',
        t: {
          'pt-BR': 'Um backup que você nunca abriu é uma suposição. Em qualquer computador com Node, baixe o `open-export.mjs` do repositório do Konclave (github.com/deegalabs/konclave, pasta `scripts`), coloque ao lado do seu arquivo e rode:',
          en: 'A backup you have never opened is an assumption. On any computer with Node, download `open-export.mjs` from the Konclave repository (github.com/deegalabs/konclave, folder `scripts`), put it next to your file and run:',
        },
      },
      { k: 'code', t: 'node open-export.mjs <your-vault>.konclave.json' },
      {
        k: 'p',
        t: {
          'pt-BR': 'Ele pede a frase-senha e responde a pergunta que importa - se está tudo lá dentro - sem imprimir os segredos. Não usa nada além do Node: nem pacote, nem rede, nem o Konclave. É de propósito, porque ele precisa funcionar numa máquina que nunca teve este app.',
          en: 'It asks for your passphrase and answers the question that matters - whether everything is in there - without printing the secrets. It uses nothing but Node: no package, no network, no Konclave. That is deliberate: it has to work on a machine that has never had this app.',
        },
      },
      {
        k: 'note',
        t: {
          'pt-BR': 'Guarde estas instruções JUNTO com o arquivo. No dia em que precisar delas, este texto pode estar exatamente tão indisponível quanto o aparelho que você perdeu. O procedimento completo, com a explicação de cada campo, está em docs/RECOVERY.md no repositório.',
          en: 'Save these instructions WITH the file. On the day you need them, this page may be exactly as unavailable as the device you lost. The full procedure, with every field explained, is in docs/RECOVERY.md in the repository.',
        },
      },
      { k: 'h', t: { 'pt-BR': 'O limite honesto', en: 'The honest limit' } },
      {
        k: 'p',
        t: {
          'pt-BR': 'Não existe recuperar uma frase-senha esquecida. Nenhuma. Ela não está no servidor nem com os outros membros, e o arquivo é inútil sem ela - que é a mesma propriedade que o torna seguro guardar em qualquer lugar. Use um gerenciador de senhas. Se desconfiar da frase-senha, troque em Ajustes, depois faça uma exportação nova e apague as cópias antigas: uma exportação antiga continua abrindo com a frase antiga.',
          en: 'There is no recovering a forgotten passphrase. None. It is not on the server and not with the other members, and the file is useless without it - the same property that makes it safe to store anywhere. Use a password manager. If you ever doubt the passphrase, change it in Settings, then make a new export and delete the old copies: an old export still opens with the old passphrase.',
        },
      },
      {
        k: 'p',
        t: {
          'pt-BR': 'E se você perder o aparelho mas o cofre seguir: os outros membros continuam com os pedaços deles. Enquanto sobrarem membros suficientes para o quórum, eles seguem pagando; num cofre em que todos precisam assinar (2 de 2), um assento perdido sem exportação trava o dinheiro para sempre. Nos dois casos, o cofre não consegue devolver o seu assento.',
          en: 'And if you lose the device while the vault carries on: the other members still hold their parts. As long as enough of them remain to reach the quorum, they can keep paying; in a vault where everyone must sign (2 of 2), one lost seat without an export locks the money for good. Either way the vault cannot give your seat back.',
        },
      },
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
        t: 'pnpm install && pnpm -C ui run build\ncargo run --manifest-path orchestrator/Cargo.toml --bin konclave -- serve --web ui/dist\n# then open the printed http://127.0.0.1:4762',
      },
      {
        k: 'note',
        t: {
          'pt-BR': 'A rede multi-dispositivo (duas abas fazem um cofre e assinam) roda contra o servidor local em `http://127.0.0.1:4762/#/net`, ou ao vivo no app hospedado.',
          en: 'The multi-device network (two tabs make one vault, then sign) works against the local server at `http://127.0.0.1:4762/#/net`, or live on the hosted app.',
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
          'pt-BR': 'O pacote ainda não está publicado no npm. Gere a partir do repositório (`sdk/`, que usa o núcleo `konclave-wasm` já compilado em `ui/src/wasm-pkg/`). O binário `.wasm` (grande) **não** é embutido no pacote: sirva-o você mesmo e aponte o `init()` para a URL dele:',
          en: 'The package is not published to npm yet. Build it from the repository (`sdk/`, which uses the `konclave-wasm` core already compiled in `ui/src/wasm-pkg/`). The large `.wasm` binary is **not** bundled in the package: serve it yourself and point `init()` at its URL:',
        },
      },
      { k: 'code', t: '# from a clone of github.com/deegalabs/konclave\npnpm install\npnpm -C sdk run build' },
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
            'A pasta `mcp-server/` expõe o cofre a um assistente de IA (Claude e outros clientes MCP) pela API do bridge local. A escolha de design é o ponto todo: as ferramentas de **leitura** (cofres, saldo, transações, propostas, razão) e de **proposta** (pagamento e folha) existem; as ferramentas de **assinar** e **transmitir** foram deixadas de fora **de propósito**. Funciona só com a versão local (`konclave serve`); cofres do app web não são alcançados por ele.',
          en:
            'The `mcp-server/` folder exposes the vault to an AI assistant (Claude and other MCP clients) via the local bridge API. The design choice is the whole point: **read** tools (vaults, balance, transactions, proposals, ledger) and **propose** tools (payment and payroll) exist; the **sign** and **broadcast** tools were deliberately left out. It works with the local build (`konclave serve`) only; vaults in the web app are not reachable from it.',
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
          'tools exposed:   list_vaults · get_vault · get_balance · get_transactions ·\n                 list_proposals · get_ledger · propose_payment · propose_payroll\ntools withheld:  (none for sign) · (none for send)   <-  by design',
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
