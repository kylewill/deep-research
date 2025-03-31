import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { streamText } from "ai";
import { google } from "@ai-sdk/google";
import {
  getSystemPrompt,
  generateSerpQueriesPrompt,
  processSearchResultPrompt,
  writeFinalReportPrompt,
  getSERPQuerySchema,
} from "@/utils/deep-research";
import { isNetworkingModel } from "@/utils/models";
import { pick } from "radash";

// Request schema
const requestSchema = z.object({
  query: z.string(),
  language: z.string().optional(),
  thinkingModel: z.string().optional(),
  networkingModel: z.string().optional(),
  apiKey: z.string().optional(),
  apiProxy: z.string().optional(),
  callbackUrl: z.string().optional(),
});

function getResponseLanguagePrompt(language: string): string {
  return language ? `Please respond in ${language}.` : "";
}

function parsePartialJson(text: string): { state: string; value: unknown } {
  try {
    return { state: "successful-parse", value: JSON.parse(text) };
  } catch {
    try {
      // Try to repair common JSON issues
      const repaired = text
        .replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3')
        .replace(/'/g, '"');
      return { state: "repaired-parse", value: JSON.parse(repaired) };
    } catch {
      return { state: "failed-parse", value: null };
    }
  }
}

function removeJsonMarkdown(text: string): string {
  return text.replace(/```json\n?|\n?```/g, "").trim();
}

interface ResearchQuery {
  query: string;
  researchGoal: string;
}

// Function to run the research process in the background
async function runResearchInBackground(params: {
  query: string;
  language: string;
  thinkingModel: string;
  networkingModel: string;
  callbackUrl: string | null;
}) {
  const { query, language, thinkingModel, networkingModel, callbackUrl } = params;

  let reportContent = "";
  let researchError: Error | null = null;

  try {
    // The actual research logic starts here
    let queries: Array<ResearchQuery & { state: string; learning: string }> = [];

    // 1. Generate initial research queries
    const initialQueryResult = await streamText({
      model: google(thinkingModel),
      system: getSystemPrompt(),
      prompt: [
        generateSerpQueriesPrompt(query),
        getResponseLanguagePrompt(language),
      ].join("\n\n"),
      onError: (event) => {
        console.error("Background - Error generating initial queries:", event.error);
        throw event.error;
      },
    });

    const querySchema = getSERPQuerySchema();
    let queryContent = "";
    for await (const textPart of initialQueryResult.textStream) {
      queryContent += textPart;
      const data = parsePartialJson(removeJsonMarkdown(queryContent));
      if (querySchema.safeParse(data.value)) {
        if (data.state === "repaired-parse" || data.state === "successful-parse") {
          if (data.value && Array.isArray(data.value)) {
            queries = data.value.map((item: ResearchQuery) => ({
              state: "unprocessed",
              learning: "",
              ...pick(item, ["query", "researchGoal"]),
            }));
            break;
          }
        }
      }
    }
    if (queries.length === 0) {
      throw new Error("Failed to generate valid initial research queries.");
    }

    // 2. Process each research query
    const learnings: string[] = [];
    for (const item of queries) {
      let searchContent = "";
      try {
        const searchResult = await streamText({
          model: google(networkingModel, {
            useSearchGrounding: isNetworkingModel(networkingModel),
          }),
          system: getSystemPrompt(),
          prompt: [
            processSearchResultPrompt(item.query, item.researchGoal),
            getResponseLanguagePrompt(language),
          ].join("\n\n"),
          onError: (event) => {
            console.error(`Background - Error processing query '${item.query}':`, event.error);
            throw event.error;
          },
        });

        for await (const part of searchResult.textStream) {
          searchContent += part;
        }
        learnings.push(searchContent);
        item.state = "processed";
        item.learning = searchContent;
      } catch (processingError) {
        item.state = "failed";
        console.error(`Background - Skipping query '${item.query}' due to processing error:`, processingError);
      }
    }

    // 3. Generate final report
    const finalReportResult = await streamText({
      model: google(thinkingModel),
      system: getSystemPrompt(),
      prompt: [
        writeFinalReportPrompt(query, learnings),
        getResponseLanguagePrompt(language),
      ].join("\n\n"),
      onError: (event) => {
        console.error("Background - Error generating final report:", event.error);
        throw event.error;
      },
    });

    for await (const textPart of finalReportResult.textStream) {
      reportContent += textPart;
    }

  } catch (error) {
    researchError = error instanceof Error ? error : new Error(String(error));
    console.error("Background - Error during research process:", researchError);
    reportContent = `Research failed: ${researchError.message}`;
  }

  // Send final report (or error) to callback URL if provided
  if (callbackUrl) {
    try {
      const finalSlackPayload = {
        text: researchError
          ? `❌ Research failed for query: \"${query}\"\nError: ${researchError.message}`
          : `✅ *Research Report for Query:* ${query}\n\n---\n\n${reportContent}`,
      };

      await fetch(callbackUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(finalSlackPayload),
      });
    } catch (callbackError) {
      console.error("Background - Final Slack notification callback error:", callbackError);
    }
  }
}

export async function POST(req: NextRequest) {
  let callbackUrl: string | null = null; // Keep track of callbackUrl for error handling

  try {
    const body = await req.json();
    const validatedData = requestSchema.parse(body);

    const {
      query,
      language = "",
      thinkingModel = "gemini-2.0-flash", // Default thinking model
      networkingModel = "gemini-2.0-flash", // Default networking model
      apiKey,
    } = validatedData;

    // Assign callbackUrl from validated data
    callbackUrl = validatedData.callbackUrl || null;

    // Set the API key as an environment variable
    if (apiKey) {
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = apiKey;
    }

    // Send initial Slack notification if callbackUrl is provided
    if (callbackUrl) {
      try {
        const initialSlackPayload = {
          text: `⏳ Research accepted for query: \"${query}\" (Processing in background...)`,
        };
        // Fire off the initial notification without waiting
        fetch(callbackUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(initialSlackPayload),
        }).catch(callbackError => {
          console.error("Initial Slack notification callback error:", callbackError);
        });
      } catch (initialCallbackError) {
        console.error("Error constructing initial Slack notification:", initialCallbackError);
      }
    }

    // Trigger the background research process - DO NOT AWAIT
    runResearchInBackground({
      query,
      language,
      thinkingModel,
      networkingModel,
      callbackUrl,
    });

    // Return 202 Accepted immediately
    return new NextResponse(
      JSON.stringify({ success: true, message: "Research process started in background." }),
      {
        status: 202,
        headers: { 'Content-Type': 'application/json' }
      }
    );

  } catch (error) {
    console.error("Outer Research API error:", error);

    // Attempt to notify Slack about this early failure if possible
    // callbackUrl might be null if parsing failed before it was assigned
    if (callbackUrl) {
      try {
        const errorPayload = {
          text: `❌ Initial request failed before processing could start. Error: ${error instanceof Error ? error.message : "Unknown setup error"}`
        };
        // Don't necessarily wait for this, but log if it fails
        fetch(callbackUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(errorPayload) })
          .catch(e => console.error("Failed to send error notification to Slack:", e));
      } catch (e) { console.error("Error constructing error notification for Slack:", e); }
    }

    // Return 500 error to the original client
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error occurred",
      },
      { status: 500 }
    );
  }
} 