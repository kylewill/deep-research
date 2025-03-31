import { GenerativeModel } from "@ai-sdk/google";

interface StreamOptions {
  model: GenerativeModel;
  system: string;
  prompt: string;
  experimental_transform?: (text: string) => string;
  onError?: (error: Error) => void;
}

interface TextPart {
  type: "text-delta";
  textDelta: string;
}

interface ReasoningPart {
  type: "reasoning";
  textDelta: string;
}

interface SourcePart {
  type: "source";
  source: {
    title?: string;
    url: string;
  };
}

type StreamPart = TextPart | ReasoningPart | SourcePart;

interface StreamResult {
  textStream: AsyncIterable<string>;
  fullStream: AsyncIterable<StreamPart>;
}

export async function streamText(options: StreamOptions): Promise<StreamResult> {
  const { model, system, prompt, experimental_transform, onError } = options;

  try {
    const result = await model.generateContentStream({
      contents: [{ role: "user", parts: [{ text: `${system}\n\n${prompt}` }] }],
    });

    const textStream = async function* () {
      for await (const chunk of result.stream) {
        const text = chunk.text();
        if (text) {
          yield experimental_transform ? experimental_transform(text) : text;
        }
      }
    };

    const fullStream = async function* () {
      for await (const chunk of result.stream) {
        const text = chunk.text();
        if (text) {
          yield {
            type: "text-delta",
            textDelta: experimental_transform ? experimental_transform(text) : text,
          };
        }
      }
    };

    return { textStream, fullStream };
  } catch (error) {
    if (error instanceof Error && onError) {
      onError(error);
    }
    throw error;
  }
} 