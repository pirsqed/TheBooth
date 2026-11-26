import { GoogleGenAI } from '@google/genai';
import {
  DirectorReviewer,
  DirectorReviewRequest,
  DirectorReviewVerdict,
  DirectorReviewVerdictSchema,
} from './interface.js';
import { buildDirectorSystemInstruction } from './personas.js';

export interface GeminiDirectorClient {
  interactions: {
    create(params: Record<string, unknown>): Promise<{
      id?: string;
      status?: string;
      output_text?: string;
      steps?: Array<{
        type?: string;
        content?: Array<{
          type?: string;
          text?: string;
        }>;
      }>;
    }>;
  };
}

export interface GeminiDirectorReviewerOptions {
  apiKey?: string;
  model?: string;
  client?: GeminiDirectorClient;
}

const VERDICT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    approved: { type: 'boolean' },
    score: { type: 'number' },
    feedback: { type: 'string' },
    suggestedDirection: { type: ['string', 'null'] },
    suggestedText: { type: ['string', 'null'] },
    suggestedMixPatch: {
      type: ['object', 'null'],
      properties: {
        gainDb: { type: 'number' },
        eqPreset: {
          type: 'string',
          enum: ['neutral', 'intimate', 'whisper', 'phone', 'radio', 'distant'],
        },
      },
    },
  },
  required: ['approved', 'score', 'feedback'],
};

/**
 * Multimodal Director reviewer backed by the Gemini v1beta Interactions API.
 * Listens directly to the immutable raw take WAV alongside script context & telemetry,
 * steered by the configured Director Persona.
 */
export class GeminiDirectorReviewer implements DirectorReviewer {
  readonly name = 'gemini-director';
  private readonly apiKey?: string;
  private readonly model: string;
  private client: GeminiDirectorClient | null;

  constructor(options: GeminiDirectorReviewerOptions = {}) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? 'gemini-3.5-flash';
    this.client = options.client ?? null;
  }

  private getClient(): GeminiDirectorClient {
    if (this.client) return this.client;
    if (!this.apiKey) {
      throw new Error('GEMINI_API_KEY is not configured for GeminiDirectorReviewer');
    }
    const sdkClient = new GoogleGenAI({
      apiKey: this.apiKey,
      httpOptions: { apiVersion: 'v1beta' },
    });
    this.client = sdkClient as unknown as GeminiDirectorClient;
    return this.client;
  }

  async reviewTake(req: DirectorReviewRequest): Promise<DirectorReviewVerdict> {
    const systemInstruction = buildDirectorSystemInstruction({
      persona: req.persona,
      projectName: req.projectName,
      extraInstructions: req.extraInstructions,
    });

    const contextLines = [
      `Cue ID: ${req.cue.id}`,
      `Speaker: ${req.voiceLabel} (${req.cue.speaker})`,
      `Script Text: ${req.cue.text}`,
      `Current Direction: ${req.take.direction ?? '(none / voice default)'}`,
      `Stage-1 Telemetry: duration=${req.take.durationMs}ms, measuredLufs=${req.take.measuredLufs ?? 'null (sub-second)'}, rmsDbfs=${req.take.measuredRmsDbfs.toFixed(1)}, peakDbfs=${req.take.peakDbfs.toFixed(1)}`,
      `Review Attempt: ${req.attempt + 1} of ${req.maxRetakes + 1} (retakes remaining: ${Math.max(0, req.maxRetakes - req.attempt)})`,
    ];

    if (req.previousFeedback.length > 0) {
      contextLines.push(
        'Previous Take Notes:',
        ...req.previousFeedback.map((f, i) => `  Take ${i + 1}: ${f}`),
      );
    }

    contextLines.push(
      '',
      'Listen carefully to the attached audio take and return your structured Director verdict JSON.',
    );

    const payload: Record<string, unknown> = {
      model: this.model,
      store: false,
      system_instruction: systemInstruction,
      input: [
        {
          type: 'user_input',
          content: [
            {
              type: 'text',
              text: contextLines.join('\n'),
            },
            {
              type: 'audio',
              data: req.wavBuffer.toString('base64'),
              mime_type: 'audio/wav',
            },
          ],
        },
      ],
      response_format: {
        type: 'text',
        mime_type: 'application/json',
        schema: VERDICT_JSON_SCHEMA,
      },
      safety_settings: [
        { type: 'hate_speech', threshold: 'off' },
        { type: 'harassment', threshold: 'off' },
        { type: 'sexually_explicit', threshold: 'off' },
        { type: 'dangerous_content', threshold: 'off' },
      ],
    };

    const client = this.getClient();
    const interaction = await client.interactions.create(payload);

    let rawText = interaction.output_text;
    if (!rawText && Array.isArray(interaction.steps)) {
      for (const step of interaction.steps) {
        if (step.type === 'model_output' && Array.isArray(step.content)) {
          const textPart = step.content.find(
            (c) => c.type === 'text' && typeof c.text === 'string',
          );
          if (textPart?.text) {
            rawText = textPart.text;
            break;
          }
        }
      }
    }

    if (!rawText) {
      throw new Error(
        `Gemini Director returned no text verdict (status: ${interaction.status ?? 'unknown'})`,
      );
    }

    // Strip optional markdown code fences if a model wraps JSON
    const cleaned = rawText
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    const parsedJson = JSON.parse(cleaned);
    return DirectorReviewVerdictSchema.parse(parsedJson);
  }
}
