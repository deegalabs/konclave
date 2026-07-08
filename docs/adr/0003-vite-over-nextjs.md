# ADR-0003 — Vite + React em vez de Next.js para o Rosto

- **Status:** aceito
- **Data:** 2026-07-01
- **Contexto:** [ADR-0001](0001-decisoes-fechadas.md) fixou "Frontend: Next.js em static
  export" como decisão de menor consequência, a confirmar na execução. Ao iniciar a
  Fase 5 (o app de verdade), a escolha foi reavaliada.

## Decisão

Usar **Vite + React + TypeScript** (não Next.js) para o Rosto.

## Porquê

- O Konclave é um **app desktop Tauri**, não um site. Não há SSR, rotas de servidor,
  SEO nem edge — todo o valor do Next.js (o runtime de servidor) é **inaplicável**.
- O que a Tauri consome é um **bundle estático** (`file://`). Vite entrega isso
  nativamente, com build mais leve e rápido; Next.js exigiria `output: export` e ainda
  carregaria peso desnecessário.
- Vite é o caminho **padrão e recomendado** para frontends Tauri.

## Consequências

- Estrutura simples: `ui/` = app Vite; `ui/design/` = design system + protótipos;
  `ui/src/lacre.css` = o design system aplicado.
- Build para `file://` exige `base: './'` (relativo) no `vite.config.ts` — já
  configurado. (Nota: módulos ES não carregam via `file://` fora do Tauri por CORS;
  para preview usa-se `vite preview` ou a flag de dev.)
- Sem perda: o design (tokens + componentes em `lacre.css`) independe do framework.
