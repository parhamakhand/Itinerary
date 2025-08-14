/**
 * Cloudflare Worker — Google Gemini + Firestore (REST)
 * Bindings you need:
 * GEMINI_API_KEY (secret)               ← your Google AI Studio API key
 * GCP_KEY_JSON   (secret or JSON var)   ← service account JSON for Firestore
 * GCP_PROJECT_ID (var)                  ← your GCP project id
 */

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Only POST requests are accepted", { status: 405 });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response("Invalid JSON body", { status: 400 });
    }

    const { destination, durationDays } = payload || {};
    if (!destination || !Number.isInteger(durationDays) || durationDays < 1) {
      return new Response(
        "A destination (string) and durationDays (positive integer) are required.",
        { status: 400 }
      );
    }

    const jobId = crypto.randomUUID();

    ctx.waitUntil(createAndRunGemini(jobId, destination, durationDays, env));

    return Response.json({ jobId }, { status: 202 });
  },
};

const FS_HOST = "https://firestore.googleapis.com/v1";
function nowTS() {
  const s = Math.floor(Date.now() / 1000);
  return { seconds: s, nanos: 0 };
}
function wrap(v) {
  if (v === null) return { nullValue: null };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(wrap) } };
  if (typeof v === "object" && v && "seconds" in v)
    return { timestampValue: new Date(v.seconds * 1e3).toISOString() };
  if (typeof v === "object")
    return {
      mapValue: {
        fields: Object.fromEntries(
          Object.entries(v).map(([k, x]) => [k, wrap(x)])
        ),
      },
    };
  if (typeof v === "number" && Number.isInteger(v)) return { integerValue: v };
  if (typeof v === "number") return { doubleValue: v };
  return { stringValue: String(v) };
}
async function getToken(env) {
  const key =
    typeof env.GCP_KEY_JSON === "string"
      ? JSON.parse(env.GCP_KEY_JSON)
      : env.GCP_KEY_JSON;
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 3600;
  const enc = new TextEncoder();
  const toB = (a) =>
    btoa(String.fromCharCode(...a))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  const hdr = toB(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const pld = toB(
    enc.encode(
      JSON.stringify({
        iss: key.client_email,
        scope: "https://www.googleapis.com/auth/datastore",
        aud: "https://oauth2.googleapis.com/token",
        iat,
        exp,
      })
    )
  );
  const pk = key.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const keyBuf = Uint8Array.from(atob(pk), (c) => c.charCodeAt(0)).buffer;
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyBuf,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    enc.encode(`${hdr}.${pld}`)
  );
  const jwt = `${hdr}.${pld}.${toB(new Uint8Array(sig))}`;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`GCP OAuth error: ${JSON.stringify(j)}`);
  return j.access_token;
}

async function createDoc(id, dest, days, env) {
  const token = await getToken(env);
  const url = `${FS_HOST}/projects/${env.GCP_PROJECT_ID}/databases/(default)/documents/itineraries?documentId=${id}`;
  const body = {
    status: "processing",
    destination: dest,
    durationDays: days,
    createdAt: nowTS(),
    completedAt: null,
    itinerary: null,
    error: null,
  };
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fields: Object.fromEntries(
        Object.entries(body).map(([k, v]) => [k, wrap(v)])
      ),
    }),
  });

  if (!response.ok) {
    const errorBody = await response.json();
    throw new Error(
      `Firestore create failed: ${response.status} ${response.statusText}. ` +
      `Details: ${JSON.stringify(errorBody)}`
    );
  }
}
async function patchDoc(id, data, env) {
  const token = await getToken(env);

  const updateMaskParams = Object.keys(data)
    .map(key => `updateMask.fieldPaths=${encodeURIComponent(key)}`)
    .join('&');

  const url = `${FS_HOST}/projects/${env.GCP_PROJECT_ID}/databases/(default)/documents/itineraries/${id}?${updateMaskParams}`;

  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fields: Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, wrap(v)])
      ),
    }),
  });

  if (!response.ok) {
    const errorBody = await response.json();
    throw new Error(
      `Firestore patch failed: ${response.status} ${response.statusText}. ` +
      `Details: ${JSON.stringify(errorBody)}`
    );
  }
}


async function withTimeout(promise, ms, label = "operation") {
  const t = new Promise((_, rej) =>
    setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)
  );
  return Promise.race([promise, t]);
}

async function createAndRunGemini(id, dest, days, env) {
  console.log(`[${id}] Starting background job...`);
  try {
    await createDoc(id, dest, days, env);
    console.log(`[${id}] Successfully created Firestore doc with 'processing' status.`);

    if (!env.GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY environment variable not set.");
    }

    const model = "gemini-1.5-flash-latest";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;

    const prompt = `You are an expert travel itinerary generator. Your task is to create a ${days}-day travel plan for ${dest}.

    **CRITICAL INSTRUCTION**: Your entire response MUST be a single, raw JSON object. Do not add any commentary, markdown, or any text outside of the JSON.

    The JSON object must have one single root key: "itinerary".
    The value of "itinerary" must be an array of day objects, with exactly ${days} elements.

    Each day object in the array must contain:
    - "day": (Integer) The day number.
    - "theme": (String) A short theme for the day.
    - "activities": (Array) A list of activity objects.

    Each activity object must contain:
    - "time": (String) The suggested time, e.g., "9:00 AM".
    - "description": (String) A brief description of the activity.
    - "location": (String) The location of the activity.

    Here is an example of the required format for a 2-day trip:
    {
      "itinerary": [
        {
          "day": 1,
          "theme": "Historical Arrival",
          "activities": [
            { "time": "2:00 PM", "description": "Arrive and check into the hotel", "location": "City Center Hotel" },
            { "time": "4:00 PM", "description": "Visit the Old Town Square", "location": "Old Town" }
          ]
        },
        {
          "day": 2,
          "theme": "Cultural Exploration",
          "activities": [
            { "time": "10:00 AM", "description": "Explore the National Museum", "location": "Museum District" }
          ]
        }
      ]
    }

    Now, generate the JSON for the ${days}-day trip to ${dest}.`;

    const body = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
      },
    };

    console.log(`[${id}] Calling Gemini API at ${model}...`);
    const resp = await withTimeout(
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json()),
      45000,
      "Gemini API call"
    );

    console.log(`[${id}] Received response from Gemini:`, JSON.stringify(resp, null, 2));
    if (resp.error) throw new Error(resp.error.message || "Unknown Gemini API error");
    const textContent = resp.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!textContent) throw new Error(`Invalid response structure from Gemini.`);
    const parsed = JSON.parse(textContent);
    if (!parsed || !parsed.itinerary) {
        throw new Error(`Missing 'itinerary' key in parsed JSON. Found keys: ${Object.keys(parsed).join(', ')}`);
    }

    console.log(`[${id}] Successfully parsed itinerary. Patching Firestore doc...`);
    await patchDoc(id, {
        status: "completed",
        completedAt: nowTS(),
        itinerary: parsed.itinerary,
        error: null
      },
      env
    );
    console.log(`[${id}] ✅ Background job finished successfully.`);

  } catch (err) {
    console.error(`[${id}] ❌ FAILED: An error occurred during the background job.`);
    console.error(`[${id}] Error Message: ${err.message}`);
    console.error(`[${id}] Error Stack: ${err.stack}`);

    const errorText = String(err.message ? err.message : err);
    try {
      console.log(`[${id}] 🩹 Attempting to patch Firestore with 'failed' status...`);
      await patchDoc(id, { status: "failed", completedAt: nowTS(), error: errorText }, env);
      console.log(`[${id}] 🩹 Successfully patched Firestore with 'failed' status.`);
    } catch (patchErr) {
      console.error(`[${id}] 🆘 CRITICAL: Failed to patch Firestore with error state after initial failure.`, patchErr);
    }
  }
}
