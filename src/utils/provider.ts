import { createGoogleGenerativeAI } from "@ai-sdk/google";

export function createProvider() {
  return (model: string, apiKey?: string, apiProxy?: string, options = {}) => {
    const genAI = createGoogleGenerativeAI(apiKey || "", {
      apiEndpoint: apiProxy,
    });
    return genAI.getGenerativeModel({ model, ...options });
  };
} 