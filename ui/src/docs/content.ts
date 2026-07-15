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
            'O crate `konclave-wasm` compila FROST rerandomized-redpallas (Orchard) para WebAssembly. Dois dispositivos separados **criam um cofre por DKG real** e depois **produzem juntos uma assinatura de grupo FROST que verifica**, cada um guardando só o próprio share, através de um **relay cego hospedado** (`relay-server`, na Railway) que carrega apenas material público ou já criptografado.',
          en:
            'The `konclave-wasm` crate compiles rerandomized-redpallas (Orchard) FROST to WebAssembly. Two separate devices **create one vault by a real DKG** and then **produce a verifying FROST group signature together**, each keeping only its own share, through a **hosted blind relay** (`relay-server`, on Railway) that carries only public or already-encrypted bytes.',
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
          'pt-BR': 'Limite honesto: no navegador, a assinatura é real, mas a mensagem assinada é um **digest de teste**, ainda não uma transação Orchard transmitida. Ver o Roadmap.',
          en: 'Honest limit: in the browser the signature is real, but the signed message is a **test digest**, not yet a broadcast Orchard transaction. See the Roadmap.',
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
            'pt-BR': '**Na mainnet, 4 txids verificáveis** (`node scripts/verify-proof.mjs` ou a tela /proof): um pagamento por quórum 2-de-3 (proposto/aprovado no app, assinado por FROST, cofre por DKG real, shares lacrados); uma folha privada (uma tx Orchard blindada com 3 saídas, cada uma com memo criptografado, 2-de-3 FROST); e um pagamento reproduzido ponta a ponta de um cofre criado e financiado do zero. Nota honesta: a folha e o cofre-novo usaram trusted-dealer; o pagamento pelo app usou DKG.',
            en: '**On mainnet, 4 verifiable txids** (`node scripts/verify-proof.mjs` or the /proof page): a 2-of-3 quorum payment (proposed/approved in the app, FROST-signed, real-DKG vault, sealed shares); a private payroll (one shielded Orchard tx with 3 outputs, each with an encrypted memo, 2-of-3 FROST); and a payment reproduced end to end from a freshly created and funded vault. Honest note: the payroll and fresh vault used trusted-dealer; the app payment used DKG.',
          },
          {
            'pt-BR': '**Por dry-run** (assina, ainda não transmite): o caminho de assinatura totalmente lacrado (configs abertos só em tmpfs).',
            en: '**By dry-run** (it signs, it does not yet broadcast): the fully-sealed signing path (configs unsealed only to tmpfs).',
          },
          {
            'pt-BR': '**No navegador, ao vivo:** DKG multi-dispositivo e assinatura FROST por um relay cego hospedado. A assinatura é real; a mensagem é um digest de teste.',
            en: '**In the browser, live:** multi-device DKG and FROST signing over a hosted blind relay. The signature is real; the message is a test digest.',
          },
          {
            'pt-BR': '**Provado por teste:** recuperação social (reparo de share RTS) e o motor de política de herança.',
            en: '**Proven by test:** social recovery (RTS share repair) and the inheritance policy engine.',
          },
          {
            'pt-BR': '**Roadmap, não entregue:** envio a partir de um cofre DKG novo (a evidência de folha usou trusted-dealer), assinatura de transação real no navegador (ainda um digest de teste), persistência completa do share no dispositivo (restaura; assinar-após-restore pendente), e o binário desktop único instalável (Tauri).',
            en: '**Roadmap, not shipped:** sending from a fresh DKG vault (the payroll evidence used trusted-dealer), real-transaction signing in the browser (still a test digest), full on-device share persistence (restore works; signing-after-restore pending), and the single installable desktop binary (Tauri).',
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
]
