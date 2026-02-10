
import { describe, it, expect, vi, afterEach } from 'vitest';
import { getSemanticMemory, resetSemanticMemory } from '../../src/agent/semantic-memory.js';
import { extractJsonFromText as extractJson } from '../../src/utils/llm-json.js';
import { resetCircuitBreakerRegistry } from '../../src/utils/circuit-breaker.js';

// Mocks
global.fetch = vi.fn();

describe('Verification Tests: Agent Hangs & Parsing Failures FIXED', () => {

    afterEach(() => {
        vi.restoreAllMocks();
        resetSemanticMemory();
        resetCircuitBreakerRegistry();
    });

    // FIX VERIFICATION 1: No longer hangs when fetch stalls
    // With circuit breaker and timeout, the search should complete quickly
    it('should NOT hang when fetch stalls - circuit breaker + timeout prevents hang', async () => {
        // Mock fetch to never resolve (simulate hung network/server)
        (global.fetch as any).mockImplementation(() => new Promise(() => { }));

        const memory = getSemanticMemory({ enabled: true });

        console.log('Starting search with stalled fetch...');

        // Race against a 2 second timeout - with the fix, search should complete much faster
        const searchPromise = memory.search('context', 1);
        const testTimeout = new Promise((resolve) => setTimeout(() => resolve('timeout_reached'), 8000));

        const result = await Promise.race([searchPromise, testTimeout]);

        // With the fix, result should be [] (empty results due to circuit breaker/timeout)
        // NOT 'timeout_reached' (which would mean it hung for >8 seconds)
        expect(result).not.toBe('timeout_reached');
        expect(result).toEqual([]); // Graceful degradation returns empty array
    }, 15000);

    // REPRO 2: Chatty JSON is now properly extracted
    // Simulates small models returning conversational text around JSON.
    it('should extract JSON from chatty LLM output', () => {
        const chattyInput = `
    Sure, here is the list of files you asked for:
    \`\`\`json
    {
      "files": ["src/main.ts", "package.json"]
    }
    \`\`\`
    Hope that helps!
    `;

        // Extraction should work - the fix extracts JSON from markdown
        const extracted = extractJson(chattyInput);
        console.log('Extracted:', extracted);
        expect(extracted).toBeTruthy();
        expect(extracted).toHaveProperty('files');
    });

    // REPRO 3: Plain text list throws error (expected behavior)
    // Small models might just return a list without JSON format
    it('should throw when trying to parse plain text as JSON', () => {
        const plainTextList = `
        src/main.ts
        src/utils.ts
        README.md
        `;

        // extractJson throws when no JSON is found - this is expected behavior
        // The caller should handle this gracefully
        expect(() => extractJson(plainTextList)).toThrow('No JSON found');
    });
});
