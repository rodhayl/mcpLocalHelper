export type LmStudioProbeResult = {
  reachable: boolean;
  hasModels: boolean;
  inferenceOk: boolean;
  ready: boolean;
  details?: string;
};

function envTrue(name: string): boolean {
  const v = (process.env[name] || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export function requireLmStudioForTests(): boolean {
  return envTrue('MCP_REQUIRE_LMSTUDIO') || envTrue('MCP_LOCAL_LLM_REQUIRE_LMSTUDIO');
}

function safeString(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export async function probeLmStudio(
  lmStudioApiBaseUrl: string,
  opts?: { timeoutMs?: number; modelHint?: string; maxModelAttempts?: number }
): Promise<LmStudioProbeResult> {
  const timeoutMs = Math.max(500, opts?.timeoutMs ?? 3000);
  const maxModelAttempts = Math.max(1, opts?.maxModelAttempts ?? 8);

  const abortController = new AbortController();
  const t = setTimeout(() => abortController.abort(), timeoutMs);

  const looksNonChatModel = (id: string): boolean => {
    const lower = id.toLowerCase();
    return (
      lower.includes('embedding') ||
      lower.includes('embed') ||
      lower.includes('text-embedding') ||
      lower.includes('rerank') ||
      lower.includes('re-rank') ||
      lower.includes('clip') ||
      lower.includes('whisper') ||
      lower.includes('tts') ||
      lower.includes('speech') ||
      lower.includes('stt')
    );
  };

  try {
    const apiBase = lmStudioApiBaseUrl.replace(/\/+$/, '');
    const modelsResponse = await fetch(`${apiBase}/models`, {
      signal: abortController.signal,
    });

    if (!modelsResponse.ok) {
      return {
        reachable: false,
        hasModels: false,
        inferenceOk: false,
        ready: false,
        details: `HTTP ${modelsResponse.status} from /models`,
      };
    }

    const modelsJson = (await modelsResponse.json().catch(() => null)) as unknown as { data?: unknown };
    const models = Array.isArray((modelsJson as any)?.data)
      ? (((modelsJson as any).data as unknown[]) ?? [])
      : [];

    if (models.length === 0) {
      return {
        reachable: true,
        hasModels: false,
        inferenceOk: false,
        ready: false,
        details: 'LM Studio reachable but /models returned empty data[]',
      };
    }

    const modelIds = models
      .map((m) => (typeof (m as any)?.id === 'string' ? String((m as any).id) : null))
      .filter((id): id is string => Boolean(id));

    const hinted =
      (opts?.modelHint || process.env.MCP_LOCAL_LLM_MODEL || '').trim();

    const candidatesRaw = [
      ...(hinted ? [hinted] : []),
      ...modelIds.filter((id) => !looksNonChatModel(id)),
      ...modelIds.filter((id) => looksNonChatModel(id)),
    ];

    const candidates: string[] = [];
    for (const id of candidatesRaw) {
      if (!candidates.includes(id)) {
        candidates.push(id);
      }
    }

    // Verify inference works too; this catches the common "model exists but none loaded" case.
    let lastDetails = '';
    const tried: string[] = [];
    for (const modelId of candidates.slice(0, maxModelAttempts)) {
      tried.push(modelId);
      const chatResponse = await fetch(`${apiBase}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 1,
          temperature: 0,
        }),
        signal: abortController.signal,
      });

      if (chatResponse.ok) {
        return {
          reachable: true,
          hasModels: true,
          inferenceOk: true,
          ready: true,
        };
      }

      const body = await chatResponse.text().catch(() => '');
      const bodyPreview = safeString(body).slice(0, 200);
      lastDetails = `HTTP ${chatResponse.status} from /chat/completions for model "${modelId}": ${bodyPreview}`;

      // Common LM Studio error when probing an embedding model via chat endpoint.
      // Keep searching for a chat-capable model.
      if (chatResponse.status === 400 && /not\\s+llm/i.test(bodyPreview)) {
        continue;
      }
    }

    return {
      reachable: true,
      hasModels: true,
      inferenceOk: false,
      ready: false,
      details: `${lastDetails || 'No chat-capable model responded successfully.'} Tried: ${tried.join(', ')}`,
    };
  } catch (error) {
    return {
      reachable: false,
      hasModels: false,
      inferenceOk: false,
      ready: false,
      details: safeString(error),
    };
  } finally {
    clearTimeout(t);
  }
}
