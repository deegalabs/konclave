// The mainnet transactions the /proof screen lists, in the order of the table in docs/PROOF.md.
//
// THE TABLE IS THE RECORD, and this is a copy of it the app can ship. The screen held its own list
// of eight from the day it was written, and nothing connected that list to the record, so the
// record grew to nineteen while the screen and the in-app docs went on saying eight.
//
// A copy is allowed to exist because `proof-record.test.ts` reads docs/PROOF.md and fails when
// the two disagree: a row missing here, a row here that the record does not have, a different
// order, a different block. Adding a row to the record without adding it here does not merge.
//
// The count is never written down. The screen renders this list and the in-app docs read its
// length, so there is no number to fall behind.
//
// `origin` says how the vault's key was made, which the chain cannot show. It is checked against
// the attribution table in docs/CLAIMS.md by the same test.
//   dealer  a trusted dealer held the whole key at creation and split it
//   dkg     Distributed Key Generation: the key was never whole on any machine

export type ProofLocale = 'pt-BR' | 'en'
export type ProofOrigin = 'dealer' | 'dkg'

export type ProofTx = {
  txid: string
  /** The height it was mined at, as public explorers report it. */
  block: number
  origin: ProofOrigin
  label: Record<ProofLocale, string>
}

/** The record itself, for a reader who wants what each row rests on in full. */
export const PROOF_RECORD_URL = 'https://github.com/deegalabs/konclave/blob/main/docs/PROOF.md'

export const PROOF_TXS: readonly ProofTx[] = [
  {
    txid: '43433a109d3f2a078c0a9269ccb156392ade7a1f7ac1532981611eda1e59a572',
    block: 3397342,
    origin: 'dealer',
    label: {
      en: 'Application-driven 2-of-3 quorum payment (FROST-signed, broadcast)',
      'pt-BR': 'Pagamento por quórum 2-de-3 conduzido pelo app (assinado por FROST, transmitido)',
    },
  },
  {
    txid: 'f63ee64d7bc086a8286631d03936ec2ca2ca57f4e4c63712fc95c1f02c522360',
    block: 3396616,
    origin: 'dealer',
    label: {
      en: 'Gate-1 CLI-driven vertical-slice payment',
      'pt-BR': 'Pagamento do Gate 1, fatia vertical pela CLI',
    },
  },
  {
    txid: '6c898239e05fdd1ccce5d650fa25eeabb10d1645a3fdbc36ab5fd3ac8d4fd35f',
    block: 3413636,
    origin: 'dealer',
    label: {
      en: '2-of-3 FROST payment from a freshly created and funded vault (reproduced end to end)',
      'pt-BR': 'Pagamento 2-de-3 FROST de um cofre criado e financiado do zero (reproduzido ponta a ponta)',
    },
  },
  {
    txid: 'b1e24c07fcd629e6e6ea6809ffeb5d2e311054781740c6a5db73dabc94d0e1b4',
    block: 3413648,
    origin: 'dealer',
    label: {
      en: 'Private multi-output payroll (3 outputs, one encrypted memo each), 2-of-3 FROST',
      'pt-BR': 'Folha privada multi-saída (3 saídas, um memo criptografado cada), 2-de-3 FROST',
    },
  },
  {
    txid: 'aab00f903b65e32d1adac317820a85fc97d15c2dcd788b3657ce36773e230ff3',
    block: 3413792,
    origin: 'dkg',
    label: {
      en: '2-of-3 FROST send from a real DKG-generated vault (key never reconstituted), broadcast to mainnet',
      'pt-BR': 'Envio 2-de-3 FROST de um cofre gerado por DKG real (chave nunca reconstituída), transmitido à mainnet',
    },
  },
  {
    txid: '54266f478505160adfb039c7c76f5615f1536a34059ab30e9f24781ec2e5c494',
    block: 3428205,
    origin: 'dealer',
    label: {
      en: 'Orchard→Ironwood migration (NU6.3/V6), 2-of-3 FROST, seeds the Ironwood pool',
      'pt-BR': 'Migração Orchard→Ironwood (NU6.3/V6), 2-de-3 FROST, semeia o pool Ironwood',
    },
  },
  {
    txid: '36c60f1e3f602c2ac13c9f5b0687f248522499fc5a8b69311605336457226c95',
    block: 3428246,
    origin: 'dealer',
    label: {
      en: "Konclave's first spend FROM the Ironwood pool on mainnet (NU6.3/V6), 2-of-3 FROST",
      'pt-BR': 'Primeiro gasto do Konclave DO pool Ironwood na mainnet (NU6.3/V6), 2-de-3 FROST',
    },
  },
  {
    txid: '3022420a8bcf17ffd5511163c18ee9b5996a3ba44747e4eff6794bdd3f04ccee',
    block: 3429922,
    origin: 'dkg',
    label: {
      // This said "each device". The record says two tabs on one machine, so the screen does too.
      en: "Konclave's first browser-signed mainnet broadcast: a browser-DKG 2-of-2 vault, each tab signing in the browser with only its own share over the blind relay (Architecture B), Ironwood pool. Two tabs on one machine.",
      'pt-BR': 'Primeiro broadcast do Konclave na mainnet assinado NO NAVEGADOR: cofre 2-de-2 nascido de DKG no navegador, cada aba assinando com só o seu share pelo relay cego (Arquitetura B), pool Ironwood. Duas abas numa máquina só.',
    },
  },
  {
    txid: '64f94d290f409f0e80b7985213bf0089a82b5c8de13e587d096ad57be7ae7f32',
    block: 3460108,
    origin: 'dkg',
    label: {
      en: 'Browser-signed send where every member signs and the last signer sends: a 2-of-2 browser-DKG vault, each device signing with its own share, the device that closed the quorum broadcasting',
      'pt-BR': 'Envio assinado no navegador em que todos assinam e o último a assinar envia: cofre 2-de-2 nascido de DKG no navegador, cada dispositivo assinando com o seu share, e o dispositivo que fechou o quórum transmitindo',
    },
  },
  {
    txid: 'b496fc3ce0b728f840b5346127a7757c670b4e38f55f0f7198b4a2e43a902898',
    block: 3460538,
    origin: 'dkg',
    label: {
      en: '3-of-4 browser-DKG vault, browser-signed, operated by someone other than the maintainer. The largest quorum proven.',
      'pt-BR': 'Cofre 3-de-4 nascido de DKG no navegador, assinado no navegador, operado por alguém que não é o mantenedor. O maior quórum provado.',
    },
  },
  {
    txid: '7c4c1dd5d8522dc14a77b4a37ebb0846d5a3b7ed0c507c9cede2de09480490ea',
    block: 3461704,
    origin: 'dkg',
    label: {
      en: 'Private payroll on the web path, after Ironwood: 2 beneficiaries in one V6 transaction, a 2-of-2 browser-DKG vault, approved once and signed by both devices',
      'pt-BR': 'Folha privada pelo caminho web, depois do Ironwood: 2 beneficiários numa única transação V6, cofre 2-de-2 nascido de DKG no navegador, aprovada uma vez e assinada pelos dois dispositivos',
    },
  },
  {
    txid: 'aec83baf22ee9eaab1281d43a7efb4abed619154980a935bf37ddc00171a938a',
    block: 3460285,
    origin: 'dkg',
    label: {
      en: 'Across separate physical machines, over the internet: a 2-of-2 browser-DKG vault, proposed and approved by one person and co-signed by another on a different computer in a different place, each browser holding only its own share. Where the signers were rests on the two operators and the ceremony trail, not on the block.',
      'pt-BR': 'Entre máquinas físicas separadas, pela internet: cofre 2-de-2 nascido de DKG no navegador, proposto e aprovado por uma pessoa e coassinado por outra, em outro computador e em outro lugar, cada navegador com só o seu share. Onde os signatários estavam se apoia nos dois operadores e no registro da cerimônia, não no bloco.',
    },
  },
  {
    txid: '2d861b8f6fe6e1959b15364f484a532aad6cd4d30066850360a72206ece5d06b',
    block: 3463297,
    origin: 'dkg',
    label: {
      en: 'Signed from a phone, through the installed app: a 2-of-2 browser-DKG vault, the closing signature made on an Android phone in a mobile browser, its share sealed on that phone. The chain cannot show the device, so this rests on the operator and the ceremony trail, not on the block.',
      'pt-BR': 'Assinado de um celular, pelo app instalado: cofre 2-de-2 nascido de DKG no navegador, a assinatura que fechou o quórum feita num celular Android, em navegador móvel, com o share lacrado nesse celular. A cadeia não mostra o dispositivo, então isto se apoia no operador e no registro da cerimônia, não no bloco.',
    },
  },
  {
    txid: 'ef80a1812275eccb58a032cdeeb1769e4890949257578c45e78348bcc07040c6',
    block: 3463857,
    origin: 'dkg',
    label: {
      en: 'Survived a live injection of a bogus response (#394): an outsider holding only the public vault id posted a well-formed but cryptographically bogus signing response into a running 2-of-2 ceremony, and the coordinator skipped it and collected the real signatures. The chain shows a normal send. The injection is attested by the captured room trace, not by the block.',
      'pt-BR': 'Sobreviveu a uma injeção ao vivo de resposta falsa (#394): alguém de fora, só com o id público do cofre, postou numa cerimônia 2-de-2 em andamento uma resposta de assinatura bem formada e criptograficamente falsa, e o coordenador a ignorou e recolheu as assinaturas verdadeiras. A cadeia mostra um envio normal. A injeção é atestada pelo registro capturado da sala, não pelo bloco.',
    },
  },
  {
    txid: '047fe6cafe792f72c38eb6cd379e7c43be9c79cf20801288cab342580e896db3',
    block: 3464505,
    origin: 'dkg',
    label: {
      en: 'The relay blind to the payment (#63): a send from a 2-of-2 browser-DKG vault with the signing request sealed to keys the devices derive from their shares, so whoever runs the relay sees only ciphertext. The chain shows a normal send. The blindness of the relay is attested by the captured room trace, not by the block.',
      'pt-BR': 'O relay cego para o pagamento (#63): envio de um cofre 2-de-2 nascido de DKG no navegador, com o pedido de assinatura lacrado para chaves que os dispositivos derivam dos seus shares, de modo que quem opera o relay só vê texto cifrado. A cadeia mostra um envio normal. A cegueira do relay é atestada pelo registro capturado da sala, não pelo bloco.',
    },
  },
  {
    txid: '3fa08dceaa1d0a8f553ee68f6ddcf879b90f3cc7a19c370ace023ef5b2ecf81e',
    block: 3473869,
    origin: 'dkg',
    label: {
      en: 'Opaque from the outside, with a live payment inside (#476): a 2-of-3 vault proposed, approved, signed and sent while an observer holding only the vault id polled the coordinator. Every private read was refused and the public answer stayed identical, byte for byte, before, during and after. The chain shows only a shielded V6 transaction. The observation during the payment rests on the run the operator described, not on the block.',
      'pt-BR': 'Opaco por fora, com um pagamento acontecendo por dentro (#476): um cofre 2-de-3 propôs, aprovou, assinou e enviou enquanto um observador, só com o id do cofre, consultava o coordenador. Toda leitura privada foi recusada e a resposta pública ficou idêntica, byte a byte, antes, durante e depois. A cadeia mostra só uma transação V6 blindada. A observação durante o pagamento se apoia na execução descrita pelo operador, não no bloco.',
    },
  },
  {
    txid: '47e4e5dddedf08f6e92e25a69c17f7198a652e25e458107ffce2313a347ef291',
    block: 3475607,
    origin: 'dkg',
    label: {
      en: 'Every governance write authenticated (#288): a 2-of-3 vault where the proposal, the approval and the send were each signed by a key derived from the share of the seat, and refused without one. The chain cannot show this. What attests it is the coordinator refusing the identical request made without a signature.',
      'pt-BR': 'Toda escrita de governança autenticada (#288): um cofre 2-de-3 em que a proposta, a aprovação e o envio foram, cada um, assinados por uma chave derivada do share do assento, e recusados sem ela. A cadeia não mostra isso. O que atesta é o coordenador recusando o pedido idêntico feito sem assinatura.',
    },
  },
  {
    txid: '7d6b3dec5a39ebca1c8228304d5c347ab36b7f4283910b7acccd333aed7fc346',
    block: 3484231,
    origin: 'dkg',
    label: {
      en: 'A 2-of-3 vault signed with one seat deliberately absent, after the seat-poisoning fix (#399/#515). The 2-of-3 shape can be checked by anyone from the open vault endpoint of the coordinator. That a seat was left absent is attested by the operator who ran it and by nothing else.',
      'pt-BR': 'Um cofre 2-de-3 assinou com um assento ausente de propósito, depois da correção do envenenamento de assento (#399/#515). O formato 2-de-3 pode ser conferido por qualquer pessoa no endpoint aberto do cofre no coordenador. Que um assento ficou ausente é atestado pelo operador que executou, e por mais nada.',
    },
  },
  {
    txid: '075ecfe9f8664634ee906ac1cd1949edf60f77b81dc51afebf1203ddd662f685',
    block: 3484695,
    origin: 'dkg',
    label: {
      en: 'The device recognised the vault’s own change before signing (#281): a 2-of-2 vault sending 0.0001 ZEC in a transaction that carries change. The chain cannot show the check. What attests it is that the change went to the internal receiver of the vault, which differs from its receive address, and the device recognised it as its own. That send was signed before devices read the payment from the transaction itself and checked it against the approved one (#610), and an approval is not yet tied to the exact content of the proposal (#567).',
      'pt-BR': 'O dispositivo reconheceu o troco do próprio cofre antes de assinar (#281): um cofre 2-de-2 enviando 0,0001 ZEC numa transação que carrega troco. A cadeia não mostra a conferência. O que atesta é que o troco foi para o receptor interno do próprio cofre, diferente do endereço de recebimento, e o dispositivo o reconheceu como seu. Esse envio foi assinado antes de os aparelhos lerem o pagamento da própria transação e o conferirem com o aprovado (#610), e a aprovação ainda não fica presa ao conteúdo exato da proposta (#567).',
    },
  },
]

/** How many of the listed transactions came from each kind of vault. Counted, never typed. */
export function proofOriginCounts(): Record<ProofOrigin, number> {
  return {
    dealer: PROOF_TXS.filter((t) => t.origin === 'dealer').length,
    dkg: PROOF_TXS.filter((t) => t.origin === 'dkg').length,
  }
}
