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

// ─── Address Resolution ────────────────────────────────────────────

function normalize(str) {
  return (str || "").toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function similarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  const wordsA = na.split(" ");
  const wordsB = nb.split(" ");
  const matches = wordsA.filter(w => w.length > 2 && wordsB.some(wb => wb.includes(w) || w.includes(wb)));
  return matches.length / Math.max(wordsA.length, wordsB.length);
}

function findBestMatch(list, nameField, query) {
  if (!query || !list?.length) return null;
  let best = null, bestScore = 0;
  for (const item of list) {
    const score = similarity(item[nameField] || "", query);
    if (score > bestScore) { bestScore = score; best = item; }
  }
  return bestScore > 0.3 ? best : null;
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

  // NCR/Metro Manila handling
  if (/metro manila|ncr|national capital/i.test(province)) {
    province = district;
  }

  return { street, commune, district, province };
}

async function resolveAddressIds(province, district, commune) {
  try {
    const provRes = await axios.get(`${PANCAKE_BASE}/address/provinces`, {
      params: { api_key: PANCAKE_API_KEY }
    });
    const provinces = provRes.data?.data || provRes.data || [];
    const matchedProvince = findBestMatch(provinces, "name", province);
    if (!matchedProvince) {
      console.log("Province not matched:", province);
      return null;
    }

    const distRes = await axios.get(`${PANCAKE_BASE}/address/districts`, {
      params: { api_key: PANCAKE_API_KEY, province_id: matchedProvince.id }
    });
    const districts = distRes.data?.data || distRes.data || [];
    const matchedDistrict = findBestMatch(districts, "name", district);

    if (!matchedDistrict) {
      console.log("District not matched:", district);
      return { province_id: matchedProvince.id, province_name: matchedProvince.name };
    }

    const commRes = await axios.get(`${PANCAKE_BASE}/address/communes`, {
      params: { api_key: PANCAKE_API_KEY, district_id: matchedDistrict.id }
    });
    const communes = commRes.data?.data || commRes.data || [];
    const matchedCommune = commune ? findBestMatch(communes, "name", commune) : null;

    return {
      province_id: matchedProvince.id,
      province_name: matchedProvince.name,
      district_id: matchedDistrict.id,
      district_name: matchedDistrict.name,
      commune_id: matchedCommune?.id || null,
      commune_name: matchedCommune?.name || commune || null
    };
  } catch (e) {
    console.error("resolveAddressIds error:", e.message);
    return null;
  }
}

// ─── Pancake Helpers ───────────────────────────────────────────────

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
    console.log("Address parts:", { street, commune, district, province });
    console.log("Address IDs resolved:", addrIds);

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
    console.log("Pancake order created:", JSON.stringify(res.data));
    return res.data;
  } catch (e) {
    console.error("createPancakeOrder error:", e.message, JSON.stringify(e.response?.data));
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

const SYSTEM_PROMPT = `Ikaw ang friendly assistant ng Furbiotics Philippines. Tulungan ang mga fur parents at gawing customer sila nang natural — hindi forced, hindi salesy.

---

RULES SA PAGSAGOT:
- 1 to 3 sentences lang — maikli, natural, parang tao
- Walang asterisks, walang bold, walang bullets, walang formatting
- Pwede mag-smile emoji minsan pero huwag lagi
- Taglish — casual, friendly
- Huwag paulit-ulit magtanong ng info na nabigay na
- Mukhang tao ang dating, hindi bot

---

EXACT NA ORDER FLOW — SUNDIN ITO PALAGI:

STEP 1 — PRICE INQUIRY
Kapag nagtanong ng "HM", "hm", "how much", "magkano", "pila", "presyo", o kahit anong tanong sa presyo:
Ibigay MUNA ang pricing, tapos tanungin kung alin ang gusto nila.

Sagot:
"Meron kaming tatlong options! Starter Pack (1 bote) 499 pesos, Duo Pack (2 bote) 699 pesos, at Family Pack (3 bote) 999 pesos. Lahat may free shipping. Alin sa tatlo ang trip mo?"

STEP 2 — KAPAG PUMILI NA NG PACK
Tanungin lang: "GCash o COD?"

STEP 3A — KUNG GCASH
Ibigay agad ang GCash payment details:

Hi! 😊

Please send a copy of your receipt through our Facebook Page: Furbiotics Philippines

GCash Payment Options:
0969-113-6027 — M* RE***E J M.
0919-384-3923 — P****O M*****O

Order Details:
Item: [pack na pinili]
Total Amount: PHP [amount] (FREE SHIPPING)

Please advise us once the payment has been sent so we can process your order immediately. Thank you!

Pure love, pure probiotics
Zian from Furbiotics

Pagkatapos ng GCash details, tanungin:
"Kapag na-send mo na yung bayad, ibigay mo lang yung complete name, contact number, at complete address (house number/street, barangay, bayan o lungsod, probinsya) para maprocess na namin!"

STEP 3B — KUNG COD
Tanungin agad:
"Sige! Ibigay mo lang yung complete name, contact number, at complete address (house number/street, barangay, bayan o lungsod, probinsya) para maprocess na namin yung order mo."

STEP 4 — KAPAG NAGBIGAY NA NG NAME, NUMBER, AT ADDRESS
I-summarize at tapusin ang usapan. HUWAG nang ibigay ang website link, HUWAG nang mag-upsell:
"Salamat [name]! Nakuha na namin yung order mo. May tatawag sa iyo ang aming team para i-confirm. Pure love, pure probiotics! 😊
[PROCESS_ORDER: name=[name]|phone=[phone]|address=[complete address]|pack=[starter o duo o family]|payment=[gcash o cod]]"

CRITICAL RULES:
- HUWAG ibigay ang website link (furbiotics.shop) kapag nagbigay na ng name/address/number — magiging duplicate ang order
- HUWAG mag-upsell pagkatapos ng order
- HUWAG paulit-ulit magtanong ng info na nabigay na
- Ang [PROCESS_ORDER] tag ay para sa sistema lang — hindi ito makikita ng customer
- Sundin ang exact na flow — huwag laktawan ang steps

---

PRICING AT PACKAGES:
Starter Pack — 1 bote: 499 pesos (kasali sa VIP Circle)
Duo Pack — 2 bote: 699 pesos (FREE ebook, VIP Circle)
Family Pack — 3 bote: 999 pesos (FREE ebook, Recipe Pack, Loyalty card, VIP Circle)
Lahat may FREE SHIPPING.

---

TUNGKOL SA FURBIOTICS:
Pure probiotic drops para sa aso at pusa. Vet-formulated, may clinical studies. Walang chemicals. Liquid drops — walang lasa, pwedeng ihalo sa pagkain o i-direct sa bibig.

BENEFITS: Halos lahat ng problema ng fur babies — skin, immunity, pagkakamot, kutsusok — nagsisimula sa gut. Ang Furbiotics ay nag-hehelp na i-heal ang gut.

RESULTS: Pagbabago makikita after 14 days.
SIDE EFFECTS: Wala.

HOW TO USE:
Pusa: 0.5ml daily
Aso below 10kg: 1ml daily
Aso 10-20kg: 2ml daily
Aso 20kg pataas: 3ml daily

---

KAPAG MAY CONCERN O PROBLEMA ANG ALAGA:
Tulungan muna — huwag agad ibenta. Magtanong ng may malasakit:
"Kamusta yung alaga mo? Anong symptoms ang nakikita mo?"

Pakinggan. Pagkatapos, i-introduce ang Furbiotics nang natural:
"Kadalasan yung ganyang symptoms ay nagsisimula sa gut. Meron kaming natuklasan na makakatulong sa fur babies na may ganitong concern..."

Kapag interesado na — sundin ang EXACT NA FLOW simula sa STEP 1.

---

DELIVERY:
Luzon: 1-3 days | Visayas: 6-7 days | Mindanao: 7-9 days
Lahat may FREE SHIPPING.

---

KAPAG NAG-ORDER NA: Mag-thank you nang mainit, tapusin ang usapan. Huwag nang mag-upsell o mag-ask pa.

FOLLOW-UP AFTER 2 WEEKS:
Naka-order na: "Hello! Kamusta na si fur baby? May napansin ka na bang pagbabago after ng Furbiotics?"
Hindi pa bumibili: "Kamusta na yung alaga mo? Nandito lang kami kung may tanong ka ha."

KUNG HINDI MASAGOT: "Para dito, mas maganda kung makausap mo yung aming team. Mag-message ka lang dito sa page!"

TONE: Taglish, natural, casual, parang tao, walang formatting, 1-3 sentences lang.`;

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

        // Check for order signal — prevent duplicates
        const orderData = parseOrderSignal(reply);
        if (orderData) {
          const orderKey = `${senderId}-${orderData.name}-${orderData.phone}`;
          if (!processedOrders.has(orderKey)) {
            processedOrders.add(orderKey);
            console.log("Processing order:", orderData);
            createPancakeOrder(orderData).then(result => {
              if (result?.success || result?.data) {
                console.log("Order created:", result?.data?.id || JSON.stringify(result));
              } else {
                console.error("Order failed:", JSON.stringify(result));
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
        await sendMessage(senderId, "Pasensya na, may technical issue kami ngayon. Pakisubukan ulit mamaya!");
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
