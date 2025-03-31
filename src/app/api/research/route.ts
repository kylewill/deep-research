import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

// Schema for the initial trigger request
const requestSchema = z.object({
  query: z.string(),
  language: z.string().optional(),
  thinkingModel: z.string().optional(),
  networkingModel: z.string().optional(),
  apiKey: z.string().optional(),
  callbackUrl: z.string().optional(),
});

const backgroundTaskSecret = process.env.BACKGROUND_TASK_SECRET;
const appUrl = process.env.APP_URL;

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

export async function POST(req: NextRequest) {
  let callbackUrl: string | null = null;
  let query: string | null = null;

  try {
    // 1. Validate Request
    const body = await req.json();
    const validatedData = requestSchema.parse(body);
    query = validatedData.query;
    callbackUrl = validatedData.callbackUrl || null;

    // Check if secret is configured
    if (!backgroundTaskSecret) {
      console.error("BACKGROUND_TASK_SECRET is not configured. Cannot trigger background task.");
      throw new Error("Server configuration error.");
    }
    if (!appUrl) {
      console.error("APP_URL is not configured. Cannot determine background task URL.");
      throw new Error("Server configuration error.");
    }

    // 2. Send Initial Slack Notification (Fire-and-forget)
    if (callbackUrl) {
      try {
        const initialSlackPayload = {
          text: `⏳ Research accepted for query: \"${query}\" (Processing starting...)`,
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

    // 3. Trigger Background Task via internal fetch
    // Construct the full URL for the background endpoint
    const backgroundUrl = new URL("/api/research/background", appUrl).toString();

    console.log(`Triggering background task for query: "${query}" at ${backgroundUrl}`);
    fetch(backgroundUrl, {
      method: "POST",
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': backgroundTaskSecret, // Send the secret
      },
      body: JSON.stringify(validatedData), // Pass all validated data
    }).then(async triggerResponse => {
      // Check if triggering the background task failed immediately
      if (!triggerResponse.ok) {
        const errorBody = await triggerResponse.text();
        console.error(`Background task trigger failed immediately. Status: ${triggerResponse.status}, Body: ${errorBody}`);
        // We can't throw here as the main response is already sent (or about to be)
        // We could potentially send another Slack message if critical
        if (callbackUrl) {
          try {
            const errorPayload = {
              text: `❌ Failed to *initiate* background research task (Status: ${triggerResponse.status}). Query: \"${query}\"`
            };
            fetch(callbackUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(errorPayload) })
              .catch(e => console.error("Failed to send background trigger error notification to Slack:", e));
          } catch (e) { console.error("Error constructing background trigger error notification:", e); }
        }
      } else {
        console.log(`Successfully triggered background task (async) for query: "${query}"`);
      }
    }).catch(fetchError => {
      // Handle network errors trying to reach the background endpoint
      console.error(`Error fetching background task endpoint: ${fetchError}`);
      if (callbackUrl) {
        try {
          const errorPayload = {
            text: `❌ Network error trying to initiate background research task. Query: \"${query}\". Error: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`
          };
          fetch(callbackUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(errorPayload) })
            .catch(e => console.error("Failed to send background fetch error notification to Slack:", e));
        } catch (e) { console.error("Error constructing background fetch error notification:", e); }
      }
    });

    // 4. Return 202 Accepted immediately
    return new NextResponse(
      JSON.stringify({ success: true, message: "Research process started in background." }),
      {
        status: 202,
        headers: { 'Content-Type': 'application/json' }
      }
    );

  } catch (error) {
    // Handle validation errors or errors triggering the background task
    console.error("Outer Research API error (before background task):", error);

    if (callbackUrl && query) {
      try {
        const errorPayload = {
          text: `❌ Initial request failed for query \"${query}\" before processing could start. Error: ${error instanceof Error ? error.message : "Unknown setup error"}`
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