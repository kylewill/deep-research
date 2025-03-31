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
import { put } from '@vercel/blob';
import { nanoid } from 'nanoid';

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
  const researchStartTime = Date.now();
  console.log(`[Background Research - ${query}] Starting process...`);

  let reportContent = "";
  let researchError: Error | null = null;
  let reportId: string | null = null;
  let reportBlobUrl: string | null = null;

  try {
    // The actual research logic starts here
    let queries: Array<ResearchQuery & { state: string; learning: string }> = [];

    // 1. Generate initial research queries
    console.log(`[Background Research - ${query}] Generating initial queries...`);
    const initialQueryResult = await streamText({
      model: google(thinkingModel),
      system: getSystemPrompt(),
      prompt: [
        generateSerpQueriesPrompt(query),
        getResponseLanguagePrompt(language),
      ].join("\n\n"),
      onError: (event) => {
        console.error(`[Background Research - ${query}] Error generating initial queries:`, event.error);
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
    console.log(`[Background Research - ${query}] Generated ${queries.length} initial queries.`);

    // 2. Process each research query
    const learnings: string[] = [];
    console.log(`[Background Research - ${query}] Starting to process ${queries.length} queries...`);
    for (let i = 0; i < 1; i++) {
      const item = queries[i];
      console.log(`[Background Research - ${query}] Processing query ${i + 1}/${queries.length}: "${item.query}"`);
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
            console.error(`[Background Research - ${query}] Error processing query '${item.query}':`, event.error);
            throw event.error;
          },
        });

        for await (const part of searchResult.textStream) {
          searchContent += part;
        }
        learnings.push(searchContent);
        item.state = "processed";
        item.learning = searchContent;
        console.log(`[Background Research - ${query}] Successfully processed query ${i + 1}/${queries.length}.`);
      } catch (processingError) {
        item.state = "failed";
        console.error(`[Background Research - ${query}] Skipping query '${item.query}' due to processing error:`, processingError);
      }
    }
    console.log(`[Background Research - ${query}] Finished processing queries. Collected ${learnings.length} learnings.`);

    // 3. Generate final report
    console.log(`[Background Research - ${query}] Generating final report...`);
    const finalReportResult = await streamText({
      model: google(thinkingModel),
      system: getSystemPrompt(),
      prompt: [
        writeFinalReportPrompt(query, learnings),
        getResponseLanguagePrompt(language),
      ].join("\n\n"),
      onError: (event) => {
        console.error(`[Background Research - ${query}] Error generating final report:`, event.error);
        throw event.error;
      },
    });

    for await (const textPart of finalReportResult.textStream) {
      reportContent += textPart;
    }
    console.log(`[Background Research - ${query}] Finished generating final report.`);

    // 4. Upload report content to Vercel Blob
    if (!researchError && reportContent) {
      reportId = nanoid();
      const pathname = `reports/${reportId}.md`;
      console.log(`[Background Research - ${query}] Uploading report to Vercel Blob with pathname: ${pathname}`);
      try {
        const blob = await put(pathname, reportContent, {
          access: 'public',
          contentType: 'text/markdown; charset=utf-8',
          addRandomSuffix: false,
        });
        reportBlobUrl = blob.url;
        console.log(`[Background Research - ${query}] Successfully uploaded report to ${blob.url}`);
      } catch (uploadError) {
        console.error(`[Background Research - ${query}] Error uploading report to Vercel Blob:`, uploadError);
        researchError = new Error(`Failed to upload report to storage: ${uploadError instanceof Error ? uploadError.message : String(uploadError)}`);
        reportContent = `Research completed, but failed to save report: ${researchError.message}`;
        reportId = null;
      }
    }

  } catch (error) {
    researchError = error instanceof Error ? error : new Error(String(error));
    console.error(`[Background Research - ${query}] Error during research process:`, researchError);
    reportContent = `Research failed: ${researchError.message}`;
    reportId = null;
  }

  const researchDuration = (Date.now() - researchStartTime) / 1000;
  console.log(`[Background Research - ${query}] Research process took ${researchDuration.toFixed(2)} seconds.`);

  // Send final notification to callback URL if provided
  if (callbackUrl) {
    console.log(`[Background Research - ${query}] Sending final notification to callback URL...`);
    let slackTextMessage = "";

    if (researchError) {
      slackTextMessage = `❌ Research failed for query: \"${query}\" (took ${researchDuration.toFixed(1)}s)\nError: ${researchError.message}`;
    } else if (reportId && process.env.APP_URL) {
      const reportPageUrl = `${process.env.APP_URL}/report/${reportId}`;
      slackTextMessage = `✅ Research complete for query: \"${query}\" (took ${researchDuration.toFixed(1)}s)\nView Report: ${reportPageUrl}`;
      if (reportBlobUrl) console.log(`[Background Research - ${query}] Report Blob URL: ${reportBlobUrl}`);
    } else if (reportId && !process.env.APP_URL) {
      console.error(`[Background Research - ${query}] APP_URL environment variable not set. Cannot create report link.`);
      slackTextMessage = `⚠️ Research complete for query: \"${query}\" (took ${researchDuration.toFixed(1)}s), but APP_URL is not set to create a link. Report ID: ${reportId}`;
    } else {
      slackTextMessage = `❓ Research finished for query: \"${query}\" (took ${researchDuration.toFixed(1)}s), but report could not be linked or saved correctly.`;
    }

    try {
      const finalSlackPayload = { text: slackTextMessage };
      await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(finalSlackPayload),
      });
      console.log(`[Background Research - ${query}] Successfully sent final notification.`);
    } catch (callbackError) {
      console.error(`[Background Research - ${query}] Final Slack notification callback error:`, callbackError);
    }
  } else {
    console.log(`[Background Research - ${query}] No callback URL provided. Skipping final notification.`);
    if (reportBlobUrl) console.log(`[Background Research - ${query}] Report Blob URL: ${reportBlobUrl}`);
  }
  console.log(`[Background Research - ${query}] Process finished.`);
}

export async function POST(req: NextRequest) {
  let callbackUrl: string | null = null;

  try {
    const body = await req.json();
    const validatedData = requestSchema.parse(body);

    const {
      query,
      language = "",
      thinkingModel = "gemini-2.0-flash",
      networkingModel = "gemini-2.0-flash",
      apiKey,
    } = validatedData;

    callbackUrl = validatedData.callbackUrl || null;

    if (apiKey) {
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = apiKey;
    }

    if (callbackUrl) {
      try {
        const initialSlackPayload = {
          text: `⏳ Research accepted for query: \"${query}\" (Processing in background...)`,
        };
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

    runResearchInBackground({
      query,
      language,
      thinkingModel,
      networkingModel,
      callbackUrl,
    });

    return new NextResponse(
      JSON.stringify({ success: true, message: "Research process started in background." }),
      {
        status: 202,
        headers: { 'Content-Type': 'application/json' }
      }
    );

  } catch (error) {
    console.error("Outer Research API error:", error);

    if (callbackUrl) {
      try {
        const errorPayload = {
          text: `❌ Initial request failed before processing could start. Error: ${error instanceof Error ? error.message : "Unknown setup error"}`
        };
        fetch(callbackUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(errorPayload) })
          .catch(e => console.error("Failed to send error notification to Slack:", e));
      } catch (e) { console.error("Error constructing error notification for Slack:", e); }
    }

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error occurred",
      },
      { status: 500 }
    );
  }
} 