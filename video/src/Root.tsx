import { Composition } from "remotion";
import { HeroLoop, LOOP_DURATION, FPS } from "./HeroLoop";

/**
 * HeroLoop -> ui/public/videos/konclave-hero-loop.mp4 — the silent background loop the landing serves.
 * Drop the Veo clip into public/konclave-vault-source.mp4 first (see README.md).
 */
export const RemotionRoot: React.FC = () => (
  <Composition
    id="HeroLoop"
    component={HeroLoop}
    durationInFrames={LOOP_DURATION * FPS}
    fps={FPS}
    width={1920}
    height={1080}
  />
);
