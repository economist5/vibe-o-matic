/**
 * Shared scene / action / mood presets for vibe-o-matic.
 *
 * Single source of truth used by:
 *   - app/page.tsx (web UI emoji pickers)
 *   - lib/vibeify-agent.ts (server-side gpt-4o-mini agent that picks presets
 *     from a free-text intent when the x402 endpoint runs in agent mode)
 *
 * Each preset has a stable `id` (kebab-case, never displayed to humans) that
 * the agent returns; the server resolves the id back to the full prompt text
 * before passing it to the renderer. This keeps free-form text out of the
 * agentic path and lets us version preset wording without changing the API.
 */

export type ScenePreset = {
  /** Stable machine id (e.g. "neon-street"). */
  id: string;
  /** Display emoji. */
  emoji: string;
  /** Short human label. */
  label: string;
  /** Full prompt text sent to the renderer. */
  scene: string;
  /** Filenames (in public/scenes/) of background reference images. */
  bgImages?: string[];
};

export const SCENE_PRESETS: ScenePreset[] = [
  {
    id: "tropical-beach",
    emoji: "🏖️",
    label: "Tropical beach",
    scene:
      "a sun-drenched tropical beach with palm trees, a turquoise shoreline, pastel beach umbrellas and a small longtail boat tied to a wooden post",
    bgImages: ["tropical-beach.webp"],
  },
  {
    id: "chateau-godl",
    emoji: "🏰",
    label: "Château de GODL",
    scene:
      "the back grounds of the Château de GODL — an opulent gold-and-white Vibetown chateau with a heart-shaped swimming pool, golden palm trees, white loungers, and the chateau's elegant facade in soft focus",
    bgImages: ["chateau.webp"],
  },
  {
    id: "neon-street",
    emoji: "🌃",
    label: "Neon street",
    scene:
      "a wide retro-futuristic Vibetown city street at dusk — a broad streetscape view showing multiple storefronts with rounded neon signage glowing in cyan, blue, and pink, reflective wet pavement catching the colored light, and a vintage scooter parked at the curb. ONE prominent neon sign on the street is the OpenSea logo (a glowing cyan-blue circular sign with a white sailboat-on-waves icon and 'OPENSEA' wordmark, exactly as shown in the OpenSea reference image) — mount it on a storefront facade as if it were any other neon shop sign, using the exact OpenSea brand colors (Sea Blue #2081E2, Marina Blue #15B2E5, Aqua #2BCDE4) for the neon tubing. Wide-enough framing to show several signs and the depth of the street, while still keeping the characters readable in the foreground",
    bgImages: ["neon-street.webp", "opensea-neon-logo.png"],
  },
  {
    id: "rooftop-sunset",
    emoji: "🌅",
    label: "Rooftop sunset",
    scene:
      "a small rooftop terrace at golden hour with a vintage rattan chair, string lights, a low table with a glass of juice, and city rooftops in the soft-blurred background",
    bgImages: ["rooftop-sunset.webp"],
  },
  {
    id: "lagoon-pier",
    emoji: "🏝️",
    label: "Lagoon pier",
    scene:
      "a wooden pier extending into a glassy turquoise lagoon, with floating leaves on the water and a small striped beach towel folded on the planks",
    bgImages: ["lagoon-pier.webp"],
  },
  {
    id: "coastal-drive",
    emoji: "🚗",
    label: "Coastal drive",
    scene:
      "a coastal road at sunrise with a mint-green retro convertible parked by the curb, palm shadows on the asphalt, and a vintage gas pump in the distance — render the subjects standing beside the car",
    bgImages: ["coastal-drive-street.webp", "coastal-drive-car.png"],
  },
];

export type ActionPreset = {
  id: string;
  emoji: string;
  label: string;
  /** Full action text appended into the prompt's SUBJECT ACTION line. */
  prompt: string;
};

export const ACTION_PRESETS: ActionPreset[] = [
  {
    id: "friendship",
    emoji: "🤝",
    label: "Friendship",
    prompt:
      "in an easy, connected social stance — shoulders relaxed, arms loose or casually draped across nearby subjects' shoulders/backs, bodies angled slightly toward each other in warm companionship",
  },
  {
    id: "celebrate",
    emoji: "🎉",
    label: "Celebrate",
    prompt:
      "both arms thrown high overhead mid-cheer, fists open and palms forward, mouths laughing, with small bright confetti pieces drifting in the air around them",
  },
  {
    id: "group-selfie",
    emoji: "🤳",
    label: "Selfie",
    prompt:
      "facing the camera with one arm extended high and forward holding a smartphone, the phone visible in-hand pointing back at the subjects, faces tilted slightly inward into the frame",
  },
  {
    id: "zen",
    emoji: "🧘",
    label: "Zen",
    prompt:
      "seated cross-legged on the ground in a calm meditative pose, eyes softly closed, hands resting palms-up on the knees with thumb and index finger gently touching",
  },
  {
    id: "dance",
    emoji: "💃",
    label: "Dance",
    prompt:
      "caught mid-dance with one arm raised overhead and the other extended outward, hip popped to one side, weight on a bent leg with the opposite foot pointed",
  },
  {
    id: "motorcycle",
    emoji: "🏍️",
    label: "Motorcycle",
    prompt:
      "straddling a stout vintage café-racer motorcycle — a glossy candy-red rounded fuel tank, a single tan leather saddle seat, low chrome handlebars, exposed chrome exhaust pipe running along the side, fat whitewall tires with chrome-spoked wheels — feet planted firmly on the ground, both hands gripping the bars",
  },
  {
    id: "helicopter",
    emoji: "🚁",
    label: "Helicopter",
    prompt:
      "standing beside a small bubble-canopy helicopter parked on the ground — a rounded transparent glass cockpit dome, a slender exposed lattice tail boom ending in a small tail rotor, twin tubular landing skids underneath, four slim main rotor blades drooping gently overhead — one hand resting casually on the open cabin door",
  },
];

export type MoodPreset = {
  id: string;
  emoji: string;
  label: string;
  /** Mood text appended into the prompt's STYLE line. */
  prompt: string;
};

// All mood prompts describe ENVIRONMENT/SCENE/LIGHTING ONLY — never
// character body color, clothing color, skin, or material. The render
// pipeline scopes mood to environment in buildVibetownPromptForGvcSource
// (the "STYLE / Mood applies to the environment and the ambient light
// wrapping the character" instruction), but redundant anchoring here
// keeps Flux from drifting under its strong style priors. Palette refs
// say "environment palette" / "scene palette"; rim-light language is
// "edge glow wrapping the silhouette" so Flux applies the technique
// without re-coloring the character itself.
export const MOOD_PRESETS: MoodPreset[] = [
  {
    id: "joyful",
    emoji: "😊",
    label: "Joyful",
    prompt:
      "warm joyful glow — golden-hour sunlight, warm amber and honey environment palette, soft bounce light across the scene surfaces",
  },
  {
    id: "chill",
    emoji: "😎",
    label: "Chill",
    prompt:
      "cool and effortless overcast environment — muted teal-and-blue scene palette, soft diffused overhead light, gentle shadows, low-key relaxed atmosphere",
  },
  {
    id: "hyped",
    emoji: "🔥",
    label: "Hyped",
    prompt:
      "hyped electric atmosphere — highly saturated neon environment palette of magenta, cyan, and electric red, sharp contrast, kinetic light streaks blurring across the background",
  },
  {
    id: "dreamy",
    emoji: "🌙",
    label: "Dreamy",
    prompt:
      "dreamy and ethereal scene — soft moonlit calm in the environment with hazy bokeh in the background",
  },
  {
    id: "heroic",
    emoji: "💪",
    label: "Heroic",
    prompt:
      "heroic cinematic atmosphere — low-angle framing, strong rim light from behind, deeply saturated environment palette with warm key light and cool fill, contre-jour edge glow wrapping the character's silhouette",
  },
  {
    id: "noir",
    emoji: "🕶️",
    label: "Noir",
    prompt:
      "moody noir environment lighting — deep shadows in the surrounding scene, sharp rim light along the character's silhouette edge, dramatic side-lit environmental mystery",
  },
  {
    id: "playful",
    emoji: "🎈",
    label: "Playful",
    prompt:
      "whimsical and bouncy scene atmosphere — bright pastel candy environment palette, soft diffused light, lighthearted energy in the surroundings",
  },
  {
    id: "retro",
    emoji: "📼",
    label: "Retro",
    prompt:
      "nostalgic retro environment grading — faded film tones in the image grade, gentle film grain across the frame, sun-bleached 70s environment palette",
  },
];

export type VibeSize = "1024x1024" | "1024x1536" | "1536x1024";

export const VIBE_SIZES: VibeSize[] = [
  "1024x1024",
  "1024x1536",
  "1536x1024",
];

/** Resolve a preset id to its full preset (or undefined if unknown). */
export function findScene(id: string | null | undefined): ScenePreset | undefined {
  if (!id) return undefined;
  return SCENE_PRESETS.find((p) => p.id === id);
}

export function findAction(id: string | null | undefined): ActionPreset | undefined {
  if (!id) return undefined;
  return ACTION_PRESETS.find((p) => p.id === id);
}

export function findMood(id: string | null | undefined): MoodPreset | undefined {
  if (!id) return undefined;
  return MOOD_PRESETS.find((p) => p.id === id);
}
