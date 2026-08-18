import { AbsoluteFill, OffthreadVideo, staticFile } from "remotion";

/** seconds — match the Veo source clip so the loop cuts clean */
export const LOOP_DURATION = 8;
export const FPS = 30;

/**
 * The Konclave landing background loop: one continuous WHITE futuristic vault take
 * (the Veo image-to-video clip — see README). Keep motion slow and constant so the
 * loop point disappears. A very light white wash keeps hero text readable if this
 * is ever used raw; the landing also lays its own scrim on top.
 */
export const HeroLoop: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: "#F5F7FA" }}>
    <OffthreadVideo
      src={staticFile("konclave-vault-source.mp4")}
      style={{ width: "100%", height: "100%", objectFit: "cover" }}
      muted
    />
    {/* faint white grade so it stays on the "white line" of the brand */}
    <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(245,247,250,.18), rgba(245,247,250,.05))" }} />
  </AbsoluteFill>
);
