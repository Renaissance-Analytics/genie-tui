/**
 * PURE. Which model to talk to — decided here, built nowhere near here.
 *
 * ## Why this is its own module
 *
 * "Local models first, cloud as the fallback" is a product constraint, and a
 * constraint that lives in four lines inside an entry point is one nobody can
 * test without launching a process with a doctored environment. As a function it
 * is `model.test.ts`, and the resolution ORDER — the part that actually encodes
 * the constraint — becomes an assertion instead of a claim.
 *
 * ## Nothing vendor-shaped crosses this file
 *
 * A {@link ModelSpec} is a description, not a model. Turning one into something
 * a runtime can use is `runtime/mastra.ts`'s job, below the seam, because the
 * runtime is temporary and this decision is not.
 */

/** What the TUI should talk to. A description; the runtime constructs it. */
export type ModelSpec =
    | {
          kind: 'remote';
          /** Provider-qualified id — `anthropic/claude-sonnet-4-6`, `local/qwen3-coder`. */
          id: string;
          /** An OpenAI-compatible base URL. Present iff this is a local endpoint. */
          url?: string;
      }
    | {
          kind: 'offline';
          /** What the offline model answers with. It must give the user a next step. */
          notice: string;
      }
    | { kind: 'invalid'; reason: string };

export interface ModelInputs {
    /** `--model`. Falls back to `GENIE_TUI_MODEL`. */
    model?: string | undefined;
    /** `--model-url`. Falls back to `GENIE_TUI_MODEL_URL`. */
    modelUrl?: string | undefined;
    env: Record<string, string | undefined>;
}

/** The cloud model used when a key is present and nothing else was asked for. */
const DEFAULT_CLOUD_MODEL = 'anthropic/claude-sonnet-4-6';

/**
 * The keys Mastra's router auto-detects. Presence of one is the only signal
 * that a cloud call could succeed — auth is implicit in Mastra, so there is
 * nothing better to ask.
 */
const CLOUD_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'];

const OFFLINE_NOTICE =
    'No model is configured, so this is the offline skeleton and I cannot actually think. ' +
    'Point me at a local model with `--model-url http://127.0.0.1:11434/v1 --model qwen3-coder` ' +
    '(Ollama, llama.cpp, LM Studio and vLLM all speak that), ' +
    'or set ANTHROPIC_API_KEY to use a cloud model.';

/**
 * Namespace a bare model name as `local/`.
 *
 * Not cosmetic. Mastra strips `temperature`, `topP` and `topK` for any model
 * absent from its hardcoded per-provider list, and absent means UNLISTED rather
 * than unsupported — so naming a provider its registry RECOGNISES silently
 * discards the user's sampling config, which reaches them as an incoherent
 * local model and no error. An id it does not know keeps the settings intact.
 *
 * An id that already carries a namespace is the caller being explicit, and is
 * left alone.
 */
function qualify(model: string): string {
    return model.includes('/') ? model : `local/${model}`;
}

export function resolveModel(inputs: ModelInputs): ModelSpec {
    const model = inputs.model ?? inputs.env['GENIE_TUI_MODEL'];
    const url = inputs.modelUrl ?? inputs.env['GENIE_TUI_MODEL_URL'];

    // Local first — and deliberately ahead of the key check, so a machine with a
    // cloud key still honours an explicitly configured local endpoint. A local
    // endpoint needs no credential: `url` short-circuits Mastra's whole
    // gateway/auth chain and defaults the key to empty.
    if (url) {
        if (!model) {
            return {
                kind: 'invalid',
                reason:
                    'a base URL was given with no model — pass `--model <name>` (or set GENIE_TUI_MODEL) ' +
                    'so the request names the model the server should load.',
            };
        }
        return { kind: 'remote', id: qualify(model), url };
    }

    if (CLOUD_KEYS.some((key) => inputs.env[key])) {
        return { kind: 'remote', id: model ?? DEFAULT_CLOUD_MODEL };
    }

    return { kind: 'offline', notice: OFFLINE_NOTICE };
}
