/**
 * Helper to diagnose and format friendly errors for LLM connection issues.
 */
export function diagnoseConnectionError(
  error: unknown,
  backendId: string,
  configUrl: string = 'http://localhost:3000/'
): Error {
  const msg = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;

  // Enhance error message based on common failure modes
  let friendlyMessage = `LLM Backend '${backendId}' failure: ${msg}`;

  // 1. Connection Refused (Server likely not running)
  if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
    friendlyMessage =
      `❌ **LLM Backend '${backendId}' is not reachable**\n\n` +
      `Please ensure the LLM server (e.g., LM Studio, Ollama) is running and listening.\n` +
      `You can configure the backend URL at: ${configUrl}`;
  }
  // 2. Timeout (Server running but hung or wrong port)
  else if (msg.includes('ETIMEDOUT') || msg.includes('timed out')) {
    friendlyMessage =
      `⚠️ **LLM Backend '${backendId}' timed out**\n\n` +
      `The server is not responding. Check if the model is loading or if the port is correct.\n` +
      `Configure settings at: ${configUrl}`;
  }
  // 3. Unauthorized (Missing/Invalid API Key)
  else if (msg.includes('401') || msg.includes('Unauthorized')) {
    friendlyMessage =
      `🔒 **Authentication Failed for '${backendId}'**\n\n` +
      `The API key is missing or invalid.\n` +
      `Update your API key at: ${configUrl}`;
  }
  // 4. Not Found (Wrong Endpoint)
  else if (msg.includes('404') || msg.includes('Not Found')) {
    friendlyMessage =
      `❓ **Backend Endpoint Not Found**\n\n` +
      `The configured URL for '${backendId}' might be incorrect.\n` +
      `Check your settings at: ${configUrl}`;
  }
  // 5. Explicit "Not Configured" (Custom check)
  else if (msg.includes('not available') || msg.includes('not configured')) {
    friendlyMessage =
      `⚙️ **LLM Backend '${backendId}' is not configured**\n\n` +
      `Please configure the backend provider and model at: ${configUrl}`;
  }

  const newError = new Error(friendlyMessage);
  // Preserve original stack for debugging if needed
  if (stack) {
    newError.stack = stack;
  }
  return newError;
}
