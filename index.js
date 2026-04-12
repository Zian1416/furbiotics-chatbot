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
  starter: { custom_id: "SP-499", name: "Starter Pack - FurBiotics", price: 499000 },
  duo:     { custom_id: "DP-699", name: "Duo Pack - Furbiotics",     price: 699000 },
  family:  { custom_id: "FP-999", name: "Family Pack - Furbiotics",  price: 999000 }
};

const conversationHistory = {};
const processedOrders = new Set();

// Cache
let cachedProvinces = null;
const cachedDistricts = {};
const cachedCommunes = {};

// ─── Address Helpers ───────────────────────────────────────────────

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

function similarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  const wordsA = na.split(" ").filter(w => w.length > 2);
  const wordsB = nb.split(" ").filter(w => w.length > 2);
  if (!wordsA.length || !wordsB.length) return 0;
  const matches = wordsA.filter(w => wordsB.some(wb => wb.includes(w) || w.includes(wb)));
  return matches.length / Math.max(wordsA.length, wordsB.length);
}

function findBestMatch(list, nameFields, query) {
  if (!query || !list?.length) return null;
  let best = null, bestScore = 0;
  const fields = Array.isArray(nameFields) ? nameFields : [nameFields];
  for (const item of list) {
    for (const field of fields) {
      const score = similarity(item[field] || "", query);
      if (score > bestScore) { bestScore = score; best = item; }
    }
  }
  return bestScore > 0.25 ? best : null;
}

function parseAddressParts(rawAddress) {
  const parts = rawAddress.split(",").map(p => p.trim());
  let street = "", commune = "", district = "", province = "";

  if (parts.length >= 4) {
    street = parts.slice(0, parts.length - 3).join(", ");
    commune = parts[parts.length - 3].replace(/brgy\.?\s*/i, "").trim();
    district = parts[parts.length - 2];
    province = parts[parts.length - 1];
  } else if (parts.length === 3) {
    commune = parts[0].replace(/brgy\.?\s*/i, "").trim();
    district = parts[1];
    province = parts[2];
  } else if (parts.length === 2) {
    district = parts[0];
    province = parts[1];
  } else {
    district = parts[0];
  }

  const ncrKeywords = ["metro manila", "ncr", "quezon city", "makati", "pasig", "taguig", "caloocan", "manila", "paranaque", "las pinas", "pasay", "valenzuela", "malabon", "mandaluyong", "marikina", "muntinlupa", "navotas", "san juan", "pateros"];
  const allText = (province + " " + district).toLowerCase();
  if (ncrKeywords.some(k => allText.includes(k))) {
    if (!province || /metro manila|ncr/i.test(province)) province = "Metro Manila";
  }

  return { street, commune, district, province };
}

async function fetchProvinces() {
  if (cachedProvinces) return cachedProvinces;
  try {
    const res = await axios.get(`${PANCAKE_BASE}/geo/provinces`, {
      params: { country_code: 63, api_key: PANCAKE_API_KEY },
      timeout: 10000
    });
    const data = res.data?.data || [];
    if (data.length) {
      cachedProvinces = data;
      console.log(`Provinces loaded: ${data.length}, sample: ${JSON.stringify(data[0])}`);
    }
    return data;
  } catch (e) {
    console.error("fetchProvinces error:", e.message);
    return [];
  }
}

async function fetchDistricts(provinceId) {
  if (cachedDistricts[provinceId]) return cachedDistricts[provinceId];
  try {
    const res = await axios.get(`${PANCAKE_BASE}/geo/districts`, {
      params: { province_id: provinceId, api_key: PANCAKE_API_KEY },
      timeout: 10000
    });
    const data = res.data?.data || [];
    if (data.length) {
      cachedDistricts[provinceId] = data;
      console.log(`Districts loaded: ${data.length} for province ${provinceId}`);
    }
    return data;
  } catch (e) {
    console.error(`fetchDistricts error for ${provinceId}:`, e.message);
    return [];
  }
}

async function fetchCommunes(districtId, provinceId) {
  const key = `${districtId}_${provinceId}`;
  if (cachedCommunes[key]) return cachedCommunes[key];
  try {
    const res = await axios.get(`${PANCAKE_BASE}/geo/communes`, {
      params: { district_id: districtId, province_id: provinceId, api_key: PANCAKE_API_KEY },
      timeout: 10000
    });
    const data = res.data?.data || [];
    if (data.length) {
      cachedCommunes[key] = data;
      console.log(`Communes loaded: ${data.length} for district ${districtId}`);
    }
    return data;
  } catch (e) {
    console.error(`fetchCommunes error for ${districtId}:`, e.message);
    return [];
  }
}

async function resolveAddressIds(province, district, commune) {
  try {
    // Step 1: Get provinces
    const provinces = await fetchProvinces();
    if (!provinces.length) {
      console.log("No provinces available");
      return null;
    }

    const matchedProvince = findBestMatch(provinces, ["name", "name_en"], province);
    if (!matchedProvince) {
      console.log("Province not matched:", province);
      return null;
    }
    console.log(`Province: ${matchedProvince.name} (${matchedProvince.id})`);

    // Step 2: Get districts
    const districts = await fetchDistricts(matchedProvince.id);
    if (!districts.length) {
      return { province_id: matchedProvince.id, province_name: matchedProvince.name_en || matchedProvince.name };
    }

    const matchedDistrict = findBestMatch(districts, ["name", "name_en"], district);
    if (!matchedDistrict) {
      console.log("District not matched:", district);
      return { province_id: matchedProvince.id, province_name: matchedProvince.name_en || matchedProvince.name };
    }
    console.log(`District: ${matchedDistrict.name} (${matchedDistrict.id})`);

    // Step 3: Get communes
    let commune_id = null, commune_name = null;
    if (commune) {
      const communes = await fetchCommunes(matchedDistrict.id, matchedProvince.id);
      const matchedCommune = findBestMatch(communes, ["name", "name_en"], commune);
      if (matchedCommune) {
        commune_id = matchedCommune.id;
        commune_name = matchedCommune.name_en || matchedCommune.name;
        console.log(`Commune: ${matchedCommune.name} (${matchedCommune.id})`);
      }
    }

    return {
      province_id: matchedProvince.id,
      province_name: matchedProvince.name_en || matchedProvince.name,
      district_id: matchedDistrict.id,
      district_name: matchedDistrict.name_en || matchedDistrict.name,
      commune_id,
      commune_name: commune_name || commune
    };
  } catch (e) {
    console.error("resolveAddressIds error:", e.message);
    return null;
  }
}

// ─── Pancake Order Creation ────────────────────────────────────────

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
  } catch (e) {
    console.error("getProductVariation error:", e.message);
    return null;
  }
}

async function createPancakeOrder(orderData) {
  try {
    const { name, phone, address, pack, payment } = orderData;
    const packKey = pack.toLowerCase().includes("family") ? "family"
                  : pack.toLowerCase().includes("duo")    ? "duo"
                  : "starter";
    const packInfo = PACK_INFO[packKey];
    const variation = await getProductVariation(packInfo.custom_id);
    const cleanPhone = phone.replace(/\D/g, "").replace(/^0/, "63");

    const { street, commune, district, province } = parseAddressParts(address);
    const addrIds = await resolveAddressIds(province, district, commune);
    console.log("Final address IDs:", JSON.stringify(addrIds));

    const shippingAddress = {
      full_name: name,
      phone_number: cleanPhone,
      address: street || commune || address,
      full_address: address,
      country_code: "63",
      ...(addrIds && {
        province_id: addrIds.province_id,
        province_name: addrIds.province_name,
        district_id: addrIds.district_id,
        district_name: addrIds.district_name,
        commune_id: addrIds.commune_id,
        commune_name: addrIds.commune_name
      })
    };

    const payload = {
      order: {
        bill_full_name: name,
        bill_phone_number: cleanPhone,
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

    const res = await axios.post(
      `${PANCAKE_BASE}/shops/${PANCAKE_SHOP_ID}/orders`,
      payload,
      { params: { api_key: PANCAKE_API_KEY } }
    );
    console.log("Order created:", res.data?.data?.id);
    return res.data;
  } catch (e) {
    console.error("createPancakeOrder error:", e.message);
    return null;
  }
}

// ─── Parse Order Signal ────────────────────────────────────────────

function parseOrderSignal(text) {
  const match = text.match(/\[PROCESS_ORDER:([^\]]+)\]/);
  if (!match) return null;
  const raw = match[1];
  const obj = {};
  raw.split("|").forEach(part => {
    const [k, ...v] = part.split("=");
    if (k) obj[k.trim()] = v.join("=").trim();
  });
  return (obj.name && obj.phone && obj.address && obj.pack) ? obj : null;
}

// ─── System Prompt ─────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a friendly assistant for Furbiotics Philippines. Help fur parents and convert them into customers naturally — not forced, not salesy.

RESPONSE RULES:
- 1 to 3 sentences only — short, natural, like a real person
- No asterisks, no bold, no bullets, no formatting
- Occasional smile emoji is okay — no paw emojis or other emojis
- Mix of English and Filipino (Taglish) — casual and friendly
- Never repeat questions about info already given
- Sound like a human, not a bot
- No upselling after order is placed
- No "May I help you with anything else?" after order

---

EXACT ORDER FLOW:

STEP 1 — PRICE INQUIRY
When customer asks "HM", "hm", "how much", "magkano", "pila", "presyo", or any price question:
First give the pricing, then ask which one they want.

"We have three options: Starter Pack (1 bottle) 499 pesos, Duo Pack (2 bottles) 699 pesos, and Family Pack (3 bottles) 999 pesos. All with free shipping. Which one interests you?"

STEP 2 — WHEN CUSTOMER PICKS A PACK
Ask only: "GCash or COD?"

STEP 3A — IF GCASH
Send the GCash payment details immediately:

Hi! 😊

Please send a copy of your receipt through our Facebook Page: Furbiotics Philippines

GCash Payment Options:
0969-113-6027 — M* RE***E J M.
0919-384-3923 — P****O M*****O

Order Details:
Item: [chosen pack]
Total Amount: PHP [amount] (FREE SHIPPING)

Please advise us once the payment has been sent so we can process your order immediately. Thank you!

Pure love, pure probiotics
Zian from Furbiotics

Then send the order form:
"Once you've sent the payment, please fill this out:

Name:
Phone#:
House#/Street/Purok:
Barangay:
City/Municipality:
Province:
Landmark (Optional):"

STEP 3B — IF COD
Send the order form immediately:
"Please fill this out so we can process your order:

Name:
Phone#:
House#/Street/Purok:
Barangay:
City/Municipality:
Province:
Landmark (Optional):"

STEP 4 — WHEN CUSTOMER FILLS OUT THE FORM
Once you have name, phone, and complete address — summarize and close:
"Thank you [name]! We've received your order. Our team will call you shortly to confirm. Pure love, pure probiotics! 😊
[PROCESS_ORDER: name=[name]|phone=[phone]|address=[house/street], [barangay], [city/municipality], [province]|pack=[starter or duo or family]|payment=[gcash or cod]]"

IMPORTANT RULES:
- NEVER give the website link (furbiotics.shop) once customer has provided their details
- NEVER upsell or ask follow-up questions after order is placed
- NEVER repeat questions about info already provided
- The [PROCESS_ORDER] tag is for the system only — customer will not see it
- No paw emojis
- Follow the exact flow above

---

PRICING:
Starter Pack — 1 bottle: 499 pesos (VIP Circle access)
Duo Pack — 2 bottles: 699 pesos (FREE ebook + VIP Circle)
Family Pack — 3 bottles: 999 pesos (FREE ebook + Recipe Pack + Loyalty card + VIP Circle)
All with FREE SHIPPING.

---

ABOUT FURBIOTICS:
Pure probiotic drops for cats and dogs. Vet-formulated with clinical studies. No chemicals, no artificial flavorings. Liquid drops — tasteless, can be mixed with food or given directly.

BENEFITS: Most fur baby problems — skin issues, low immunity, itching, hotspots — start in the gut. Furbiotics helps heal the gut to resolve these symptoms from the root.
RESULTS: Most fur parents see changes after 14 days of daily use.
SIDE EFFECTS: None. Pure probiotic.

HOW TO USE (per bottle = 30ml):
Cats: 0.5ml daily
Dogs below 10kg: 1ml daily
Dogs 10-20kg: 2ml daily
Dogs above 20kg: 3ml daily
Can be mixed with food. Store at room temperature.

---

WHEN CUSTOMER HAS A CONCERN OR PROBLEM WITH THEIR PET:
Help them first — don't sell immediately.
"How is your fur baby doing? What symptoms are you noticing?"

Listen. Then introduce Furbiotics naturally:
"Most of the time, those symptoms start in the gut. We discovered something that has helped fur babies with similar concerns..."

Once interested — follow the ORDER FLOW above.

---

DELIVERY: Luzon: 1-3 days | Visayas: 6-7 days | Mindanao: 7-9 days. All FREE SHIPPING.

AFTER ORDER: Warm thank you, end conversation. No upsell, no follow-up questions.

FOLLOW-UP AFTER 2 WEEKS:
Ordered: "Hello! How is your fur baby doing? Have you noticed any changes since starting Furbiotics?"
Not yet: "How is your pet doing? We're here if you have any questions."

IF UNABLE TO ANSWER: "For that, it's best to speak with our team directly. Feel free to message us here on the page!"

TONE: Taglish or English, natural, casual, 1-3 sentences, no paw emojis, smile only occasionally.`;

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
        if (conversationHistory[senderId].length > 20) {
          conversationHistory[senderId] = conversationHistory[senderId].slice(-20);
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
            console.log("Processing order:", orderData.name, orderData.pack);
            createPancakeOrder(orderData).then(result => {
              if (result?.success || result?.data) {
                console.log("Order created:", result?.data?.id);
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
        await sendMessage(senderId, "Sorry, may technical issue kami ngayon. Please try again later!");
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
