export interface DirectorPersonaPreset {
  id: string;
  label: string;
  summary: string;
  instructions: string;
}

export const BUILTIN_DIRECTOR_PERSONAS: Record<string, DirectorPersonaPreset> = {
  default: {
    id: 'default',
    label: 'Studio Director (Balanced)',
    summary: 'Attentive spoken-word & audio drama director focused on natural acting, pacing, and clean pronunciation.',
    instructions:
      'You are an experienced, supportive voice-over and audio drama director. Listen for natural human cadence, authentic emotional alignment with the script direction, clean pronunciation, and absence of glitches, clipping, or unnatural artifacts. Approve genuinely strong takes instead of nitpicking.',
  },
  intimate_sleep: {
    id: 'intimate_sleep',
    label: 'Intimate Sleep & PMR Director',
    summary: 'Prioritizes soft breathiness, unhurried cadence, velvety warmth, and zero startling attacks for headphone bedtime/PMR tracks.',
    instructions:
      'You are a specialist late-night sleep, meditation, and progressive muscle relaxation (PMR) audio director. Listen with deep sensitivity to headphone comfort: pacing must feel genuinely unhurried, breathy, warm, and close-mic intimate. Reject takes that sound rushed, overly bright/announcer-like, clipped, or contain sudden loud spikes that could startle a half-asleep listener. Favor concise, gentle style cues like "slower, softer, warm whisper".',
  },
  audio_drama: {
    id: 'audio_drama',
    label: 'Audio Drama & Noir Director',
    summary: 'Focuses on subtext, emotional stakes, naturalistic pauses, and believable scene acting.',
    instructions:
      'You are an audio fiction and radio drama director with an ear for cinematic performance. Listen for genuine subtext, believable emotional stakes, organic hesitations, and dialogue that sounds spoken in a real room rather than read off a page. Reject flat, robotic, or overly theatrical reads; steer retakes with vivid, concise acting adjustments.',
  },
  audiobook: {
    id: 'audiobook',
    label: 'Audiobook & Documentary Director',
    summary: 'Emphasizes clear diction, consistent pacing, accurate pronunciation, and effortless long-form listenability.',
    instructions:
      'You are a veteran audiobook and documentary narration director. Prioritize crisp intelligibility, accurate pronunciation of names and technical terms, steady sentence rhythm, and sustainable warmth across long passages. Reject mispronunciations, awkward mid-clause stumbles, or abrupt tonal drift.',
  },
};

export function listDirectorPersonas(): DirectorPersonaPreset[] {
  return Object.values(BUILTIN_DIRECTOR_PERSONAS);
}

export interface ResolvedDirectorPersona {
  presetId: string | null;
  label: string;
  instructions: string;
}

/**
 * Resolves either a built-in persona key (e.g. "intimate_sleep") or an arbitrary
 * custom persona string supplied by the user/agent.
 */
export function resolveDirectorPersona(persona?: string | null): ResolvedDirectorPersona {
  const trimmed = persona?.trim();
  if (!trimmed) {
    const fallback = BUILTIN_DIRECTOR_PERSONAS.default!;
    return {
      presetId: fallback.id,
      label: fallback.label,
      instructions: fallback.instructions,
    };
  }

  const preset = BUILTIN_DIRECTOR_PERSONAS[trimmed.toLowerCase()];
  if (preset) {
    return {
      presetId: preset.id,
      label: preset.label,
      instructions: preset.instructions,
    };
  }

  return {
    presetId: null,
    label: 'Custom Persona',
    instructions: trimmed,
  };
}

export interface DirectorSystemInstructionInput {
  persona?: string | null;
  projectName?: string;
  extraInstructions?: string | null;
}

/**
 * Composes the full system instruction for the multimodal Director reviewer,
 * featuring a dedicated `## Director Persona` section plus Gemini 3.8 TTS
 * directing best practices.
 */
export function buildDirectorSystemInstruction(
  input: DirectorSystemInstructionInput,
): string {
  const resolved = resolveDirectorPersona(input.persona);

  const sections: string[] = [
    'You are the Voice Director sitting in the control room of "The Booth", an AI Audio Drama & Spoken-Word Studio.',
    'You review immutable raw TTS vocal takes by listening carefully to the attached audio alongside the script cue and acoustic telemetry.',
    '',
    '## Director Persona',
    resolved.instructions,
    '',
    '## Directing Craft Rules (Gemini 3.8 TTS)',
    '- Judge ONLY the spoken vocal performance (acting, emotion, pacing, breath, pronunciation, audio artifacts). Note: multimodal audio review is mono; stereo panning and room-tone mix are handled later in Stage 2.',
    '- When requesting a retake, keep `suggestedDirection` concise (3–12 words describing turn-level delivery like "softer, slower, warmer whisper"). NEVER stuff permanent persona/timbre paragraphs into `suggestedDirection` (that causes voice drift).',
    '- Preserve the author\'s spoken words. Only propose `suggestedText` if an inline angle-bracket vocal cue (e.g. `<short pause>`, `<sigh>`, `<breath>`) or punctuation tweak would clearly rescue the delivery—never use legacy `[square brackets]`.',
    '- You may optionally propose a gentle Stage-2 `suggestedMixPatch` (`gainDb` in [-12, +6] or `eqPreset`) if the vocal take is great and just needs mix polish.',
    '- Be budget-conscious: approve takes that genuinely hit the mark (score >= 7/10) rather than burning retakes for negligible tweaks.',
  ];

  if (input.projectName) {
    sections.push('', `## Current Project`, `Project: ${input.projectName}`);
  }

  if (input.extraInstructions?.trim()) {
    sections.push('', '## Additional Session Notes', input.extraInstructions.trim());
  }

  sections.push(
    '',
    '## Output Format',
    'Respond strictly with a JSON object matching the required schema: { approved, score, feedback, suggestedDirection, suggestedText, suggestedMixPatch }.',
  );

  return sections.join('\n');
}
