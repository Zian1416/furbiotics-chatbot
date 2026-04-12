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

const conversationHistory = {};
const processedOrders = new Set();
let cachedProvinces = null;
const cachedDistricts = {};
const cachedCommunes = {};

// ─── Address Helpers ───────────────────────────────────────────────

function normalize(str) {
  return (str || "").toLowerCase()
    .replace(/\bcity\b/gi, "").replace(/\bmunicipality\b/gi, "")
    .replace(/\bbrgy\.?\b/gi, "").replace(/\bbarangay\b/gi, "")
    .replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

function similarity(a, b) {
  const na = normalize(a), nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  const wA = na.split(" ").filter(w => w.length > 2);
  const wB = nb.split(" ").filter(w => w.length > 2);
  if (!wA.length || !wB.length) return 0;
  return wA.filter(w => wB.some(wb => wb.includes(w) || w.includes(wb))).length / Math.max(wA.length, wB.length);
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

function parseAddressParts(raw) {
  const parts = raw.split(",").map(p => p.trim());
  let street = "", commune = "", district = "", province = "";
  if (parts.length >= 4) {
    street = parts.slice(0, parts.length - 3).join(", ");
    commune = parts[parts.length - 3].replace(/brgy\.?\s*/i, "").trim();
    district = parts[parts.length - 2];
    province = parts[parts.length - 1];
  } else if (parts.length === 3) {
    commune = parts[0].replace(/brgy\.?\s*/i, "").trim();
    district = parts[1]; province = parts[2];
  } else if (parts.length === 2) {
    district = parts[0]; province = parts[1];
  } else { district = parts[0]; }
  const ncrKeys = ["metro manila","ncr","quezon city","makati","pasig","taguig","caloocan","manila","paranaque","las pinas","pasay","valenzuela","malabon","mandaluyong","marikina","muntinlupa","navotas","san juan","pateros"];
  if (ncrKeys.some(k => (province + " " + district).toLowerCase().includes(k))) {
    if (!province || /metro manila|ncr/i.test(province)) province = "Metro Manila";
  }
  return { street, commune, district, province };
}

async function fetchProvinces() {
  if (cachedProvinces) return cachedProvinces;
  try {
    const res = await axios.get(`${PANCAKE_BASE}/geo/provinces`, { params: { country_code: 63, api_key: PANCAKE_API_KEY }, timeout: 10000 });
    const data = res.data?.data || [];
    if (data.length) { cachedProvinces = data; console.log(`Provinces loaded: ${data.length}`); }
    return data;
  } catch (e) { console.error("fetchProvinces:", e.message); return []; }
}

async function fetchDistricts(provinceId) {
  if (cachedDistricts[provinceId]) return cachedDistricts[provinceId];
  try {
    const res = await axios.get(`${PANCAKE_BASE}/geo/districts`, { params: { province_id: provinceId, api_key: PANCAKE_API_KEY }, timeout: 10000 });
    const data = res.data?.data || [];
    if (data.length) cachedDistricts[provinceId] = data;
    return data;
  } catch (e) { console.error(`fetchDistricts ${provinceId}:`, e.message); return []; }
}

async function fetchCommunes(districtId, provinceId) {
  const key = `${districtId}_${provinceId}`;
  if (cachedCommunes[key]) return cachedCommunes[key];
  try {
    const res = await axios.get(`${PANCAKE_BASE}/geo/communes`, { params: { district_id: districtId, province_id: provinceId, api_key: PANCAKE_API_KEY }, timeout: 10000 });
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
    console.log(`Province: ${mp.name} (${mp.id})`);
    const districts = await fetchDistricts(mp.id);
    if (!districts.length) return { province_id: mp.id, province_name: mp.name_en || mp.name };
    const md = findBestMatch(districts, ["name", "name_en"], district);
    if (!md) { console.log("District not matched:", district); return { province_id: mp.id, province_name: mp.name_en || mp.name }; }
    console.log(`District: ${md.name} (${md.id})`);
    let commune_id = null, commune_name = null;
    if (commune) {
      const communes = await fetchCommunes(md.id, mp.id);
      const mc = findBestMatch(communes, ["name", "name_en"], commune);
      if (mc) { commune_id = mc.id; commune_name = mc.name_en || mc.name; console.log(`Commune: ${mc.name} (${mc.id})`); }
    }
    return {
      province_id: mp.id, province_name: mp.name_en || mp.name,
      district_id: md.id, district_name: md.name_en || md.name,
      commune_id, commune_name: commune_name || commune
    };
  } catch (e) { console.error("resolveAddressIds:", e.message); return null; }
}

async function getProductVariation(custom_id) {
  try {
    const res = await axios.get(`${PANCAKE_BASE}/shops/${PANCAKE_SHOP_ID}/products`, { params: { api_key: PANCAKE_API_KEY, custom_id } });
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
                  : pack.toLowerCase().includes("duo") || pack.includes("2") ? "duo"
                  : "starter";
    const packInfo = PACK_INFO[packKey];
    const variation = await getProductVariation(packInfo.custom_id);
    const cleanPhone = phone.replace(/\D/g, "").replace(/^0/, "63");
    const { street, commune, district, province } = parseAddressParts(address);
    const addrIds = await resolveAddressIds(province, district, commune);
    console.log("Final address IDs:", JSON.stringify(addrIds));

    const shippingAddress = {
      full_name: name, phone_number: cleanPhone,
      address: street || commune || address,
      full_address: address, country_code: "63",
      ...(addrIds && {
        province_id: addrIds.province_id, province_name: addrIds.province_name,
        district_id: addrIds.district_id, district_name: addrIds.district_name,
        commune_id: addrIds.commune_id, commune_name: addrIds.commune_name
      })
    };

    const payload = {
      order: {
        bill_full_name: name, bill_phone_number: cleanPhone,
        note: `Order via Furbiotics Messenger Bot. Payment: ${payment}. Full address: ${address}`,
        shipping_address: shippingAddress,
        payment_type: payment.toLowerCase().includes("gcash") ? "bank_transfer" : "cod",
        items: [
          variation
            ? { product_id: variation.product_id, variation_id: variation.variation_id, quantity: 1, price: packInfo.price }
            : { name: packInfo.name, quantity: 1, price: packInfo.price }
        ]
      }
    };

    const res = await axios.post(`${PANCAKE_BASE}/shops/${PANCAKE_SHOP_ID}/orders`, payload, { params: { api_key: PANCAKE_API_KEY } });
    console.log("Order created:", res.data?.data?.id);
    return res.data;
  } catch (e) { console.error("createPancakeOrder:", e.message); return null; }
}

function parseOrderSignal(text) {
  const match = text.match(/\[PROCESS_ORDER:([^\]]+)\]/);
  if (!match) return null;
  const obj = {};
  match[1].split("|").forEach(part => {
    const [k, ...v] = part.split("=");
    if (k) obj[k.trim()] = v.join("=").trim();
  });
  // Validate ALL required fields are present and non-empty
  const required = ["name", "phone", "address", "pack", "payment"];
  for (const field of required) {
    if (!obj[field] || obj[field].trim() === "" || obj[field] === "unknown" || obj[field] === "not specified") {
      console.log(`Order signal missing or invalid field: ${field} = "${obj[field]}"`);
      return null;
    }
  }
  // Validate phone has actual digits
  if (obj.phone.replace(/\D/g, "").length < 10) {
    console.log("Order signal: phone number too short:", obj.phone);
    return null;
  }
  // Validate address has at least 2 parts
  if (obj.address.split(",").length < 2) {
    console.log("Order signal: address incomplete:", obj.address);
    return null;
  }
  return obj;
}

// ─── System Prompt ─────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a friendly customer assistant for Furbiotics Philippines. Your job is to help fur parents and guide them to place an order naturally — not pushy, not scripted-sounding.

---

RESPONSE STYLE:
- 1 to 3 sentences max — short, natural, like a real person texting
- No asterisks, no bold, no bullet points, no formatting symbols
- No paw emojis. Smile emoji (😊) is okay but use sparingly
- Taglish (mix of English and Filipino) — casual and warm
- Never repeat a question if the customer already answered it
- Never say "May I help you with anything else?" after an order
- Sound like a human, not a bot

---

ORDER FLOW — FOLLOW THIS EXACTLY:

STEP 1: PRICE QUESTION
When customer says "HM", "hm", "how much", "magkano", "pila", "presyo", or anything asking about price:
→ Give the pricing first, then ask which one they want.

Example: "We have three options: Starter Pack (1 bottle) 499 pesos, Duo Pack (2 bottles) 699 pesos, or Family Pack (3 bottles) 999 pesos — all with free shipping. Which one catches your eye?"

STEP 2: CUSTOMER PICKS A PACK
When customer says "starter", "1 bottle", "1 bote", "duo", "2 bottles", "2 bote", "family", "3 bottles", "3 bote", or any variation:
→ Ask ONLY: "GCash or COD?"
→ Do NOT ask anything else at this point.

STEP 3A: IF GCASH
→ Send the GCash payment details:

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

→ Then send the order form in a SEPARATE message:
"Once you've sent the payment, please fill this out:

Name:
Phone#:
House#/Street/Purok:
Barangay:
City/Municipality:
Province:
Landmark (Optional):"

STEP 3B: IF COD
→ Send the order form immediately:
"Please fill this out so we can process your order:

Name:
Phone#:
House#/Street/Purok:
Barangay:
City/Municipality:
Province:
Landmark (Optional):"

STEP 4: COLLECTING ORDER INFORMATION
As the customer fills out the form, track what has been provided:
- Name ✓ or ✗
- Phone number ✓ or ✗ (must have actual digits, at least 10 digits)
- Street/House number ✓ or ✗
- Barangay ✓ or ✗
- City/Municipality ✓ or ✗
- Province ✓ or ✗
- Pack chosen ✓ or ✗
- Payment method ✓ or ✗

If something is missing, ask ONLY for the missing item — do not ask again for things already given.

STEP 5: WHEN ALL INFO IS COMPLETE
Once you have ALL 8 items — summarize the order and send it:

"Here's your order summary:
Name: [name]
Phone: [phone]
Address: [complete address]
Order: [pack] - [price]
Payment: [gcash/cod]

Our team will call you shortly to confirm. Pure love, pure probiotics! 😊
[PROCESS_ORDER: name=[name]|phone=[phone]|address=[street], [barangay], [city], [province]|pack=[starter or duo or family]|payment=[gcash or cod]]"

CRITICAL RULES FOR [PROCESS_ORDER]:
- ONLY include [PROCESS_ORDER] when ALL of these are confirmed: name, phone (with real digits), complete address (street + barangay + city + province), pack, payment
- If ANY field is missing or unclear — do NOT include [PROCESS_ORDER]. Ask only for the missing field.
- NEVER use placeholder values like "not specified", "unknown", or empty fields
- The [PROCESS_ORDER] tag is invisible to the customer — it is a system signal only
- NEVER give the website link (furbiotics.shop) once customer has given their details — causes duplicate orders
- NEVER upsell after order is confirmed
- NEVER ask "May I help you with anything else?" after order

---

PACK REFERENCE:
- Starter Pack = 1 bottle = 499 pesos
- Duo Pack = 2 bottles = 699 pesos  
- Family Pack = 3 bottles = 999 pesos
- All packs include FREE SHIPPING and Furbiotics VIP Circle access
- Duo Pack also includes FREE ebook
- Family Pack includes FREE ebook + Recipe Pack + Loyalty card

---

ABOUT FURBIOTICS:
Pure probiotic drops for cats and dogs. Vet-formulated, clinically studied. No chemicals, no artificial flavorings. Tasteless liquid drops — mix with food or give directly.

BENEFITS: Most fur baby problems (skin issues, itching, low immunity, hotspots) start in the gut. Furbiotics heals the gut to fix symptoms from the root.
RESULTS: Most fur parents see improvement after 14 days of daily use.
SIDE EFFECTS: None.

HOW TO USE (each bottle = 30ml):
Cats: 0.5ml daily
Dogs under 10kg: 1ml daily
Dogs 10-20kg: 2ml daily
Dogs over 20kg: 3ml daily
Store at room temperature. Can be mixed with food.

---

WHEN CUSTOMER HAS A CONCERN ABOUT THEIR PET:
Listen and help first — do not sell immediately.
Ask: "How is your fur baby? What symptoms are you seeing?"

After listening, introduce Furbiotics naturally:
"Most of the time, those kinds of symptoms actually start in the gut. We found something that's really helped a lot of fur babies with similar issues..."

Once they seem interested — follow the ORDER FLOW above from STEP 1.

---

DELIVERY TIMES (all FREE SHIPPING):
Luzon: 1-3 days | Visayas: 6-7 days | Mindanao: 7-9 days

AFTER ORDER IS CONFIRMED: Give a warm close and end the conversation. No upsell, no follow-up questions.

FOLLOW-UP MESSAGES (send after 2 weeks):
Already ordered: "Hello! How's your fur baby doing? Have you noticed any changes since starting Furbiotics?"
Not yet ordered: "Hey! How's your pet? Just checking in — we're here if you have questions."

WHEN YOU CAN'T ANSWER: "For that one, it's best to chat with our team directly. Just message us here on the page!"`;

// ─── Webhook ───────────────────────────────────────────────────────

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
  res.sendStatus(200);

  for (const entry of body.entry) {
    for (const event of entry.messaging) {
      if (!event.message || event.message.is_echo) continue;
      const senderId = event.sender.id;
      const messageText = event.message.text;
      if (!messageText) continue;

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
            console.log("Duplicate prevented:", orderKey);
          }
          reply = reply.replace(/\[PROCESS_ORDER:[^\]]+\]/g, "").trim();
        }

        conversationHistory[senderId].push({ role: "assistant", content: reply });
        await sendMessage(senderId, reply);

      } catch (err) {
        console.error("Error:", err.message);
        await sendMessage(senderId, "Sorry, may technical issue kami ngayon. Please try again in a bit!");
      }
    }
  }
});

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
