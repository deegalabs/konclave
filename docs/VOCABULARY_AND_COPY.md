# Vocabulary and copy

> **Status:** draft of 2026-10-30, revised the same day after review. It becomes the reference for
> screen copy when Daniel accepts it.
> **What it is:** the words the product uses on screen, where they come from, and what stays off the
> everyday screens. Portuguese terms are kept as they appear on screen.
> **What it is not:** it changes no engine, no screen, and decides no new field.
>
> **Sources:** the project's UX principle (CLAUDE.md §7: hide the cryptography, expose the trust),
> its honesty rules (CLAUDE.md §6.13 to §6.15), the honest and active copy of
> [UX_E_FLUXOS.md](UX_E_FLUXOS.md), the Portuguese the community writes (ZecHub Brasil), the labels
> of community wallets, and the Zcash Foundation's FROST terms (ZIP 312, `frost-client`).

---

## 0. On one page

1. **The member sees vault, members, approval, payment.** Never FROST, DKG, sighash, nonce, round.
2. **One thing, one name.** The menu, the screen title and the tab say the same word, in both
   languages.
3. **The community's word before ours.** If the wallet the member already uses says "blindado", so
   does Konclave.
4. **The machinery stays in the docs and in the trust panel**, with the technical name in
   parentheses once, where the member went looking for it.
5. **The button says what happens.** Propose payment, Approve, Sign and send, Sent.
6. **A product lock never wears the clothes of a cryptographic guarantee.** "2 of 3 must sign" is
   the guarantee of the signature; "2 of 3 must approve first" and "this proposal's balance is
   reserved" are the product's rules. The copy says which is which.

---

## 1. Terms: English, Portuguese, and where the member has seen them

| EN | pt-BR (as the community writes it) | Where the member has seen it | In Konclave |
|---|---|---|---|
| shielded / transparent | **blindado / transparente** | community wallets: "always use shielded address" | in use (#127: the screens say "blindado" and "blindado antigo (Sapling)") |
| shield | **blindar** | community wallets: Shield, Shielding, Shielded | not applicable (the vault only receives shielded) |
| Total / Spendable / Pending | total / disponível / pendente | community wallets, three lines | in use; the **reserve** held by proposals is a fourth line, named as Konclave's reserve, never as "pendente" |
| Unified Address (UA) | **endereço unificado**, "starts with u1" | community wallets show only "Shielded Address" | "endereço do cofre"; "unificado" only in the detail |
| memo | **memo** (encrypted note) | community wallets: "Write encrypted message here" | "memo"; the field says it is encrypted and that a transparent destination has no memo |
| viewing key (Incoming / Full) | **chave de visualização** | community wallets: Export Viewing Key, "cannot be undone" | "chave de visualização" (Settings, export); the vault has one key today; Incoming/Full does not apply |
| view-only | **somente leitura** | community wallets: View Only Account | **to check**: the product reads without unlocking; the name "somente leitura" does not appear yet |
| payment request (ZIP 321) | **pedido de pagamento** | community wallets: Receive, Request, "What's this for?" | in use on Receive; "ZIP 321" only in the detail |
| server / lightwalletd | **servidor** | community wallets: Choose a Server, host:port | Konclave chooses no server; **"o servidor do cofre"** is the on-screen name for the coordinator (Daniel, 2026-10-30) |
| ledger | **livro** | the accountant's term is "livro-razão"; the plain word is "livro" | **"Livro"** on the menu, the title and the tab (Daniel, 2026-10-30); "Ledger" in English |
| seed + wallet birthday | **frase + altura** | community wallets: "Estimate my block height" | the export already carries the viewing key and the birthday together (#447, #480) |
| sync | **sincronizar** | community wallets: Syncing 42%, Synced | **missing**: the screen does not say when it has not read the chain yet (feedback ruler, class 5) |
| send flow | Revisar, Confirmar, Enviando, Enviado | community wallets | in use: preview, confirm, Enviado |
| threshold / participants / coordinator | **quórum (2 de 3)**, membros, servidor do cofre | Zcash Foundation (`frost-client`, ZIP 312) | "quórum" and "membros" on screen; "coordenador" only in the docs and in the trust panel |
| key share | **sua parte** (of the vault's key) | Zcash Foundation | "sua parte"; it leaves the device only sealed, inside the backup the member exports; never "share", "fragmento", "chave parcial" |
| group viewing key | chave de visualização do cofre | Zcash Foundation | in use |
| DKG | **criação do cofre** | Zcash Foundation | "DKG" only in the docs and on the landing, as credit to the Foundation |
| multisig | múltiplas assinaturas (= transparent, in the community's mind) | ZecHub | **never** for Konclave; in the docs, "threshold signature (FROST)" |
| treasurer / contributors / reviewers | tesoureiro, contribuidores, revisores | ZecHub | "tesoureiro" is whoever operates; it is not a role with permissions (there are none) |
| coinholder / snapshot / quorum | detentor de ZEC | community consultations | not on screen; "quórum" in Konclave is the vault's |
| grantee / milestone / tranche | beneficiário, marco, parcela | the grants vocabulary | "beneficiário" is the name; "marco" and "parcela" describe nothing in the product yet |

---

## 2. The community's fifteen conventions, and where Konclave stands

| # | Convention | In Konclave |
|---|---|---|
| 1 | Shielded versus transparent on screen; pools only in the detail | done (#127) |
| 2 | Balance in three lines; the product's reserve is an explicit fourth line | to check on the dashboard |
| 3 | Two viewing keys (Incoming for the accountant, Full for audit) | does not apply today; one key |
| 4 | "Somente leitura" is the name of the read mode | the name is missing |
| 5 | A server picker like the wallets' | does not apply; the trust panel says what each service sees |
| 6 | Payment request = ZIP 321 ("Pedir ZEC", "Para que é?") | done on Receive |
| 7 | Memo: placeholder, limit, "transparent has no memo" | to check on the memo fields |
| 8 | Backup = phrase plus height, together; the part treated like a seed | the export joins them; the warning about the part, to check |
| 9 | Sync visible and honest | missing (feedback ruler, class 5) |
| 10 | Sending in four states | done; Konclave's names are Propor, Aprovar, Assinar e enviar, Enviado |
| 11 | FROST vocabulary in the docs, not on screen | this guide's rule (§3) |
| 12 | "Multisig" is not FROST | done in the docs; neither word appears on screen |
| 13 | Treasury roles with ZecHub's names | "tesoureiro" in text only; it never becomes a permission |
| 14 | On-chain proof and data before adjectives | done (PROOF.md, the evidence screen) |
| 15 | ZecHub style: brief, the most important first, as you would say it | this guide follows it |

---

## 3. Engine words: off the everyday screens

Where it is today = prefixes of the pt-BR dictionary on 2026-10-30. Substitute = what the screen says
instead. Where it may appear = the place a member goes looking for the technical name.

| Word | Where it is today | Substitute on screen | Where it may appear |
|---|---|---|---|
| FROST, DKG | landing, net, ceremony | "assinatura em grupo", "criação do cofre" | docs; the landing, once, as credit to the Foundation |
| relay | net (6), settings (5), dashboard (2) | "a ligação entre os aparelhos"; in an error: "não deu para alcançar os outros aparelhos" | trust panel: "serviço de mensagens (relay): carries sealed or public material; until every member's device has registered its key, a signing request crosses it unsealed" |
| coordenador | signing (8), error (5), registration (4), net (3) | **"o servidor do cofre"** (Daniel, 2026-10-30) | trust panel and docs, with what that server sees and what it does not |
| assento | net (4), error (2), dashboard (2), vaults (1) | "membro" (the person); "aparelho do membro" (the seat) | docs |
| cerimônia | proposal, net, ceremonies, signing | "assinatura" (of a payment); "criação do cofre" | the evidence screen could be called "Assinaturas" instead of "Registro de cerimônias" (a proposal; the screen is Daniel's) |
| key share | 31 uses as "sua parte" | **"sua parte"** stays, as the one name, defined once on the backup screen | never "share", "fragmento", "chave parcial" |
| Orchard, Sapling, Ironwood (pools) | landing, signer, error, dashboard | "blindado"; "blindado antigo (Sapling)" (#127) | technical detail and docs |
| sighash | ceremonies (2), net (1) | nothing in everyday use | evidence: "resumo assinado (sighash)" (#127) |
| ZIP 321 | 1 use | "pedido de pagamento" | the detail of Receive |
| mainnet | proposal (4), error (1) | "a rede Zcash"; in money warnings, "ZEC de verdade" | docs, PROOF |
| nonce, round 1 and 2, package, randomizer | none | never | docs |

**Stays as it is:** "quórum" (42 uses) is the community's word and the product's. Always with the
number: "2 de 3 aprovações", never "quórum atingido" on its own.

---

## 4. The proposal's states: one grouping, one colour meaning, one word

The states already exist in the product. What this guide fixes is the **grouping, the colour and
the word**, the same on the screen, in the list and in the exported workbook. The colour never goes
alone: every state has its word and, where it fits, its sign (as the notices already do).

| Group | States | Colour (meaning) | The screen says |
|---|---|---|---|
| Needs someone | aguardando, pronta | action | "aguarda 1 de 2", "pronta para assinar" |
| On its way | enviada | neutral | "enviada, aguardando confirmação" |
| Settled | confirmada | ok | "confirmada" |
| Closed without payment | recusada, expirada, cancelada, invalidada | muted | its own state, outside the sums |

Where it lives: the states are product code, **one implementation**, read by the screen and by the
export; the colours are tokens of the visual layer, never a loose colour inside a component.

---

## 5. Copy rules

1. **The button says what happens.** "Propor pagamento", "Aprovar", "Assinar e enviar". Never "OK",
   a bare "Enviar", or "Continuar" on a step that moves money.
2. **Money never leaves on one click.** Preview, then confirmation; the confirmation says the
   amount, the recipient and what happens next. Approving and signing are two moments with two
   sentences: approving is your yes to the proposal ("Ao aprovar, você diz sim a este pagamento");
   signing is your part of the key at work, and the last signature sends ("Quem aprovou assina; a
   última assinatura envia").
3. **Guarantee and lock, each with its name.** "2 de 3 precisam assinar" is the guarantee of the
   signature; "precisa de 2 aprovações" and "o saldo desta proposta fica reservado" are the product's
   locks. Never "a rede impede" for a product lock.
4. **An error says what to do.** One sentence with the next action; no code, no stack; "Tentar de
   novo" when it makes sense; on the money path the failure stays on screen, never only in a notice
   that fades.
5. **One name per thing.** Cofre, membro, sua parte, quórum, proposta, pagamento, folha,
   beneficiário, livro, evidência. No synonym, no nickname.
6. **A number with its unit and its context.** "0,25 ZEC", never "0,25"; a USD figure only as a
   labelled reference ("ref. USD").
7. **Brief, the most important first, as you would say it.** No em dashes in public text; one idea
   per sentence.
8. **Privacy decides what appears.** Never a vault's whole id, never a viewing key in a screenshot,
   a memo treated as sensitive data.

---

## 6. The product's minimal glossary

- **Cofre:** the collective fund; one shielded address, several members, one quorum.
- **Membro:** whoever holds a part of the vault's key on a device and can approve.
- **Sua parte:** the part of the key that lives on your device; it leaves only sealed, inside the
  backup you export yourself.
- **Quórum:** how many parts must sign for money to leave, said as "2 de 3": the guarantee. The
  approvals the screen asks for before that are the product's rule.
- **Proposta:** a payment or a payroll waiting for approvals.
- **Pagamento:** one outflow to one address; **folha:** several outflows in one transaction.
- **Beneficiário:** whoever receives; the people register keeps name and address.
- **Livro:** the vault's book: everything proposed, approved, sent and confirmed.
- **Evidência:** the proof of each signature, with the txid on the chain.
- **Painel de confiança:** what each service sees and what it does not, in plain words.

---

## 7. What this guide does not decide

- Fields that do not exist in the product, and anything that changes what a device signs.
- The titles of the screens that are Daniel's (dashboard, signing, ceremony). The guide proposes; he
  decides.
- The colour tokens. Here, only what each colour means.
