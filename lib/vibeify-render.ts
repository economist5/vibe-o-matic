import { NextResponse } from "next/server";
import sharp from "sharp";
import { describeSubject } from "./vibeify-describe";
import { renderWithFlux } from "./vibeify-flux";
import {
  loadGvcReferences,
  loadSceneBackgrounds,
  type GvcReference,
} from "./vibeify-references";
import { pickVibeParams } from "./vibeify-agent";

export type VibeifySize = "1024x1024" | "1024x1536" | "1536x1024";

/**
 * What the source image actually is. Drives whether we run the describer
 * (photos) or use the source itself as a reference image (GVC NFTs).
 *
 * - "photo"     → user upload. Describer extracts identity markers
 *                 (hair / clothing / accessories) as text; canonical
 *                 GVC face refs anchor the noseless smile aesthetic.
 *                 Source pixels never reach Flux.
 * - "gvc-token" → user loaded a GVC NFT via the token-ID picker. The
 *                 source IS a canonical Vibetown character — we skip the
 *                 describer (no human-skin-tone translation loss) and
 *                 inject the NFT as an extra reference image. Face refs
 *                 are dropped (the source already defines the face).
 */
export type SourceKind = "photo" | "gvc-token";

/**
 * Downscale the source image if it's larger than ~1024px on its longest
 * edge. We don't need this for Flux's MP budget (per-ref cost is
 * effectively fixed regardless of pixel dimensions — see the FACE_PRIORITY
 * note in vibeify-references.ts), but we DO want to keep transfer time
 * to Flux + base64 encode size reasonable. A 1024px JPEG is plenty for
 * the model to read identity from.
 */
async function downscaleForReference(
  buffer: Buffer,
  mime: string
): Promise<{ buffer: Buffer; mime: string }> {
  try {
    const image = sharp(buffer);
    const meta = await image.metadata();
    const MAX = 1024;
    if (
      meta.width &&
      meta.height &&
      Math.max(meta.width, meta.height) <= MAX
    ) {
      return { buffer, mime };
    }
    const resized = await image
      .resize(MAX, MAX, { fit: "inside", withoutEnlargement: true })
      .toBuffer();
    // Resize() preserves format by default — keep original mime.
    return { buffer: resized, mime };
  } catch (e) {
    // If sharp blows up on a weird input format, fall back to the raw bytes.
    console.warn(
      `[vibeify] source downscale failed (using raw bytes): ${(e as Error).message}`
    );
    return { buffer, mime };
  }
}

/**
 * v2.2 prompt — "vision-described, multi-reference render".
 *
 * Source pixels still never reach the image-gen model (today FLUX.2 [pro]).
 * We pass SEVEN reference
 * images instead of one:
 *   - GVC-STYLE-REFERENCE.png — body T-pose template
 *   - face-*.jpg × 6 — canonical noseless GVC faces in different
 *     expressions (meditation, dead, laugh, mischievous, happy, puppy)
 *
 * The variety across face refs lets the model extract the COMMON FEATURE
 * (noseless smooth front) without locking to one expression. The face list
 * is named explicitly in the prompt so the model can pick the closest
 * expression match for each described subject.
 *
 * v1 and v2 prompts are preserved in lib/prompts-backup.ts.
 */
/**
 * Build the system prompt for the GVC-token-source path.
 *
 * Different shape from the photo path: there's no describer text to inject
 * (the source NFT IS the identity reference), and we explicitly tell Flux
 * the SOURCE-CHARACTER reference is the ground truth for body color, type,
 * hair, accessories — preserve those, apply only the scene/action/mood
 * instructions on top.
 *
 * Face refs are omitted (the source already shows the canonical noseless
 * GVC face), so the face-reference section of the prompt doesn't appear.
 */
export function buildVibetownPromptForGvcSource(
  sceneBgFilenames: string[],
  scene: string,
  action: string,
  mood: string
) {
  const sceneText =
    scene.trim() ||
    "a calm, premium Vibetown setting that complements the uploaded subject";
  const actionText = action.trim();
  const moodText = mood.trim();

  return `You are rendering a Good Vibes Club / Vibetown vinyl figurine into a new scene, pose, and mood. The source character is supplied directly as a reference image — preserve its identity exactly while restyling the scene, action, and lighting per the instructions below.

REFERENCE IMAGES (in priority order — image 1 is the DOMINANT anchor)
1. SOURCE-CHARACTER reference — the canonical GVC Citizen of Vibetown to render. This is the GROUND TRUTH for the subject's identity and the DOMINANT visual anchor for this render:
   - body / skin color (preserve EXACTLY — including saturated stylized colors like yellow, mint, pink, blue, gold; do NOT translate these to human skin tones)
   - character type (Default, Robot, Alien, etc.)
   - hair color, length, style
   - eye style (open dots, closed curves, laser, X-eyes, etc. — match the source)
   - all clothing and accessories (jacket, hat, glasses, jewelry, items in hand)
   - any patches, prints, logos, badges, or graphics visible on clothing
   The source character may be shown in a neutral pose; the rendered output places that same character into the new scene + pose + mood described below.
2. GVC-STYLE-REFERENCE.png — body proportions template (shown as a T-pose from three angles purely for measurement; the T-pose stance is NOT a pose to copy and its appearance is NOT the character — the character moves per SUBJECT ACTION and looks like SOURCE-CHARACTER above).${
    sceneBgFilenames.length > 0
      ? `
3. Scene reference image(s) — canonical Vibetown environment for this render:
${sceneBgFilenames.map((n) => `  - ${n}`).join("\n")}
   Match the scene reference(s) for color palette, architecture, materials, props, lighting mood, time of day, and overall Vibetown aesthetic. Insert the source character naturally into this environment. You may adjust framing/camera distance to fit the action. Do NOT copy any characters that appear in the scene reference itself — the only character in the output is the SOURCE-CHARACTER above.`
      : ""
  }

WHAT TO PRESERVE FROM THE SOURCE
- Exact body / skin color, including non-human colors (yellow, mint, blue, etc.). Never translate to human Mediterranean tones.
- Character type (Default, Robot, Alien, etc.) and any species-specific features.
- Hair color, length, style — exactly as shown.
- Eye style — open dots / closed curves / laser / X-eyes etc. as shown.
- Mouth: ONE simple small Vibetown-style curved line if visible on the source; if the source has no mouth (e.g. bearded), keep no mouth.
- All clothing pieces, in the same colors and configuration as the source.
- All visible accessories (hat, glasses, jewelry, items in hands).
- Any patches, pins, badges, prints, embroidery, or graphics on clothing — keep them exactly.

WHAT TO CHANGE
- Pose / body language → per SUBJECT ACTION below.
- Environment / scene → per SCENE below and the scene reference image(s).
- Lighting, color palette, atmosphere → per STYLE / Mood below.

DO NOT ADD
- Brand text (e.g. literal "GVC" letters) on clothing unless those exact letters are visibly present on the source character's clothing.
- Anatomical realism to the face (no nose, no eyebrows, no realistic lips).
- Extra characters not present in the source.

SCENE
${sceneText}

${actionText ? `SUBJECT ACTION\n${actionText}\n\n` : ""}STYLE
Physically grounded miniature diorama — believable materials, weight, and depth. Pastel environment palette (mint, peach, pink, cyan) with localized saturation in signage and props. High-angle or slight isometric macro photography feel, strong tilt-shift depth of field (subject sharp, edges blurred), subtle chromatic aberration, fine cinematic film grain, soft directional sunlight with warm/cool balance. ${
    moodText ? `Mood: ${moodText}.` : "Calm but rich — cinematic and alive."
  }`;
}

export function buildVibetownPrompt(
  description: string,
  faceFilenames: string[],
  sceneBgFilenames: string[],
  scene: string,
  action: string,
  mood: string
) {
  const sceneText =
    scene.trim() ||
    "a calm, premium Vibetown setting that complements the uploaded subject";
  const actionText = action.trim();
  const moodText = mood.trim();

  const faceList = faceFilenames.length
    ? faceFilenames.map((n) => `  - ${n}`).join("\n")
    : "  (none — body reference only this render)";

  return `You are rendering Good Vibes Club / Vibetown vinyl figurines — a specific, well-defined stylized art style. Match the reference images exactly.

WHAT A GVC CHARACTER LOOKS LIKE
A Vibetown character is a soft matte vinyl 3D figurine with deliberately minimal, stylized facial features. The face is FLAT and SMOOTH — it is not anatomically realistic. Specifically:

FACE FEATURES (every character has exactly these and nothing else on the front of the head):
- Round smooth head, matte vinyl finish, subtle micro-texture
- Eyes: match the eye style of whichever face reference best fits the described expression — for example, closed/curved smile lines for relaxed or happy (face-blue-meditation, face-pink-laugh), open black-dot eyes for alert or neutral (face-red-happy), squint for mischievous (face-purple-mischievous), X-eyes for unconscious/surprised (face-mint-dead). Always stylized — never anatomically realistic eyes.
- Mouth: ONE simple small Vibetown-style curved line — a single small upturned smile shape. Just one. (Bearded characters have ZERO mouths — see below.)
- Ears: small simple shapes on the sides
- NO eyebrows (GVC characters do not have rendered eyebrows; the face references confirm this)
- Central face plane (between the eyes and the mouth): FLAT and SMOOTH vinyl skin. There is nothing on this plane — it is a clean surface, not anatomically modeled.

CHARACTER TYPES:
- Clean-shaven: the face has eyes, ONE mouth, ears. No eyebrows. Smooth chin and jaw below the mouth.
- Bearded: the face has eyes, ears. No eyebrows. The facial hair is ONE continuous bushy mass — its TOP edge starts IMMEDIATELY BELOW THE EYES, REPLACING where the mouth would otherwise sit on a clean-shaven character. From that top edge it extends down through the entire chin and jawline. No bare skin between the eyes and the top of the facial hair. No mouth, smile, or lip shape anywhere on the face — the facial hair REPLACES the mouth entirely. Expression comes from the eyes only.
- Stubble: same as clean-shaven (visible mouth and all), PLUS a faint darker tonal shadow on the chin and jaw area. No hair shapes, no separate mustache.

BODY:
- Soft vinyl figurine proportions (per the body reference)
- Realistic natural human skin tone per the subject description (peach, tan, olive, brown, dark — not the saturated reference colors)
- Pose comes from SUBJECT ACTION below; if no action is specified, the character stands naturally with arms relaxed at their sides

(Animals, objects, vehicles, food, plants keep their natural anatomy. The above applies only to humans / humanoids.)

REFERENCE IMAGES
1. GVC-STYLE-REFERENCE.png — body proportions template (shown as a T-pose from three angles purely for measurement; the T-pose stance is NOT a pose to copy — characters move per SUBJECT ACTION).
2. Face reference set — canonical GVC face structures across expressions and beard states:
${faceList}
   The references use saturated artistic colors (blue, mint, pink, purple, red) to demonstrate face STRUCTURE across variants. Real characters use realistic skin tones from the description, not these reference colors.${
    sceneBgFilenames.length > 0
      ? `
3. Scene reference image(s) — canonical Vibetown environment for this render:
${sceneBgFilenames.map((n) => `  - ${n}`).join("\n")}
   Match the scene reference(s) for: color palette, architecture, materials, props, lighting mood, time of day, and overall Vibetown aesthetic. Insert the subject(s) naturally into this environment. You may adjust framing/camera distance to fit the action (the scene reference may be a wide shot; the final render can be tighter on the characters). Do NOT copy any characters that appear in the scene reference itself — the only characters in the output are the SUBJECT(S) described below.

FACE STRUCTURE OVERRIDES SCENE AESTHETIC: regardless of how polished, glamorous, or photoreal the scene reference looks, every character's face follows the GVC FACE FEATURES rules above — flat, smooth, eyes + ONE mouth (or no mouth if bearded), no nose, no eyebrows. The scene reference informs the ENVIRONMENT only (palette, materials, lighting, props) — never the characters' faces. Do not add nose, lip detail, brow shadow, or other anatomical realism to a face just because the scene reference shows realistic depth or polish.

SKIN TONE OVERRIDES SCENE-REF CHARACTERS: skin color for the rendered subjects comes ONLY from the subject description (realistic human tones: peach, tan, olive, brown, dark). NEVER pull skin color from any character that appears in a scene reference — e.g. if Craig appears with pink skin in a scene reference, or if a GVC character with green/blue/mint/purple skin is visible anywhere in the input images, the rendered subjects still use the realistic skin tones from the description. The saturated character colors in references are demonstration palette, never skin.

OLIVE = WARM HUMAN TONE, NEVER GREEN: when the description says "olive" or "light olive" skin, render it as a warm Mediterranean beige with a subtle golden/tan undertone — like sun-kissed Italian, Greek, or Spanish skin. NEVER render olive skin with any green, mint, or sage tint. If in doubt, lean toward warm tan/beige rather than cool/green. Olive describes a HUMAN complexion family, not the color of an olive fruit.`
      : ""
  }

SUBJECT(S) TO RENDER

${description}

Render each subject as a fresh Vibetown vinyl figurine in the style described above. Render the exact number of subjects described; never merge them.

SCENE
${sceneText}

${actionText ? `SUBJECT ACTION\n${actionText}\n\n` : ""}STYLE
Physically grounded miniature diorama — believable materials, weight, and depth. Pastel environment palette (mint, peach, pink, cyan) with localized saturation in signage and props. High-angle or slight isometric macro photography feel, strong tilt-shift depth of field (subject sharp, edges blurred), subtle chromatic aberration, fine cinematic film grain, soft directional sunlight with warm/cool balance. ${
    moodText ? `Mood: ${moodText}.` : "Calm but rich — cinematic and alive."
  }`;
}

/**
 * Pull the image input from a FormData body. Returns a NextResponse on failure
 * (so the route handler can `return await prepareImage(form)` style early-out),
 * or a normalized { buffer, filename, mime } on success.
 */
export async function prepareImage(
  form: FormData
): Promise<
  | { kind: "ok"; buffer: Buffer; filename: string; mime: string }
  | { kind: "err"; response: NextResponse }
> {
  const imageField = form.get("image");
  const imageUrl = form.get("imageUrl");

  if (imageField instanceof File) {
    return {
      kind: "ok",
      buffer: Buffer.from(await imageField.arrayBuffer()),
      filename: imageField.name || "input.png",
      mime: imageField.type || "image/png",
    };
  }

  if (typeof imageUrl === "string" && imageUrl) {
    try {
      const r = await fetch(imageUrl);
      if (!r.ok) throw new Error(`status ${r.status}`);
      const mime = r.headers.get("content-type") || "image/png";
      const ext = mime.split("/")[1]?.split(";")[0] || "png";
      return {
        kind: "ok",
        buffer: Buffer.from(await r.arrayBuffer()),
        filename: `input.${ext}`,
        mime,
      };
    } catch (e) {
      return {
        kind: "err",
        response: NextResponse.json(
          { error: `Could not fetch image from URL: ${(e as Error).message}` },
          { status: 400 }
        ),
      };
    }
  }

  return {
    kind: "err",
    response: NextResponse.json(
      { error: "No image provided. Send an 'image' file or 'imageUrl'." },
      { status: 400 }
    ),
  };
}

/**
 * Run the OpenAI image edit. Returns a NextResponse either way.
 * Both routes (VIBESTR + x402) call this after their respective payment checks.
 */
export async function generateVibetown(opts: {
  buffer: Buffer;
  filename: string;
  mime: string;
  scene: string;
  action: string;
  mood: string;
  size: VibeifySize;
  /** Optional scene background reference filenames (in public/scenes/). */
  sceneBgFilenames?: string[];
  /**
   * What the source image is. Defaults to "photo" — describer runs, source
   * pixels never reach Flux. When "gvc-token", describer is SKIPPED, the
   * source is injected as a Flux reference image, and face refs are dropped
   * (the source already defines the canonical GVC face).
   */
  sourceKind?: SourceKind;
  /** Extra fields to merge into the success response (e.g. testMode, paymentRail). */
  extra?: Record<string, unknown>;
}): Promise<NextResponse> {
  const openaiKey = process.env.OPENAI_API_KEY;
  const bflKey = process.env.BFL_API_KEY;
  if (!openaiKey) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY is not configured on the server." },
      { status: 500 }
    );
  }
  if (!bflKey) {
    return NextResponse.json(
      { error: "BFL_API_KEY is not configured on the server." },
      { status: 500 }
    );
  }

  const sourceKind: SourceKind = opts.sourceKind ?? "photo";
  console.log(
    `[vibeify] start sourceKind=${sourceKind} size=${opts.size} mime=${opts.mime} bufferBytes=${opts.buffer.length}`
  );

  // ── Step 1: identity capture ──
  // photo:      gpt-4o-mini vision describer; source pixels never reach Flux
  // gvc-token:  skip describer; source IS the identity; injected as ref below
  let description: string;
  let extraReference: GvcReference | undefined;

  if (sourceKind === "gvc-token") {
    description =
      "(GVC NFT source — see the SOURCE-CHARACTER reference image; no text description.)";
    // Downscale + repackage the NFT image as a Flux reference. We don't need
    // this for MP budget (ref count is what matters, not pixel size — and we
    // dropped 4 face refs to make room for the source), but a 1024px JPEG
    // keeps base64 transfer size + encode time reasonable.
    const downscaled = await downscaleForReference(opts.buffer, opts.mime);
    extraReference = {
      filename: "SOURCE-CHARACTER.png",
      buffer: downscaled.buffer,
      mimeType: downscaled.mime,
    };
    console.log(
      `[vibeify] gvc-token path — describer skipped; source attached as ref (${extraReference.buffer.length} bytes)`
    );
  } else {
    try {
      description = await describeSubject(opts.buffer, opts.mime, openaiKey);
      console.log(`[vibeify] describer ok (${description.length} chars)`);
    } catch (e) {
      const msg = (e as Error).message;
      console.error(`[vibeify] describer failed:`, msg);
      return NextResponse.json(
        { error: `Could not describe the uploaded image: ${msg}` },
        { status: 502 }
      );
    }
  }

  // ── Step 2: load GVC references ──
  // GVC-token path drops the face refs (the source defines the face).
  const refs = await loadGvcReferences({
    includeFaces: sourceKind !== "gvc-token",
  });
  if (refs.refs.length === 0) {
    return NextResponse.json(
      {
        error:
          "GVC body reference is missing at public/gvc-character-reference.png — pipeline cannot run without it.",
      },
      { status: 500 }
    );
  }

  // Optional scene background reference(s) — appended after the GVC refs.
  const sceneBgs = await loadSceneBackgrounds(opts.sceneBgFilenames ?? []);
  const sceneBgFilenames = sceneBgs.map((r) => r.filename);

  // Reference ordering matters — Flux input_image_1 is the strongest anchor.
  // Photo path:      body T-pose, face refs, scene bgs (T-pose anchors
  //                  proportions; identity comes from the describer text).
  // GVC-token path:  SOURCE-CHARACTER, body T-pose, scene bgs (the NFT IS
  //                  the identity, so it MUST sit at slot 1 — otherwise
  //                  Flux anchors the characterless T-pose and invents the
  //                  rest, especially when sceneBgs is empty (Freeform).
  //                  The T-pose moves to slot 2 as a proportions-only ref.
  const allReferences =
    sourceKind === "gvc-token"
      ? [
          ...(extraReference ? [extraReference] : []),
          ...refs.refs,
          ...sceneBgs,
        ]
      : [
          ...refs.refs,
          ...sceneBgs,
        ];

  const prompt =
    sourceKind === "gvc-token"
      ? buildVibetownPromptForGvcSource(
          sceneBgFilenames,
          opts.scene,
          opts.action,
          opts.mood
        )
      : buildVibetownPrompt(
          description,
          refs.faceFilenames,
          sceneBgFilenames,
          opts.scene,
          opts.action,
          opts.mood
        );

  // Flux supports up to 9 input images. Trim if we somehow exceeded that.
  // Photo path     budget: body (1) + 4 faces + 2 scenes = 7 → fine.
  // GVC-token path budget: body (1) + 1 source + 2 scenes = 4 → ample room.
  const MAX = 9;
  const trimmed = allReferences.slice(0, MAX);

  try {
    const { imageB64, mimeType } = await renderWithFlux({
      apiKey: bflKey,
      prompt,
      references: trimmed,
      size: opts.size,
    });
    return NextResponse.json({
      image: `data:${mimeType};base64,${imageB64}`,
      prompt,
      description,
      provider: "flux-2-pro",
      sourceKind,
      ...(opts.extra ?? {}),
    });
  } catch (e) {
    const msg = (e as Error).message || "Image generation failed";
    // Surface in dev server log so /tmp/vibe-o-matic-dev.log captures the real reason.
    console.error(
      `[vibeify] Flux render failed (size=${opts.size}, refs=${trimmed.length}):`,
      msg
    );
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}

export function readVibeifyFields(form: FormData) {
  const sceneBgImagesRaw = (form.get("sceneBgImages") as string | null) || "";
  const sceneBgFilenames = sceneBgImagesRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    scene: (form.get("scene") as string) ?? "",
    action: (form.get("action") as string) ?? "",
    mood: (form.get("mood") as string) ?? "",
    size: ((form.get("size") as string) || "1024x1024") as VibeifySize,
    sceneBgFilenames,
  };
}

/**
 * Read the explicit sourceKind form field. Falls back to "photo" so
 * existing callers (and any agent caller that doesn't set the field)
 * keep the describer-driven path unchanged.
 */
export function readSourceKind(form: FormData): SourceKind {
  const raw = (form.get("sourceKind") as string | null)?.trim().toLowerCase();
  return raw === "gvc-token" ? "gvc-token" : "photo";
}

export type ResolvedVibeifyParams = {
  scene: string;
  action: string;
  mood: string;
  size: VibeifySize;
  sceneBgFilenames: string[];
  /** Present when agent mode was used — surfaces what the picker chose. */
  agentPicks?: {
    sceneId: string;
    actionId: string;
    moodId: string;
    size: string;
    reasoning: string;
  };
};

/**
 * Resolve the vibeify params from a form, supporting two modes:
 *   - Explicit (default): caller sent scene/action/mood/size/sceneBgImages.
 *   - Agent (form.get("agentMode") === "1"): server calls gpt-4o-mini to pick
 *     all params from the source photo + optional `intent` text.
 *
 * Used by BOTH the VIBESTR rail (/api/vibeify) and the x402 rail
 * (/api/vibeify/x402) — keeps agent-mode behavior identical across rails.
 *
 * Throws on agent failure so the caller route can decide how to respond
 * (e.g. x402 must not settle payment, VIBESTR has already been verified).
 */
export async function resolveVibeifyParams(
  form: FormData,
  image: { buffer: Buffer; mime: string },
  openaiKey: string
): Promise<ResolvedVibeifyParams> {
  const agentMode = form.get("agentMode") === "1";
  if (!agentMode) {
    return readVibeifyFields(form);
  }

  const intent = ((form.get("intent") as string) || "").trim();
  const picked = await pickVibeParams(image, intent, openaiKey);
  return {
    scene: picked.scene,
    action: picked.action,
    mood: picked.mood,
    size: picked.size,
    sceneBgFilenames: picked.sceneBgFilenames,
    agentPicks: {
      sceneId: picked.agentPicks.sceneId,
      actionId: picked.agentPicks.actionId,
      moodId: picked.agentPicks.moodId,
      size: picked.agentPicks.size,
      reasoning: picked.agentReasoning,
    },
  };
}
