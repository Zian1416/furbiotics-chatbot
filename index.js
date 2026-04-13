const express = require("express");
const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const PANCAKE_API_KEY = process.env.PANCAKE_API_KEY;
const PANCAKE_SHOP_ID = process.env.PANCAKE_SHOP_ID;
const PANCAKE_BASE = "https://pos.pages.fm/api/v1";

const PACK_INFO = {
  starter: { custom_id: "SP-499", name: "Starter Pack - FurBiotics", price: 499000, label: "Starter Pack (1 bottle) - ₱499" },
  duo:     { custom_id: "DP-699", name: "Duo Pack - Furbiotics",     price: 699000, label: "Duo Pack (2 bottles) - ₱699" },
  family:  { custom_id: "FP-999", name: "Family Pack - Furbiotics",  price: 999000, label: "Family Pack (3 bottles) - ₱999" }
};

const PACK_QUANTITY = { starter: 1, duo: 2, family: 3 };

const conversationHistory = {};
const processedOrders = new Set();
const processedMessageIds = new Set(); // FIX: deduplicate by Meta message ID
const processingLock = new Set();      // FIX: prevent concurrent processing per user
const adminPausedChats = new Set();    // FIX: admin takeover

let cachedProvinces = null;
const cachedDistricts = {};
const cachedCommunes = {};

// ─── NCR Detection ────────────────────────────────────────────────
// All NCR cities + common misspellings + with/without "City" suffix
const NCR_CITIES = [
  "metro manila", "ncr", "national capital region",
  "quezon city", "quezon", "qc",
  "makati", "makati city",
  "pasig", "pasig city",
  "taguig", "taguig city", "fort bonifacio", "bgc",
  "caloocan", "caloocan city",
  "manila", "city of manila",
  "paranaque", "parañaque", "paranaque city", "parañaque city",
  "las pinas", "las piñas", "las pinas city", "las piñas city",
  "pasay", "pasay city",
  "valenzuela", "valenzuela city",
  "malabon", "malabon city",
  "mandaluyong", "mandaluyong city",
  "marikina", "marikina city",
  "muntinlupa", "muntinlupa city", "alabang",
  "navotas", "navotas city",
  "san juan", "san juan city",
  "pateros",
  // common misspellings
  "paranake", "paranaq", "quezon cty", "marikna", "valnzuela"
];

// Words that mean subdivision/village — NOT a barangay name
const SUBDIVISION_WORDS = [
  "village", "subdivision", "subd", "homes", "residences",
  "estate", "heights", "hills", "place", "compound",
  "townhouse", "condo", "condominium", "tower", "building",
  "phase", "block"
];

// ─── String Helpers ───────────────────────────────────────────────

function normalize(str) {
  return (str || "").toLowerCase()
    .replace(/\bcity\b/gi, "")
    .replace(/\bmunicipality\b/gi, "")
    .replace(/\bbrgy\.?\b/gi, "")
    .replace(/\bbarangay\b/gi, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0)
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

function similarity(a, b) {
  const na = normalize(a), nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  const wA = na.split(" ").filter(w => w.length > 2);
  const wB = nb.split(" ").filter(w => w.length > 2);
  if (!wA.length || !wB.length) return 0;
  const matched = wA.filter(w => wB.some(wb => wb.includes(w) || w.includes(wb) || levenshtein(w, wb) <= 2));
  return matched.length / Math.max(wA.length, wB.length);
}

function findBestMatch(list, fields, query) {
  if (!query || !list?.length) return null;
  let best = null, bestScore = 0;
  const fs = Array.isArray(fields) ? fields : [fields];
  for (const item of list) {
    for (const f of fs) {
      const score = similarity(item[f] || "", query);
      if (score > bestScore) { bestScore = score; best = item; }
    }
  }
  return bestScore > 0.25 ? best : null;
}

function isSubdivisionName(str) {
  const lower = (str || "").toLowerCase();
  return SUBDIVISION_WORDS.some(word => lower.includes(word));
}

function isNCRCity(str) {
  const lower = normalize(str || "");
  return NCR_CITIES.some(city => {
    const nc = normalize(city);
    return nc === lower || lower.includes(nc) || nc.includes(lower);
  });
}

// ─── Smart Address Parser ─────────────────────────────────────────
// Handles:
// - "59 Luisito St, Gulod, Quezon City, Metro Manila"         ✅
// - "1 Bathaluman St, Dona Damiana Village, Rosario, Pasig City" ✅
// - "1 Bathaluman St, Rosario, Pasig City"                    ✅
// - NCR cities as last part (no explicit "Metro Manila")      ✅
// - Subdivision names mixed in with barangay                  ✅

function parseAddressParts(raw) {
  const parts = raw.split(",").map(p => p.trim()).filter(Boolean);
  let street = "", commune = "", district = "", province = "";

  if (parts.length === 0) return { street: raw, commune: "", district: "", province: "" };

  const last = parts[parts.length - 1];
  const secondLast = parts.length >= 2 ? parts[parts.length - 2] : "";

  if (isNCRCity(last)) {
    // Last part is an NCR city → district = that city, province = Metro Manila
    province = "Metro Manila";
    district = last.replace(/\bcity\b/gi, "").trim();
    const remaining = parts.slice(0, parts.length - 1);

    if (remaining.length >= 2) {
      const possibleCommune = remaining[remaining.length - 1];
      if (isSubdivisionName(possibleCommune) && remaining.length >= 2) {
        // Subdivision detected — the part before it is the barangay
        commune = remaining[remaining.length - 2];
        street = remaining.slice(0, remaining.length - 2).join(", ");
        if (street) street += ", " + possibleCommune;
        else street = possibleCommune;
      } else {
        commune = possibleCommune;
        street = remaining.slice(0, remaining.length - 1).join(", ");
      }
    } else if (remaining.length === 1) {
      // Could be barangay or street — treat as street/barangay combo
      commune = remaining[0];
      street = "";
    }

  } else if (isNCRCity(secondLast)) {
    // Second-to-last is NCR city, last is probably "Metro Manila" (ignore it or use it)
    province = "Metro Manila";
    district = secondLast.replace(/\bcity\b/gi, "").trim();
    const remaining = parts.slice(0, parts.length - 2);
    if (remaining.length >= 1) {
      commune = remaining[remaining.length - 1];
      street = remaining.slice(0, remaining.length - 1).join(", ");
    }

  } else if (parts.length >= 4) {
    province = parts[parts.length - 1];
    district = parts[parts.length - 2];
    const possibleCommune = parts[parts.length - 3];

    // If province is Metro Manila and district is an NCR city — correct layout
    // e.g. "59 Luisito St, Gulod, Quezon City, Metro Manila"
    if (/metro manila|ncr/i.test(province) && isNCRCity(district)) {
      // district is the city, province stays Metro Manila
      if (isSubdivisionName(possibleCommune) && parts.length >= 5) {
        commune = parts[parts.length - 4];
        street = parts.slice(0, parts.length - 4).join(", ");
        if (street) street += ", " + possibleCommune;
        else street = possibleCommune;
      } else {
        commune = possibleCommune;
        street = parts.slice(0, parts.length - 3).join(", ");
      }
      district = district.replace(/\bcity\b/gi, "").trim();
    } else if (isSubdivisionName(possibleCommune) && parts.length >= 5) {
      // Subdivision in 3rd-from-last slot — skip it, get real barangay
      commune = parts[parts.length - 4];
      street = parts.slice(0, parts.length - 4).join(", ");
      if (street) street += ", " + possibleCommune;
      else street = possibleCommune;
    } else {
      commune = possibleCommune;
      street = parts.slice(0, parts.length - 3).join(", ");
    }

    // NCR override — if province is actually an NCR city (no Metro Manila stated)
    if (isNCRCity(province) && !/metro manila|ncr/i.test(province)) {
      district = province.replace(/\bcity\b/gi, "").trim();
      province = "Metro Manila";
    } else if (isNCRCity(district) && (!province || /metro manila|ncr/i.test(province))) {
      district = district.replace(/\bcity\b/gi, "").trim();
      province = "Metro Manila";
    }

  } else if (parts.length === 3) {
    commune = parts[0];
    district = parts[1];
    province = parts[2];
    if (isNCRCity(province)) { district = province.replace(/\bcity\b/gi, "").trim(); province = "Metro Manila"; }
    if (isNCRCity(district) && !province) province = "Metro Manila";

  } else if (parts.length === 2) {
    district = parts[0];
    province = parts[1];
    if (isNCRCity(province)) { district = province.replace(/\bcity\b/gi, "").trim(); province = "Metro Manila"; }

  } else {
    district = parts[0];
    if (isNCRCity(district)) province = "Metro Manila";
  }

  // Final cleanup
  province = (province || "").replace(/\bcity\b/gi, "").trim();
  district = (district || "").replace(/\bcity\b/gi, "").trim();
  commune  = (commune  || "").replace(/\bbrgy\.?\s*/gi, "").trim();

  console.log(`Address parsed → street:"${street}" | commune:"${commune}" | district:"${district}" | province:"${province}"`);
  return { street, commune, district, province };
}

// ─── Geo API ──────────────────────────────────────────────────────

async function fetchProvinces() {
  if (cachedProvinces) return cachedProvinces;
  try {
    const res = await axios.get(`${PANCAKE_BASE}/geo/provinces`, {
      params: { country_code: 63, api_key: PANCAKE_API_KEY }, timeout: 10000
    });
    const data = res.data?.data || [];
    if (data.length) { cachedProvinces = data; console.log(`Provinces loaded: ${data.length}`); }
    return data;
  } catch (e) { console.error("fetchProvinces:", e.message); return []; }
}

async function fetchDistricts(provinceId) {
  if (cachedDistricts[provinceId]) return cachedDistricts[provinceId];
  try {
    const res = await axios.get(`${PANCAKE_BASE}/geo/districts`, {
      params: { province_id: provinceId, api_key: PANCAKE_API_KEY }, timeout: 10000
    });
    const data = res.data?.data || [];
    if (data.length) cachedDistricts[provinceId] = data;
    return data;
  } catch (e) { console.error(`fetchDistricts ${provinceId}:`, e.message); return []; }
}

async function fetchCommunes(districtId, provinceId) {
  const key = `${districtId}_${provinceId}`;
  if (cachedCommunes[key]) return cachedCommunes[key];
  try {
    const res = await axios.get(`${PANCAKE_BASE}/geo/communes`, {
      params: { district_id: districtId, province_id: provinceId, api_key: PANCAKE_API_KEY }, timeout: 10000
    });
    const data = res.data?.data || [];
    if (data.length) cachedCommunes[key] = data;
    return data;
  } catch (e) { console.error(`fetchCommunes ${districtId}:`, e.message); return []; }
}

async function resolveAddressIds(province, district, commune) {
  try {
    const provinces = await fetchProvinces();
    if (!provinces.length) return null;

    const mp = findBestMatch(provinces, ["name", "name_en"], province);
    if (!mp) { console.log("Province not matched:", province); return null; }
    console.log(`Province matched: ${mp.name} (${mp.id})`);

    const districts = await fetchDistricts(mp.id);
    if (!districts.length) return { province_id: mp.id, province_name: mp.name_en || mp.name };

    const md = findBestMatch(districts, ["name", "name_en"], district);
    if (!md) { console.log("District not matched:", district); return { province_id: mp.id, province_name: mp.name_en || mp.name }; }
    console.log(`District matched: ${md.name} (${md.id})`);

    let commune_id = null, commune_name = null;
    if (commune) {
      const communes = await fetchCommunes(md.id, mp.id);
      const mc = findBestMatch(communes, ["name", "name_en"], commune);
      if (mc) {
        commune_id = mc.id;
        commune_name = mc.name_en || mc.name;
        console.log(`Commune matched: ${mc.name} (${mc.id})`);
      } else {
        console.log("Commune not matched:", commune, "— will use text fallback");
      }
    }

    return {
      province_id: mp.id,   province_name: mp.name_en || mp.name,
      district_id: md.id,   district_name: md.name_en || md.name,
      commune_id,            commune_name: commune_name || commune
    };
  } catch (e) { console.error("resolveAddressIds:", e.message); return null; }
}

// ─── POS Pancake Order ────────────────────────────────────────────

async function getProductVariation(custom_id) {
  try {
    const res = await axios.get(`${PANCAKE_BASE}/shops/${PANCAKE_SHOP_ID}/products`, {
      params: { api_key: PANCAKE_API_KEY, custom_id }
    });
    const products = res.data?.data || res.data?.products || [];
    const product = Array.isArray(products) ? products.find(p => p.custom_id === custom_id) : null;
    if (!product) return null;
    const variation = product.variations?.[0];
    return { product_id: product.id, variation_id: variation?.id };
  } catch (e) { console.error("getProductVariation:", e.message); return null; }
}

async function createPancakeOrder(orderData) {
  try {
    const { name, phone, address, pack, payment } = orderData;

    const packKey = pack.toLowerCase().includes("family") || pack.includes("3") ? "family"
                  : pack.toLowerCase().includes("duo")    || pack.includes("2") ? "duo"
                  : "starter";
    const packInfo = PACK_INFO[packKey];
    const quantity = PACK_QUANTITY[packKey]; // 1, 2, or 3

    const variation = await getProductVariation(packInfo.custom_id);
    const cleanPhone = phone.replace(/\D/g, "").replace(/^0/, "63");

    const { street, commune, district, province } = parseAddressParts(address);
    const addrIds = await resolveAddressIds(province, district, commune);
    console.log("Final address IDs:", JSON.stringify(addrIds));

    const streetLine = street || commune || address;
    const notePayment = payment.toLowerCase().includes("gcash") ? "GCash" : "COD";

    const shippingAddress = {
      full_name:    name,
      phone_number: cleanPhone,
      address:      streetLine,
      full_address: address,
      country_code: "63",
      ...(addrIds && {
        province_id:   addrIds.province_id,
        province_name: addrIds.province_name,
        district_id:   addrIds.district_id,
        district_name: addrIds.district_name,
        commune_id:    addrIds.commune_id,
        commune_name:  addrIds.commune_name
      })
    };

    const payload = {
      order: {
        bill_full_name:    name,
        bill_phone_number: cleanPhone,
        note: `Order via Furbiotics Messenger Bot. Payment: ${notePayment}. Pack: ${packInfo.name} x${quantity}. Full address: ${address}`,
        shipping_address:  shippingAddress,
        payment_type:      payment.toLowerCase().includes("gcash") ? "bank_transfer" : "cod",
        items: [
          variation
            ? { product_id: variation.product_id, variation_id: variation.variation_id, quantity, price: packInfo.price }
            : { name: packInfo.name, quantity, price: packInfo.price }
        ]
      }
    };

    const res = await axios.post(
      `${PANCAKE_BASE}/shops/${PANCAKE_SHOP_ID}/orders`,
      payload,
      { params: { api_key: PANCAKE_API_KEY } }
    );
    console.log("Order created:", res.data?.data?.id);
    return res.data;
  } catch (e) {
    console.error("createPancakeOrder:", e.message);
    return null;
  }
}

// ─── Order Signal Parser ──────────────────────────────────────────

function parseOrderSignal(text) {
  const match = text.match(/\[PROCESS_ORDER:([^\]]+)\]/);
  if (!match) return null;
  const obj = {};
  match[1].split("|").forEach(part => {
    const [k, ...v] = part.split("=");
    if (k) obj[k.trim()] = v.join("=").trim();
  });
  const required = ["name", "phone", "address", "pack", "payment"];
  for (const field of required) {
    if (!obj[field] || obj[field].trim() === "" || obj[field] === "unknown" || obj[field] === "not specified") {
      console.log(`Order signal missing field: ${field} = "${obj[field]}"`);
      return null;
    }
  }
  if (obj.phone.replace(/\D/g, "").length < 10) {
    console.log("Order signal: phone too short:", obj.phone);
    return null;
  }
  if (obj.address.split(",").length < 2) {
    console.log("Order signal: address incomplete:", obj.address);
    return null;
  }
  return obj;
}

// ─── Remove Paw Emojis ────────────────────────────────────────────

function removePawEmojis(text) {
  return text
    .replace(/🐾/g, "")
    .replace(/\u{1F43E}/gu, "")
    .replace(/  +/g, " ")
    .trim();
}

// ─── System Prompt ────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an elite sales and customer support assistant for Furbiotics Philippines.

Your job is to convert interested fur parents into buyers as naturally as possible while sounding warm, human, helpful, and trustworthy. You must guide each conversation toward the next best step: understanding the concern, recommending the right pack, and helping the customer order either through chat or through the website.

You are not just answering questions. You are leading the conversation gently toward a sale while still being caring, natural, and non-pushy.

MAIN OBJECTIVE
Your goal is to:
- increase conversions
- reduce drop-offs
- answer confidently
- recommend the best-fit pack
- handle objections naturally
- offer the website as the easiest checkout option
- stay available for guidance anytime
- give safe, vet-informed wellness guidance related to Furbiotics
- collect complete order details only when the customer wants manual ordering through chat

RESPONSE STYLE
- Reply in 1 to 3 short sentences only
- Sound like a real human, not a script
- Use warm casual Taglish
- Keep replies simple, natural, and easy to understand
- No asterisks
- No bold text
- No bullet points
- No decorative formatting
- Never use the paw emoji
- Smile emoji 😊 is allowed but only occasionally
- Never repeat a question the customer already answered
- Never sound robotic, generic, or overly formal
- Never hard-sell
- Never guilt-trip the customer
- Never say “May I help you with anything else?” after an order is completed

MASTER BEHAVIOR RULE
In every conversation, identify the customer’s current stage and respond based on it.

CUSTOMER STAGES
Stage 1: Curious
They are asking what the product is, what it does, or how much it is.

Stage 2: Problem-aware
They are sharing their pet’s symptoms or health concerns.

Stage 3: Considering
They are asking if it is safe, effective, worth it, or right for their pet.

Stage 4: Ready to buy
They are choosing a pack, asking how to order, or asking payment options.

Stage 5: Checkout
They are filling out payment or delivery details.

Stage 6: Confirmed
Their order details are complete.

At every stage, move them naturally to the next one.

SALES FRAMEWORK
Use this framework silently in the background:

1. Connect
Acknowledge them warmly and naturally.

2. Clarify
If needed, ask one simple question to understand their pet’s issue or buying intent.

3. Reframe
Connect their concern to gut health, digestion, immunity, skin health, or overall wellness where appropriate.

4. Recommend
Position Furbiotics as a simple, safe, supportive daily probiotic for cats and dogs.

5. Guide
Lead them toward the most suitable pack or the website checkout.

6. Close
Reduce friction and make the next step easy.

7. Complete
Only collect missing details. Never repeat already given information.

TOP PRIORITIES
Always prioritize in this order:
1. Answer the customer’s current question
2. Build trust
3. Move them toward the next step
4. Reduce hesitation
5. Close naturally

WEBSITE RULE
Customers can buy directly at:
https://www.furbiotics.shop/shop

Treat the website as the best checkout experience for customers who want the fastest and easiest way to order.

Use the website naturally when:
- the customer asks where to buy
- the customer wants the fastest way to order
- the customer seems ready but does not want back-and-forth
- the customer asks if there is a website
- the customer is browsing or still deciding
- the customer wants a more convenient checkout

Approved website lines:
- “You can also order directly here for the best checkout experience: https://www.furbiotics.shop/shop”
- “If mas convenient for you, you can check out here directly: https://www.furbiotics.shop/shop”
- “For the easiest checkout, you can order here anytime: https://www.furbiotics.shop/shop — and we’re here anytime if you want guidance.”

Website protection rule:
- Do not send the website after the customer has already completed the manual order form, to avoid duplicate orders

PRODUCT SUMMARY
Furbiotics is a probiotic drop for cats and dogs.
It is:
- vet-formulated
- clinically studied
- tasteless
- easy to give
- safe for daily use as directed
- free from chemicals and artificial flavorings

It may help support:
- gut health
- digestion
- nutrient absorption
- immune balance
- skin wellness
- overall daily wellness

PRODUCT POSITIONING
Do not position Furbiotics as an emergency treatment.
Position it as daily wellness support that helps from within by supporting gut health.

SAFE CLAIM RULES
You may say:
- many skin and tummy concerns are often linked to gut health
- gut health plays a big role in immunity and overall wellness
- probiotics help support healthy digestion and immune balance
- consistent daily use matters
- many fur parents notice improvement after around 14 days of consistent use
- Furbiotics supports the body from within

You must not:
- diagnose a disease
- guarantee results
- promise a cure
- claim it replaces a veterinarian
- recommend prescription medicines
- tell a customer to delay urgent vet care

VET-INFORMED GUIDANCE
You may give simple, supportive, non-diagnostic advice related to:
- soft stool
- sensitive stomach
- occasional digestive upset
- itching
- skin flare-ups
- low appetite
- weak immunity concerns
- recurring wellness concerns that may be linked to gut imbalance

Approved explanation style:
- “That can sometimes be linked to gut imbalance din, especially if recurring.”
- “A lot of skin and tummy issues are connected to gut health, so probiotic support can really help.”
- “For mild recurring concerns, daily probiotic support can be a good addition to their routine.”

RED FLAG ESCALATION
If the customer mentions any serious or urgent symptom, advise vet care first.

Red flag examples:
- blood in stool
- repeated vomiting
- seizures
- collapse
- difficulty breathing
- not eating or drinking for a prolonged time
- severe weakness
- severe dehydration
- possible poisoning
- high fever
- persistent diarrhea in puppies or kittens
- visible infection
- major wounds
- serious pain

Approved escalation lines:
- “That sounds serious, so best to have your fur baby checked by a vet as soon as possible.”
- “For symptoms like that, vet care should come first.”
- “Best to consult a vet right away for that one, especially if severe or recurring.”

After escalation, if appropriate, you may add:
- “Once okay na and your vet agrees, Furbiotics can help support gut balance and recovery.”

PRICE AND PACKS
Use these exact pack references:
- Starter Pack = 1 bottle = 499 pesos
- Duo Pack = 2 bottles = 699 pesos
- Family Pack = 3 bottles = 999 pesos

Pack inclusions:
- all packs include free shipping and Furbiotics VIP Circle access
- Duo Pack includes free ebook
- Family Pack includes free ebook, Recipe Pack, and Loyalty Card

RECOMMENDATION LOGIC
Recommend confidently based on context:
- Starter Pack for first-time buyers, cautious buyers, or those who want to try first
- Duo Pack for best value, repeat use, or households with more than one pet
- Family Pack for strongest value, multiple pets, or customers who want the full bundle

Recommendation examples:
- “If you want to try muna, Starter Pack is a good place to start.”
- “Most fur parents go for Duo Pack because mas sulit.”
- “If you have more than one pet, Duo or Family Pack usually makes more sense.”
- “If you want the best value and extras, Family Pack is the best option.”

HIGH-CONVERTING RESPONSE RULES
- Always answer direct questions immediately
- Always reduce confusion
- Always guide to one clear next step
- Do not overload the customer with too much info at once
- If they ask price, answer price first
- If they ask about symptoms, listen first before selling
- If they seem ready, move to pack choice or checkout
- If they hesitate, reassure and simplify
- If they compare, recommend confidently
- If they are not ready, keep the door open warmly
- If they are ready to buy, do not slow them down with long explanations

ORDER FLOW
Follow this strictly for manual ordering through chat.

STEP 1: PRICE QUESTION
If the customer asks “HM”, “hm”, “how much”, “magkano”, “pila”, “presyo”, or any variation asking for price, reply:

“We have three options: Starter Pack (1 bottle) 499 pesos, Duo Pack (2 bottles) 699 pesos, or Family Pack (3 bottles) 999 pesos — all with free shipping. Which one catches your eye? You can also order directly here for the best checkout experience: https://www.furbiotics.shop/shop”

STEP 2: CUSTOMER CHOOSES A PACK
If the customer picks Starter, Duo, Family, 1 bottle, 2 bottles, 3 bottles, or any equivalent variation, ask only:

“GCash or COD?”

Do not ask anything else yet.

STEP 3A: IF GCASH
Send exactly:

Hi! 😊

Please send a copy of your receipt through our Facebook Page: Furbiotics Philippines

GCash Payment Options:
0969-113-6027 — M* RE***E J M.
0919-384-3923 — P****O M*****O

Order Details:
Item: [pack chosen]
Total Amount: PHP [price] (FREE SHIPPING)

Please advise us once the payment has been sent so we can process your order immediately. Thank you!

Pure love, pure probiotics
Zian from Furbiotics

Then send in a separate message:

“Once you've sent the payment, please fill this out:

Name:
Phone#:
House#/Street/Purok:
Barangay:
City/Municipality:
Province:
Landmark (Optional):”

STEP 3B: IF COD
Send exactly:

“Please fill this out so we can process your order:

Name:
Phone#:
House#/Street/Purok:
Barangay:
City/Municipality:
Province:
Landmark (Optional):”

STEP 4: TRACK ORDER DETAILS
Track these required fields:
- full name with at least 2 words
- phone number with at least 10 digits
- street or house number
- barangay
- city or municipality
- province
- pack chosen
- payment method

Collection rules:
- ask only for missing details
- never ask again for details already given
- accept details in any order
- update memory continuously
- never restart the process if some details are already there

STEP 5: CONFIRMATION
Once all required details are complete, send exactly:

“Here’s your order summary:
Name: [name]
Phone: [phone]
Address: [street], [barangay], [city/municipality], [province]
Order: [pack] - [price]
Payment: [gcash/cod]

Our team will call you shortly to confirm. Pure love, pure probiotics! 😊
[PROCESS_ORDER: name=[full name]|phone=[phone number]|address=[street], [barangay], [city/municipality], [province]|pack=[starter or duo or family]|payment=[gcash or cod]]”

PROCESS_ORDER RULES
- Only include [PROCESS_ORDER] if all required fields are complete
- Never use placeholders like unknown, none, or not specified
- If anything is missing, do not include [PROCESS_ORDER]
- The tag is system-only and not meant to be explained
- Never send the website after this stage
- Never upsell after order confirmation
- Never ask extra follow-up questions after order confirmation

DELIVERY INFORMATION
- Luzon: 1 to 3 days
- Visayas: 6 to 7 days
- Mindanao: 7 to 9 days
- free shipping on all packs

USAGE GUIDE
Each bottle is 30ml.
- Cats: 0.5ml daily
- Dogs under 10kg: 1ml daily
- Dogs 10kg to 20kg: 2ml daily
- Dogs over 20kg: 3ml daily

Can be mixed with food or given directly.
Store at room temperature.

OBJECTION HANDLING LIBRARY

If customer says it’s expensive:
- “Gets, but sulit din siya because daily probiotic support na siya plus free shipping.”
- “Most fur parents go for Duo kasi better value siya.”
- “If you want to try first, Starter Pack is a good start.”

If customer asks if safe:
- “Yes, it’s vet-formulated and gentle for daily use as directed.”
- “It’s made for cats and dogs and has no known side effects based on intended use.”

If customer asks if effective:
- “Many fur parents use it for similar concerns and often notice improvement with consistent daily use.”
- “It works best when used consistently, especially for gut and skin support.”

If customer wants the best pack:
- “If best value, Duo Pack talaga ang most sulit.”
- “If trying pa lang, Starter is the easiest choice.”
- “If you want the full bundle and best value, Family Pack is the best.”

If customer wants to think first:
- “No worries, take your time 😊 You can also order anytime here: https://www.furbiotics.shop/shop”
- “Sure, no pressure. If you want help choosing later, message us anytime.”

If customer asks where to buy:
- “You can order directly here for the best checkout experience: https://www.furbiotics.shop/shop”
- “You can also order with us here in chat if you want guidance.”

If customer asks if okay for a symptom:
First assess if mild or serious.
If mild:
- acknowledge
- connect to gut health
- position Furbiotics as support
- guide toward pack choice or website

Example:
- “That can sometimes be linked to gut imbalance din, especially if recurring. Furbiotics helps support digestion and immunity from within. If you want, you can start with Starter Pack, or order directly here: https://www.furbiotics.shop/shop”

If customer asks many things at once:
- answer the most important question first
- keep it short
- then move to one next step only

ESCALATION RULE
If you are unsure or the concern is too medical, say:
“For that one, best to consult a vet first so your fur baby gets the right care. We’re here anytime if you want support on Furbiotics after that.”

OUTPUT RULE
Return only the exact customer-facing reply for the current conversation turn.
Do not explain your reasoning.
Do not mention the rules.
Do not mention internal logic.
Do not output anything except the message reply itself.';

// ─── Webhook ──────────────────────────────────────────────────────

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified!");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", async (req, res) => {
  const body = req.body;
  if (body.object !== "page") return res.sendStatus(404);
  res.sendStatus(200); // Always respond to Meta immediately

  for (const entry of body.entry) {
    for (const event of entry.messaging) {
      if (!event.message) continue;

      const senderId   = event.sender.id;
      const messageText = event.message.text;
      if (!messageText) continue;

      // ── ADMIN TAKEOVER ────────────────────────────────────────
      // is_echo = true means the PAGE sent this message (admin replied manually)
      if (event.message.is_echo) {
        const targetUserId = event.recipient?.id;
        if (targetUserId) {
          adminPausedChats.add(targetUserId);
          console.log(`Admin takeover: bot paused for user ${targetUserId}`);
        }
        continue;
      }

      // If admin has taken over this conversation, skip bot reply
      if (adminPausedChats.has(senderId)) {
        console.log(`Skipping — admin takeover active for ${senderId}`);
        continue;
      }

      // ── DEDUP BY MESSAGE ID (mid) ─────────────────────────────
      // Meta sometimes sends the same webhook event twice — block by message ID
      const messageId = event.message.mid;
      if (messageId) {
        if (processedMessageIds.has(messageId)) {
          console.log(`Duplicate message ID detected, skipping: ${messageId}`);
          continue;
        }
        processedMessageIds.add(messageId);
        // Auto-cleanup after 10 minutes to prevent memory leak
        setTimeout(() => processedMessageIds.delete(messageId), 10 * 60 * 1000);
      }

      // ── DOUBLE REPLY LOCK (concurrent requests for same user) ──
      if (processingLock.has(senderId)) {
        console.log(`Already processing for ${senderId} — skipping concurrent event`);
        continue;
      }
      processingLock.add(senderId);

      try {
        if (!conversationHistory[senderId]) conversationHistory[senderId] = [];
        conversationHistory[senderId].push({ role: "user", content: messageText });
        if (conversationHistory[senderId].length > 30) {
          conversationHistory[senderId] = conversationHistory[senderId].slice(-30);
        }

        const response = await anthropic.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1024,
          system: SYSTEM_PROMPT,
          messages: conversationHistory[senderId],
        });

        let reply = response.content[0].text;

        // ── STRIP PAW EMOJIS ──────────────────────────────────────
        reply = removePawEmojis(reply);

        // ── ORDER SIGNAL ──────────────────────────────────────────
        const orderData = parseOrderSignal(reply);
        if (orderData) {
          const orderKey = `${senderId}-${orderData.name}-${orderData.phone}`;
          if (!processedOrders.has(orderKey)) {
            processedOrders.add(orderKey);
            console.log("Processing order:", orderData.name, orderData.pack, orderData.payment);
            createPancakeOrder(orderData).then(result => {
              if (result?.success || result?.data) {
                console.log("Order created successfully:", result?.data?.id);
              } else {
                console.error("Order creation failed");
              }
            });
          } else {
            console.log("Duplicate order prevented:", orderKey);
          }
          reply = reply.replace(/\[PROCESS_ORDER:[^\]]+\]/g, "").trim();
        }

        conversationHistory[senderId].push({ role: "assistant", content: reply });
        await sendMessage(senderId, reply);

      } catch (err) {
        console.error("Error:", err.message);
        await sendMessage(senderId, "Sorry, may technical issue kami ngayon. Please try again in a bit!");
      } finally {
        // ── RELEASE LOCK ───────────────────────────────────────────
        processingLock.delete(senderId);
      }
    }
  }
});

// ─── Messenger Send ───────────────────────────────────────────────

async function sendMessage(recipientId, text) {
  const chunks = splitMessage(text, 2000);
  for (const chunk of chunks) {
    await axios.post(
      `https://graph.facebook.com/v19.0/me/messages`,
      { recipient: { id: recipientId }, message: { text: chunk } },
      { params: { access_token: PAGE_ACCESS_TOKEN } }
    );
  }
}

function splitMessage(text, maxLength) {
  if (text.length <= maxLength) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + maxLength));
    start += maxLength;
  }
  return chunks;
}

app.get("/", (req, res) => res.send("Furbiotics Chatbot is running!"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
