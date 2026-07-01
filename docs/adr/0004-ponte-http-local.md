# ADR-0004 — Ponte HTTP local (loopback) entre Rosto e Orquestrador; empacotamento Tauri vira roadmap

- **Status:** aceito
- **Data:** 2026-07-01
- **Contexto:** [ADR-0003](0003-vite-over-nextjs.md) assumiu o Konclave como **app desktop
  Tauri** — o Rosto (bundle estático) rodando dentro de uma webview Tauri, falando com o
  Orquestrador por **IPC**. Ao chegar na Fase 5c (casca Tauri + IPC), a validação de
  go/no-go — "uma janela Tauri renderiza na máquina Windows do desenvolvedor via WSLg?" —
  **falhou de forma reprodutível**: o WSLg registra a janela (ícone na barra) mas **não
  pinta o conteúdo**, mesmo com renderização por software (`LIBGL_ALWAYS_SOFTWARE=1`,
  backend X11). É uma limitação do ambiente WSLg desta máquina, não do código.

  Consertar o WSLg a fundo (atualização de WSL/driver de GPU/Windows) é incerto e, mesmo
  se resolvido pontualmente, um WSLg instável é **risco para a demo ao vivo** do hackathon.

## Decisão

Ligar **Rosto ↔ Orquestrador por HTTP em loopback** (`127.0.0.1`), não por IPC Tauri:

- O Orquestrador expõe um **servidor local** (`konclave serve`) que:
  1. serve o bundle estático do Rosto (`rosto/dist`), e
  2. expõe a API sob `/api/*` (JSON), envolvendo o núcleo já testado (Store, wallet reads,
     máquina de estados de proposta, orquestração dos binários oficiais).
- O Rosto, no navegador (ou numa futura webview), consome essa API **na mesma origem**
  (sem CORS).
- **Empacotamento Tauri** (binário único desktop para Windows/macOS/Linux) passa a ser
  **item de roadmap**, não de MVP: a casca Tauri reaproveita exatamente este mesmo
  Orquestrador e o mesmo Rosto.

## Porquê

- **Demonstrável no Windows sem WSLg.** O navegador do Windows alcança um servidor que
  escuta em `127.0.0.1` dentro do WSL2 (localhost forwarding). Não depende da renderização
  de janela do WSLg, que é o ponto quebrado.
- **Continua local-first e shielded-first.** O servidor escuta **apenas em loopback** — não
  há superfície de rede; nada sai do aparelho. A propriedade de segurança do produto se
  mantém: é um daemon local + uma UI local, na mesma máquina.
- **Desacopla UI de núcleo.** A mesma API serve a webview Tauri (produto empacotado) e o
  navegador (demo/desenvolvimento). O núcleo Rust não muda; só a camada de transporte
  (HTTP em vez de `invoke`) — uma casca fina.
- **Sem retrabalho.** O Rosto e o Orquestrador já existem e são testados; adiciona-se
  apenas o `serve` (roteamento + estáticos + handlers JSON) por cima.

## Consequências

- **Nova superfície:** um bin `konclave` no crate `orquestrador` com o subcomando `serve`
  (`--port`, `--web <dir>`, `--db <path>`). Bind **fixo em `127.0.0.1`** — nunca `0.0.0.0`.
- **Dependência mínima:** um servidor HTTP bloqueante leve (`tiny_http`), coerente com o
  núcleo síncrono (rusqlite/subprocessos são bloqueantes) — sem arrastar runtime async.
  Roteamento e handlers ficam em `server.rs`, testáveis sem abrir socket (uma função
  `handle(method, path, state) -> Response` pura o suficiente para testes destrutivos).
- **HashRouter continua adequado:** as rotas do Rosto vivem no fragmento (`/#/...`), então o
  servidor não precisa de fallback de rota SPA — serve arquivos reais e `index.html` em `/`.
- **Segredos:** a API **nunca** expõe shares nem material selado; só material público e
  bookkeeping local (idêntico à disciplina do Store). Endpoints de assinatura orquestram a
  cerimônia FROST server-side sem que a chave transite pela camada HTTP.
- **Roadmap:** empacotar como binário único (Tauri no macOS/Windows nativo, ou uma webview
  local) para distribuição ao usuário final não-técnico — a garantia local-first não muda,
  muda só a forma de entrega. Registrado como dívida de empacotamento, não de arquitetura.
