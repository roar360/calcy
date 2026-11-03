// Cloudflare Worker: receives a photo, asks a vision model to READ the numbers,
// returns an arithmetic expression. The page calculates the total with math.js.
//
// Setup (Cloudflare dashboard or wrangler):
//   secret   GEMINI_API_KEY   -> your key from aistudio.google.com
//   variable ALLOW_ORIGIN     -> your site, e.g. https://yourdomain.com (use * only while testing)
//   variable MODEL            -> optional, default below; check the current model name in Google AI Studio
//   KV binding RATE           -> optional but strongly recommended (per-IP daily cap)

const DAILY_CAP = 30;            // hard server-side cap per IP per day (abuse protection)
const MAX_IMAGE_CHARS = 2_000_000;
const DEFAULT_MODEL = "gemini-2.5-flash";

const PROMPT = `You read arithmetic from a photo of handwriting or print (a sum, or a shop bill / ledger).
Return JSON only: {"expression": string, "note": string}.
Rules:
- "expression" uses only digits, + - * / ( ) and ".". Convert x or × to *, ÷ to /. Remove currency symbols and thousand separators.
- Convert percentages to plain arithmetic, e.g. "500 less 10%" becomes "500*(1-10/100)".
- For a bill with items, quantities and prices, build the sum of line totals, e.g. "3*45+2*30+120". Do not copy a written grand total; compute from the lines.
- If a grand total is written on the page and is visible, mention it in "note" (e.g. "Bill shows total 315"). Otherwise note can be "".
- If a digit is unclear, make your best guess and say which in "note".
- If there is nothing readable, return {"expression": "", "note": ""}.
- Never add words or explanations outside the JSON. Do not calculate the final answer.`;

export default {
  async fetch(req, env) {
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOW_ORIGIN || "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    const reply = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST") return reply({ error: "POST only" }, 405);

    // Per-IP daily cap
    if (env.RATE) {
      const ip = req.headers.get("CF-Connecting-IP") || "unknown";
      const key = `u:${ip}:${new Date().toISOString().slice(0, 10)}`;
      const n = parseInt((await env.RATE.get(key)) || "0", 10);
      if (n >= DAILY_CAP) return reply({ error: "limit" }, 429);
      await env.RATE.put(key, String(n + 1), { expirationTtl: 90000 });
    }

    let body;
    try { body = await req.json(); } catch { return reply({ error: "bad json" }, 400); }
    if (!body.image || typeof body.image !== "string") return reply({ error: "no image" }, 400);
    if (body.image.length > MAX_IMAGE_CHARS) return reply({ error: "image too large" }, 413);

    const model = env.MODEL || DEFAULT_MODEL;
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: body.mime || "image/jpeg", data: body.image } }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json" },
      }),
    });
    if (!r.ok) return reply({ error: "model error" }, 502);

    try {
      const data = await r.json();
      const text = data.candidates[0].content.parts[0].text;
      const out = JSON.parse(text.replace(/```json|```/g, "").trim());
      // Only allow safe characters through to the page
      const expression = String(out.expression || "").replace(/[^0-9+\-*/().\s]/g, "").trim();
      return reply({ expression, note: String(out.note || "").slice(0, 200) });
    } catch {
      return reply({ expression: "", note: "" });
    }
  },
};
