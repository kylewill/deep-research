import { list } from '@vercel/blob';
import { notFound } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import { cache } from 'react';

export const revalidate = 0; // Revalidate on every request for debugging

const getReportData = cache(async (reportId: string) => {
  console.log(`[Report Page - ${reportId}] Starting getReportData function.`);

  if (!reportId) {
    console.error(`[Report Page - ${reportId}] Invalid report ID provided.`);
    return { reportMarkdown: null, error: 'Invalid report ID.' };
  }

  const pathname = `reports/${reportId}.md`;
  console.log(`[Report Page - ${reportId}] Constructed pathname: ${pathname}`);

  let reportMarkdown: string | null = null;
  let error: string | null = null;
  let blobUrl: string | null = null;

  try {
    console.log(`[Report Page - ${reportId}] Attempting to list blob with prefix: ${pathname}`);
    // Check if the token environment variable is present (for debugging)
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      console.warn(`[Report Page - ${reportId}] WARNING: BLOB_READ_WRITE_TOKEN environment variable not found! list() will likely fail.`);
    }

    const { blobs } = await list({
      prefix: pathname,
      limit: 1,
    });
    console.log(`[Report Page - ${reportId}] list() returned blobs:`, JSON.stringify(blobs, null, 2));

    if (blobs.length === 1 && blobs[0].pathname === pathname) {
      blobUrl = blobs[0].url;
      console.log(`[Report Page - ${reportId}] Found matching blob. URL: ${blobUrl}`);

      console.log(`[Report Page - ${reportId}] Fetching content from blob URL...`);
      const response = await fetch(blobUrl);
      console.log(`[Report Page - ${reportId}] Fetch response status: ${response.status}`);

      if (!response.ok) {
        throw new Error(`Failed to fetch report content: ${response.status} ${response.statusText}`);
      }
      reportMarkdown = await response.text();
      console.log(`[Report Page - ${reportId}] Successfully fetched markdown content (length: ${reportMarkdown.length}).`);
    } else if (blobs.length > 0) {
      console.warn(`[Report Page - ${reportId}] list() found ${blobs.length} blob(s), but pathname mismatch. Expected: ${pathname}, Found: ${blobs[0]?.pathname}`);
      error = 'Report identifier mismatch.';
    } else {
      console.log(`[Report Page - ${reportId}] list() found 0 blobs matching the prefix.`);
      error = 'Report not found.';
    }
  } catch (err) {
    console.error(`[Report Page - ${reportId}] Error during getReportData:`, err);
    error = `Error loading report: ${err instanceof Error ? err.message : String(err)}`;
  }

  console.log(`[Report Page - ${reportId}] Finished getReportData. Error: ${error}, Has Markdown: ${!!reportMarkdown}`);
  return { reportMarkdown, error };
});

// The Page component - use 'any' for props temporarily for debugging
export default async function ReportPage(props: any) {
  // Extract params manually, assuming the structure
  const reportId = props?.params?.reportId;
  console.log(`[Report Page Component - ${reportId}] Rendering page...`);

  // Ensure reportId is valid before proceeding
  if (typeof reportId !== 'string' || !reportId) {
    console.error("[Report Page Component] Invalid or missing reportId in props.", props);
    notFound();
  }

  const { reportMarkdown, error } = await getReportData(reportId);

  if (error && !reportMarkdown) {
    console.log(`[Report Page Component - ${reportId}] Error condition met. Error: ${error}`);
    if (error === 'Report not found.' || error === 'Report identifier mismatch.') {
      console.log(`[Report Page Component - ${reportId}] Calling notFound().`);
      notFound(); // Renders the nearest not-found.tsx page
    }
    // Render generic error for other issues
    return (
      <main className="container mx-auto p-4">
        <h1 className="text-2xl font-bold mb-4 text-red-600">Error Loading Report</h1>
        <p>{error}</p>
      </main>
    );
  }

  if (!reportMarkdown) {
    // Fallback if error logic somehow missed it
    console.log(`[Report Page Component - ${reportId}] Fallback: No markdown content, calling notFound().`);
    notFound();
  }

  console.log(`[Report Page Component - ${reportId}] Rendering report markdown.`);
  return (
    <main className="container mx-auto p-4">
      <article className="prose lg:prose-xl max-w-none">
        <ReactMarkdown>{reportMarkdown}</ReactMarkdown>
      </article>
    </main>
  );
}

// Optional: Add metadata for the page title - use 'any' for props temporarily
export async function generateMetadata(props: any) {
  // Extract params manually
  const reportId = props?.params?.reportId;
  if (typeof reportId !== 'string' || !reportId) {
    // Return default metadata or handle error
    return { title: "Research Report" };
  }
  return {
    title: `Research Report ${reportId}`,
  };
} 