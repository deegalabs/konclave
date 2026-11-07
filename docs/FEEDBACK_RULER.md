# Feedback ruler: one vehicle per class of event

> **Status:** draft of 2026-10-30, revised the same day after review; accepted on 2026-11-03, with
> the inventory recounted on staging that day. The feedback-layer work follows from it, one issue per
> screen when the work starts.
> **What it is:** the rule that decides **how** the product tells the member what happened. The
> class of the event picks the vehicle; the screen never picks.
> **What it is not:** it changes neither the money path nor the inline messages it already has. It
> does not touch the maintainer's files; the ruler applies to them too, and the changes there are
> the maintainer's.
>
> **Where it comes from:** the product owner's review of 2026-07-01 named three gaps: no success
> confirmation when proposing a payment, no notification when sending for approval, and no error
> notifications. They are the same mistake seen three times: the vehicle is chosen screen by screen,
> so one event looks one way on one screen, another way on the next, and is silent on the third.
> The inventory below was first taken on 2026-10-30 and recounted in the code on 2026-11-03
> (`ui/src`, staging `5571690`), after the "could not read" state reached the book, the proposals and
> five other screens (#766 to #771, #801).

---

## 0. The ruler on one page

| # | Class | Vehicle | Example | Never |
|---|---|---|---|---|
| 1 | **The result of your own action** | passing notice (toast) | "Aprovação registrada", "Copiado", "Importado" | carrying something the member must act on; a money failure only in a notice that fades |
| 2 | **Something that happened away from you** (another member approved, a payment went out, a proposal expired) | counter and "since last time" list | "3 novidades: Bob aprovou o aluguel; a folha de outubro foi enviada; 1 proposta expirou" | a toast (you were not there; it fades before it is read) |
| 3 | **A condition that lasts** (vault without protection, a service out of reach, a network upgrade coming) | standing banner | "Cofre aberto: quem tiver o link lê este cofre"; "Sem ligação com o servidor do cofre desde 14:02" | disappearing while the condition lasts; appearing without the next action |
| 4 | **Loading** | a skeleton in the shape of the content to come, plus the progress bar at the top | grey lines where the book's lines will be | an empty screen; a generic spinner in place of content; a skeleton forever |
| 5 | **Could not read** | its own state, said out loud, with "Tentar de novo" | "Não deu para ler os membros. O cofre e a sua parte continuam neste aparelho." | an empty list in place of a failed read; a skeleton that never ends |
| 6 | **What you asked for failed** | an inline message, where the action is, with what to do | "Endereço inválido: o cofre paga só endereço blindado (u1...)" | only a toast; an error code; a stack |
| 7 | **Needs you** | the dashboard's desk (bands by urgency) and the counter of class 2 | "Assinar: 1", "Aprovar: 2" | a loose notification with nowhere to act |
| 8 | **Locked, or not available on this path** | the unlock veil; "Em breve" with the reason | "Importar CSV ainda roda só na versão local" | a dead button with no explanation |
| 9 | **It broke** | an error screen in the member's language, with a way out | "Algo quebrou nesta tela. Voltar ao início." | a white screen; English for a Portuguese member |

---

## 1. Why a ruler

- The three gaps above come from one missing rule: nothing says which vehicle each class uses.
- With the ruler, a new screen does not choose: it looks at the class and uses the vehicle. And an
  old screen that departs from the ruler is a nameable defect, not an opinion.
- The ruler is testable: "every screen that reads has state 5" becomes a source scan, like the ones
  the project already runs for other rules.

---

## 2. The vehicles that already exist

Everything below is in the code today. The ruler creates no new vehicle; it says when each one
comes in.

| Vehicle | Where | What it already does |
|---|---|---|
| Toast | `ui/src/toast.tsx` | four kinds (ok, info, warning, error); lasts 3.5 s, 3.5 s, 6 s and 9 s; at most 3 in the stack; a repeat replaces instead of stacking; hovering or focusing holds the clock; Esc closes the newest; warning and error are announced assertively to a screen reader; colour never alone (each kind has a sign) |
| Skeleton | `ui/src/skeleton.tsx` | `Skeleton` and seven shapes (`SkeletonStatus`, `SkeletonStat`, `SkeletonRows`, `SkeletonRoster`, `SkeletonForm`, `SkeletonDetail`, `SkeletonQr`); announces "Carregando" once per screen (#765) |
| Progress bar | `ui/src/loading.tsx` | a thin bar at the top while any screen fetches; each screen holds its content until `ready` |
| Standing banner | `BannerWarn` in `ui/src/components.tsx` | used on the dashboard (open vault) and on Receive (address differs from the one on record); the dashboard's network-upgrade notice is its own element (`upgrade-notice.ts`) |
| "Em breve" with a reason | `Soon` in `ui/src/components.tsx` | used on Intro (2) and New payroll (CSV import on the web); the book's CSV export now runs on the web and no longer needs it |
| "Could not read" state | `ui/src/ReadState.tsx` (#766), reasons in `ui/src/read-failure.ts` | title, why and who was asked, what still holds, "Tentar de novo"; focus moves to the message after a retry that fails; a compact form above rows kept from an earlier read. Used by seven screens; Members keeps its own version of the same state (#315), the one `ReadState` was modelled on |
| Generic spinner | `Loading` in `ui/src/components.tsx` | a ring with "Carregando". Still exported, used by **no screen** since the loading shapes replaced it (#765, #766, #767, #768, #800) |
| Unlock veil | `ui/src/LockOverlay.tsx` | asks for the passphrase in place, without sending the member to the list |
| Error screen and 404 | `ui/src/ErrorBoundary.tsx`, `screens/NotFound.tsx` | in the member's language, reading the dictionary directly (#318) |
| New-build notice | `ui/src/UpdatePrompt.tsx` | says a new build exists and offers to reload |

---

## 3. Where each class stands today, screen by screen

Counts from staging `5571690` (2026-11-03). How they were taken, so the next recount compares like
with like: **toast** = calls to `toast.ok`, `.warn`, `.err` or `.info` in the screen's file (a call
site, not a message seen); **skeleton** = elements `<Skeleton…>` of any shape; **spinner** = elements
`<Loading>`; **state 5** = whether the screen says a failed read. The 30/10 table counted another way
and its numbers do not reproduce, so the two tables are not compared line by line. A "0" is not a
defect by itself: it means the screen has no action of that class, or the vehicle is missing. The
last column says which.

| Screen | Toast (1) | Skeleton (4) | Generic spinner | State 5 | Situation |
|---|---|---|---|---|---|
| Dashboard | 0 | 3 | 0 | to check | the maintainer's file; a failed poll keeps what the screen has; banner for an open vault, notice for a network upgrade |
| Ledger | 0 | 1 | 0 | **yes** (#770) | a failed first read says so; failed refreshes after a good read show the compact line above the rows |
| Proposals | 0 | 1 | 0 | **yes** (#769) | a failed read is no longer an empty list |
| Proposal | 2 | 1 | 0 | **yes** (#768) | toasts for approve or refuse, and for a vote that failed |
| New payment | 2 | 1 | 0 | **no** | toasts for sent and for a failed send; a failed read of the vault is not said (the vault name stays "…") |
| New payroll | 4 | 2 | 0 | **no** | toasts for imported, partly imported, sent, and a failed send; a failed read of the vault is not said |
| Members | 2 | 1 | 0 | **yes** (#315, its own) | toast for a saved name |
| People | 4 | 1 | 0 | **yes** (#766) | toasts for saved, saved with the old entry kept, removed, and a removal that failed |
| Receive | 1 | 3 | 0 | **yes** (#767) | "Copiado" announced through a live region, and a toast when the copy fails; has a banner |
| Settings | 2 | 8 | 0 | **no** | toasts for the backup saved or copied; rotating the passphrase: to check whether it says so; a failed read of the vault: to check what it shows |
| Vaults | 2 | 0 | 0 | **yes** (#801) | toasts for a vault removed and imported |
| Evidence (Ceremonies) | 0 | 1 | 0 | **yes** (#768) | the list of signatures |
| Proof | 2 | 0 | 0 | not a read | toasts for copied and for a copy that failed |
| Activity | 0 | 0 | 0 | not a read | a tab bar over the lists; the natural home of class 2 (counter and list) |
| Signing panel | 4 | 0 | 0 | yes (its own) | the maintainer's file; money path |

Facts checked on `5571690`: the generic spinner appears on no screen; `ReadState` is used by
Ceremonies, Ledger, People, Proposal, Proposals, Receive and Vaults; Members has its own state
(`members.retry`); New payment, New payroll and Settings read the vault without saying a failure.

---

## 4. The rules of each vehicle

**Toast (class 1).** One sentence, past tense, short ("Aprovação registrada"). Never a link the
member has to click. Never the only place of a failure on the money path: there the message stays
inline (class 6) and the toast only repeats it. Two identical clicks show one notice, not two.

**Counter and list (class 2).** Per vault. Counts what happened since the member last saw the
screen, by kind (approvals, sends, confirmations, expirations, refusals). The list says who, what and
when, one line per event, and clears once seen. No toast for what happened away from the member.

**Standing banner (class 3).** Says the condition, the consequence and the next action, in that
order. Stays while the condition lasts and leaves on its own when it ends. One banner per condition;
with two, the graver on top. Never a banner for the result of an action (that is class 1).

**Skeleton (class 4).** In the shape of the content to come: lines for a list, blocks for numbers,
pills for chips. The top bar runs alongside. A skeleton has a deadline: if nothing arrived, it
becomes class 5. Never a spinner where the content has a known shape.

**Could not read (class 5).** A title, one honest line and "Tentar de novo". Focus moves to the
message when it returns. It says what still holds ("o cofre e a sua parte continuam neste
aparelho"). Never an empty list in place of a failed read: empty is one fact ("nenhuma proposta"),
failure is another.

**What you asked for failed (class 6).** Where the action is, in the member's language, one
sentence with what to do. No code, no stack. The money path already does this and does not change.

**Needs you (class 7).** It has a place: the dashboard's desk, by urgency. The counter of class 2
points there. Never a loose notice with nowhere to act.

**Locked or not available (class 8).** Unlock in place, without sending the member to the list. A
feature that exists on one path only appears with "Em breve" and the reason, never as a dead button.

**It broke (class 9).** Its own screen, in the member's language, with a way out. It exists (#318).

---

## 5. Accessibility already in the code, and kept

- `role="status"` for loading and quiet notices; `role="alert"` and an assertive announcement for
  warning and error.
- Focus moves to the "could not read" message when it returns; Esc closes the newest notice;
  hovering or focusing holds the toast's clock.
- Colour never alone: sign and word on every state.
- A tap target of at least 24 by 24 on the close button (#320).

---

## 6. What follows from the ruler

- **The root is built:** `ReadState` (#766) is the one component for class 5, used by seven screens,
  and a read that takes more than 4 s is cut and said as a timeout (`getJson` in `ui/src/api.ts`), so
  a skeleton no longer waits forever. What is left: New payment, New payroll and Settings, which read
  the vault without saying a failure; Members, which could move to the shared component; and a source
  scan that every screen that reads uses it. Today each screen has its own test, not a scan.
- The generic spinner is gone from the screens; what is left is removing the unused `Loading` export.
  Give a notice (class 1) to the actions that end in silence today, after checking each one; a banner
  for "no link to the vault's server".
- The counter and the "since last time" list (class 2), per vault, on Activity and on the dashboard
  when the maintainer frees that file.
- Each item becomes a neutral issue, named for the screen or the defect, when the work starts.

---

## 7. What the ruler does not decide

- How the money path speaks: the inline messages of signing and sending are the maintainer's.
- The text of each notice: that belongs to the vocabulary guide
  ([VOCABULARY_AND_COPY.md](VOCABULARY_AND_COPY.md)).
- The look of the vehicles: tokens, shadow and motion belong to the visual layer. Here, only the
  rule of when.
