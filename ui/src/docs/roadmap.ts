// The public roadmap: where Konclave goes next, one step at a time, each step pointing at the GitHub
// issues and pull requests where the work is tracked. It is a plan, not a promise, and it carries no
// amounts or hour estimates (a test holds that): those belong to the founders' working notes.
//
// Issue titles are copied from GitHub as they read on ROADMAP_AS_OF, so showing them needs no network
// call (no third party learns who reads the docs). A title that changes on GitHub is updated here,
// and so is the date.

import type { L } from './content'

export const REPO = 'deegalabs/konclave'

/** When the steps and the titles below were last checked against GitHub. Shown on the page. */
export const ROADMAP_AS_OF = { iso: '2026-10-03', 'pt-BR': '3 de outubro de 2026', en: '3 October 2026' }

export type RefKind = 'issue' | 'pull'
export type Ref = { kind: RefKind; n: number }
export type StageStatus = 'now' | 'next' | 'planned' | 'later'

export type Stage = {
  id: string
  /** The step's place in the order. Only the numbered steps have one; later work does not. */
  n?: number
  status: StageStatus
  title: L
  body: L
  refs: Ref[]
}

const issue = (n: number): Ref => ({ kind: 'issue', n })

export const refKey = (r: Ref): string => `${r.kind}:${r.n}`

export const refUrl = (r: Ref): string =>
  `https://github.com/${REPO}/${r.kind === 'pull' ? 'pull' : 'issues'}/${r.n}`

/** Titles as they read on GitHub. Every key is used by some step, and every step's refs are here. */
export const REF_TITLES: Record<string, string> = {
  'issue:599': 'A restored vault keeps its viewing key unencrypted in browser storage',
  'issue:567': 'Proposal anchor: bind approvals to content first, then timestamp on chain (design for review)',
  'issue:577': "A member can claim a colleague's unclaimed seat, and then vote as them",
  'issue:575': 'An approval planted while a vault took unsigned writes keeps counting after it requires signatures',
  'issue:576': 'Two requests for one vault run unserialised when their query strings name another',
  'issue:610': 'A signing device does not yet check what it shows against what it signs, nor the fee or the memos',
  'issue:605': 'Let anyone check that the web app is a published release, and refuse updates that are not',
  'issue:516': 'Prove on the device: remove the viewing key from the server, and measure what it costs',
  'issue:583': "Remember whether this device has a backup, and show the vault's address only once it has one",
  'issue:584': 'Check a backup file on this device without importing it',
  'issue:586': 'The export dialog says "Removing…" while it exports, and import errors appear only in English',
  'issue:587': "The export file's name reveals the vault's name",
  'issue:588': 'A failure to register the seat after import is only logged to the console',
  'issue:214': 'Export / import your vault: cross-backend (helper ↔ local-first / desktop / frost-client)',
  'issue:309': "Tell the 'if you lose your device' story at the four moments it matters",
  'issue:58': 'Wire RTS social recovery + inheritance into a live vault UI',
  'issue:585': 'Report a lost device: stop sealing signing requests to it and refuse its writes',
  'issue:593': 'EPIC: recovery an ordinary member can do',
  'issue:406': 'Upgrade an existing vault in place, without a new DKG and without moving funds',
  'issue:601': 'Seal the proposals and member names the coordinator stores',
  'issue:476': 'Responses carry the viewing key and the roster in the clear to the browser',
  'issue:340': 'The signing room now carries governance metadata the relay can read',
  'issue:154': 'Add / change signers on an existing vault (FROST resharing), quorum-approved',
  'issue:251': 'Decaying-quorum recovery path (no custodian)',
  'issue:332': 'Start a payroll from the last one, so nobody retypes addresses every month',
  'issue:247': 'CSV batch import for payroll',
  'issue:300': 'The book records no settlement date and no fee, so it can never reconcile to the chain',
  'issue:305': 'is_public is asserted from a string prefix, and there is no book-vs-chain statement',
  'issue:189': 'Vault-shared beneficiary address-book (helper-backed), not per-device',
  'issue:245': 'Recipient allow-list + address book',
  'issue:151': 'Notifications: tell a member when a proposal needs them (approve / ready to sign / ceremony waiting)',
  'issue:125': 'Full in-app history (vault lifecycle, per-user, proposals) beyond the Ledger',
  'issue:250': 'Bounded auto-approve / spending allowance (skip full quorum under a limit)',
  'issue:150': 'R&D: fully async threshold signing (offline-tolerant, persistent sign-request)',
  'issue:212': 'Tauri desktop: from groundwork to a working per-platform build (MVP)',
  'issue:213': 'Relay selection + growable relay network (pick the nearest, federate over time)',
  'issue:53': 'R1: ZcashNames (ZNS) resolve in beneficiary/recipient',
  'issue:54': 'R2: Coinholder polling / protocol voting',
  'issue:370': 'A staging vault: somewhere to break things that is not the one holding real ZEC',
  'issue:141': 'Git/CI-based deploy for the helper and relay (stop manual railway up)',
  'issue:565': 'Scaling: what grows with vault count, and what must hold before 9,000 vaults',
}

/** The steps, in the order we intend to work on them. A step starts once the one before it is done. */
export const ROADMAP_STEPS: Stage[] = [
  {
    id: 'own-defects',
    n: 0,
    status: 'now',
    title: { 'pt-BR': 'Consertar os nossos defeitos', en: 'Fix our own defects' },
    body: {
      'pt-BR':
        'Antes de qualquer coisa nova: a chave de visualização que fica sem cifra no navegador depois de restaurar um backup; a aprovação, que ainda não fica presa ao que a proposta diz; um assento ainda livre que outro membro consegue ocupar para votar como o colega; dois defeitos do coordenador achados em revisão; um aparelho que, ao assinar, ainda não confere se o que mostra é o que assina, nem a taxa nem os memos; e nada ainda deixa um membro conferir que o app que o nosso servidor entrega é uma versão publicada.',
      en:
        'Before anything new: the viewing key left unencrypted in the browser after restoring a backup; approvals, which are not yet tied to what the proposal says; an unclaimed seat another member can take and then vote as its owner; two coordinator defects found in review; a signing device that does not yet check what it shows against what it signs, nor the fee or the memos; and nothing yet lets a member check that the app our server sends is a published release.',
    },
    refs: [issue(599), issue(567), issue(577), issue(575), issue(576), issue(610), issue(605)],
  },
  {
    id: 'measure-design-review',
    n: 1,
    status: 'next',
    title: { 'pt-BR': 'Medir, desenhar e revisar', en: 'Measure, design and review' },
    body: {
      'pt-BR':
        'Medir quanto custa, no navegador de um celular, procurar na blockchain os pagamentos do cofre e gerar a prova de cada transação, com um teste que qualquer pessoa roda. Escrever o plano técnico para tirar a chave de visualização do coordenador. E ter uma revisão independente desse plano, publicada na íntegra. Esta etapa espera por um revisor de fora do time.',
      en:
        'Measure what it costs, in a phone’s browser, to find the vault’s payments on the blockchain and to make the proof for each transaction, with a test anyone can run. Write the technical plan for taking the viewing key off the coordinator. And have an independent review of that plan, published in full. This step waits on a reviewer from outside the team.',
    },
    refs: [issue(516)],
  },
  {
    id: 'backup-you-trust',
    n: 2,
    status: 'planned',
    title: { 'pt-BR': 'Um backup que você sabe que funciona', en: 'A backup you know works' },
    body: {
      'pt-BR':
        'Conferir o backup dentro do app, sem precisar importá-lo. Dizer com clareza o que uma restauração fez. E ajudar cada membro a guardar uma segunda cópia.',
      en:
        'Check a backup inside the app, without importing it. Say plainly what a restore did. And help every member keep a second copy.',
    },
    refs: [issue(583), issue(584), issue(586), issue(587), issue(588), issue(214), issue(309)],
  },
  {
    id: 'viewing-key-on-device',
    n: 3,
    status: 'planned',
    title: { 'pt-BR': 'A chave de visualização no aparelho', en: 'The viewing key on the device' },
    body: {
      'pt-BR':
        'Construir o que a etapa 1 desenhar: cofres novos cuja chave de visualização nasce no aparelho de um membro e nunca vai ao coordenador. O próprio aparelho procura os pagamentos do cofre na blockchain, monta cada transação e gera a prova dela.',
      en:
        'Build what step 1 designs: new vaults whose viewing key is created on a member’s device and never reaches the coordinator. The device itself finds the vault’s payments on the blockchain, builds each transaction and makes its proof.',
    },
    refs: [issue(516)],
  },
  {
    id: 'lost-seat',
    n: 4,
    status: 'planned',
    title: { 'pt-BR': 'Recuperar um assento perdido', en: 'Get a lost seat back' },
    body: {
      'pt-BR':
        'Quem perdeu o aparelho recupera o assento com a ajuda dos outros membros, sem mover os fundos, depois de os outros confirmarem quem está pedindo.',
      en:
        'A member who lost a device gets the seat back with the other members’ help, without moving the funds, once the others have confirmed who is asking.',
    },
    refs: [issue(58), issue(585), issue(593)],
  },
  {
    id: 'existing-vaults',
    n: 5,
    status: 'planned',
    title: { 'pt-BR': 'Cofres que já existem: a chave de visualização sai do coordenador', en: 'Existing vaults: the viewing key leaves the coordinator' },
    body: {
      'pt-BR':
        'Os cofres que já existem deixam de depender da cópia da chave de visualização no coordenador, sem mover fundos. O que aprendermos vira um guia para outros times da Zcash que guardam uma chave de visualização num servidor.',
      en:
        'Existing vaults stop depending on the coordinator’s copy of the viewing key, without moving funds. What we learn becomes a guide for other Zcash teams that keep a viewing key on a server.',
    },
    refs: [issue(406)],
  },
  {
    id: 'coordinator-reads-nothing',
    n: 6,
    status: 'planned',
    title: { 'pt-BR': 'Um coordenador que não lê nomes nem propostas', en: 'A coordinator that cannot read names or proposals' },
    body: {
      'pt-BR':
        'Selar os nomes dos membros e, depois que o aparelho montar as transações, também as propostas. E diminuir o que a sala de assinatura deixa o relay ver. O coordenador ainda vê o endereço do cofre, quantos membros ele tem e quantos precisam aprovar.',
      en:
        'Seal the members’ names and, once devices build the transactions, the proposals too. And cut down what the signing room lets the relay see. The coordinator still sees the vault’s address, how many members it has and how many must approve.',
    },
    refs: [issue(601), issue(476), issue(340)],
  },
  {
    id: 'change-members',
    n: 7,
    status: 'planned',
    title: { 'pt-BR': 'Trocar membros e o quórum', en: 'Change members and the quorum' },
    body: {
      'pt-BR':
        'Trocar quem está no cofre, ou o quórum. O caminho desta etapa é guiado: criar um cofre novo com as pessoas certas e passar os fundos para ele numa transação aprovada pelo quórum. Mudar o próprio cofre, sem mover os fundos, fica para depois, porque a biblioteca da Foundation ainda não oferece mudar o quórum de uma chave existente.',
      en:
        'Change who is in a vault, or its quorum. This step guides the way that works today: create a new vault with the right people and move the funds to it in a transaction the quorum approves. Changing the vault itself, without moving funds, comes later, because the Foundation’s library does not yet offer changing the quorum of an existing key.',
    },
    refs: [issue(154), issue(251)],
  },
]

/** Work already mapped that has no place in the order yet. */
export const ROADMAP_LATER: Stage[] = [
  {
    id: 'deeper-treasury',
    status: 'later',
    title: { 'pt-BR': 'Tesouraria mais funda', en: 'A deeper treasury' },
    body: {
      'pt-BR':
        'Começar a folha a partir da última, importar a folha por planilha, um livro que fecha com a cadeia, e uma agenda de destinatários do cofre.',
      en:
        'Start a payroll from the last one, import a payroll from a spreadsheet, a ledger that reconciles to the chain, and an address book for the vault.',
    },
    refs: [issue(332), issue(247), issue(300), issue(305), issue(189), issue(245)],
  },
  {
    id: 'members-governance',
    status: 'later',
    title: { 'pt-BR': 'Membros e governança', en: 'Members and governance' },
    body: {
      'pt-BR':
        'Avisar quem precisa agir, um histórico completo no app, um limite de gasto sem o quórum inteiro, e assinar sem que todos estejam online ao mesmo tempo.',
      en:
        'Tell members when they need to act, a full history in the app, a spending allowance below the full quorum, and signing without everyone online at once.',
    },
    refs: [issue(151), issue(125), issue(250), issue(150)],
  },
  {
    id: 'reach',
    status: 'later',
    title: { 'pt-BR': 'Alcance', en: 'Reach' },
    body: {
      'pt-BR':
        'A versão desktop validada em cada sistema, uma rede de relays, nomes ZNS no destinatário, e votação de quem detém ZEC.',
      en:
        'The desktop version tested on each platform, a network of relays, ZNS names for recipients, and coinholder voting.',
    },
    refs: [issue(212), issue(213), issue(53), issue(54)],
  },
  {
    id: 'foundations',
    status: 'later',
    title: { 'pt-BR': 'Base e operação', en: 'Foundations and operations' },
    body: {
      'pt-BR':
        'Um ambiente de teste que já existe, à parte do que guarda ZEC de verdade, e que ainda precisa saber falhar de propósito; entrega automática dos servidores; e o que precisa aguentar quando houver milhares de cofres.',
      en:
        'A test environment that already exists apart from the one holding real ZEC, and still has to learn to fail on purpose; automatic deploys for the servers; and what has to hold once there are thousands of vaults.',
    },
    refs: [issue(370), issue(141), issue(565)],
  },
]
