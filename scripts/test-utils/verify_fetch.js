/**
 * LM Studio API Verification Script
 * 
 * Tests connectivity to LM Studio's local API endpoints.
 * Useful for debugging backend connection issues.
 * 
 * Usage: node scripts/test-utils/verify_fetch.js
 */

const fetch = global.fetch;

async function check() {
    console.log('Checking /models...');
    try {
        const r1 = await fetch('http://127.0.0.1:1234/v1/models');
        console.log('/models status:', r1.status);
        if (!r1.ok) throw new Error('Models failed');
        const d1 = await r1.json();
        console.log('/models count:', d1.data?.length);
    } catch (e) {
        console.error('/models ERROR:', e);
    }

    console.log('Checking /chat/completions...');
    try {
        const r2 = await fetch('http://127.0.0.1:1234/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messages: [{ role: 'user', content: 'hi' }],
                model: 'gpt-oss-12b-i1',
                max_tokens: 1
            })
        });
        console.log('/chat status:', r2.status);
        if (!r2.ok) {
            console.log('Text:', await r2.text());
        } else {
            const d2 = await r2.json();
            console.log('/chat response:', JSON.stringify(d2));
        }
    } catch (e) {
        console.error('/chat ERROR:', e);
    }
}

check();
