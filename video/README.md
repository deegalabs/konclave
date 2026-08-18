# Konclave — hero background loop (Remotion)

Same pipeline as `deegalabs/lizzy/tokeneconomy/video`:

**Nano Banana** (keyframe) → **Veo** (image-to-video) → **Remotion** (this timeline) →
`ui/public/videos/` → the landing picks it up.

You generate the material in the **Google AI Studio / Flow UI** (that's where your prepaid
credit works — not the raw API, which hit the free-tier quota). Then drop the clip here and
Remotion renders the loop.

## 1. Generate the material (in the AI Studio / Flow UI)

**Keyframe — Nano Banana (image):**
> Ultra-clean **WHITE** futuristic scene, Apple-keynote aesthetic. A floating circular
> bank-vault door of brushed steel and frosted glass, concentric rings, a softly glowing
> **blue keyhole** at the center, on a bright white studio background with a faint perspective
> grid. Minimal, premium, high detail, cinematic soft light, 16:9.

Pick the best frame.

**Animate it — Veo (image-to-video, ~8s):**
> Slowly rotate the vault's concentric rings; a soft **blue** light pulse ripples outward from
> the keyhole as the vault is "approved together". Very slow, calm, constant motion; a gentle
> dolly-in. **Seamless loop, no text, no logos.** Bright white palette. 16:9.

Keep it ~8s and slow so the loop point disappears.

## 2. Drop the clip here
```
public/konclave-vault-source.mp4
```
(If it's not 8s, set `LOOP_DURATION` in `src/HeroLoop.tsx` to its real length.)

## 3. Preview + render
```bash
cd temp/video/konclave-hero
pnpm install          # or npm install
pnpm studio           # preview the loop
pnpm render:loop      # -> ui/public/videos/konclave-hero-loop.mp4
```

## 4. Wire it into the landing (I do this)
Set the one constant in `ui/src/screens/Intro.tsx`:
```ts
const HERO_VIDEO_SRC = '/videos/konclave-hero-loop.mp4'   // was '' → the 3D vault fallback
```
The landing renders it full-bleed under a scrim, and falls back to the CSS-3D vault under
`prefers-reduced-motion`.

> The `../veo-pipeline/` API script is **superseded** by this UI-generate + Remotion-assemble
> flow (the one your other project actually uses). Keep generating in the Studio/Flow UI.
