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
  getOutputGuidelinesPrompt,
} from "@/utils/deep-research"; // Assuming these paths are correct
import { isNetworkingModel } from "@/utils/models"; // Assuming this path is correct
import { pick } from "radash";
import { put } from '@vercel/blob';
import { nanoid } from 'nanoid';

// Define max duration for this background function (optional, Vercel defaults apply otherwise)
// Max duration is 900 seconds (15 minutes) on Pro, 60 seconds on Hobby.
export const maxDuration = 300; // Increased to 15 minutes

// Schema for the data expected by the background task
const backgroundTaskSchema = z.object({
  query: z.string(),
  language: z.string().optional(),
  thinkingModel: z.string().optional(),
  networkingModel: z.string().optional(),
  apiKey: z.string().optional(),
  callbackUrl: z.string().optional(),
});

// Re-add necessary helper functions here
function getResponseLanguagePrompt(language?: string): string {
  return language ? `Please respond in ${language}.` : "";
}

function removeJsonMarkdown(text: string): string {
  text = text.trim();
  if (text.startsWith("```json")) {
    text = text.slice(7);
  } else if (text.startsWith("json")) {
    text = text.slice(4);
  } else if (text.startsWith("```")) {
    text = text.slice(3);
  }
  if (text.endsWith("```")) {
    text = text.slice(0, -3);
  }
  return text.trim();
}

function parsePartialJson(text: string): { state: string; value: unknown } {
  try {
    return { state: "successful-parse", value: JSON.parse(text) };
  } catch {
    try {
      const repaired = text
        .replace(/([{,]\\s*)(\\w+)(\\s*:)/g, '$1"$2"$3')
        .replace(/'/g, '"');
      return { state: "repaired-parse", value: JSON.parse(repaired) };
    } catch {
      return { state: "failed-parse", value: null };
    }
  }
}

interface ResearchQuery {
  query: string;
  researchGoal: string;
}

async function fetchWithRetry(url: string, options: RequestInit, maxRetries = 3): Promise<Response> {
  let lastError: Error | null = null;
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      // Add timeout to prevent hanging
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
      
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        // Add keep-alive to help with connection stability
        headers: {
          ...options.headers,
          'Connection': 'keep-alive',
        },
      });
      
      clearTimeout(timeoutId);
      return response;
    } catch (error) {
      lastError = error as Error;
      
      // Check if it's a TLS/connection error
      const isTlsError = error instanceof Error && 
        (error.message.includes('TLS') || 
         error.message.includes('ECONNRESET') ||
         error.message.includes('ETIMEDOUT'));
      
      // If it's not a TLS error or we're on the last retry, throw
      if (!isTlsError || i === maxRetries - 1) {
        throw error;
      }
      
      // For TLS errors, wait longer between retries
      const backoffTime = Math.pow(2, i) * 2000; // 2s, 4s, 8s
      console.log(`Retry attempt ${i + 1}/${maxRetries} after ${backoffTime}ms due to: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, backoffTime));
    }
  }
  
  throw lastError || new Error('Max retries reached');
}

const backgroundTaskSecret = process.env.BACKGROUND_TASK_SECRET;
const appUrl = process.env.APP_URL;

export async function POST(req: NextRequest) {
  // 1. Verify Secret Token
  const providedSecret = req.headers.get('X-Internal-Secret');
  if (providedSecret !== backgroundTaskSecret || !backgroundTaskSecret) {
    console.warn("Background task called with invalid or missing secret.");
    return new NextResponse("Unauthorized", { status: 401 });
  }

  let query: string | null = null; // For logging context
  let callbackUrl: string | null = null; // For final notification

  try {
    // 2. Parse Request Body
    const body = await req.json();
    const validatedData = backgroundTaskSchema.parse(body);

    const {
      language = "",
      thinkingModel = "gemini-2.0-flash",
      networkingModel = "gemini-2.0-flash",
      apiKey,
    } = validatedData;
    query = validatedData.query; // Assign for logging/error reporting
    callbackUrl = validatedData.callbackUrl || null; // Assign for final notification

    // 3. Set API Key (Important for Background Function)
    // The background function runs in its own environment instance
    if (apiKey) {
      console.log(`[Background Task - ${query}] Using API key provided in request.`);
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = apiKey;
    } else if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
      console.log(`[Background Task - ${query}] Using API key from environment variable.`);
      // No action needed, it's already set in the environment
    } else {
      console.error(`[Background Task - ${query}] No Google API Key found in request or environment.`);
      throw new Error("Google API Key is required but not found.");
    }

    // 4. --- Start the actual research process ---
    // This is the logic moved from runResearchInBackground
    const researchStartTime = Date.now();
    console.log(`[Background Task - ${query}] Starting research process...`);

    let reportContent = "";
    let researchError: Error | null = null;
    let reportId: string | null = null;
    let reportBlobUrl: string | null = null; // For logging

    try {
      let queries: Array<ResearchQuery & { state: string; learning: string }> = [];

      // Step 1: Generate initial research queries
      console.log(`[Background Task - ${query}] Generating initial queries...`);
      const initialQueryResult = await streamText({
        model: google(thinkingModel),
        system: getSystemPrompt(),
        prompt: [
          generateSerpQueriesPrompt(query),
          getResponseLanguagePrompt(language),
        ].join("\\n\\n"),
        onError: (event) => {
          console.error(`[Background Task - ${query}] Error generating initial queries:`, event.error);
          throw event.error;
        },
      });

      // Accumulate the full content first
      let queryContent = "";
      for await (const textPart of initialQueryResult.textStream) {
        queryContent += textPart;
      }
      console.log(`[Background Task - ${query}] Raw content received for initial queries: ${queryContent}`);

      // Now, process the full content once after the stream is complete
      const querySchema = getSERPQuerySchema();
      const cleanedContent = removeJsonMarkdown(queryContent);
      const parsedData = parsePartialJson(cleanedContent);

      if (parsedData.state === "failed-parse") {
        console.error(`[Background Task - ${query}] Failed to parse JSON even after repairing attempts. Content: ${cleanedContent}`);
        throw new Error("Failed to parse initial research queries JSON.");
      }

      const validationResult = querySchema.safeParse(parsedData.value);

      if (!validationResult.success) {
        console.error(`[Background Task - ${query}] Zod schema validation failed for initial queries. Error: ${validationResult.error.message}. Parsed Data:`, parsedData.value);
        throw new Error(`Initial research queries JSON failed schema validation: ${validationResult.error.message}`);
      }

      // Validation successful, map the data
      if (validationResult.data && Array.isArray(validationResult.data)) {
        queries = validationResult.data.map((item: ResearchQuery) => ({
          state: "unprocessed",
          learning: "",
          ...pick(item, ["query", "researchGoal"]),
        }));
      }

      // This check should now only fail if the validated data wasn't an array somehow
      if (queries.length === 0) {
        // This condition implies successful parsing & validation but resulted in an empty array or non-array data
        console.error(`[Background Task - ${query}] Parsed and validated query data is empty or not an array. Validated Data:`, validationResult.data);
        throw new Error("Generated valid JSON for initial queries, but it was empty or not an array.");
      }
      console.log(`[Background Task - ${query}] Generated and validated ${queries.length} initial queries.`);

      // Step 2: Process each research query
      const learnings: string[] = [];
      console.log(`[Background Task - ${query}] Starting to process ${queries.length} queries...`);
      for (let i = 0; i < queries.length; i++) { // Ensure loop runs for all queries
        const item = queries[i];
        console.log(`[Background Task - ${query}] Processing query ${i + 1}/${queries.length}: \\\"${item.query}\\\"`);
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
            ].join("\\n\\n"),
            onError: (event) => {
              console.error(`[Background Task - ${query}] Error processing query \'${item.query}\':`, event.error);
              throw event.error;
            },
          });

          for await (const part of searchResult.textStream) {
            searchContent += part;
          }
          learnings.push(searchContent);
          item.state = "processed";
          item.learning = searchContent;
          console.log(`[Background Task - ${query}] Successfully processed query ${i + 1}/${queries.length}.`);
        } catch (processingError) {
          item.state = "failed";
          console.error(`[Background Task - ${query}] Skipping query \'${item.query}\' due to processing error:`, processingError);
        }
      }
      console.log(`[Background Task - ${query}] Finished processing queries. Collected ${learnings.length} learnings.`);

      // Step 3: Generate final report
      console.log(`[Background Task - ${query}] Generating final report...`);
      try {
        const finalReportResult = await streamText({
          model: google(thinkingModel),
          system: [getSystemPrompt(), getOutputGuidelinesPrompt()].join("\n\n"),
          prompt: [
            writeFinalReportPrompt(query, learnings),
            getResponseLanguagePrompt(language),
          ].join("\n\n"),
          onError: (event) => {
            console.error(`[Background Task - ${query}] Error generating final report:`, event.error);
            throw event.error;
          },
        });

        // Accumulate the full content first
        for await (const textPart of finalReportResult.textStream) {
          reportContent += textPart;
        }
        
        // Validate report content
        if (!reportContent.trim()) {
          throw new Error("Generated report is empty");
        }
        
        console.log(`[Background Task - ${query}] Finished generating final report. Content length: ${reportContent.length}`);
      } catch (reportError) {
        console.error(`[Background Task - ${query}] Error during report generation:`, reportError);
        researchError = reportError instanceof Error ? reportError : new Error(String(reportError));
        reportContent = `Research completed, but report generation failed: ${researchError.message}`;
      }

      // Step 4: Upload report content to Vercel Blob
      if (!researchError && reportContent) {
        reportId = nanoid();
        const pathname = `reports/${reportId}.md`;
        console.log(`[Background Task - ${query}] Uploading report to Vercel Blob with pathname: ${pathname}`);
        try {
          const blob = await put(pathname, reportContent, {
            access: 'public',
            contentType: 'text/markdown; charset=utf-8',
            addRandomSuffix: false,
          });
          reportBlobUrl = blob.url;
          console.log(`[Background Task - ${query}] Successfully uploaded report to ${blob.url}`);
        } catch (uploadError) {
          console.error(`[Background Task - ${query}] Error uploading report to Vercel Blob:`, uploadError);
          researchError = new Error(`Failed to upload report to storage: ${uploadError instanceof Error ? uploadError.message : String(uploadError)}`);
          reportContent = `Research completed, but failed to save report: ${researchError.message}`;
          reportId = null;
        }
      }

    } catch (error) { // Catch errors from the main research steps
      researchError = error instanceof Error ? error : new Error(String(error));
      console.error(`[Background Task - ${query}] Error during research process:`, researchError);
      reportContent = `Research failed: ${researchError.message}`;
      reportId = null;
    }

    // --- Research process finished (successfully or with caught error) ---

    const researchDuration = (Date.now() - researchStartTime) / 1000;
    console.log(`[Background Task - ${query}] Research process took ${researchDuration.toFixed(2)} seconds.`);

    // 5. Send final notification to callback URL if provided
    if (callbackUrl) {
      console.log(`[Background Task - ${query}] Sending final notification to callback URL...`);
      let slackTextMessage = "";

      if (researchError) {
        slackTextMessage = `❌ Research failed for query: \\\"${query}\\\" (took ${researchDuration.toFixed(1)}s)\\nError: ${researchError.message}`;
      } else if (reportId && appUrl) {
        const reportPageUrl = `${appUrl}/report/${reportId}`;
        slackTextMessage = `✅ Research complete for query: \\\"${query}\\\" (took ${researchDuration.toFixed(1)}s)\\nView Report: ${reportPageUrl}`;
        if (reportBlobUrl) console.log(`[Background Task - ${query}] Report Blob URL: ${reportBlobUrl}`);
      } else if (reportId && !appUrl) {
        console.error(`[Background Task - ${query}] APP_URL environment variable not set. Cannot create report link.`);
        slackTextMessage = `⚠️ Research complete for query: \\\"${query}\\\" (took ${researchDuration.toFixed(1)}s), but APP_URL is not set. Report ID: ${reportId}`;
      } else {
        slackTextMessage = `❓ Research finished for query: \\\"${query}\\\" (took ${researchDuration.toFixed(1)}s), but report could not be linked or saved correctly.`;
      }

      try {
        const finalSlackPayload = { text: slackTextMessage };
        await fetchWithRetry(callbackUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(finalSlackPayload),
        });
        console.log(`[Background Task - ${query}] Successfully sent final notification.`);
      } catch (callbackError) {
        console.error(`[Background Task - ${query}] Final Slack notification callback error:`, callbackError);
      }
    } else {
      console.log(`[Background Task - ${query}] No callback URL provided. Skipping final notification.`);
      if (reportBlobUrl) console.log(`[Background Task - ${query}] Report Blob URL: ${reportBlobUrl}`);
    }

    console.log(`[Background Task - ${query}] Process finished.`);

    // Background task returns 200 OK if it reached this point without uncaught errors
    return NextResponse.json({ success: true, message: "Background research process finished." });

  } catch (error) {
    // Catch errors during setup (validation, secret check, initial key check)
    console.error(`[Background Task - ${query || 'Unknown Query'}] Error setting up research task:`, error);

    // Attempt to notify callback URL about setup failure
    if (callbackUrl && query) {
      try {
        const errorPayload = {
          text: `❌ Background research task failed to start for query \\\"${query}\\\". Error: ${error instanceof Error ? error.message : "Unknown setup error"}`
        };
        // Fire-and-forget notification attempt
        fetchWithRetry(callbackUrl, { 
          method: "POST", 
          headers: { "Content-Type": "application/json" }, 
          body: JSON.stringify(errorPayload) 
        }).catch(e => console.error("Failed to send background setup error notification to Slack:", e));
      } catch (e) { console.error("Error constructing background setup error notification for Slack:", e); }
    }

    // Return 500 to the internal fetch trigger
    return NextResponse.json(
      { success: false, error: `Background task setup failed: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 }
    );
  }
}